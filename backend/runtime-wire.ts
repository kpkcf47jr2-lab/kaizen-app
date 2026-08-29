// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — runtime wiring
//
//  Adapters that let @kaizen/runtime (Fase 1 multi-turn ReAct loop)
//  drive the existing kaizen-app primitives (LLMClient, ToolRegistry,
//  MemoryStore). Kept in one file so a future refactor of either side
//  has exactly one bridge to update.
// ═══════════════════════════════════════════════════════════════════════

import type {
  LlmChatClient,
  LlmChatResponse,
  LlmToolCall,
  LlmToolSchema,
  RunLedger,
  ToolExecutor,
} from "@kaizen/runtime/agent";
import type { RuntimeSnapshot, SurvivalTier } from "@kaizen/runtime";
import type { ChatMessage, LLMClient, ToolSchema } from "../src/brain/llm.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import { MemoryStore } from "../src/memory/store.js";
import type { Snapshot } from "../src/brain/economic.js";

// ── LLM adapter ───────────────────────────────────────────────────────

/** Wrap the existing LLMClient so it satisfies @kaizen/runtime's
 *  LlmChatClient contract. The runtime speaks tool_choice + typed
 *  usage; the underlying client speaks provider-native shapes. */
export function wireLlm(llm: LLMClient): LlmChatClient {
  return {
    async chat(params): Promise<LlmChatResponse> {
      // LLMClient.chat currently ignores toolChoice + maxTokens. We pass
      // them for future-proofing (a small patch to llm.ts adds support
      // without breaking the runtime contract).
      const raw = await llm.chat(
        params.messages as unknown as ChatMessage[],
        params.tools.map((t): ToolSchema => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters as ToolSchema["function"]["parameters"],
          },
        })),
      );

      const toolCalls: LlmToolCall[] = (raw.toolCalls ?? []).map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = { _raw: tc.function.arguments };
        }
        return { id: tc.id, name: tc.function.name, arguments: args };
      });

      return {
        content: raw.content,
        toolCalls,
        usage: {
          inputTokens: raw.usage?.prompt ?? 0,
          outputTokens: raw.usage?.completion ?? 0,
          // llm.ts doesn't surface the model back; use env default.
          model: process.env.KAIZEN_LLM_MODEL || "meta/llama-3.2-90b-vision-instruct",
        },
        finishReason: (raw.finishReason as LlmChatResponse["finishReason"]) ?? "stop",
      };
    },
  };
}

// ── Tool executor adapter ─────────────────────────────────────────────

/** Wrap ToolRegistry so it satisfies ToolExecutor. Route through PolicyEngine
 *  via each tool's own intent (the registry stores `toIntent()` per tool). */
export function wireTools(
  registry: ToolRegistry,
  makeContext: (agentId: string) => { agentId: string; ts: number },
): ToolExecutor {
  return {
    schemas(): LlmToolSchema[] {
      return registry.list().map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters as Record<string, unknown>,
      }));
    },
    async execute(agentId: string, call: LlmToolCall): Promise<unknown> {
      const tool = registry.get(call.name);
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      const ctx = makeContext(agentId);
      // NB: PolicyEngine is enforced inside the tool implementations via
      // SecureWalletService.transferUsdc / swapExactUsdcFor — no double-
      // check needed here. Runtime-level PolicyEngine wrapping is a Fase 3
      // add-on if we decide we want the runtime to enforce independently.
      return tool.exec(call.arguments, ctx);
    },
  };
}

// ── Ledger adapter ────────────────────────────────────────────────────

/** RunLedger that persists into the existing MemoryStore. Uses the
 *  conversation_turns table for LLM turns and economic_events for
 *  aborts (so the owner can see them in the same feed as trades). */
export function wireLedger(): RunLedger {
  return {
    async recordTurn(agentId, msg): Promise<void> {
      const mem = new MemoryStore(agentId);
      try {
        // The runtime message shape maps 1:1 to MemoryStore.addTurn
        // (role, content, optional tool_calls / tool_call_id / name).
        mem.addTurn({
          ts: Date.now(),
          role: msg.role,
          content: typeof msg.content === "string" ? msg.content : (msg.content ?? ""),
          toolCall: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          toolResult: null,
        });
      } finally { mem.close(); }
    },
    async recordAbort(agentId, reason, meta): Promise<void> {
      const mem = new MemoryStore(agentId);
      try {
        mem.recordEvent({
          ts: Date.now(),
          kind: "policy_violation",
          reason: `runtime_abort: ${reason}`,
          metadata: meta ? JSON.stringify(meta) : null,
        });
      } finally { mem.close(); }
    },
  };
}

// ── Snapshot translator ───────────────────────────────────────────────

/** Translate kaizen-app's fat Snapshot into the compact RuntimeSnapshot. */
export function toRuntimeSnapshot(
  agentId: string,
  snap: Snapshot,
  activeChildren = 0,
): RuntimeSnapshot {
  return {
    agentId,
    ts: snap.ts,
    netWorthUsd: snap.netWorthUsd,
    cashUsd: snap.cashUsd,
    gasReserveUsd: snap.gasReserveUsd,
    drawdownPct: snap.drawdownPct,
    tier: snap.suggestedStatus as SurvivalTier,
    activeChildren,
  };
}
