// ═══════════════════════════════════════════════════════════════════════
//  Built-in heartbeat tasks
//
//  Category convention: <category>:<name>.
//  Categories used by the tier-cadence table: survival, health, trading,
//  marketing, experimentation, commerce.
//
//  Survival tasks always run (they're what keep the agent alive at all).
//  Everything else is skippable per tier.
// ═══════════════════════════════════════════════════════════════════════

import type { HeartbeatTask, OwnerNotifier } from "./index.js";
import type { RunOptions } from "../agent/index.js";
import type { MultiTurnReactLoop } from "../agent/loop.js";

// ── survival:health-check ────────────────────────────────────────────
export function makeHealthCheckTask(opts: {
  minIntervalMs?: number;
  ping: () => Promise<{ ok: boolean; latencyMs: number; note?: string }>;
  notifier: OwnerNotifier;
}): HeartbeatTask {
  return {
    name: "survival:health-check",
    minIntervalMs: opts.minIntervalMs ?? 60_000,
    async run(ctx) {
      const res = await opts.ping().catch((e) => ({ ok: false, latencyMs: -1, note: (e as Error).message }));
      if (!res.ok) {
        await opts.notifier.notify(
          "urgent",
          "backend health check FAILED",
          `Agent ${ctx.agentId} — ping returned not-ok. ${res.note ?? ""}`,
          { agentId: ctx.agentId, category: "health" },
        );
      } else if (res.latencyMs > 5_000) {
        await opts.notifier.notify(
          "banner",
          "backend health check slow",
          `Agent ${ctx.agentId} — ping ok but ${res.latencyMs}ms`,
          { agentId: ctx.agentId, category: "health" },
        );
      }
    },
  };
}

// ── survival:credit-monitor ─────────────────────────────────────────
// Watches net worth and drawdown. If either crosses the alert thresholds
// (drawdown ≥25% or netWorth < minReserveUsd), notifies the owner. In
// HIBERNATING it emits an escalated funding request.
export function makeCreditMonitorTask(opts: {
  minIntervalMs?: number;
  minReserveUsd: number;                 // e.g. 2.0 — below this we're in trouble
  notifier: OwnerNotifier;
}): HeartbeatTask {
  return {
    name: "survival:credit-monitor",
    minIntervalMs: opts.minIntervalMs ?? 5 * 60_000,
    async run(ctx) {
      const { snapshot } = ctx;
      if (snapshot.tier === "HIBERNATING") {
        await opts.notifier.notify(
          "urgent",
          "agent HIBERNATING — funding request",
          `Agent ${ctx.agentId}: netWorth $${snapshot.netWorthUsd.toFixed(4)}, ` +
          `drawdown ${snapshot.drawdownPct.toFixed(1)}%. All costly ops paused. ` +
          `Top up USDC to ${ctx.agentId}'s wallet to resume.`,
          { agentId: ctx.agentId, category: "survival" },
        );
        return;
      }
      if (snapshot.tier === "CRITICAL") {
        await opts.notifier.notify(
          "banner",
          "agent CRITICAL — approaching hibernation",
          `Agent ${ctx.agentId}: drawdown ${snapshot.drawdownPct.toFixed(1)}% ` +
          `(hibernate threshold 40%). Reduce exposure or top up.`,
          { agentId: ctx.agentId, category: "survival" },
        );
        return;
      }
      if (snapshot.cashUsd < opts.minReserveUsd) {
        await opts.notifier.notify(
          "banner",
          "agent cash reserve low",
          `Agent ${ctx.agentId}: cash $${snapshot.cashUsd.toFixed(4)} < ` +
          `reserve floor $${opts.minReserveUsd}.`,
          { agentId: ctx.agentId, category: "survival" },
        );
      }
    },
  };
}

// ── trading:autonomous-tick ─────────────────────────────────────────
// The task that actually MOVES the agent forward — runs one full
// MultiTurnReactLoop each firing. The daemon's tier-cadence controls
// how often this fires (30s in STABLE, 3min in CRITICAL, 15min in
// HIBERNATING — where it's also skipped by the `trading` category
// filter, so it stops firing entirely).
export function makeAutonomousTickTask(opts: {
  minIntervalMs?: number;
  loop: MultiTurnReactLoop;
  operatorPrompt?: string;
  runOptions?: Omit<RunOptions, "operatorPrompt">;
}): HeartbeatTask {
  return {
    name: "trading:autonomous-tick",
    minIntervalMs: opts.minIntervalMs ?? 30_000,
    // Belt-and-braces: even if the tier-cadence category filter is
    // misconfigured, still refuse to run in HIBERNATING.
    tiers: ["STABLE", "DEFENSIVE", "CRITICAL"],
    async run(ctx) {
      await opts.loop.run(ctx.snapshot, {
        operatorPrompt: opts.operatorPrompt,
        ...opts.runOptions,
      });
    },
  };
}
