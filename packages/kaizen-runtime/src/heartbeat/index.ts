// ═══════════════════════════════════════════════════════════════════════
//  heartbeat/  —  continuous daemon between agent ticks (Fase 2)
//
//  The heartbeat runs on the host (not inside the agent loop), keeps the
//  agent alive when no HTTP request comes in, and escalates funding
//  requests as the survival tier degrades.
// ═══════════════════════════════════════════════════════════════════════

import type { ModuleConfig, RuntimeSnapshot, SurvivalTier } from "../types.js";

export interface HeartbeatTaskContext {
  agentId: string;
  snapshot: RuntimeSnapshot;
  /** Insert a follow-up task into the daemon's queue. Used e.g. by the
   *  credit monitor to schedule a re-check after a funding attempt. */
  enqueue(task: HeartbeatTask, delayMs: number): void;
}

export interface HeartbeatTask {
  name: string;
  /** Which survival tiers this task should run in. Empty = all tiers. */
  tiers?: SurvivalTier[];
  /** Cron-like cadence (minimum interval between runs of this task). */
  minIntervalMs: number;
  run(ctx: HeartbeatTaskContext): Promise<void>;
}

export interface HeartbeatDaemon {
  register(task: HeartbeatTask): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** For tests + owner CLI: run one iteration immediately. */
  tickOnce(): Promise<void>;
}

export interface OwnerNotifier {
  /** Escalation levels: silent (dashboard flag only) → dashboard-visible
   *  banner → out-of-band (email/telegram). Runtime picks the level
   *  based on survival tier at emit-time. */
  notify(
    level: "silent" | "banner" | "urgent",
    subject: string,
    body: string,
    opts?: { agentId?: string; category?: string },
  ): Promise<void>;
}

/** Fase 0 stub — no-op daemon so callers can inject it without booting.
 *  Real implementation: RealHeartbeatDaemon from './daemon.js'. */
export class NoopHeartbeatDaemon implements HeartbeatDaemon {
  private readonly tasks: HeartbeatTask[] = [];
  constructor(private readonly cfg: ModuleConfig) {}
  register(task: HeartbeatTask): void { this.tasks.push(task); }
  async start(): Promise<void> { /* no-op — use RealHeartbeatDaemon */ }
  async stop(): Promise<void> { /* nothing to release */ }
  async tickOnce(): Promise<void> {
    console.warn(
      `[kaizen-runtime] NoopHeartbeatDaemon.tickOnce() called with ${this.tasks.length} registered tasks ` +
      `(agent=${this.cfg.agentId}). Use RealHeartbeatDaemon instead.`,
    );
  }
}

// Fase 2 concrete exports
export { RealHeartbeatDaemon, type RealHeartbeatDaemonDeps, type SnapshotProvider } from "./daemon.js";
export { ConsoleOwnerNotifier, type IOwnerNotifier, type NotifyLevel, type OwnerNotification } from "./notifier.js";
// C.4 real out-of-band notifier
export { TelegramOwnerNotifier, type TelegramNotifierConfig } from "./telegram-notifier.js";
export {
  DEFAULT_TIER_POLICY,
  policyFor,
  type TierPolicy,
} from "./tier-cadence.js";
export {
  makeHealthCheckTask,
  makeCreditMonitorTask,
  makeAutonomousTickTask,
} from "./tasks.js";
