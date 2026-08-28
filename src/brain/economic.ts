// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Economic Brain
//
//  Pure calculation: net_worth, budget allocation, ROI, drawdown, risk.
//  Reads current balances + open positions, produces a snapshot the
//  Decision Engine feeds to the LLM and the Policy Engine consumes.
//
//  No LLM here. This is the ledger part of the brain. Deterministic,
//  100% testable.
// ═══════════════════════════════════════════════════════════════════════

import type { SurvivalStatus } from "../agent/registry.js";
import { HARD_LIMITS } from "../policy/limits.js";

export interface Balances {
  usdc: number;            // liquid cash
  pol: number;             // native for gas
  polUsdRate: number;      // 1 POL = ? USD, from price feed
}

export interface Position {
  strategy: string;        // e.g. "eth-momentum"
  asset: string;           // symbol
  entryUsd: number;        // cost basis
  currentUsd: number;      // current mark
}

export interface StrategyStats {
  strategy: string;
  trades: number;
  winRate: number;         // 0-1
  netProfitUsd: number;
  maxDrawdownPct: number;
  profitFactor: number;    // gross_profit / gross_loss
}

/** Deterministic snapshot the rest of the system operates on. */
export interface Snapshot {
  agentId: string;
  ts: number;
  netWorthUsd: number;
  cashUsd: number;
  gasReserveUsd: number;
  investedUsd: number;
  outflow24hUsd: number;
  outflow7dUsd: number;
  peakNetWorthUsd: number;
  drawdownPct: number;
  suggestedStatus: SurvivalStatus;
  /** Split of net worth by category, for the dashboard. */
  breakdown: {
    cash: number;
    invested: number;
    gas: number;
  };
}

export interface RollingOutflows {
  outflow24hUsd: number;
  outflow7dUsd: number;
}

/**
 * Compute a full snapshot. Called on every agent tick.
 */
export function snapshot(
  agentId: string,
  balances: Balances,
  positions: Position[],
  outflows: RollingOutflows,
  peakNetWorthUsd: number,
): Snapshot {
  const cash = balances.usdc;
  const gas = balances.pol * balances.polUsdRate;
  const invested = positions.reduce((s, p) => s + p.currentUsd, 0);
  const net = cash + gas + invested;
  const peak = Math.max(peakNetWorthUsd, net);
  const dd = peak > 0 ? ((peak - net) / peak) * 100 : 0;

  return {
    agentId,
    ts: Date.now(),
    netWorthUsd: net,
    cashUsd: cash,
    gasReserveUsd: gas,
    investedUsd: invested,
    outflow24hUsd: outflows.outflow24hUsd,
    outflow7dUsd: outflows.outflow7dUsd,
    peakNetWorthUsd: peak,
    drawdownPct: dd,
    suggestedStatus: classifyStatus(dd, net, invested, cash),
    breakdown: { cash, invested, gas },
  };
}

/**
 * Map drawdown + balance sheet to Survival Economy status. The Policy
 * Engine uses this to decide what the agent is allowed to do.
 */
export function classifyStatus(
  drawdownPct: number,
  netWorthUsd: number,
  investedUsd: number,
  cashUsd: number,
): SurvivalStatus {
  if (netWorthUsd < 5) return "HIBERNATING";
  if (drawdownPct >= HARD_LIMITS.HIBERNATE_DRAWDOWN_PCT) return "HIBERNATING";
  if (drawdownPct >= HARD_LIMITS.CRITICAL_DRAWDOWN_PCT) return "CRITICAL";
  if (drawdownPct >= HARD_LIMITS.DEFENSIVE_DRAWDOWN_PCT) return "DEFENSIVE";
  const cashRatio = netWorthUsd > 0 ? cashUsd / netWorthUsd : 0;
  if (investedUsd === 0 && cashRatio >= 0.5) return "STABLE";
  if (cashRatio < 0.15) return "PROFITABLE";
  return "GROWING";
}

/**
 * Suggest a budget allocation from current net worth.
 * Ratios are heuristic starting points; the agent (via LLM) can propose
 * different splits but the Policy Engine caps everything anyway.
 */
export interface BudgetProposal {
  reserveUsd: number;
  tradingUsd: number;
  marketingUsd: number;
  productAcquisitionUsd: number;
  infrastructureUsd: number;
  experimentationUsd: number;
}

export function proposeBudget(net: number, status: SurvivalStatus): BudgetProposal {
  // Fractions vary by survival status. Defensive = conserve cash.
  const ratios = {
    GROWING:      { reserve: 0.40, trading: 0.20, marketing: 0.15, product: 0.10, infra: 0.08, exper: 0.07 },
    PROFITABLE:   { reserve: 0.30, trading: 0.25, marketing: 0.20, product: 0.10, infra: 0.08, exper: 0.07 },
    STABLE:       { reserve: 0.50, trading: 0.20, marketing: 0.10, product: 0.10, infra: 0.05, exper: 0.05 },
    DEFENSIVE:    { reserve: 0.70, trading: 0.15, marketing: 0.05, product: 0.05, infra: 0.05, exper: 0.00 },
    CRITICAL:     { reserve: 0.90, trading: 0.00, marketing: 0.00, product: 0.00, infra: 0.10, exper: 0.00 },
    HIBERNATING:  { reserve: 1.00, trading: 0.00, marketing: 0.00, product: 0.00, infra: 0.00, exper: 0.00 },
  }[status];

  return {
    reserveUsd:            round2(net * ratios.reserve),
    tradingUsd:            round2(net * ratios.trading),
    marketingUsd:          round2(net * ratios.marketing),
    productAcquisitionUsd: round2(net * ratios.product),
    infrastructureUsd:     round2(net * ratios.infra),
    experimentationUsd:    round2(net * ratios.exper),
  };
}

/** ROI for a closed trade. Positive = profit. */
export function roiPct(entryUsd: number, exitUsd: number): number {
  if (entryUsd <= 0) return 0;
  return ((exitUsd - entryUsd) / entryUsd) * 100;
}

/** Strategy composite score. Higher = better. */
export function strategyScore(s: StrategyStats): number {
  if (s.trades === 0) return 0;
  const winFactor = s.winRate;                       // 0-1
  const pf = Math.min(s.profitFactor, 3) / 3;        // capped at 3 → 1
  const dd = 1 - Math.min(s.maxDrawdownPct, 30) / 30; // low dd = high
  return winFactor * 0.35 + pf * 0.45 + dd * 0.2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
