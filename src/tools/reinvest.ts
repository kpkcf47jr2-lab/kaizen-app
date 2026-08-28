// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Reinvestment tools
//
//  Two tools bridge the pure Reinvest module to the agent:
//
//    reinvest.plan   L0  read-only. Given pnlUsd + strategy label,
//                        returns the proposed allocation across
//                        winner/explore/reserve/growth. The LLM
//                        inspects, decides accept or modify.
//
//    reinvest.apply  L1  records a capital_allocation event in the
//                        ledger with the chosen allocation. Does NOT
//                        move on-chain funds — the actual transfers
//                        (reserve boost, new positions) happen via
//                        wallet.transfer / trading.openPosition in
//                        subsequent tool calls, each policy-checked.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore } from "../memory/store.js";
import { proposeReinvest, type ReinvestPlan } from "../brain/reinvest.js";
import type { SurvivalStatus } from "../agent/registry.js";

// ── reinvest.plan ────────────────────────────────────────────────────
export interface PlanArgs {
  pnlUsd: number;
  status: SurvivalStatus;
  strategy?: string; // Optional strategy label — we pull its stats from memory
}
export interface PlanResult {
  plan: ReinvestPlan;
  strategyLoaded: boolean;
}

export function makeReinvestPlanTool(): RegisteredTool<PlanArgs, PlanResult> {
  const exec: ToolFn<PlanArgs, PlanResult> = async (args, ctx) => {
    let stats;
    let loaded = false;
    if (args.strategy) {
      const mem = new MemoryStore(ctx.agentId);
      try {
        const raw = mem.strategyStats(args.strategy);
        if (raw.trades > 0) {
          loaded = true;
          stats = {
            strategy: args.strategy,
            trades: raw.trades,
            winRate: raw.wins / raw.trades,
            profitFactor: raw.grossLoss > 0
              ? raw.grossProfit / raw.grossLoss
              : (raw.grossProfit > 0 ? Infinity : 0),
            netProfitUsd: raw.netProfit,
            // Memory doesn't currently store per-strategy drawdown; expose 0
            // and refine the schema later. For now the modulator can't gate
            // on drawdown unless the caller supplies it explicitly.
            maxDrawdownPct: 0,
          };
        }
      } finally { mem.close(); }
    }
    const plan = proposeReinvest({
      pnlUsd: args.pnlUsd,
      status: args.status,
      strategy: stats,
    });
    return { plan, strategyLoaded: loaded };
  };

  return {
    def: {
      name: "reinvest.plan",
      description:
        "Propose an allocation of realized pnl across four buckets " +
        "(winner / explore / reserve / growth), tuned to the current " +
        "Survival Status and the strategy's closed-trade stats. Read-only. " +
        "Call this after trading.closePosition returns pnlUsd > 0, then " +
        "either accept via reinvest.apply or override with a custom split.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        required: ["pnlUsd", "status"],
        properties: {
          pnlUsd: {
            type: "number",
            description: "Realized profit in USD, from trading.closePosition.",
          },
          status: {
            type: "string",
            enum: ["GROWING", "PROFITABLE", "STABLE", "DEFENSIVE", "CRITICAL", "HIBERNATING"],
            description: "Current Survival Status. Use the value from your snapshot.",
          },
          strategy: {
            type: "string",
            description: "Optional strategy label. Loads its stats from memory to modulate the winner bucket.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "reinvest.plan", level: PermissionLevel.READ_ONLY }),
  };
}

// ── reinvest.apply ───────────────────────────────────────────────────
export interface ApplyArgs {
  pnlUsd: number;
  strategy: string;
  winnerUsd: number;
  exploreUsd: number;
  reserveUsd: number;
  growthUsd: number;
  reason: string;
}
export interface ApplyResult {
  ok: true;
  eventId: number;
  totalUsd: number;
}

export function makeReinvestApplyTool(): RegisteredTool<ApplyArgs, ApplyResult> {
  const exec: ToolFn<ApplyArgs, ApplyResult> = async (args, ctx) => {
    const total =
      args.winnerUsd + args.exploreUsd + args.reserveUsd + args.growthUsd;

    // Sanity: buckets must not exceed pnl by more than a rounding cent.
    if (total > args.pnlUsd + 0.05) {
      throw new Error(
        `Buckets sum $${total.toFixed(2)} exceeds pnl $${args.pnlUsd.toFixed(2)}`,
      );
    }

    const mem = new MemoryStore(ctx.agentId);
    try {
      const eventId = mem.recordEvent({
        ts: Date.now(),
        kind: "capital_allocation",
        strategy: args.strategy,
        amountUsd: args.pnlUsd,
        reason: args.reason,
        metadata: JSON.stringify({
          winnerUsd: args.winnerUsd,
          exploreUsd: args.exploreUsd,
          reserveUsd: args.reserveUsd,
          growthUsd: args.growthUsd,
          totalUsd: total,
        }),
      });
      return { ok: true, eventId, totalUsd: total };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "reinvest.apply",
      description:
        "Record the chosen allocation of realized pnl into the Economic " +
        "Ledger as a capital_allocation event. This does NOT move any " +
        "funds — it's a plan that binds subsequent tool calls: use the " +
        "winnerUsd budget for trading.openPosition on the same strategy, " +
        "exploreUsd for a new one, growthUsd for kame.* / social.*, and " +
        "let reserveUsd sit in USDC. Every downstream transfer is still " +
        "policy-checked. Call this AFTER reinvest.plan and any edits you " +
        "want to make.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["pnlUsd", "strategy", "winnerUsd", "exploreUsd", "reserveUsd", "growthUsd", "reason"],
        properties: {
          pnlUsd: { type: "number", description: "Total profit being allocated." },
          strategy: { type: "string", description: "Strategy label that generated the pnl." },
          winnerUsd: { type: "number", description: "Amount going back into the same strategy." },
          exploreUsd: { type: "number", description: "Amount for a different / new opportunity." },
          reserveUsd: { type: "number", description: "Amount staying in cash reserve." },
          growthUsd: { type: "number", description: "Amount for marketing / experimentation." },
          reason: { type: "string", description: "One-line justification of the split." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "reinvest.apply", level: PermissionLevel.ZERO_COST }),
  };
}
