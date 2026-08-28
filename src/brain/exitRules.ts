// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Position exit rule evaluator (pure logic)
//
//  Given a position's entry, current mark, and its exit rules, returns
//  whether the position should be closed and why. The AutoTickScheduler
//  evaluates every open position every poll and closes ones that hit a
//  rule — no LLM required, no gas beyond the close swap itself.
//
//  Supported rules:
//    - takeProfitPct    close if roi ≥ +N%
//    - stopLossPct      close if roi ≤ -N%   (pct passed as positive number)
//    - trailingStopPct  close if drop from peak ≥ N%
//
//  Rules are ORed — first hit wins. Precedence: takeProfit > stopLoss > trailing.
// ═══════════════════════════════════════════════════════════════════════

export interface ExitRules {
  takeProfitPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  highWatermarkUsd: number | null;
}

export interface ExitDecision {
  shouldClose: boolean;
  reason: string;
  triggered: "take_profit" | "stop_loss" | "trailing_stop" | null;
  /** New high watermark to persist if the current mark set a fresh peak. */
  newHighWatermark: number | null;
}

export function evaluateExit(
  entryUsd: number,
  currentUsd: number,
  rules: ExitRules,
): ExitDecision {
  if (!(entryUsd > 0)) {
    return { shouldClose: false, reason: "no entry", triggered: null, newHighWatermark: null };
  }

  const roiPct = ((currentUsd - entryUsd) / entryUsd) * 100;

  // 1. Take profit
  if (rules.takeProfitPct != null && roiPct >= rules.takeProfitPct) {
    return {
      shouldClose: true,
      reason: `Take-profit hit: ROI ${roiPct.toFixed(2)}% ≥ +${rules.takeProfitPct}%`,
      triggered: "take_profit",
      newHighWatermark: null,
    };
  }

  // 2. Stop loss
  if (rules.stopLossPct != null && roiPct <= -Math.abs(rules.stopLossPct)) {
    return {
      shouldClose: true,
      reason: `Stop-loss hit: ROI ${roiPct.toFixed(2)}% ≤ -${Math.abs(rules.stopLossPct)}%`,
      triggered: "stop_loss",
      newHighWatermark: null,
    };
  }

  // 3. Trailing stop — always maintain the watermark so it moves up
  const peak = rules.highWatermarkUsd != null
    ? Math.max(rules.highWatermarkUsd, currentUsd)
    : currentUsd;
  const newHighWatermark = peak > (rules.highWatermarkUsd ?? -Infinity) ? peak : null;

  if (rules.trailingStopPct != null && peak > entryUsd) {
    const dropPct = ((peak - currentUsd) / peak) * 100;
    if (dropPct >= rules.trailingStopPct) {
      return {
        shouldClose: true,
        reason:
          `Trailing stop hit: dropped ${dropPct.toFixed(2)}% from peak $${peak.toFixed(2)} ` +
          `(threshold ${rules.trailingStopPct}%)`,
        triggered: "trailing_stop",
        newHighWatermark,
      };
    }
  }

  return {
    shouldClose: false,
    reason: `ROI ${roiPct.toFixed(2)}%, no rule triggered`,
    triggered: null,
    newHighWatermark,
  };
}
