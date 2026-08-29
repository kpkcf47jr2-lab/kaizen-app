// ═══════════════════════════════════════════════════════════════════════
//  MultiTurnReactLoop — Think → Act → Observe → repeat
//
//  Replaces the existing kaizen-app DecisionLoop (1 tool per HTTP call)
//  with a real ReAct loop that keeps going until the LLM decides `done`
//  or one of the caps is hit (max steps / max wall time / max cost /
//  loop detected / kill switch).
//
//  Deliberately depends on INTERFACES (LlmChatClient, ToolExecutor,
//  RunLedger), not on concrete kaizen-app modules — so the runtime can
//  be unit-tested with fakes and wired to production in Fase 7.
// ═══════════════════════════════════════════════════════════════════════

import type {
  LoopRunResult,
  LoopStepResult,
  ModuleConfig,
  RuntimeSnapshot,
} from "../types.js";
import type { AgentLoop, RunOptions } from "./index.js";
import { InjectionDefense } from "./injection-defense.js";
import { LoopDetector, hashArgs } from "./loop-detector.js";
import { SpendTracker } from "./spend-tracker.js";
import { ContextTrimmer, type TrimmableMessage } from "./context-trimmer.js";

// ── LLM contract ──────────────────────────────────────────────────────

export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmChatUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmChatResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage: LlmChatUsage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
}

export interface LlmChatClient {
  chat(params: {
    messages: TrimmableMessage[];
    tools: LlmToolSchema[];
    toolChoice: "auto" | "required" | "none";
    maxTokens?: number;
  }): Promise<LlmChatResponse>;
}

// ── Tool executor contract ────────────────────────────────────────────

export interface ToolExecutor {
  /** List of tool schemas the LLM may call this run. */
  schemas(): LlmToolSchema[];
  /** Execute a tool call. Throws if the tool is unknown or the policy
   *  engine rejects it. The runtime turns thrown errors into
   *  observations the LLM can see next turn — errors are learning material. */
  execute(agentId: string, call: LlmToolCall): Promise<unknown>;
  /** Optional per-tool USD cost (surfaced by the tool wrapper if known). */
  lastCallCostUsd?: number;
}

// ── Ledger contract (persist turns + events between steps) ────────────

export interface RunLedger {
  recordTurn(agentId: string, msg: TrimmableMessage): Promise<void>;
  recordAbort(agentId: string, reason: string, meta?: Record<string, unknown>): Promise<void>;
}

// ── System prompt builder ─────────────────────────────────────────────

function buildSystemPrompt(snapshot: RuntimeSnapshot): TrimmableMessage {
  return {
    role: "system",
    content: [
      "You are Kaizen, an autonomous entrepreneur AI built by Kaizen LLC.",
      "",
      "Your rules of engagement:",
      "1. Reason step by step before acting. Never invent facts.",
      "2. Call tools when action is needed; never simulate a tool call in prose.",
      "3. Every action passes through the Policy Engine. If a call is rejected,",
      "   do not blindly retry — read the rejection reason and adapt.",
      "4. USDC is the primary user-facing stablecoin. Never treat USDK as one.",
      "5. Casino / Predict are OFF in US jurisdiction. Do not open positions there.",
      "6. Prefer conservative sizing early: this may be seed capital.",
      "7. When you have completed the operator's request OR you are waiting on",
      "   an external event, respond with a short natural-language summary",
      "   and no tool calls — that signals `done` and ends this run.",
      "",
      "Current state:",
      `  netWorth:  $${snapshot.netWorthUsd.toFixed(4)}`,
      `  cash:      $${snapshot.cashUsd.toFixed(4)}`,
      `  gas:       $${snapshot.gasReserveUsd.toFixed(4)}`,
      `  drawdown:  ${snapshot.drawdownPct.toFixed(2)}%`,
      `  tier:      ${snapshot.tier}`,
      `  children:  ${snapshot.activeChildren}`,
    ].join("\n"),
  };
}

// ── The loop ──────────────────────────────────────────────────────────

export interface MultiTurnReactLoopDeps {
  llm: LlmChatClient;
  tools: ToolExecutor;
  ledger: RunLedger;
  injection?: InjectionDefense;
  detector?: LoopDetector;
  trimmer?: ContextTrimmer;
  spend?: SpendTracker;
  /** Read the kill switch env var. Isolated so tests can inject a fake. */
  killSwitch?: () => boolean;
  /** Max message tokens before ContextTrimmer kicks in. Default 16k. */
  maxContextTokens?: number;
}

export class MultiTurnReactLoop implements AgentLoop {
  private readonly injection: InjectionDefense;
  private readonly detector: LoopDetector;
  private readonly trimmer: ContextTrimmer;
  private readonly spend: SpendTracker;
  private readonly killSwitch: () => boolean;
  private readonly maxContextTokens: number;

  constructor(
    private readonly cfg: ModuleConfig,
    private readonly deps: MultiTurnReactLoopDeps,
  ) {
    this.injection = deps.injection ?? new InjectionDefense();
    this.detector = deps.detector ?? new LoopDetector();
    this.trimmer = deps.trimmer ?? new ContextTrimmer();
    this.spend = deps.spend ?? new SpendTracker();
    this.killSwitch = deps.killSwitch ?? (() => process.env[cfg.killSwitchEnv] === "1");
    this.maxContextTokens = deps.maxContextTokens ?? 16_000;
  }

  async run(snapshot: RuntimeSnapshot, opts: RunOptions): Promise<LoopRunResult> {
    const startedAt = Date.now();
    const maxSteps = opts.maxSteps ?? 20;
    const maxWallMs = opts.maxWallMs ?? 5 * 60 * 1000;
    const maxCostUsd = opts.maxCostUsd ?? 0.50;
    const steps: LoopStepResult[] = [];

    // Reset stateful helpers so a leaky prior run can't influence this one.
    this.injection.reset();
    this.detector.reset();
    this.spend.reset();

    // Kill switch: refuse to start at all.
    if (this.killSwitch()) {
      const reason = "kill_switch_active";
      await this.deps.ledger.recordAbort(this.cfg.agentId, reason);
      return this.finish(snapshot, startedAt, steps, reason);
    }

    // Build initial message array
    const messages: TrimmableMessage[] = [buildSystemPrompt(snapshot)];
    if (opts.operatorPrompt) {
      messages.push({
        role: "user",
        content: this.injection.sanitize("operator", opts.operatorPrompt),
      });
      await this.deps.ledger.recordTurn(this.cfg.agentId, messages[messages.length - 1]!);
    }

    // Main loop
    for (let step = 0; step < maxSteps; step++) {
      // Cap checks BEFORE calling the LLM (cheaper to abort here).
      if (Date.now() - startedAt >= maxWallMs) {
        return this.abort(snapshot, startedAt, steps, "max_wall_ms_exceeded");
      }
      if (this.spend.totalUsd() >= maxCostUsd) {
        return this.abort(snapshot, startedAt, steps, `max_cost_exceeded ($${this.spend.totalUsd().toFixed(4)} of $${maxCostUsd})`);
      }
      if (this.killSwitch()) {
        return this.abort(snapshot, startedAt, steps, "kill_switch_active_midrun");
      }

      // Trim if needed
      const trimmed = await this.trimmer.trim(messages, this.maxContextTokens);
      // Only replace the array if trim actually happened — otherwise we
      // lose the tool_calls/tool_call_id metadata on the objects.
      const forLlm = trimmed.length < messages.length ? trimmed : messages;

      // Ask the LLM
      const t0 = Date.now();
      let resp: LlmChatResponse;
      try {
        resp = await this.deps.llm.chat({
          messages: forLlm,
          tools: this.deps.tools.schemas(),
          // Force tool_choice=required on the first hop so the LLM commits
          // to a plan; auto after that so it can decide "done" naturally.
          toolChoice: step === 0 ? "required" : "auto",
        });
      } catch (e) {
        return this.abort(snapshot, startedAt, steps, `llm_error: ${(e as Error).message}`);
      }
      const llmMs = Date.now() - t0;
      this.spend.addLlmCall(resp.usage.inputTokens, resp.usage.outputTokens, resp.usage.model);

      // Persist the assistant turn
      const assistantMsg: TrimmableMessage = {
        role: "assistant",
        content: resp.content,
        tool_calls: resp.toolCalls.length > 0 ? resp.toolCalls : undefined,
      };
      messages.push(assistantMsg);
      await this.deps.ledger.recordTurn(this.cfg.agentId, assistantMsg);

      // No tool calls → the LLM is done. Record the message and exit.
      if (resp.toolCalls.length === 0) {
        steps.push({
          step,
          kind: "assistant_message",
          reason: resp.content ?? "(empty)",
          elapsedMs: llmMs,
        });
        return this.finish(snapshot, startedAt, steps, "done");
      }

      // Execute EACH tool call in this batch (some models emit multiple).
      // If any aborts (loop detected, kill switch), bail out immediately.
      for (const call of resp.toolCalls) {
        const argsHash = hashArgs(call.arguments);
        if (this.detector.observe(call.name, argsHash)) {
          const reason = this.detector.lastAbortReason ?? "loop_detected";
          steps.push({ step, kind: "aborted", reason, elapsedMs: 0, toolName: call.name, toolArgs: call.arguments });
          return this.abort(snapshot, startedAt, steps, reason);
        }

        const t1 = Date.now();
        let result: unknown;
        let ok = true;
        try {
          result = await this.deps.tools.execute(this.cfg.agentId, call);
        } catch (e) {
          ok = false;
          result = { error: (e as Error).message };
        }
        const toolMs = Date.now() - t1;
        const toolCostUsd = this.deps.tools.lastCallCostUsd;
        if (typeof toolCostUsd === "number") this.spend.addToolCost(toolCostUsd, call.name);

        steps.push({
          step,
          kind: "tool_call",
          toolName: call.name,
          toolArgs: call.arguments,
          toolResult: result,
          elapsedMs: toolMs,
          costUsd: toolCostUsd,
        });

        // Push tool result as an untrusted-source message. sanitize() wraps
        // it in a "treat as DATA" envelope so the LLM doesn't role-confuse.
        const rendered = typeof result === "string" ? result : JSON.stringify(result);
        const toolMsg: TrimmableMessage = {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: this.injection.sanitize("tool_result", rendered),
        };
        messages.push(toolMsg);
        await this.deps.ledger.recordTurn(this.cfg.agentId, toolMsg);

        // If the tool blew up hard AND it was the only call this hop, let
        // the LLM see the error and decide what to do next hop — that's
        // learning behavior, not a fatal loop failure.
        void ok;
      }
    }

    return this.abort(snapshot, startedAt, steps, `max_steps_exceeded (${maxSteps})`);
  }

  private abort(
    snapshot: RuntimeSnapshot,
    startedAt: number,
    steps: LoopStepResult[],
    reason: string,
  ): LoopRunResult {
    void this.deps.ledger.recordAbort(this.cfg.agentId, reason);
    return this.finish(snapshot, startedAt, steps, reason);
  }

  private finish(
    snapshot: RuntimeSnapshot,
    startedAt: number,
    steps: LoopStepResult[],
    reason: string,
  ): LoopRunResult {
    return {
      agentId: this.cfg.agentId,
      startedAt,
      endedAt: Date.now(),
      steps,
      finalTier: snapshot.tier,
      totalCostUsd: this.spend.totalUsd(),
      abortReason: reason === "done" ? undefined : reason,
    };
  }
}
