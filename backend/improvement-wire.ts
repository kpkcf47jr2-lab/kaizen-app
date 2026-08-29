// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — improvement loop wiring
//
//  Adapts the runtime's OutcomeMeasurer + AutoCurator against the
//  kaizen-app SQLite MemoryStore + SecureWalletService so the ledger
//  is persistent + measurements can read real on-chain balances.
// ═══════════════════════════════════════════════════════════════════════

import type {
  MeasurementContext, OutcomeLedger, PendingMeasurement, MeasurementResult,
  CuratorLedger,
} from "@kaizen/runtime";
import type { SecureWalletService } from "./wallet/service.js";
import { MemoryStore } from "../src/memory/store.js";
import { erc20Balance, type ChainConfig } from "@kaizen/wallet-core";
import { CHAINS } from "./wallet/service.js";

// ── OutcomeLedger over MemoryStore ───────────────────────────────────

export function wireOutcomeLedger(agentId: string): OutcomeLedger {
  return {
    async schedulePending(m) {
      const mem = new MemoryStore(agentId);
      try {
        return mem.scheduleMeasurement({
          eventId: m.eventId, dueAt: m.dueAt, kind: m.kind, params: m.params,
        });
      } finally { mem.close(); }
    },
    async dueMeasurements(limit): Promise<PendingMeasurement[]> {
      const mem = new MemoryStore(agentId);
      try { return mem.duePendingMeasurements(limit) as PendingMeasurement[]; }
      finally { mem.close(); }
    },
    async completePending(id, r: MeasurementResult) {
      const mem = new MemoryStore(agentId);
      try {
        mem.completeMeasurement(id, {
          resultUsd: r.outcomeUsd,
          resultSuccess: r.success,
          error: r.error,
        });
      } finally { mem.close(); }
    },
    async writeEventOutcome(eventId, r) {
      const mem = new MemoryStore(agentId);
      try {
        mem.recordOutcome(eventId, { outcomeUsd: r.outcomeUsd, metric: r.metric, success: r.success });
      } finally { mem.close(); }
    },
  };
}

// ── MeasurementContext — reads live on-chain balance for the agent ──

/** Reads the token's balance held by THIS agent (the agent-under-measurement)
 *  and returns it in USDC-equivalent so pnl_* strategies can compute
 *  currentUsd - entryUsd. For non-stable tokens we take current on-chain
 *  balance * a mark price passed in via params.markPriceUsd if the caller
 *  gave one; otherwise 0 (safe fallback — treated as loss). */
export function wireMeasurementContext(
  agentId: string,
  wallet: SecureWalletService,
): MeasurementContext {
  return {
    agentId,
    async readEvent(_id) {
      // For now we don't need to project the raw event back to the
      // measurer — strategies self-contain via params. Return null.
      return null;
    },
    async readBalanceUsd(chainId, tokenAddress) {
      const chain = CHAINS[chainId] as ChainConfig | undefined;
      if (!chain) return 0;
      const address = await wallet.addressFor(agentId);
      const bal = await erc20Balance(chain, tokenAddress, address).catch(() => ({ formatted: 0 } as { formatted: number }));
      // If the caller passed a mark price in params we could scale it,
      // but strategies compute their own using params. Return the raw
      // human-units balance — pnl strategies expect USD-equivalent, so
      // for non-stables the caller must supply a `markPriceUsd` in the
      // measurement params and multiply. For MVP the mock returns
      // formatted units and the strategy treats them as USDC-equivalent
      // (accurate for stable → stable pairs).
      return bal.formatted;
    },
  };
}

// ── CuratorLedger over MemoryStore ────────────────────────────────────

export function wireCuratorLedger(agentId: string): CuratorLedger {
  const base = wireOutcomeLedger(agentId);
  return {
    ...base,
    async eventsWithOutcome(opts) {
      const mem = new MemoryStore(agentId);
      try {
        const rows = mem.eventsWithOutcome(opts);
        return rows.map((r) => ({
          id: r.id ?? 0,
          ts: r.ts,
          kind: r.kind,
          strategy: r.strategy ?? null,
          amountUsd: r.amountUsd ?? null,
          txHash: r.txHash ?? null,
          reason: r.reason,
          metadata: r.metadata ? (typeof r.metadata === "string" ? JSON.parse(r.metadata) as Record<string, unknown> : r.metadata) : null,
          outcomeUsd: r.outcomeUsd,
          outcomeMetric: r.outcomeMetric,
          outcomeSuccess: r.outcomeSuccess,
        }));
      } finally { mem.close(); }
    },
    async turnsAround(eventTs, windowMs = 5 * 60_000) {
      const mem = new MemoryStore(agentId);
      try {
        // Fetch a broad window of recent turns; caller filters. MemoryStore
        // doesn't yet expose a ts-window query, so we grab the latest 50
        // and filter in-process. Good enough for < 1000 events/day.
        const all = mem.recentTurns(50);
        return all
          .filter((t) => Math.abs(t.ts - eventTs) <= windowMs)
          .map((t) => ({
            ts: t.ts,
            role: t.role,
            content: t.content,
            toolCall: t.toolCall ?? null,
            toolResult: t.toolResult ?? null,
          }));
      } finally { mem.close(); }
    },
  };
}
