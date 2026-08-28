// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Reinvestment Engine (pure logic)
//
//  When a strategy closes with a positive pnl, Kaizen decides how to
//  redeploy the profit. This module is the reasoning kernel — no
//  side effects, no LLM, no I/O. The Decision Loop calls it via a
//  tool; the LLM can accept or modify (bounded by policy).
//
//  Allocation buckets:
//    winner     — capital back into the strategy that generated the pnl
//    explore    — into a *different* strategy or a fresh opportunity
//    reserve    — bumps the cash cushion (safety)
//    growth     — marketing / experimentation (compounding through demand)
//
//  Ratios shift with Survival Status:
//    GROWING / PROFITABLE → weight winner + explore (aggressive compounding)
//    STABLE               → balanced
//    DEFENSIVE            → mostly reserve, small explore
//    CRITICAL / HIBERNATING → 100% reserve, never reinvest
//
//  Strategy performance modulates the winner bucket:
//    profitFactor ≥ 1.5   → boost winner (proven engine)
//    winRate < 0.4        → dampen winner (edge decaying)
//    drawdown ≥ 20%       → skip winner entirely, redirect to reserve
// ═══════════════════════════════════════════════════════════════════════

import type { SurvivalStatus } from "../agent/registry.js";
import type { StrategyStats } from "./economic.js";

export interface ReinvestPlan {
  winnerUsd: number;
  exploreUsd: number;
  reserveUsd: number;
  growthUsd: number;
  /** Sum of the four buckets — always ≈ pnlUsd. */
  totalUsd: number;
  /** Human-readable rationale for the ledger + LLM briefing. */
  rationale: string;
}

interface Ratios {
  winner: number;
  explore: number;
  reserve: number;
  growth: number;
}

/** Base ratios by survival status. Sum to 1.0. */
const BASE_RATIOS: Record<SurvivalStatus, Ratios> = {
  GROWING:      { winner: 0.40, explore: 0.30, reserve: 0.20, growth: 0.10 },
  PROFITABLE:   { winner: 0.45, explore: 0.25, reserve: 0.20, growth: 0.10 },
  STABLE:       { winner: 0.30, explore: 0.20, reserve: 0.40, growth: 0.10 },
  DEFENSIVE:    { winner: 0.10, explore: 0.05, reserve: 0.80, growth: 0.05 },
  CRITICAL:     { winner: 0.00, explore: 0.00, reserve: 1.00, growth: 0.00 },
  HIBERNATING:  { winner: 0.00, explore: 0.00, reserve: 1.00, growth: 0.00 },
};

export interface ReinvestInput {
  pnlUsd: number;              // profit to allocate (must be > 0 to reinvest)
  status: SurvivalStatus;
  /** Optional — the closed strategy's stats. If provided, we modulate the
   *  winner bucket by profit factor / win rate / drawdown. */
  strategy?: StrategyStats;
}

/**
 * Compute a proposal. The Decision Loop hands this to the LLM; the LLM can
 * accept or emit a modified allocation via reinvest.apply. Every allocation
 * still goes through the Policy Engine before any downstream tool executes.
 */
export function proposeReinvest(input: ReinvestInput): ReinvestPlan {
  const pnl = Math.max(0, input.pnlUsd || 0);
  if (pnl <= 0) {
    return {
      winnerUsd: 0, exploreUsd: 0, reserveUsd: 0, growthUsd: 0,
      totalUsd: 0,
      rationale: "No positive pnl to reinvest.",
    };
  }

  const base = BASE_RATIOS[input.status] ?? BASE_RATIOS.STABLE;
  const ratios = modulateByStrategy(base, input.strategy);
  const notes = ratioNotes(base, ratios, input.status, input.strategy);

  const winnerUsd  = round2(pnl * ratios.winner);
  const exploreUsd = round2(pnl * ratios.explore);
  const growthUsd  = round2(pnl * ratios.growth);
  // Reserve absorbs rounding drift so buckets sum exactly to pnl.
  const reserveUsd = round2(pnl - winnerUsd - exploreUsd - growthUsd);

  return {
    winnerUsd, exploreUsd, reserveUsd, growthUsd,
    totalUsd: round2(winnerUsd + exploreUsd + reserveUsd + growthUsd),
    rationale: notes,
  };
}

/** Adjust ratios based on how the strategy has been performing. */
function modulateByStrategy(base: Ratios, s?: StrategyStats): Ratios {
  if (!s || s.trades === 0) return { ...base };
  if (base.winner === 0) return { ...base }; // DEFENSIVE and worse — don't override

  // Drawdown gate: brutal, redirect to reserve.
  if (s.maxDrawdownPct >= 20) {
    return {
      winner: 0,
      explore: base.explore * 0.5,          // half to explore, half to reserve
      reserve: base.reserve + base.winner + base.explore * 0.5,
      growth: base.growth,
    };
  }

  // Boost / dampen winner by profit factor and win rate.
  let winnerScale = 1;
  if (s.profitFactor >= 1.5) winnerScale += 0.25;
  if (s.winRate < 0.4)       winnerScale -= 0.30;
  winnerScale = clamp(winnerScale, 0.4, 1.4);

  const winner = base.winner * winnerScale;
  const delta = base.winner - winner;         // positive if we dampened
  // Redirect any delta from winner into reserve (safer default).
  return {
    winner,
    explore: base.explore,
    reserve: base.reserve + delta,
    growth: base.growth,
  };
}

function ratioNotes(
  base: Ratios,
  applied: Ratios,
  status: SurvivalStatus,
  s?: StrategyStats,
): string {
  const parts: string[] = [];
  parts.push(`Status ${status}, base allocation ${pct(base.winner)}/${pct(base.explore)}/${pct(base.reserve)}/${pct(base.growth)}.`);
  if (!s || s.trades === 0) {
    parts.push("No closed-trade stats yet, using base ratios.");
  } else {
    parts.push(`Strategy: trades=${s.trades}, winRate=${s.winRate.toFixed(2)}, PF=${s.profitFactor.toFixed(2)}, maxDD=${s.maxDrawdownPct.toFixed(1)}%.`);
    if (s.maxDrawdownPct >= 20) parts.push("Drawdown ≥20% → skip winner, redirect to reserve.");
    else if (s.profitFactor >= 1.5) parts.push("PF ≥1.5 → boost winner bucket.");
    else if (s.winRate < 0.4) parts.push("Win rate <40% → dampen winner bucket.");
  }
  parts.push(`Applied ${pct(applied.winner)} winner / ${pct(applied.explore)} explore / ${pct(applied.reserve)} reserve / ${pct(applied.growth)} growth.`);
  return parts.join(" ");
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
