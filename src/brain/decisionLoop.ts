// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Decision Loop
//
//  One tick of the agent:
//    1. OBSERVE  — read balances via wallet service, compose snapshot
//    2. BRIEF    — build the operator briefing prompt
//    3. DECIDE   — ask the LLM with the tool schema attached
//    4. VALIDATE — the LLM emits at most one tool call; run it through
//                  Policy Engine explicitly (defense in depth — the tool
//                  itself will also validate, but we log the intent here)
//    5. EXECUTE  — run the tool via the registry
//    6. LEARN    — persist the tool call + result to memory + event ledger
//
//  Ticks are independent. The agent can be ticked from cron, from an
//  HTTP endpoint (POST /tick), or from a long-running scheduler. Each
//  tick is a bounded unit of work: at most one tool call, then done.
// ═══════════════════════════════════════════════════════════════════════

import {
  PolicyEngine,
  type AgentState,
} from "../policy/engine.js";
import { snapshot, proposeBudget } from "./economic.js";
import type { Snapshot, BudgetProposal, Balances } from "./economic.js";
import { buildTickMessages } from "./prompt.js";
import type { LLMClient, ChatMessage, ToolCallEmission } from "./llm.js";
import type { ToolRegistry } from "../tools/registry.js";
import { MemoryStore } from "../memory/store.js";
import type { AgentRegistry, AgentRecord } from "../agent/registry.js";

export interface TickInput {
  agentId: string;
  operatorPrompt?: string;
  /** Provided by the caller — the composed source of truth (backend/wallet). */
  balances: Balances;
  agentState: AgentState;
}

export type TickOutcome =
  | { kind: "waited"; reason: string }
  | { kind: "tool_call"; tool: string; args: unknown; result: unknown }
  | { kind: "tool_rejected"; tool: string; reason: string }
  | { kind: "tool_failed"; tool: string; error: string };

export interface TickResult {
  agentId: string;
  ts: number;
  snapshot: Snapshot;
  budget: BudgetProposal;
  outcome: TickOutcome;
  llmContent: string | null;
  usage?: { prompt: number; completion: number; total: number };
}

export class DecisionLoop {
  private policy = new PolicyEngine();

  constructor(
    private readonly llm: LLMClient,
    private readonly tools: ToolRegistry,
    private readonly registry: AgentRegistry,
  ) {}

  async tick(input: TickInput): Promise<TickResult> {
    const record = await this.registry.get(input.agentId);
    if (!record) throw new Error(`Agent ${input.agentId} not found`);

    // 1. OBSERVE — snapshot from balances + memory-supplied outflows
    const snap = snapshot(
      input.agentId,
      input.balances,
      [], // MVP: no open positions tracked yet
      {
        outflow24hUsd: input.agentState.outflow24hUsd,
        outflow7dUsd: input.agentState.outflow7dUsd,
      },
      record.peakNetWorthUsd,
    );
    await this.registry.updatePeak(input.agentId, snap.peakNetWorthUsd);
    if (snap.suggestedStatus !== record.status) {
      await this.registry.updateStatus(input.agentId, snap.suggestedStatus);
      const mem = new MemoryStore(input.agentId);
      try {
        mem.recordEvent({
          ts: Date.now(),
          kind: "status_change",
          reason: `${record.status} → ${snap.suggestedStatus}`,
          metadata: JSON.stringify({ drawdownPct: snap.drawdownPct }),
        });
      } finally { mem.close(); }
    }
    const budget = proposeBudget(snap.netWorthUsd, snap.suggestedStatus);

    // 2. BRIEF — operator briefing + tool schema
    const mem = new MemoryStore(input.agentId);
    let messages: ChatMessage[];
    try {
      const recentEvents = mem.recentEvents(10);
      messages = buildTickMessages({
        agent: updatedRecord(record, snap),
        snapshot: snap,
        budget,
        recentEvents,
        toolNames: this.tools.list().map(t => t.name),
        operatorPrompt: input.operatorPrompt,
      });
    } finally { mem.close(); }

    // 3. DECIDE — call the LLM with tools
    const toolSchema = this.tools.toOpenAiSchema();
    const resp = await this.llm.chat(messages, toolSchema);

    // Persist the assistant turn (with tool_calls if any) for memory continuity
    this.persistAssistantTurn(input.agentId, resp.content, resp.toolCalls);

    // 4/5. VALIDATE + EXECUTE
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      return {
        agentId: input.agentId,
        ts: Date.now(),
        snapshot: snap,
        budget,
        outcome: { kind: "waited", reason: resp.content ?? "(no rationale)" },
        llmContent: resp.content,
        usage: resp.usage,
      };
    }

    // Only allow one tool per tick — ignore extras but log a violation.
    const call = resp.toolCalls[0];
    if (resp.toolCalls.length > 1) {
      this.logViolation(input.agentId, "multi_tool_per_tick", call);
    }

    const outcome = await this.executeCall(input.agentId, call, input.agentState);

    return {
      agentId: input.agentId,
      ts: Date.now(),
      snapshot: snap,
      budget,
      outcome,
      llmContent: resp.content,
      usage: resp.usage,
    };
  }

  private async executeCall(
    agentId: string,
    call: ToolCallEmission,
    agentState: AgentState,
  ): Promise<TickOutcome> {
    const registered = this.tools.get(call.function.name);
    if (!registered) {
      const reason = `Unknown tool: ${call.function.name}`;
      this.persistToolResult(agentId, call, { error: reason });
      return { kind: "tool_rejected", tool: call.function.name, reason };
    }

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch (e) {
      const reason = `Malformed tool args JSON: ${(e as Error).message}`;
      this.persistToolResult(agentId, call, { error: reason });
      return { kind: "tool_rejected", tool: call.function.name, reason };
    }

    const intent = registered.toIntent(args, { agentId });
    const decision = this.policy.evaluate(agentState, intent);
    if (!decision.allow) {
      this.persistToolResult(agentId, call, { policyRejected: decision.reason });
      return {
        kind: "tool_rejected",
        tool: call.function.name,
        reason: decision.reason,
      };
    }

    try {
      const result = await registered.exec(args, { agentId });
      this.persistToolResult(agentId, call, result);
      return { kind: "tool_call", tool: call.function.name, args, result };
    } catch (e) {
      const msg = (e as Error).message;
      this.persistToolResult(agentId, call, { error: msg });
      return { kind: "tool_failed", tool: call.function.name, error: msg };
    }
  }

  private persistAssistantTurn(
    agentId: string,
    content: string | null,
    toolCalls: ToolCallEmission[],
  ): void {
    const mem = new MemoryStore(agentId);
    try {
      mem.addTurn({
        ts: Date.now(),
        role: "assistant",
        content: content ?? "",
        toolCall: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      });
    } finally { mem.close(); }
  }

  private persistToolResult(
    agentId: string,
    call: ToolCallEmission,
    result: unknown,
  ): void {
    const mem = new MemoryStore(agentId);
    try {
      mem.addTurn({
        ts: Date.now(),
        role: "tool",
        content: call.function.name,
        toolCall: JSON.stringify(call),
        toolResult: JSON.stringify(result).slice(0, 4000),
      });
    } finally { mem.close(); }
  }

  private logViolation(agentId: string, kind: string, call: ToolCallEmission): void {
    const mem = new MemoryStore(agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "policy_violation",
        reason: kind,
        metadata: JSON.stringify({ toolName: call.function.name }),
      });
    } finally { mem.close(); }
  }
}

function updatedRecord(prev: AgentRecord, snap: Snapshot): AgentRecord {
  return {
    ...prev,
    status: snap.suggestedStatus,
    peakNetWorthUsd: snap.peakNetWorthUsd,
  };
}
