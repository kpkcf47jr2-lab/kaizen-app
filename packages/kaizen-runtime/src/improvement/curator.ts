// ═══════════════════════════════════════════════════════════════════════
//  Improvement.2 — Auto dataset curation
//
//  Reads the enriched economic_events table (with outcome_success set
//  by Improvement.1) + the conversation_turns table (with the exact
//  LLM prompt + tool call that produced the decision), and emits three
//  training corpora:
//
//    · sft.jsonl       — high-outcome decisions to imitate.
//                        Format: { messages: [system, user, assistant(tool_call), tool] }
//    · dpo.jsonl       — preference pairs (chosen_high_ROI vs rejected_low_ROI)
//                        grouped by strategy label.
//                        Format: { prompt, chosen, rejected, strategy }
//    · eval.jsonl      — hold-out sample for eval loss + qualitative review.
//
//  The Improvement.5 auto-retrain trigger tool consumes these files.
// ═══════════════════════════════════════════════════════════════════════

import type { OutcomeLedger, PendingMeasurement } from "./index.js";

export type CurationExample = {
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call?: unknown; tool_call_id?: string; name?: string }>;
  meta: { eventId: number; strategy: string | null; outcomeUsd: number; outcomeMetric: string; success: boolean };
};

export type PreferencePair = {
  prompt: string;
  chosen: string;             // serialized assistant response of the winning example
  rejected: string;           // serialized assistant response of the losing example
  strategy: string;
  meta: { chosenEventId: number; rejectedEventId: number; roiDeltaUsd: number };
};

/** Reader over the store — kept as an interface so tests inject fakes
 *  and the backend wires it to the real MemoryStore. */
export interface CuratorLedger extends OutcomeLedger {
  /** Fetch enriched events for the curator. Same shape as
   *  MemoryStore.eventsWithOutcome(). */
  eventsWithOutcome(opts?: {
    sinceMs?: number;
    successOnly?: boolean;
    kinds?: string[];
    limit?: number;
  }): Promise<Array<{
    id: number; ts: number; kind: string; strategy: string | null;
    amountUsd: number | null; txHash: string | null;
    reason: string; metadata: Record<string, unknown> | string | null;
    outcomeUsd: number; outcomeMetric: string; outcomeSuccess: boolean;
  }>>;
  /** Return the recent conversation turns bracketing the event (for
   *  context reconstruction — the LLM prompt that led to the decision). */
  turnsAround(eventTs: number, windowMs?: number): Promise<Array<{
    ts: number; role: "system" | "user" | "assistant" | "tool";
    content: string; toolCall: string | null; toolResult: string | null;
  }>>;
}

export interface CuratorConfig {
  ledger: CuratorLedger;
  /** How far back to look — default 30 days. */
  sinceMs?: number;
  /** ROI delta threshold for a preference pair to be included. Default $0.10 —
   *  ignore noise-level differences. */
  minRoiDeltaUsd?: number;
  /** Max preference pairs to emit per strategy. Default 50. */
  maxPairsPerStrategy?: number;
}

export class AutoCurator {
  private readonly cfg: Required<CuratorConfig>;

  constructor(cfg: CuratorConfig) {
    this.cfg = {
      sinceMs: cfg.sinceMs ?? 30 * 24 * 3600_000,
      minRoiDeltaUsd: cfg.minRoiDeltaUsd ?? 0.10,
      maxPairsPerStrategy: cfg.maxPairsPerStrategy ?? 50,
      ...cfg,
    };
  }

  /** Build SFT corpus: keep only events with `outcomeSuccess = true`.
   *  Each example is (system + user context) + (assistant tool_call) +
   *  (tool result summary). */
  async buildSft(): Promise<CurationExample[]> {
    const wins = await this.cfg.ledger.eventsWithOutcome({
      sinceMs: this.cfg.sinceMs, successOnly: true, limit: 2000,
    });
    const examples: CurationExample[] = [];
    for (const w of wins) {
      const turns = await this.cfg.ledger.turnsAround(w.ts);
      // Find the assistant turn with the tool_call that triggered `w`,
      // and the tool response turn.
      const assistantTurn = turns.find((t) => t.role === "assistant" && t.toolCall);
      const toolTurn = turns.find((t) => t.role === "tool");
      if (!assistantTurn || !toolTurn) continue;
      const userTurn = turns.find((t) => t.role === "user") ?? { role: "user" as const, content: "", ts: 0, toolCall: null, toolResult: null };
      const systemTurn = turns.find((t) => t.role === "system") ?? { role: "system" as const, content: "", ts: 0, toolCall: null, toolResult: null };
      examples.push({
        messages: [
          { role: "system",    content: systemTurn.content },
          { role: "user",      content: userTurn.content },
          { role: "assistant", content: assistantTurn.content,
            tool_call: assistantTurn.toolCall ? safeParse(assistantTurn.toolCall) : undefined },
          { role: "tool",      content: toolTurn.content, name: safeName(assistantTurn.toolCall) },
        ],
        meta: { eventId: w.id, strategy: w.strategy, outcomeUsd: w.outcomeUsd, outcomeMetric: w.outcomeMetric, success: true },
      });
    }
    return examples;
  }

  /** Build DPO preference pairs: for each strategy, pair up wins and
   *  losses in the same context bucket. Keep only pairs with ROI delta
   *  > minRoiDeltaUsd. */
  async buildDpo(): Promise<PreferencePair[]> {
    const all = await this.cfg.ledger.eventsWithOutcome({
      sinceMs: this.cfg.sinceMs, limit: 5000,
    });
    // Group by strategy
    const byStrategy = new Map<string, typeof all>();
    for (const e of all) {
      const s = e.strategy ?? "_unknown";
      if (!byStrategy.has(s)) byStrategy.set(s, []);
      byStrategy.get(s)!.push(e);
    }
    const pairs: PreferencePair[] = [];
    for (const [strategy, events] of byStrategy) {
      const wins   = events.filter((e) => e.outcomeSuccess).sort((a, b) => b.outcomeUsd - a.outcomeUsd);
      const losses = events.filter((e) => !e.outcomeSuccess).sort((a, b) => a.outcomeUsd - b.outcomeUsd);
      const upto = Math.min(wins.length, losses.length, this.cfg.maxPairsPerStrategy);
      for (let i = 0; i < upto; i++) {
        const w = wins[i]!;
        const l = losses[i]!;
        const delta = w.outcomeUsd - l.outcomeUsd;
        if (delta < this.cfg.minRoiDeltaUsd) continue;
        const chosenTurns  = await this.cfg.ledger.turnsAround(w.ts);
        const rejectedTurns = await this.cfg.ledger.turnsAround(l.ts);
        const chosenAssistant   = chosenTurns.find((t) => t.role === "assistant");
        const rejectedAssistant = rejectedTurns.find((t) => t.role === "assistant");
        if (!chosenAssistant || !rejectedAssistant) continue;
        pairs.push({
          prompt: chosenTurns.find((t) => t.role === "user")?.content ?? "",
          chosen: JSON.stringify({ content: chosenAssistant.content, tool_call: safeParse(chosenAssistant.toolCall) }),
          rejected: JSON.stringify({ content: rejectedAssistant.content, tool_call: safeParse(rejectedAssistant.toolCall) }),
          strategy,
          meta: { chosenEventId: w.id, rejectedEventId: l.id, roiDeltaUsd: delta },
        });
      }
    }
    return pairs;
  }

  /** Hold out ~10% for eval. Same shape as buildSft(). */
  async buildEval(fraction = 0.1): Promise<CurationExample[]> {
    const all = await this.buildSft();
    const takeN = Math.max(1, Math.floor(all.length * fraction));
    // Deterministic hold-out: last N by event id.
    return all.slice(-takeN);
  }
}

// ── helpers ──────────────────────────────────────────────────────────
function safeParse(s: string | null | undefined): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}
function safeName(toolCall: string | null): string | undefined {
  if (!toolCall) return undefined;
  const parsed = safeParse(toolCall) as { function?: { name?: string } } | Array<{ function?: { name?: string } }>;
  if (Array.isArray(parsed)) return parsed[0]?.function?.name;
  return parsed?.function?.name;
}
