// Economic Brain — deterministic math tests.

import { describe, it, expect } from "vitest";
import {
  classifyStatus,
  proposeBudget,
  roiPct,
  snapshot,
  strategyScore,
} from "./economic.js";

describe("Economic Brain", () => {
  const balances = { usdc: 800, pol: 10, polUsdRate: 0.5 }; // $800 + $5 = $805
  const positions = [
    { strategy: "s1", asset: "ETH", entryUsd: 100, currentUsd: 120 },
    { strategy: "s2", asset: "MATIC", entryUsd: 50, currentUsd: 40 },
  ];
  const outflows = { outflow24hUsd: 40, outflow7dUsd: 220 };

  it("snapshot sums cash + gas + invested", () => {
    const s = snapshot("agt_x", balances, positions, outflows, 1000);
    expect(s.cashUsd).toBe(800);
    expect(s.gasReserveUsd).toBe(5);
    expect(s.investedUsd).toBe(160);
    expect(s.netWorthUsd).toBe(965);
  });

  it("tracks the rolling peak — never overwrites down", () => {
    const s = snapshot("agt_x", balances, positions, outflows, 1200);
    expect(s.peakNetWorthUsd).toBe(1200);
  });

  it("computes drawdown from peak, not from prior tick", () => {
    const s = snapshot("agt_x", balances, positions, outflows, 1000);
    // net 965, peak 1000 -> dd 3.5%
    expect(s.drawdownPct).toBeCloseTo(3.5, 1);
  });

  it("classifies HIBERNATING when net worth is dust", () => {
    const dust = snapshot(
      "agt_x",
      { usdc: 1, pol: 0, polUsdRate: 0.5 },
      [],
      { outflow24hUsd: 0, outflow7dUsd: 0 },
      100,
    );
    expect(dust.suggestedStatus).toBe("HIBERNATING");
  });

  it("classifies CRITICAL when drawdown ≥25%", () => {
    expect(classifyStatus(26, 700, 100, 600)).toBe("CRITICAL");
  });

  it("classifies DEFENSIVE at 10-24% drawdown", () => {
    expect(classifyStatus(15, 850, 200, 650)).toBe("DEFENSIVE");
  });

  it("proposeBudget in HIBERNATING keeps 100% reserve", () => {
    const b = proposeBudget(500, "HIBERNATING");
    expect(b.reserveUsd).toBe(500);
    expect(b.tradingUsd).toBe(0);
    expect(b.marketingUsd).toBe(0);
  });

  it("proposeBudget in GROWING splits sensibly and sums to net", () => {
    const b = proposeBudget(1000, "GROWING");
    const total =
      b.reserveUsd + b.tradingUsd + b.marketingUsd +
      b.productAcquisitionUsd + b.infrastructureUsd + b.experimentationUsd;
    expect(total).toBeCloseTo(1000, 1);
    expect(b.reserveUsd).toBeGreaterThan(b.tradingUsd);
  });

  it("roiPct handles gains and losses", () => {
    expect(roiPct(100, 130)).toBe(30);
    expect(roiPct(100, 80)).toBe(-20);
    expect(roiPct(0, 100)).toBe(0);
  });

  it("strategyScore rewards win rate + profit factor + low drawdown", () => {
    const good = strategyScore({
      strategy: "g", trades: 100, winRate: 0.7,
      netProfitUsd: 5000, maxDrawdownPct: 5, profitFactor: 2.5,
    });
    const bad = strategyScore({
      strategy: "b", trades: 100, winRate: 0.4,
      netProfitUsd: -500, maxDrawdownPct: 25, profitFactor: 0.6,
    });
    expect(good).toBeGreaterThan(bad);
    expect(strategyScore({ ...good as any, trades: 0 } as any)).toBe(0);
  });
});
