// ═══════════════════════════════════════════════════════════════════════
//  ContextTrimmer — keep the message array under the model's context cap
//
//  Fase 1 ships a *simple* trimmer:
//    · Always keep the system message.
//    · Always keep the last K assistant/tool pairs (the "hot" context).
//    · If we still exceed the budget, drop the middle turns and inject a
//      short synthetic "assistant" note summarizing what got dropped
//      ("[trimmed N turns: last thesis was …]").
//
//  Fase 2+ can replace this with an LLM-summarized rolling window.
//  The interface is stable so callers don't change.
// ═══════════════════════════════════════════════════════════════════════

import type { IContextTrimmer } from "./index.js";

/** Rough token estimator — 1 token ≈ 4 chars for English/Spanish text. Good
 *  enough for budgeting; the exact tokenizer varies per model and would
 *  couple this to the model provider unnecessarily. */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Minimal chat-message shape the trimmer expects. Matches the LLM
 *  provider payloads (OpenAI-style) so callers don't need to re-map. */
export interface TrimmableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  // ignored by the trimmer but preserved:
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface ContextTrimmerConfig {
  /** Always keep the last N pairs even if budget is tight. Default 4. */
  hotPairs: number;
  /** Emit the synthetic summary note when trimming. Default true. */
  summarizeDropped: boolean;
}

export class ContextTrimmer implements IContextTrimmer {
  private readonly cfg: ContextTrimmerConfig;

  constructor(cfg?: Partial<ContextTrimmerConfig>) {
    this.cfg = {
      hotPairs: cfg?.hotPairs ?? 4,
      summarizeDropped: cfg?.summarizeDropped ?? true,
    };
  }

  async trim<T>(messages: T[], maxTokens: number): Promise<T[]> {
    const msgs = messages as unknown as TrimmableMessage[];
    if (msgs.length === 0) return messages;

    // Total estimate
    const budget = maxTokens;
    let total = 0;
    for (const m of msgs) total += estimateTokens(typeof m.content === "string" ? m.content : "");
    if (total <= budget) return messages;

    // Pin: system messages (there might be more than one) and the tail.
    const systemHead: TrimmableMessage[] = [];
    let firstNonSystem = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]!.role === "system") {
        systemHead.push(msgs[i]!);
        firstNonSystem = i + 1;
      } else break;
    }

    const tailKeepMessages = this.cfg.hotPairs * 2;
    const tailStart = Math.max(firstNonSystem, msgs.length - tailKeepMessages);
    const tail = msgs.slice(tailStart);

    // The middle turns get dropped
    const dropped = msgs.slice(firstNonSystem, tailStart);

    const out: TrimmableMessage[] = [...systemHead];
    if (dropped.length > 0 && this.cfg.summarizeDropped) {
      out.push({
        role: "assistant",
        content:
          `[context-trimmed] ${dropped.length} earlier turns removed to stay under ` +
          `~${budget} tokens. Last-known thesis before trim: ` +
          `${lastAssistantText(dropped).slice(0, 200) || "(none)"}.`,
      });
    }
    out.push(...tail);
    return out as unknown as T[];
  }
}

function lastAssistantText(msgs: TrimmableMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === "assistant" && typeof msgs[i]!.content === "string") {
      return msgs[i]!.content as string;
    }
  }
  return "";
}
