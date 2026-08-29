import { describe, it, expect } from "vitest";
import {
  OutcomeMeasurer,
  makePnlStrategy,
  makeRoasStrategy,
  type MeasurementContext,
  type OutcomeLedger,
  type PendingMeasurement,
  type MeasurementResult,
} from "../improvement/index.js";

// ── Fake ledger + context for tests ──────────────────────────────────

function fakeLedger(): OutcomeLedger & {
  scheduled: Array<{ eventId: number; dueAt: number; kind: string; params?: Record<string, unknown> }>;
  completions: Array<{ id: number; result: MeasurementResult }>;
  eventOutcomes: Array<{ eventId: number; outcomeUsd: number; metric: string; success: boolean }>;
  pending: PendingMeasurement[];
} {
  const scheduled: Array<{ eventId: number; dueAt: number; kind: string; params?: Record<string, unknown> }> = [];
  const completions: Array<{ id: number; result: MeasurementResult }> = [];
  const eventOutcomes: Array<{ eventId: number; outcomeUsd: number; metric: string; success: boolean }> = [];
  const pending: PendingMeasurement[] = [];
  return {
    scheduled, completions, eventOutcomes, pending,
    async schedulePending(m) {
      const id = scheduled.length + 1;
      scheduled.push(m);
      pending.push({ id, eventId: m.eventId, dueAt: m.dueAt, kind: m.kind, params: m.params ?? null });
      return id;
    },
    async dueMeasurements(_limit) {
      const now = Date.now();
      return pending.filter((p) => p.dueAt <= now);
    },
    async completePending(id, r) {
      completions.push({ id, result: r });
      const idx = pending.findIndex((p) => p.id === id);
      if (idx >= 0) pending.splice(idx, 1);
    },
    async writeEventOutcome(eventId, r) {
      eventOutcomes.push({ eventId, ...r });
    },
  };
}

function fakeCtx(balances: Record<string, number>): MeasurementContext {
  return {
    agentId: "agt_test",
    async readEvent() { return null; },
    async readBalanceUsd(chainId, addr) {
      return balances[`${chainId}:${addr.toLowerCase()}`] ?? 0;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("OutcomeMeasurer", () => {
  it("no pending → no work", async () => {
    const ledger = fakeLedger();
    const m = new OutcomeMeasurer(ledger, fakeCtx({}));
    const r = await m.tick();
    expect(r).toEqual({ processed: 0, failed: 0 });
  });

  it("PnL win: current > entry → success=true, outcome > 0", async () => {
    const ledger = fakeLedger();
    // Simulate: entry $10, current $15 → +$5 win.
    ledger.pending.push({
      id: 1, eventId: 42, dueAt: Date.now() - 1000, kind: "pnl_1h",
      params: { entryUsd: 10, tokenAddress: "0xWETH", chainId: 8453 },
    });
    const ctx = fakeCtx({ "8453:0xweth": 15 });
    const m = new OutcomeMeasurer(ledger, ctx);
    m.register(makePnlStrategy("pnl_1h"));
    const r = await m.tick();
    expect(r).toEqual({ processed: 1, failed: 0 });
    expect(ledger.completions[0]!.result.outcomeUsd).toBe(5);
    expect(ledger.completions[0]!.result.success).toBe(true);
    expect(ledger.eventOutcomes[0]).toEqual({ eventId: 42, outcomeUsd: 5, metric: "pnl_1h", success: true });
  });

  it("PnL loss: current < entry → success=false, outcome < 0", async () => {
    const ledger = fakeLedger();
    ledger.pending.push({
      id: 2, eventId: 99, dueAt: Date.now() - 1000, kind: "pnl_24h",
      params: { entryUsd: 100, tokenAddress: "0xTOK", chainId: 8453 },
    });
    const m = new OutcomeMeasurer(ledger, fakeCtx({ "8453:0xtok": 75 }));
    m.register(makePnlStrategy("pnl_24h"));
    await m.tick();
    expect(ledger.eventOutcomes[0]!.success).toBe(false);
    expect(ledger.eventOutcomes[0]!.outcomeUsd).toBe(-25);
  });

  it("unknown kind → failure recorded, no event outcome written", async () => {
    const ledger = fakeLedger();
    ledger.pending.push({ id: 3, eventId: 1, dueAt: Date.now() - 1000, kind: "unknown_metric", params: {} });
    const m = new OutcomeMeasurer(ledger, fakeCtx({}));
    const r = await m.tick();
    expect(r).toEqual({ processed: 0, failed: 1 });
    expect(ledger.completions[0]!.result.error).toMatch(/no measurement strategy/);
    expect(ledger.eventOutcomes).toHaveLength(0);
  });

  it("strategy throw → failure recorded", async () => {
    const ledger = fakeLedger();
    ledger.pending.push({
      id: 4, eventId: 1, dueAt: Date.now() - 1000, kind: "pnl_1h",
      params: {},   // missing required entryUsd/tokenAddress/chainId
    });
    const m = new OutcomeMeasurer(ledger, fakeCtx({}));
    m.register(makePnlStrategy("pnl_1h"));
    const r = await m.tick();
    expect(r.failed).toBe(1);
    expect(ledger.completions[0]!.result.error).toMatch(/pnl strategy needs/);
  });

  it("scheduleTradeCascade queues 3 measurements at 1h/24h/7d", async () => {
    const ledger = fakeLedger();
    const m = new OutcomeMeasurer(ledger, fakeCtx({}));
    const ids = await m.scheduleTradeCascade(50, 10, "0xTOK", 8453, 18);
    expect(ids).toHaveLength(3);
    expect(ledger.scheduled.map((s) => s.kind)).toEqual(["pnl_1h", "pnl_24h", "pnl_7d"]);
    // dueAt is roughly now + Nh
    const now = Date.now();
    expect(ledger.scheduled[0]!.dueAt - now).toBeGreaterThan(3_500_000);       // ~1h
    expect(ledger.scheduled[2]!.dueAt - now).toBeGreaterThan(6 * 86400_000);    // ~7d
  });

  it("ROAS strategy: revenue/spend >= minRoas → success", async () => {
    const ledger = fakeLedger();
    ledger.pending.push({
      id: 5, eventId: 7, dueAt: Date.now() - 1000, kind: "roas_48h",
      params: { spendUsd: 10, campaignId: "camp-1" },
    });
    const m = new OutcomeMeasurer(ledger, fakeCtx({}));
    m.register(makeRoasStrategy("roas_48h", { minRoas: 1.5, async readRevenueUsd() { return 20; } }));
    await m.tick();
    expect(ledger.eventOutcomes[0]!.success).toBe(true);   // ROAS = 2.0 >= 1.5
    expect(ledger.eventOutcomes[0]!.outcomeUsd).toBe(10);   // net profit
  });

  it("ROAS below minRoas → success=false", async () => {
    const ledger = fakeLedger();
    ledger.pending.push({
      id: 6, eventId: 8, dueAt: Date.now() - 1000, kind: "roas_48h",
      params: { spendUsd: 10, campaignId: "camp-2" },
    });
    const m = new OutcomeMeasurer(ledger, fakeCtx({}));
    m.register(makeRoasStrategy("roas_48h", { minRoas: 1.5, async readRevenueUsd() { return 12; } }));
    await m.tick();
    expect(ledger.eventOutcomes[0]!.success).toBe(false);  // ROAS = 1.2 < 1.5
  });
});
