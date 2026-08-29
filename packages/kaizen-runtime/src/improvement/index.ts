// ═══════════════════════════════════════════════════════════════════════
//  improvement/  —  the "Kaizen loop" — continuous self-improvement
//
//  Kaizen means "continuous improvement" (改善). If the agent doesn't
//  actually learn from what it does, the name is just decoration.
//  This module closes the loop:
//
//    ACTION → OUTCOME MEASURED → LEDGER ENRICHED → DATASET CURATED
//       ↑                                                   ↓
//       └──── PROMOTED MODEL ← A/B WIN ← SHADOW ← TRAINED ──┘
//
//  Fase Improvement.1 ships: OUTCOME TRACKING (this file + tasks.ts).
//  Later fases: auto-curation (I.2), DPO (I.3), versioning (I.4),
//  auto-retrain trigger (I.5).
// ═══════════════════════════════════════════════════════════════════════

export type MeasurementKind = "pnl_1h" | "pnl_24h" | "pnl_7d" | "roas_48h" | "conversion_7d" | "custom";

/** A pending measurement: written to the ledger when a "decision worth
 *  learning from" happens (trade, campaign, allocation). The heartbeat
 *  measurement task drains these when their `dueAt` arrives. */
export interface PendingMeasurement {
  id: number;
  eventId: number;
  dueAt: number;
  kind: string;
  params: Record<string, unknown> | null;
}

/** Result written back to both the measurement row + the source event. */
export interface MeasurementResult {
  outcomeUsd: number | null;
  outcomeMetric: string;
  success: boolean | null;
  error?: string;
}

/** A single strategy for measuring outcomes. The runtime holds a
 *  registry keyed by `MeasurementKind` — the task picks the right one
 *  by inspecting the measurement row's `kind`. */
export interface MeasurementStrategy {
  kind: MeasurementKind;
  measure(m: PendingMeasurement, ctx: MeasurementContext): Promise<MeasurementResult>;
}

/** Injected context so measurement strategies can read chain state,
 *  balances, etc. without knowing where they come from. */
export interface MeasurementContext {
  agentId: string;
  /** Look up the source event by id — measurement strategies need it
   *  to know what to compare against (entry price, campaign spend, …) */
  readEvent(eventId: number): Promise<{
    id: number; ts: number; kind: string; strategy: string | null;
    amountUsd: number | null; txHash: string | null; metadata: Record<string, unknown> | null;
  } | null>;
  /** Current spot balance of a token in USDC-equivalent, so PnL strategies
   *  can compute (currentUsd - entryUsd). */
  readBalanceUsd(chainId: number, tokenAddress: string): Promise<number>;
  /** External fetch surface — some strategies need to call analytics APIs. */
  fetch?: typeof fetch;
}

/** Adapter over the ledger + measurement queue — Fase Improvement.1
 *  keeps this in-memory + backend/backend wires it to the SQLite store. */
export interface OutcomeLedger {
  schedulePending(m: { eventId: number; dueAt: number; kind: MeasurementKind; params?: Record<string, unknown> }): Promise<number>;
  dueMeasurements(limit?: number): Promise<PendingMeasurement[]>;
  completePending(id: number, r: MeasurementResult): Promise<void>;
  writeEventOutcome(eventId: number, r: { outcomeUsd: number; metric: string; success: boolean }): Promise<void>;
}

// ── The orchestrator ─────────────────────────────────────────────────

export class OutcomeMeasurer {
  private readonly strategies = new Map<string, MeasurementStrategy>();

  constructor(private readonly ledger: OutcomeLedger, private readonly ctx: MeasurementContext) {}

  register(strategy: MeasurementStrategy): void {
    this.strategies.set(strategy.kind, strategy);
  }

  /** One pass: fetch pending measurements up to `limit`, run each,
   *  write result. Returns how many were processed. */
  async tick(limit = 25): Promise<{ processed: number; failed: number }> {
    const pending = await this.ledger.dueMeasurements(limit);
    let processed = 0;
    let failed = 0;
    for (const m of pending) {
      const strat = this.strategies.get(m.kind);
      if (!strat) {
        await this.ledger.completePending(m.id, {
          outcomeUsd: null, outcomeMetric: m.kind, success: null,
          error: `no measurement strategy registered for kind=${m.kind}`,
        });
        failed++;
        continue;
      }
      try {
        const r = await strat.measure(m, this.ctx);
        await this.ledger.completePending(m.id, r);
        if (r.outcomeUsd !== null && r.success !== null) {
          await this.ledger.writeEventOutcome(m.eventId, {
            outcomeUsd: r.outcomeUsd, metric: r.outcomeMetric, success: r.success,
          });
        }
        // A soft-error return (error field set + nulls) counts as failed.
        // Throw and soft-return are equivalent from the loop's POV.
        if (r.error) failed++; else processed++;
      } catch (e) {
        await this.ledger.completePending(m.id, {
          outcomeUsd: null, outcomeMetric: m.kind, success: null,
          error: (e as Error).message,
        });
        failed++;
      }
    }
    return { processed, failed };
  }

  /** Convenience: schedule the standard cascade for a trade — pnl at
   *  1h, 24h, 7d. Pick shorter horizons for micro-trades. */
  async scheduleTradeCascade(eventId: number, entryUsd: number, tokenAddress: string, chainId: number, decimals: number): Promise<number[]> {
    const now = Date.now();
    const params = { entryUsd, tokenAddress, chainId, decimals };
    const ids = await Promise.all([
      this.ledger.schedulePending({ eventId, dueAt: now + 3600_000,    kind: "pnl_1h", params }),
      this.ledger.schedulePending({ eventId, dueAt: now + 86400_000,   kind: "pnl_24h", params }),
      this.ledger.schedulePending({ eventId, dueAt: now + 7 * 86400_000, kind: "pnl_7d", params }),
    ]);
    return ids;
  }
}

// ── Built-in strategies ──────────────────────────────────────────────

/** PnL at time T: (currentBalanceUsd - entryUsd). `success` iff > 0. */
export function makePnlStrategy(kind: "pnl_1h" | "pnl_24h" | "pnl_7d"): MeasurementStrategy {
  return {
    kind,
    async measure(m, ctx) {
      const params = m.params ?? {};
      const entryUsd = Number(params.entryUsd ?? 0);
      const tokenAddress = String(params.tokenAddress ?? "");
      const chainId = Number(params.chainId ?? 0);
      if (!entryUsd || !tokenAddress || !chainId) {
        return { outcomeUsd: null, outcomeMetric: kind, success: null,
          error: "pnl strategy needs {entryUsd, tokenAddress, chainId} in params" };
      }
      const currentUsd = await ctx.readBalanceUsd(chainId, tokenAddress);
      const pnl = currentUsd - entryUsd;
      return { outcomeUsd: pnl, outcomeMetric: kind, success: pnl > 0 };
    },
  };
}

// Improvement.2 auto-curation exports
export { AutoCurator, type CurationExample, type PreferencePair, type CuratorConfig, type CuratorLedger } from "./curator.js";

/** ROAS at time T: (revenueUsd / spendUsd). `success` iff > minRoas. */
export function makeRoasStrategy(kind: "roas_48h", opts: { minRoas: number; readRevenueUsd: (campaignId: string) => Promise<number> }): MeasurementStrategy {
  return {
    kind,
    async measure(m) {
      const params = m.params ?? {};
      const spendUsd = Number(params.spendUsd ?? 0);
      const campaignId = String(params.campaignId ?? "");
      if (!spendUsd || !campaignId) {
        return { outcomeUsd: null, outcomeMetric: kind, success: null,
          error: "roas strategy needs {spendUsd, campaignId} in params" };
      }
      const revenue = await opts.readRevenueUsd(campaignId);
      const roas = spendUsd > 0 ? revenue / spendUsd : 0;
      return { outcomeUsd: revenue - spendUsd, outcomeMetric: kind, success: roas >= opts.minRoas };
    },
  };
}
