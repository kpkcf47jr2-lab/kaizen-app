import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RealHeartbeatDaemon,
  ConsoleOwnerNotifier,
  policyFor,
  DEFAULT_TIER_POLICY,
  makeHealthCheckTask,
  makeCreditMonitorTask,
} from "../heartbeat/index.js";
import type { HeartbeatTask } from "../heartbeat/index.js";
import type { ModuleConfig, RuntimeSnapshot, SurvivalTier } from "../types.js";

const cfg: ModuleConfig = {
  agentId: "agt_hb",
  runtimeVersion: "0.1.0-alpha.0",
  readOnly: true,
  killSwitchEnv: "KAIZEN_KILL_HB",
};

function makeSnap(tier: SurvivalTier, over?: Partial<RuntimeSnapshot>): RuntimeSnapshot {
  return {
    agentId: "agt_hb", ts: Date.now(),
    netWorthUsd: 10, cashUsd: 8, gasReserveUsd: 2, drawdownPct: 0,
    tier, activeChildren: 0, ...over,
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("tier-cadence", () => {
  it("has policies for every survival tier", () => {
    expect(DEFAULT_TIER_POLICY.STABLE.intervalMs).toBeLessThan(DEFAULT_TIER_POLICY.HIBERNATING.intervalMs);
    expect(DEFAULT_TIER_POLICY.HIBERNATING.allowSpawn).toBe(false);
    expect(DEFAULT_TIER_POLICY.HIBERNATING.skipCategories).toContain("trading");
    expect(DEFAULT_TIER_POLICY.STABLE.skipCategories).toEqual([]);
  });

  it("policyFor merges overrides", () => {
    const p = policyFor("STABLE", { STABLE: { intervalMs: 5_000 } });
    expect(p.intervalMs).toBe(5_000);
    expect(p.llmModel).toBe(DEFAULT_TIER_POLICY.STABLE.llmModel);
  });
});

describe("ConsoleOwnerNotifier", () => {
  it("stores notifications and dedupes within cooldown", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const n = new ConsoleOwnerNotifier("agt_hb");
    await n.notify("banner", "same", "body");
    await n.notify("banner", "same", "body");   // suppressed by cooldown
    expect(n.recent(60 * 60_000)).toHaveLength(1);
    spy.mockRestore();
  });

  it("logs three distinct subjects independently", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const n = new ConsoleOwnerNotifier("agt_hb");
    await n.notify("silent", "a", "x");
    await n.notify("silent", "b", "x");
    await n.notify("silent", "c", "x");
    expect(n.recent(60_000)).toHaveLength(3);
    spy.mockRestore();
  });
});

describe("RealHeartbeatDaemon", () => {
  it("runs registered tasks whose category is not skipped by the tier", async () => {
    const runs: string[] = [];
    const task1: HeartbeatTask = {
      name: "survival:always-runs", minIntervalMs: 0,
      async run() { runs.push("survival"); },
    };
    const task2: HeartbeatTask = {
      name: "trading:only-in-stable", minIntervalMs: 0,
      async run() { runs.push("trading"); },
    };

    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("HIBERNATING"),
    });
    daemon.register(task1);
    daemon.register(task2);

    await daemon.tickOnce();
    expect(runs).toEqual(["survival"]);           // trading skipped in HIBERNATING
    await daemon.stop();
  });

  it("runs all tasks in STABLE tier", async () => {
    const runs: string[] = [];
    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("STABLE"),
    });
    daemon.register({ name: "survival:x", minIntervalMs: 0, async run() { runs.push("x"); } });
    daemon.register({ name: "trading:y", minIntervalMs: 0, async run() { runs.push("y"); } });
    daemon.register({ name: "marketing:z", minIntervalMs: 0, async run() { runs.push("z"); } });

    await daemon.tickOnce();
    expect(runs.sort()).toEqual(["x", "y", "z"]);
    await daemon.stop();
  });

  it("honors per-task minIntervalMs (does not re-run inside window)", async () => {
    let runs = 0;
    let clock = 0;
    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("STABLE"),
      now: () => clock,
    });
    daemon.register({
      name: "survival:cool", minIntervalMs: 60_000,
      async run() { runs++; },
    });

    await daemon.tickOnce();          // runs=1
    clock += 10_000;
    await daemon.tickOnce();          // still within 60s → skip
    expect(runs).toBe(1);
    clock += 60_000;
    await daemon.tickOnce();          // window passed → runs
    expect(runs).toBe(2);
    await daemon.stop();
  });

  it("swallows task errors and notifies the owner", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = new ConsoleOwnerNotifier("agt_hb");
    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("STABLE"),
      notifier,
    });
    daemon.register({
      name: "survival:bomb", minIntervalMs: 0,
      async run() { throw new Error("boom"); },
    });

    await expect(daemon.tickOnce()).resolves.toBeUndefined();
    const notes = notifier.recent(60_000);
    expect(notes.some((n) => /task 'survival:bomb' failed/.test(n.subject))).toBe(true);
    await daemon.stop();
    spy.mockRestore();
  });

  it("credit-monitor fires urgent notif in HIBERNATING", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = new ConsoleOwnerNotifier("agt_hb");
    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("HIBERNATING", { drawdownPct: 55, netWorthUsd: 3 }),
      notifier,
    });
    daemon.register(makeCreditMonitorTask({ minReserveUsd: 2, notifier }));

    await daemon.tickOnce();
    const urgent = notifier.recent(60_000).find((n) => n.level === "urgent");
    expect(urgent).toBeDefined();
    expect(urgent!.subject).toMatch(/HIBERNATING/);
    await daemon.stop();
    spy.mockRestore();
  });

  it("health-check fires banner when ping is slow", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = new ConsoleOwnerNotifier("agt_hb");
    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("STABLE"),
      notifier,
    });
    daemon.register(makeHealthCheckTask({
      notifier,
      async ping() { return { ok: true, latencyMs: 6_000 }; },
    }));

    await daemon.tickOnce();
    expect(notifier.recent(60_000).some((n) => /slow/.test(n.subject))).toBe(true);
    await daemon.stop();
    spy.mockRestore();
  });

  it("status() returns introspection data", async () => {
    const daemon = new RealHeartbeatDaemon(cfg, {
      snapshotProvider: async () => makeSnap("STABLE"),
    });
    daemon.register({ name: "survival:a", minIntervalMs: 0, async run() {} });
    daemon.register({ name: "survival:b", minIntervalMs: 0, async run() {} });
    await daemon.tickOnce();
    const s = daemon.status();
    expect(s.tasksRegistered).toBe(2);
    expect(Object.keys(s.lastRun).length).toBe(2);
    await daemon.stop();
  });
});
