// ═══════════════════════════════════════════════════════════════════════
//  CircuitBreaker — stop repeating an economic action that keeps failing
//
//  Owner directive (2026-08-30): the heartbeat needs "circuit breaker;
//  exponential backoff; global kill switch" so a broken provider can't be
//  hammered into a runaway bill or a rate-limit ban.
//
//  Per-key state machine:
//     closed   → normal, calls allowed
//     open     → too many consecutive failures; calls REFUSED until
//                cooldown expires
//     half_open→ cooldown elapsed; ONE probe call allowed. Success closes
//                the circuit, failure re-opens it with a longer cooldown.
//
//  Cooldown grows exponentially per consecutive open: base * 2^(opens-1),
//  capped at maxCooldownMs. Recorded so an operator can see the escalation.
//
//  Persisted to SQLite so a process restart does not reset a tripped
//  breaker — otherwise a crash-loop would silently re-enable a provider
//  that is still broken.
// ═══════════════════════════════════════════════════════════════════════

import type { EconomicStore } from "./store.js";

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerRow {
  key: string;
  state: BreakerState;
  consecutive_failures: number;
  open_count: number;
  opened_at: number | null;
  cooldown_ms: number;
  last_failure_reason: string | null;
  updated_at: number;
}

export interface CircuitBreakerConfig {
  stateDir?: string;
  dbPath?: string;
  /** Consecutive failures before the circuit opens. Default 3. */
  failureThreshold?: number;
  /** First cooldown. Doubles on each subsequent open. Default 60s. */
  baseCooldownMs?: number;
  /** Upper bound on cooldown. Default 2h. */
  maxCooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export type AllowResult =
  | { allow: true; state: BreakerState; probe: boolean }
  | { allow: false; state: "open"; retry_after_ms: number; reason: string };

export class CircuitBreaker {
  private readonly db: import("better-sqlite3").Database;
  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  /** Gate #6: shares ONE database with the rest of the economic layer. */
  constructor(store: EconomicStore, cfg: Omit<CircuitBreakerConfig, "stateDir" | "dbPath"> = {}) {
    this.db = store.db;
    this.failureThreshold = cfg.failureThreshold ?? 3;
    this.baseCooldownMs = cfg.baseCooldownMs ?? 60_000;
    this.maxCooldownMs = cfg.maxCooldownMs ?? 2 * 3600_000;
    this.now = cfg.now ?? (() => Date.now());
  }

  /**
   * Ask whether a call on this key may proceed. Transitions open→half_open
   * when the cooldown has elapsed, so the caller gets exactly one probe.
   */
  allow(key: string): AllowResult {
    const txn = this.db.transaction((k: string): AllowResult => {
      const row = this.rowFor(k);
      const t = this.now();
      if (row.state === "closed") return { allow: true, state: "closed", probe: false };
      if (row.state === "half_open") {
        // Only one probe in flight — a second caller while half_open is refused.
        return { allow: false, state: "open", retry_after_ms: 0, reason: `probe already in flight for ${k}` };
      }
      // open
      const elapsed = t - (row.opened_at ?? t);
      if (elapsed >= row.cooldown_ms) {
        this.db.prepare(`UPDATE breakers SET state='half_open', updated_at=? WHERE key=?`).run(t, k);
        return { allow: true, state: "half_open", probe: true };
      }
      return {
        allow: false, state: "open",
        retry_after_ms: row.cooldown_ms - elapsed,
        reason: `circuit open for ${k}: ${row.consecutive_failures} consecutive failures. Last: ${row.last_failure_reason ?? "unknown"}`,
      };
    });
    return txn(key);
  }

  /** Report a successful call — resets the failure counter and closes. */
  recordSuccess(key: string): void {
    const t = this.now();
    this.db.prepare(`
      INSERT INTO breakers (key, state, consecutive_failures, open_count, opened_at, cooldown_ms, last_failure_reason, updated_at)
      VALUES (?, 'closed', 0, 0, NULL, 0, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET
        state='closed', consecutive_failures=0, opened_at=NULL, cooldown_ms=0,
        last_failure_reason=NULL, updated_at=excluded.updated_at
    `).run(key, t);
  }

  /** Report a failed call — may open the circuit with escalating cooldown. */
  recordFailure(key: string, reason: string): BreakerRow {
    const txn = this.db.transaction((k: string, why: string): BreakerRow => {
      const row = this.rowFor(k);
      const t = this.now();
      const failures = row.consecutive_failures + 1;
      const shouldOpen = failures >= this.failureThreshold || row.state === "half_open";
      if (!shouldOpen) {
        this.db.prepare(`
          UPDATE breakers SET consecutive_failures=?, last_failure_reason=?, updated_at=? WHERE key=?
        `).run(failures, why, t, k);
      } else {
        const opens = row.open_count + 1;
        const cooldown = Math.min(this.maxCooldownMs, this.baseCooldownMs * Math.pow(2, opens - 1));
        this.db.prepare(`
          UPDATE breakers SET state='open', consecutive_failures=?, open_count=?, opened_at=?,
            cooldown_ms=?, last_failure_reason=?, updated_at=? WHERE key=?
        `).run(failures, opens, t, cooldown, why, t, k);
      }
      return this.rowFor(k);
    });
    return txn(key, reason);
  }

  /** Operator override — force a breaker closed (e.g. after fixing a provider). */
  reset(key: string): void { this.recordSuccess(key); }

  status(key: string): BreakerRow { return this.rowFor(key); }

  all(): BreakerRow[] {
    return this.db.prepare(`SELECT * FROM breakers ORDER BY updated_at DESC`).all() as BreakerRow[];
  }

  private rowFor(key: string): BreakerRow {
    const existing = this.db.prepare(`SELECT * FROM breakers WHERE key=?`).get(key) as BreakerRow | undefined;
    if (existing) return existing;
    const t = this.now();
    this.db.prepare(`
      INSERT INTO breakers (key, state, consecutive_failures, open_count, opened_at, cooldown_ms, last_failure_reason, updated_at)
      VALUES (?, 'closed', 0, 0, NULL, 0, NULL, ?)
    `).run(key, t);
    return this.db.prepare(`SELECT * FROM breakers WHERE key=?`).get(key) as BreakerRow;
  }

}
