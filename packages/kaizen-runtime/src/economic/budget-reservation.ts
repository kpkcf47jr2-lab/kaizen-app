// ═══════════════════════════════════════════════════════════════════════
//  BudgetReservation — atomic policy-check + capital reservation
//
//  Owner directive (2026-08-30): "ReserveBudget + SpendTracker +
//  IdempotencyStore deben operar transaccionalmente. No quiero:
//    Policy check → context switch → otra operación consume presupuesto
//    → primera operación también ejecuta → excedemos limits.
//   Budget check + reservation deben ser atomic."
//
//  Design: the check and the reservation happen inside ONE SQLite
//  transaction on ONE database handle. Between reading the current
//  spend/reserved totals and inserting the new reservation row, no other
//  writer can interleave — better-sqlite3 serializes writes, and the
//  IMMEDIATE transaction takes the write lock up front.
//
//  Two-phase commit:
//    reserve(...)  → row in `reservations` with state='held'
//                    (counted against the daily cap immediately)
//    commit(id, actual)  → state='committed', actual_cost recorded
//    release(id, why)    → state='released', capital freed
//
//  A held reservation that is never committed or released is a leak. The
//  `staleHeld()` sweeper surfaces them so the caller can decide (usually:
//  verify with the provider, then either commit or release).
// ═══════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import type { EconomicStore } from "./store.js";
import {
  PolicyEngine,
  type EconomicActionRequest,
  type PolicyDecision,
  type PolicySnapshot,
} from "./policy-engine.js";

export type ReservationState = "held" | "committed" | "released";

export interface ReservationRow {
  reservation_id: string;
  decision_id: string;
  agent_id: string;
  kind: string;
  amount_usd: number;
  actual_cost_usd: number | null;
  state: ReservationState;
  created_at: number;
  updated_at: number;
  release_reason: string | null;
}

export type ReserveResult =
  | { ok: true; reservation_id: string; policy: PolicyDecision }
  | { ok: false; policy: PolicyDecision };

export interface WalletReader {
  /** Current spendable USD balance of the ops wallet. */
  readBalanceUsd(agent_id: string): Promise<number>;
}

export interface BudgetReservationConfig {
  stateDir?: string;
  dbPath?: string;
  policy?: PolicyEngine;
  /** Rolling window for the daily cap. Default 24h. */
  windowMs?: number;
}

export class BudgetReservation {
  private readonly db: import("better-sqlite3").Database;
  private readonly policy: PolicyEngine;
  private readonly windowMs: number;

  /** Gate #6: shares ONE database with the ledger + idempotency store. */
  constructor(store: EconomicStore, cfg: { policy?: PolicyEngine; windowMs?: number } = {}) {
    this.db = store.db;
    this.policy = cfg.policy || new PolicyEngine();
    this.windowMs = cfg.windowMs ?? 24 * 3600 * 1000;
  }

  /**
   * ATOMIC: read current spend + reserved, evaluate policy, and if allowed
   * insert the reservation — all inside one IMMEDIATE transaction so no
   * other caller can slip a competing reservation in between the read and
   * the write.
   *
   * `walletBalanceUsd` is passed in (not read inside the txn) because it is
   * an async network read. The caller reads it just before; the policy
   * treats it as a ceiling and the reservation math is what actually
   * prevents double-spend inside the process.
   */
  reserve(params: {
    decision_id: string;
    agent_id: string;
    request: EconomicActionRequest;
    walletBalanceUsd: number;
    concurrent_gpus?: number;
  }): ReserveResult {
    // `immediate` takes the write lock at BEGIN, not at first write — this
    // is what makes the read-then-write sequence race-free.
    const txn = this.db.transaction((p: typeof params): ReserveResult => this.reserveWithin(p));
    return txn.immediate(params);
  }

  /**
   * Same logic as reserve() but WITHOUT opening its own transaction.
   * Gate #6: the DecisionBuilder already holds an IMMEDIATE transaction on
   * the shared store, and SQLite does not support nesting one inside it.
   * Callers outside a transaction should use reserve(); callers already
   * inside store.atomic() must use this.
   */
  reserveWithin(params: {
    decision_id: string;
    agent_id: string;
    request: EconomicActionRequest;
    walletBalanceUsd: number;
    concurrent_gpus?: number;
  }): ReserveResult {
    const totals = this.totalsFor(params.agent_id);
    const snap: PolicySnapshot = {
      spent_last_24h_usd: totals.committed_usd,
      reserved_usd: totals.held_usd,
      wallet_balance_usd: params.walletBalanceUsd,
    };
    const decision = this.policy.evaluate(
      { ...params.request, concurrent_gpus: params.concurrent_gpus ?? this.activeGpuCount(params.agent_id) },
      snap,
    );
    if (!decision.allow) return { ok: false, policy: decision };

    const reservation_id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO reservations (reservation_id, decision_id, agent_id, kind, amount_usd, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'held', ?, ?)
    `).run(reservation_id, params.decision_id, params.agent_id, params.request.kind, params.request.amount_usd, now, now);
    return { ok: true, reservation_id, policy: decision };
  }

  /** Phase 2 — the money actually moved. Record what it really cost. */
  commit(reservation_id: string, actual_cost_usd: number): ReservationRow {
    const info = this.db.prepare(`
      UPDATE reservations SET state='committed', actual_cost_usd=?, updated_at=?
       WHERE reservation_id=? AND state='held'
    `).run(actual_cost_usd, Date.now(), reservation_id);
    if (info.changes === 0) {
      const row = this.get(reservation_id);
      throw new Error(`commit refused: reservation ${reservation_id} is ${row ? row.state : "missing"}, expected held`);
    }
    return this.get(reservation_id)!;
  }

  /** Phase 2 alternative — the operation did NOT happen; free the capital. */
  release(reservation_id: string, reason: string): ReservationRow {
    const info = this.db.prepare(`
      UPDATE reservations SET state='released', release_reason=?, updated_at=?
       WHERE reservation_id=? AND state='held'
    `).run(reason, Date.now(), reservation_id);
    if (info.changes === 0) {
      const row = this.get(reservation_id);
      throw new Error(`release refused: reservation ${reservation_id} is ${row ? row.state : "missing"}, expected held`);
    }
    return this.get(reservation_id)!;
  }

  /**
   * Owner requirement: "Nunca marcar budget como released mientras la
   * infraestructura siga potencialmente facturando." A reservation whose
   * infrastructure could not be confirmed stopped must be converted to a
   * committed liability (worst-case cost), NOT released.
   */
  commitAsLiability(reservation_id: string, worstCaseUsd: number, reason: string): ReservationRow {
    const info = this.db.prepare(`
      UPDATE reservations SET state='committed', actual_cost_usd=?, release_reason=?, updated_at=?
       WHERE reservation_id=? AND state='held'
    `).run(worstCaseUsd, `LIABILITY: ${reason}`, Date.now(), reservation_id);
    if (info.changes === 0) throw new Error(`commitAsLiability refused: ${reservation_id} not held`);
    return this.get(reservation_id)!;
  }

  get(reservation_id: string): ReservationRow | undefined {
    return this.db.prepare(`SELECT * FROM reservations WHERE reservation_id=?`).get(reservation_id) as ReservationRow | undefined;
  }

  /** Rolling-window totals used by the policy snapshot. */
  totalsFor(agent_id: string): { committed_usd: number; held_usd: number } {
    const since = Date.now() - this.windowMs;
    const c = this.db.prepare(`
      SELECT COALESCE(SUM(COALESCE(actual_cost_usd, amount_usd)), 0) AS s
        FROM reservations WHERE agent_id=? AND state='committed' AND updated_at >= ?
    `).get(agent_id, since) as { s: number };
    const h = this.db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS s
        FROM reservations WHERE agent_id=? AND state='held'
    `).get(agent_id) as { s: number };
    return { committed_usd: c.s, held_usd: h.s };
  }

  /** How many GPU rentals are currently held/uncommitted for this agent. */
  activeGpuCount(agent_id: string): number {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS n FROM reservations
       WHERE agent_id=? AND state='held' AND kind IN ('compute_rent','compute_extend')
    `).get(agent_id) as { n: number };
    return r.n;
  }

  /** Held reservations older than ageMs — potential leaks needing a sweep. */
  staleHeld(age_ms: number): ReservationRow[] {
    return this.db.prepare(`
      SELECT * FROM reservations WHERE state='held' AND updated_at < ? ORDER BY updated_at ASC
    `).all(Date.now() - age_ms) as ReservationRow[];
  }

}
