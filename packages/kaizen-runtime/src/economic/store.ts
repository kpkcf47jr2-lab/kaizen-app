// ═══════════════════════════════════════════════════════════════════════
//  EconomicStore — ONE database, ONE transaction boundary
//
//  CEO gate rejection #6 (2026-08-30):
//    "Resolver la atomicidad entre idempotencia, reserva y ledger: una
//     sola base/transacción o protocolo durable de recuperación con
//     invariantes y pruebas de crash en cada frontera."
//
//  Fase-1-rev-1 fixes this by collapsing the three previously-separate
//  SQLite files (idempotency.db, economic-ledger.db, budget.db) into a
//  single `economic.db`. Every cross-concern mutation — dedupe + reserve
//  + ledger transition — now runs inside ONE `db.transaction()`, so a
//  crash between them is impossible: SQLite either commits all three or
//  none.
//
//  This module owns the connection and the schema. The concern-specific
//  classes (IdempotencyStore, EconomicEventLedger, BudgetReservation)
//  take the shared store instead of opening their own file.
//
//  Audit immutability (gate #5): decision_events is protected by SQLite
//  triggers that RAISE(ABORT) on UPDATE and DELETE. No ON DELETE CASCADE
//  on economic evidence — a deleted decision leaves its events behind as
//  a tombstone rather than destroying the record.
// ═══════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface EconomicStoreConfig {
  stateDir?: string;
  dbPath?: string;
  /** Test hook: open the same file from a second connection. */
  readonly?: boolean;
}

export class EconomicStore {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(cfg: EconomicStoreConfig = {}) {
    const stateDir = cfg.stateDir || path.join(process.cwd(), "data");
    fs.mkdirSync(stateDir, { recursive: true });
    this.dbPath = cfg.dbPath || path.join(stateDir, "economic.db");
    this.db = new Database(this.dbPath, { readonly: cfg.readonly ?? false });
    if (!cfg.readonly) {
      this.db.pragma("journal_mode = WAL");
      // Durability: FULL means a crash can't lose a committed txn.
      this.db.pragma("synchronous = FULL");
      this.db.pragma("foreign_keys = ON");
      // Fail fast instead of hanging forever when another writer holds the lock.
      this.db.pragma("busy_timeout = 5000");
      this.migrate();
    }
  }

  private migrate(): void {
    this.db.exec(`
      -- ── DECISIONS ───────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id            TEXT PRIMARY KEY,
        agent_id               TEXT NOT NULL,
        objective              TEXT NOT NULL,
        available_capital_usd  REAL NOT NULL,
        reserved_capital_usd   REAL NOT NULL DEFAULT 0,
        options_considered     TEXT NOT NULL,
        selected_option        TEXT,
        reason                 TEXT NOT NULL,
        confidence             REAL NOT NULL,
        expected_cost_usd      REAL NOT NULL,
        maximum_cost_usd       REAL NOT NULL,
        expected_value_usd     REAL NOT NULL,
        policy_result          TEXT,
        tool_calls             TEXT NOT NULL DEFAULT '[]',
        provider               TEXT,
        actual_cost_usd        REAL,
        actual_result          TEXT,
        profit_or_utility_usd  REAL,
        failure_reason         TEXT,
        state                  TEXT NOT NULL,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_state_created ON decisions(state, created_at);
      CREATE INDEX IF NOT EXISTS decisions_agent_state   ON decisions(agent_id, state);

      -- ── AUDIT TRAIL — append-only, no CASCADE on economic evidence ──
      -- Deliberately NOT "REFERENCES decisions(...) ON DELETE CASCADE".
      -- If a decision row were ever removed, its events survive as a
      -- tombstone. Economic evidence outlives the row it describes.
      CREATE TABLE IF NOT EXISTS decision_events (
        event_id     TEXT PRIMARY KEY,
        decision_id  TEXT NOT NULL,
        from_state   TEXT,
        to_state     TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        actor        TEXT NOT NULL,
        data         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS decision_events_decision_ts ON decision_events(decision_id, ts);

      -- Gate #5: real append-only enforcement at the engine level.
      CREATE TRIGGER IF NOT EXISTS decision_events_no_update
        BEFORE UPDATE ON decision_events
        BEGIN SELECT RAISE(ABORT, 'decision_events is append-only: UPDATE forbidden'); END;
      CREATE TRIGGER IF NOT EXISTS decision_events_no_delete
        BEFORE DELETE ON decision_events
        BEGIN SELECT RAISE(ABORT, 'decision_events is append-only: DELETE forbidden'); END;

      -- ── IDEMPOTENCY ─────────────────────────────────────────────────
      -- Gate #2: 'failed' and 'uncertain' now BLOCK a retry. Only an
      -- explicit reconcile() releases the key.
      CREATE TABLE IF NOT EXISTS operations (
        operation_id     TEXT PRIMARY KEY,
        tool             TEXT NOT NULL,
        key              TEXT NOT NULL,
        state            TEXT NOT NULL CHECK(state IN
                           ('pending','committed','failed','uncertain','rolled_back','reconciled')),
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        actor            TEXT NOT NULL,
        metadata         TEXT NOT NULL DEFAULT '{}',
        result_hash      TEXT,
        fail_reason      TEXT,
        external_reference TEXT,
        reconciled_at    INTEGER,
        reconcile_note   TEXT
      );
      -- Blocking states: anything that is NOT a deliberate release.
      -- rolled_back = we proved nothing happened → safe to retry.
      -- reconciled  = a human/process resolved it → safe to retry.
      CREATE UNIQUE INDEX IF NOT EXISTS operations_key_active
        ON operations(tool, key)
        WHERE state IN ('pending','committed','failed','uncertain');
      CREATE INDEX IF NOT EXISTS operations_state_updated ON operations(state, updated_at);
      CREATE INDEX IF NOT EXISTS operations_extref ON operations(external_reference);

      -- ── RESERVATIONS ────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS reservations (
        reservation_id   TEXT PRIMARY KEY,
        decision_id      TEXT NOT NULL,
        agent_id         TEXT NOT NULL,
        kind             TEXT NOT NULL,
        amount_usd       REAL NOT NULL,
        actual_cost_usd  REAL,
        state            TEXT NOT NULL CHECK(state IN ('held','committed','released')),
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        release_reason   TEXT
      );
      CREATE INDEX IF NOT EXISTS reservations_agent_state ON reservations(agent_id, state);
      CREATE INDEX IF NOT EXISTS reservations_created     ON reservations(created_at);
      CREATE INDEX IF NOT EXISTS reservations_decision    ON reservations(decision_id);

      -- ── CIRCUIT BREAKERS ────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS breakers (
        key                  TEXT PRIMARY KEY,
        state                TEXT NOT NULL CHECK(state IN ('closed','open','half_open')),
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        open_count           INTEGER NOT NULL DEFAULT 0,
        opened_at            INTEGER,
        cooldown_ms          INTEGER NOT NULL DEFAULT 0,
        last_failure_reason  TEXT,
        probe_holder         TEXT,
        updated_at           INTEGER NOT NULL
      );
    `);
  }

  /**
   * Run `fn` inside a single IMMEDIATE transaction. The write lock is taken
   * at BEGIN, so a read-then-write sequence inside `fn` cannot interleave
   * with another writer — this is the primitive that makes dedupe + reserve
   * + ledger atomic together.
   */
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  close(): void { this.db.close(); }
}
