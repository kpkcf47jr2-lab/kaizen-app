// ═══════════════════════════════════════════════════════════════════════
//  Runtime-wide types shared across every module.
// ═══════════════════════════════════════════════════════════════════════

/** Survival tier — same taxonomy as the existing kaizen-app snapshot but
 *  the runtime exposes it as a first-class value that determines model
 *  choice, heartbeat cadence, and which tools can even be considered. */
export type SurvivalTier = "STABLE" | "DEFENSIVE" | "CRITICAL" | "HIBERNATING";

/** Compact snapshot the runtime passes around instead of the fatter
 *  Snapshot from src/brain/economic.ts. Enough to make loop decisions
 *  without pulling the full record every hop. */
export interface RuntimeSnapshot {
  agentId: string;
  ts: number;
  netWorthUsd: number;
  cashUsd: number;
  gasReserveUsd: number;
  drawdownPct: number;
  tier: SurvivalTier;
  activeChildren: number;
}

/** Result of one iteration of the multi-turn loop. */
export interface LoopStepResult {
  step: number;
  kind: "tool_call" | "assistant_message" | "done" | "aborted";
  reason?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  elapsedMs: number;
  costUsd?: number;
}

/** Aggregate result of a full loop run (from start to `done`/abort). */
export interface LoopRunResult {
  agentId: string;
  startedAt: number;
  endedAt: number;
  steps: LoopStepResult[];
  finalTier: SurvivalTier;
  totalCostUsd: number;
  abortReason?: string;
}

/** Contract every module exports so the runtime can enumerate + boot them. */
export interface RuntimeModule {
  name: string;
  version: string;
  /** Called once at runtime start. Idempotent — safe to call after a hot
   *  reload of the module without duplicating side effects. */
  init?(): Promise<void>;
  /** Called on graceful shutdown. Must finish in-flight work + release
   *  external handles (RPC providers, DB connections, cron timers). */
  shutdown?(): Promise<void>;
}

/** Where a module reads its config from. Keeps configs isolated so a
 *  self-mod that rewrites one module's config can't leak into another. */
export interface ModuleConfig {
  readonly agentId: string;
  readonly runtimeVersion: string;
  readonly readOnly: boolean;         // dry-run mode
  readonly killSwitchEnv: string;     // usually "KAIZEN_KILL"
}
