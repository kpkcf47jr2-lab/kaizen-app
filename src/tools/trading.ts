// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Trading tools
//
//  A trade is an OPEN position (buy) + eventually a CLOSE (sell back)
//  tracked in the memory store's `positions` table. These tools give
//  the LLM the ability to reason over open positions and to
//  open/close them explicitly — the swap execution itself still goes
//  through wallet.transfer via the Secure Wallet Service (and the
//  Policy Engine caps every leg).
//
//  MVP semantics (single-strategy, single-chain):
//   - "buy" = swap USDC → target token via Kairos Router. Recorded as
//     a position (strategy, entryUsd, sellToken=USDC, buyToken=target).
//   - "sell" = swap target token → USDC. Closes the position with
//     realized pnl.
//   - Kaizen picks the strategy label ("eth-momentum",
//     "arbitrage-vela-quickswap", etc). The label is what the
//     Strategy Score aggregates on.
//
//  For MVP, `trading.openPosition` records intent + entry price but
//  does NOT execute the swap itself — the LLM must follow up with a
//  wallet.transfer or exchange.swap tool call in a subsequent tick.
//  This keeps the workflow inspectable in the event ledger.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore, type Position } from "../memory/store.js";

// ── trading.setExitRules ─────────────────────────────────────────────
export interface SetExitRulesArgs {
  positionId: number;
  takeProfitPct?: number | null;   // close if roi ≥ +N%
  stopLossPct?: number | null;     // close if roi ≤ -N% (positive number, magnitude)
  trailingStopPct?: number | null; // close if drop from peak ≥ N%
}
export interface SetExitRulesResult {
  ok: true;
  positionId: number;
  rules: {
    takeProfitPct: number | null;
    stopLossPct: number | null;
    trailingStopPct: number | null;
  };
}

export function makeSetExitRulesTool(): RegisteredTool<SetExitRulesArgs, SetExitRulesResult> {
  const exec: ToolFn<SetExitRulesArgs, SetExitRulesResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const open = mem.openPositions().find((p) => p.id === args.positionId);
      if (!open) throw new Error(`Position ${args.positionId} not found or already closed`);
      mem.setExitRules(args.positionId, {
        takeProfitPct: args.takeProfitPct ?? null,
        stopLossPct: args.stopLossPct ?? null,
        trailingStopPct: args.trailingStopPct ?? null,
        highWatermarkUsd: null,
      });
      return {
        ok: true,
        positionId: args.positionId,
        rules: {
          takeProfitPct: args.takeProfitPct ?? null,
          stopLossPct: args.stopLossPct ?? null,
          trailingStopPct: args.trailingStopPct ?? null,
        },
      };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "trading.setExitRules",
      description:
        "Attach automatic exit rules to an open position — take-profit, " +
        "stop-loss, trailing stop. The AutoTickScheduler evaluates these " +
        "on every poll against current mark. When a rule triggers, the " +
        "position is auto-closed without needing another LLM tick. Set " +
        "at least one of the three; leave others null. Values are " +
        "percentages (e.g. takeProfitPct=10 = close at +10% ROI, " +
        "stopLossPct=5 = close at -5% ROI, trailingStopPct=3 = close if " +
        "position drops 3% from its peak).",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["positionId"],
        properties: {
          positionId: { type: "number", description: "positions.id from trading.openPosition" },
          takeProfitPct: { type: "number", description: "Close if ROI ≥ +N%. null to disable." },
          stopLossPct: { type: "number", description: "Close if ROI ≤ -N% (positive magnitude). null to disable." },
          trailingStopPct: { type: "number", description: "Close if drop from peak ≥ N%. null to disable." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "trading.setExitRules", level: PermissionLevel.ZERO_COST }),
  };
}

// ── trading.openPosition ─────────────────────────────────────────────
export interface OpenPositionArgs {
  strategy: string;
  buyToken: string;
  entryUsd: number;
  reason: string;
}

export interface OpenPositionResult {
  ok: true;
  positionId: number;
  strategy: string;
  entryUsd: number;
}

export function makeOpenPositionTool(): RegisteredTool<OpenPositionArgs, OpenPositionResult> {
  const exec: ToolFn<OpenPositionArgs, OpenPositionResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const id = mem.openPosition({
        openedTs: Date.now(),
        strategy: args.strategy,
        chainId: 137,
        sellToken: "USDC",
        buyToken: args.buyToken,
        entryUsd: args.entryUsd,
        reasonOpen: args.reason,
      });
      mem.recordEvent({
        ts: Date.now(),
        kind: "trade_open",
        strategy: args.strategy,
        amountUsd: args.entryUsd,
        reason: args.reason,
        metadata: JSON.stringify({ positionId: id, buyToken: args.buyToken }),
      });
      return { ok: true, positionId: id, strategy: args.strategy, entryUsd: args.entryUsd };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "trading.openPosition",
      description:
        "Record intent to open a trading position (USDC → target token) under a " +
        "named strategy. Records to the positions table and emits a trade_open " +
        "event. Follow up in a subsequent tick with exchange.quote + " +
        "wallet.transfer to actually execute. Use this to keep the strategy " +
        "book of record separate from wallet mechanics.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["strategy", "buyToken", "entryUsd", "reason"],
        properties: {
          strategy: {
            type: "string",
            description:
              "Strategy label — used to aggregate stats. Pick a stable name and " +
              "reuse it across positions (e.g. 'eth-momentum', 'arb-quickswap').",
          },
          buyToken: {
            type: "string",
            description: "ERC-20 address of the token you're buying with USDC.",
          },
          entryUsd: {
            type: "number",
            description: "USDC amount you plan to commit. Must fit within self-defined trading budget.",
          },
          reason: {
            type: "string",
            description: "Short thesis — recorded in the ledger + attached to the position.",
          },
        },
      },
    },
    exec,
    toIntent: (a, _ctx) => ({
      tool: "trading.openPosition",
      level: PermissionLevel.FINANCIAL,
      valueUsd: a.entryUsd,
      metadata: { strategyExposureUsd: a.entryUsd },
    }),
  };
}

// ── trading.closePosition ────────────────────────────────────────────
export interface ClosePositionArgs {
  positionId: number;
  exitUsd: number;
  reason: string;
  closeTx?: string;
}

export interface ClosePositionResult {
  ok: true;
  positionId: number;
  entryUsd: number;
  exitUsd: number;
  pnlUsd: number;
  roiPct: number;
}

export function makeClosePositionTool(): RegisteredTool<ClosePositionArgs, ClosePositionResult> {
  const exec: ToolFn<ClosePositionArgs, ClosePositionResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const open = mem.openPositions().find((p) => p.id === args.positionId);
      if (!open) throw new Error(`Position ${args.positionId} not found or already closed`);

      const pnl = args.exitUsd - open.entryUsd;
      const roi = open.entryUsd > 0 ? (pnl / open.entryUsd) * 100 : 0;

      mem.closePosition(args.positionId, {
        closedTs: Date.now(),
        exitUsd: args.exitUsd,
        pnlUsd: pnl,
        closeTx: args.closeTx,
        reasonClose: args.reason,
      });

      mem.recordEvent({
        ts: Date.now(),
        kind: "trade_close",
        strategy: open.strategy,
        amountUsd: pnl,
        txHash: args.closeTx ?? null,
        reason: args.reason,
        outcome: pnl >= 0 ? "win" : "loss",
        metadata: JSON.stringify({
          positionId: args.positionId,
          entryUsd: open.entryUsd,
          exitUsd: args.exitUsd,
          roiPct: roi,
        }),
      });

      return {
        ok: true,
        positionId: args.positionId,
        entryUsd: open.entryUsd,
        exitUsd: args.exitUsd,
        pnlUsd: pnl,
        roiPct: roi,
      };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "trading.closePosition",
      description:
        "Close an open position. Computes realized PnL, updates the positions " +
        "table, and emits a trade_close event. Call this AFTER the sell-side " +
        "wallet.transfer has confirmed on-chain and you know the actual USDC " +
        "you received.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["positionId", "exitUsd", "reason"],
        properties: {
          positionId: {
            type: "number",
            description: "positions.id from trading.getPositions or the open event's metadata.",
          },
          exitUsd: {
            type: "number",
            description: "USDC actually received on the sell side. Use the on-chain amount, not a quote.",
          },
          reason: {
            type: "string",
            description: "Why you closed — stop-loss, target hit, thesis invalidated.",
          },
          closeTx: {
            type: "string",
            description: "Optional close tx hash for audit.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({
      tool: "trading.closePosition",
      level: PermissionLevel.FINANCIAL,
      // Closing is neutral for outflow accounting (money flowing back in).
      valueUsd: 0,
    }),
  };
}

// ── trading.getPositions ─────────────────────────────────────────────
export interface GetPositionsArgs {
  strategy?: string;
}
export interface GetPositionsResult {
  open: Position[];
  strategyStats: Record<string, { trades: number; winRate: number; profitFactor: number; netProfit: number }>;
}

export function makeGetPositionsTool(): RegisteredTool<GetPositionsArgs, GetPositionsResult> {
  const exec: ToolFn<GetPositionsArgs, GetPositionsResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const open = mem.openPositions(args.strategy);
      const strategies = new Set(open.map((p) => p.strategy));
      // Also compute stats for closed positions of the requested strategy(ies)
      const stats: GetPositionsResult["strategyStats"] = {};
      const targets = args.strategy ? [args.strategy] : Array.from(strategies);
      for (const s of targets) {
        const st = mem.strategyStats(s);
        stats[s] = {
          trades: st.trades,
          winRate: st.trades > 0 ? st.wins / st.trades : 0,
          profitFactor: st.grossLoss > 0 ? st.grossProfit / st.grossLoss : (st.grossProfit > 0 ? Infinity : 0),
          netProfit: st.netProfit,
        };
      }
      return { open, strategyStats: stats };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "trading.getPositions",
      description:
        "List open positions and, per strategy, aggregate closed-trade stats " +
        "(trade count, win rate, profit factor, net profit). Use this before " +
        "deciding whether to scale a strategy up, down, or kill it.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          strategy: {
            type: "string",
            description: "Optional: filter to one strategy label.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "trading.getPositions", level: PermissionLevel.READ_ONLY }),
  };
}
