import { describe, it, expect } from "vitest";
import { proposeReinvest } from "./reinvest.js";

describe("Reinvestment Engine", () => {
  it("returns zero-buckets when pnl is not positive", () => {
    const p = proposeReinvest({ pnlUsd: 0, status: "GROWING" });
    expect(p.totalUsd).toBe(0);
    expect(p.rationale).toMatch(/no positive pnl/i);
  });

  it("HIBERNATING sends 100% to reserve", () => {
    const p = proposeReinvest({ pnlUsd: 200, status: "HIBERNATING" });
    expect(p.reserveUsd).toBe(200);
    expect(p.winnerUsd + p.exploreUsd + p.growthUsd).toBe(0);
  });

  it("CRITICAL sends 100% to reserve", () => {
    const p = proposeReinvest({ pnlUsd: 100, status: "CRITICAL" });
    expect(p.reserveUsd).toBe(100);
  });

  it("GROWING splits 40/30/20/10 with no strategy stats", () => {
    const p = proposeReinvest({ pnlUsd: 1000, status: "GROWING" });
    expect(p.winnerUsd).toBeCloseTo(400, 0);
    expect(p.exploreUsd).toBeCloseTo(300, 0);
    expect(p.reserveUsd).toBeCloseTo(200, 0);
    expect(p.growthUsd).toBeCloseTo(100, 0);
    expect(p.totalUsd).toBeCloseTo(1000, 0);
  });

  it("boosts winner when profit factor ≥ 1.5", () => {
    const stats = {
      strategy: "eth-mom", trades: 20, winRate: 0.6,
      profitFactor: 2.0, maxDrawdownPct: 5, netProfitUsd: 500,
    };
    const p = proposeReinvest({ pnlUsd: 100, status: "GROWING", strategy: stats });
    // Base winner 40, boost 1.25 → 50 → clamp/round.
    expect(p.winnerUsd).toBeGreaterThan(40);
    expect(p.rationale).toMatch(/boost winner/i);
  });

  it("dampens winner when win rate < 40%", () => {
    const stats = {
      strategy: "eth-mom", trades: 20, winRate: 0.30,
      profitFactor: 0.9, maxDrawdownPct: 8, netProfitUsd: -50,
    };
    const p = proposeReinvest({ pnlUsd: 100, status: "GROWING", strategy: stats });
    // Base 40 * 0.7 = 28 → still > 0 but < 40.
    expect(p.winnerUsd).toBeLessThan(40);
    expect(p.winnerUsd).toBeGreaterThan(0);
    expect(p.rationale).toMatch(/dampen winner/i);
  });

  it("skips winner entirely when drawdown ≥ 20%", () => {
    const stats = {
      strategy: "brutal", trades: 50, winRate: 0.55,
      profitFactor: 1.2, maxDrawdownPct: 25, netProfitUsd: 100,
    };
    const p = proposeReinvest({ pnlUsd: 100, status: "GROWING", strategy: stats });
    expect(p.winnerUsd).toBe(0);
    expect(p.rationale).toMatch(/skip winner/i);
  });

  it("buckets always sum to pnl (no rounding leak)", () => {
    const cases = [7.77, 123.45, 1000, 33.33, 0.99];
    for (const pnl of cases) {
      const p = proposeReinvest({ pnlUsd: pnl, status: "PROFITABLE" });
      expect(p.totalUsd).toBeCloseTo(pnl, 2);
    }
  });

  it("DEFENSIVE prioritizes reserve heavily", () => {
    const p = proposeReinvest({ pnlUsd: 100, status: "DEFENSIVE" });
    expect(p.reserveUsd).toBeGreaterThan(60);
    expect(p.winnerUsd).toBeLessThan(15);
  });
});
