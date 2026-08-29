// ═══════════════════════════════════════════════════════════════════════
//  HeartbeatDaemon — cron between agent ticks
//
//  The daemon is a plain setInterval that on every wake:
//    1. Reads the current SurvivalTier (via snapshotFn injected at ctor)
//    2. Selects the tier policy (interval + skip-categories + spawn ok)
//    3. Runs every registered task whose category is NOT skipped AND
//       whose per-task minIntervalMs has elapsed since its last run
//    4. Adjusts its own next-wake interval to the tier's intervalMs
//
//  Deliberately unopinionated about WHAT tasks do — tasks are pure
//  functions of (snapshot, notifier, enqueue). The autonomous-tick task
//  (which drives the MultiTurnReactLoop) is registered by the caller,
//  not baked in.
// ═══════════════════════════════════════════════════════════════════════

import type { HeartbeatDaemon, HeartbeatTask, HeartbeatTaskContext, OwnerNotifier } from "./index.js";
import type { ModuleConfig, RuntimeSnapshot } from "../types.js";
import { policyFor, type TierPolicy } from "./tier-cadence.js";
import { ConsoleOwnerNotifier } from "./notifier.js";

/** Function the daemon calls on each wake to learn the agent's current
 *  runtime snapshot. Injected so tests can drive tier transitions and so
 *  the runtime doesn't have to know how to compute a snapshot. */
export type SnapshotProvider = () => Promise<RuntimeSnapshot>;

export interface RealHeartbeatDaemonDeps {
  snapshotProvider: SnapshotProvider;
  notifier?: OwnerNotifier;
  /** Custom overrides for the tier-cadence table. Merged with defaults. */
  tierOverrides?: Parameters<typeof policyFor>[1];
  /** Escape hatch for tests — inject a fake clock. */
  now?: () => number;
}

interface Enqueued {
  task: HeartbeatTask;
  runAfterMs: number;
}

export class RealHeartbeatDaemon implements HeartbeatDaemon {
  private readonly tasks: HeartbeatTask[] = [];
  private readonly lastRunAt = new Map<string, number>();
  private readonly queue: Enqueued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly notifier: OwnerNotifier;
  private readonly now: () => number;

  constructor(
    private readonly cfg: ModuleConfig,
    private readonly deps: RealHeartbeatDaemonDeps,
  ) {
    this.notifier = deps.notifier ?? new ConsoleOwnerNotifier(cfg.agentId);
    this.now = deps.now ?? (() => Date.now());
  }

  register(task: HeartbeatTask): void {
    if (this.tasks.some((t) => t.name === task.name)) {
      throw new Error(`Duplicate heartbeat task name: ${task.name}`);
    }
    this.tasks.push(task);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.tickOnce();       // fire immediately so start isn't lazy
    this.scheduleNext(30_000);   // conservative first fallback wake
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async tickOnce(): Promise<void> {
    // Note: tickOnce always runs — it's the entry point for tests and the
    // owner CLI. Only scheduleNext() checks the stopped flag so a stopped
    // daemon doesn't re-arm its own timer after a manual tick.
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = await this.deps.snapshotProvider();
    } catch (e) {
      // If we can't even read the snapshot, don't run any task — a task
      // running on stale/absent state is worse than one that skipped.
      await this.notifier.notify("banner", "heartbeat: snapshot failed",
        `Skipping this tick — snapshotProvider threw: ${(e as Error).message}`,
        { agentId: this.cfg.agentId, category: "heartbeat" });
      return;
    }

    const policy = policyFor(snapshot.tier, this.deps.tierOverrides);
    const nowMs = this.now();

    // Drain the ad-hoc queue first
    const readyFromQueue: HeartbeatTask[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      if (q.runAfterMs <= nowMs) {
        readyFromQueue.push(q.task);
        this.queue.splice(i, 1);
      }
    }

    // Assemble the run list from registered tasks + queue
    const eligible: HeartbeatTask[] = [];
    for (const task of this.tasks) {
      if (this.shouldRun(task, snapshot, policy, nowMs)) eligible.push(task);
    }
    eligible.push(...readyFromQueue);

    // Run them (sequential — the whole point is to not overload the LLM)
    for (const task of eligible) {
      const ctx: HeartbeatTaskContext = {
        agentId: this.cfg.agentId,
        snapshot,
        enqueue: (t, delayMs) => {
          this.queue.push({ task: t, runAfterMs: this.now() + delayMs });
        },
      };
      try {
        await task.run(ctx);
        this.lastRunAt.set(task.name, this.now());
      } catch (e) {
        await this.notifier.notify("banner", `heartbeat: task '${task.name}' failed`,
          (e as Error).message, { agentId: this.cfg.agentId, category: "heartbeat" });
        // Even a failed run counts against the rate limit so a broken
        // task doesn't spin the daemon into a hot loop.
        this.lastRunAt.set(task.name, this.now());
      }
    }

    // Only re-arm if we're an actively running daemon (start() was called).
    if (!this.stopped) this.scheduleNext(policy.intervalMs);
  }

  private shouldRun(
    task: HeartbeatTask,
    snapshot: RuntimeSnapshot,
    policy: TierPolicy,
    nowMs: number,
  ): boolean {
    // Tier filter — task must run in this tier
    if (task.tiers && task.tiers.length > 0 && !task.tiers.includes(snapshot.tier)) return false;
    // Skip categories from tier policy (task name convention: category:name).
    const [cat] = task.name.split(":");
    if (cat && policy.skipCategories.includes(cat)) return false;
    // Rate-limit by task's own minIntervalMs. A task that has never run
    // yet always runs on the next eligible tick (regardless of interval)
    // — otherwise a large minIntervalMs blocks the first run forever.
    const last = this.lastRunAt.get(task.name);
    if (last === undefined) return true;
    return nowMs - last >= task.minIntervalMs;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tickOnce(); }, delayMs);
    // Node timers hold the event loop open — for a long-running daemon
    // that IS what we want. If we ever want the process to exit cleanly
    // while the daemon is idle, call this.timer.unref() here.
  }

  /** Introspection for the owner dashboard / tests. */
  status(): {
    running: boolean;
    tasksRegistered: number;
    queueSize: number;
    lastRun: Record<string, number>;
  } {
    return {
      running: !this.stopped,
      tasksRegistered: this.tasks.length,
      queueSize: this.queue.length,
      lastRun: Object.fromEntries(this.lastRunAt),
    };
  }
}
