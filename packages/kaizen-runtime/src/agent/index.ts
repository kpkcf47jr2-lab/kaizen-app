// ═══════════════════════════════════════════════════════════════════════
//  agent/  —  the multi-turn ReAct loop (Fase 1)
//
//  Fase 0 exports the INTERFACES so downstream callers can code against
//  the runtime today. Fase 1 fills in the bodies with the real Think →
//  Act → Observe → repeat implementation, injection defense, loop
//  detection, context trimming, and spend tracking.
// ═══════════════════════════════════════════════════════════════════════

import type { LoopRunResult, ModuleConfig, RuntimeSnapshot } from "../types.js";

export interface RunOptions {
  /** Free-form goal / prompt from the operator (owner or the heartbeat
   *  daemon). Sanitized by InjectionDefense before it reaches the LLM. */
  operatorPrompt?: string;
  /** Hard cap on tool calls this loop can make. Defaults to
   *  HARD_LIMITS.MAX_TOOL_CALLS_PER_MINUTE if omitted. */
  maxSteps?: number;
  /** Hard cap on wall-clock time (ms). Defaults to 5 min. */
  maxWallMs?: number;
  /** Hard cap on USD spent on LLM tokens in this run. Defaults to
   *  self-defined `experimentationUsd` from the budget. */
  maxCostUsd?: number;
}

export interface AgentLoop {
  run(snapshot: RuntimeSnapshot, opts: RunOptions): Promise<LoopRunResult>;
}

// The interfaces are named with the `I` prefix so the concrete Fase 1
// classes (`InjectionDefense`, `LoopDetector`, `ContextTrimmer`,
// `SpendTracker`) can keep the natural names. Callers who want to inject
// a custom implementation type against the interface.

export interface IInjectionDefense {
  /** Return a sanitized copy of the input safe to feed to the LLM. Never
   *  throws — malicious content is silently stripped or escaped and an
   *  event is written to the audit log. */
  sanitize(source: "operator" | "tool_result" | "child_message", text: string): string;
}

export interface ILoopDetector {
  /** Register a completed tool call. Returns true if the loop should
   *  abort (e.g. same tool + same args ≥ N times in a row). */
  observe(toolName: string, argsHash: string): boolean;
  reset(): void;
}

export interface IContextTrimmer {
  /** Given a raw message array + a max token count, return a trimmed
   *  array that fits the budget. Older assistant/tool turns get
   *  summarized rather than dropped so the agent keeps continuity. */
  trim<T>(messages: T[], maxTokens: number): Promise<T[]>;
}

export interface ISpendTracker {
  addLlmCall(inputTokens: number, outputTokens: number, model: string): void;
  addToolCost(usd: number, note: string): void;
  totalUsd(): number;
  reset(): void;
}

/** Fase 0 stub — throws on run() so no caller boots this by accident.
 *  Preserved for tests. Real implementation is `MultiTurnReactLoop`
 *  (Fase 1) in `./loop.js`. */
export class NotImplementedAgentLoop implements AgentLoop {
  constructor(private readonly cfg: ModuleConfig) {}
  async run(_snapshot: RuntimeSnapshot, _opts: RunOptions): Promise<LoopRunResult> {
    throw new Error(
      `[kaizen-runtime] AgentLoop.run() is unimplemented (agent=${this.cfg.agentId}). ` +
      `Use MultiTurnReactLoop from '@kaizen/runtime/agent/loop.js' instead.`,
    );
  }
}

// Re-export Fase 1 concrete implementations so callers can `import {
// MultiTurnReactLoop } from "@kaizen/runtime/agent"` without knowing the
// internal file layout.
export { MultiTurnReactLoop } from "./loop.js";
export type {
  LlmChatClient,
  LlmChatResponse,
  LlmChatUsage,
  LlmToolCall,
  LlmToolSchema,
  MultiTurnReactLoopDeps,
  RunLedger,
  ToolExecutor,
} from "./loop.js";
export { InjectionDefense } from "./injection-defense.js";
export type { RedactionEvent } from "./injection-defense.js";
export { LoopDetector, hashArgs } from "./loop-detector.js";
export type { LoopDetectorConfig } from "./loop-detector.js";
export { SpendTracker } from "./spend-tracker.js";
export { ContextTrimmer, estimateTokens } from "./context-trimmer.js";
export type { ContextTrimmerConfig, TrimmableMessage } from "./context-trimmer.js";
