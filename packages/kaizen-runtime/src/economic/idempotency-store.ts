// ═══════════════════════════════════════════════════════════════════════
//  IdempotencyStore — prevent duplicate economic operations
//
//  Owner directive (2026-08-30): "Si el heartbeat corre dos veces, hay
//  network retry o el LLM repite una tool call, el sistema NO puede
//  alquilar dos GPUs accidentalmente / pagar dos veces / duplicar orden."
//
//  Contract:
//    - Every economic operation carries an operation_id (UUID v4) AND an
//      idempotency_key. The key is a deterministic hash of
//      { tool, args_canonical, actor, time_bucket }. Two calls in the same
//      bucket with the same args produce the same key.
//    - `begin(op_id, key)` atomically inserts a `pending` row. If the same
//      key already exists in a non-terminal state, the call is REFUSED —
//      that's the duplicate. The existing row's id is returned so the
//      caller can await/inspect it.
//    - `commit(op_id, result_hash?)` marks a pending row committed.
//    - `rollback(op_id, reason)` marks it rolled_back and frees the key.
//    - `fail(op_id, reason)` marks it failed; the key stays consumed
//      unless caller decides to release it via `expire()`.
//
//  Persistence: SQLite with a UNIQUE constraint on (tool, idempotency_key)
//  scoped to non-terminal states. Uses better-sqlite3 which is synchronous
//  and single-writer — inherently safe for our workload.
//
//  Time bucketing: default 1-hour window. Configurable per operation kind
//  to allow e.g. daily-unique campaigns vs minute-unique tool retries.
// ═══════════════════════════════════════════════════════════════════════

import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type OpState = "pending" | "committed" | "rolled_back" | "failed";

/** Returned by `begin()`. */
export interface BeginResult {
  /** true if this is a fresh operation you should execute. */
  fresh: boolean;
  /** The operation row (either the one you just created, or the duplicate). */
  operation_id: string;
  state: OpState;
  key: string;
  created_at: number;
  /** When fresh=false: how many ms until you can retry the same key. */
  retry_after_ms?: number;
}

export interface OperationRow {
  operation_id: string;
  tool: string;
  key: string;
  state: OpState;
  created_at: number;
  updated_at: number;
  actor: string;
  metadata: string;                // JSON blob
  result_hash: string | null;      // set on commit()
  fail_reason: string | null;      // set on fail()/rollback()
}

/** Canonicalize a JSON-ish args object so { a: 1, b: 2 } and { b: 2, a: 1 }
 *  produce the same hash. Excludes fields listed in `ignore`. */
export function canonicalizeArgs(args: unknown, ignore: string[] = []): string {
  const seen = new WeakSet<object>();
  const sortKeys = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sortKeys);
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (ignore.includes(k)) continue;
      o[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return o;
  };
  return JSON.stringify(sortKeys(args));
}

/** Deterministic key for idempotency. Time bucket rounds to bucket_seconds. */
export function makeIdempotencyKey(params: {
  tool: string;
  args: unknown;
  actor: string;
  now_ms?: number;
  bucket_seconds?: number;
  ignore_arg_keys?: string[];
}): string {
  const now = params.now_ms ?? Date.now();
  const bucket_s = params.bucket_seconds ?? 3600;   // 1h default
  const bucket = Math.floor(now / 1000 / bucket_s);
  const canonical = canonicalizeArgs(params.args, params.ignore_arg_keys);
  const h = createHash("sha256");
  h.update(params.tool); h.update("\0");
  h.update(canonical);   h.update("\0");
  h.update(params.actor); h.update("\0");
  h.update(String(bucket));
  return h.digest("hex");
}

export function newOperationId(): string {
  return randomUUID();
}

// ── Store ─────────────────────────────────────────────────────────────

export interface IdempotencyStoreConfig {
  dbPath?: string;         // default: <stateDir>/idempotency.db
  stateDir?: string;
}

export class IdempotencyStore {
  private readonly db: Database.Database;

  constructor(cfg: IdempotencyStoreConfig = {}) {
    const stateDir = cfg.stateDir || path.join(process.cwd(), "data");
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = cfg.dbPath || path.join(stateDir, "idempotency.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        tool         TEXT NOT NULL,
        key          TEXT NOT NULL,
        state        TEXT NOT NULL CHECK(state IN ('pending','committed','rolled_back','failed')),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        actor        TEXT NOT NULL,
        metadata     TEXT NOT NULL DEFAULT '{}',
        result_hash  TEXT,
        fail_reason  TEXT
      );
      -- Enforce uniqueness on (tool, key) only for non-terminal-in-a-conflicting-way
      -- states. pending + committed BLOCK further attempts with the same key.
      -- rolled_back + failed do NOT block — the caller can retry.
      CREATE UNIQUE INDEX IF NOT EXISTS operations_key_active
        ON operations(tool, key) WHERE state IN ('pending','committed');
      CREATE INDEX IF NOT EXISTS operations_state_updated
        ON operations(state, updated_at);
    `);
  }

  /**
   * Atomically insert a new pending operation with the given key.
   * If a row with that (tool, key) already exists in pending/committed state,
   * returns { fresh: false, ... } pointing at the existing row.
   */
  begin(params: {
    tool: string;
    key: string;
    actor: string;
    metadata?: Record<string, unknown>;
    ttl_seconds?: number;
  }): BeginResult {
    const op_id = newOperationId();
    const now = Date.now();
    const metaJson = JSON.stringify(params.metadata ?? {});
    const ttl_ms = (params.ttl_seconds ?? 3600) * 1000;
    // Try insert. Rely on UNIQUE INDEX to enforce dedup.
    try {
      this.db.prepare(`
        INSERT INTO operations (operation_id, tool, key, state, created_at, updated_at, actor, metadata)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(op_id, params.tool, params.key, now, now, params.actor, metaJson);
      return { fresh: true, operation_id: op_id, state: "pending", key: params.key, created_at: now };
    } catch (e) {
      // Presume UNIQUE-constraint violation. Fetch the winner.
      const existing = this.db.prepare(`
        SELECT operation_id, state, created_at FROM operations
         WHERE tool = ? AND key = ? AND state IN ('pending','committed')
         ORDER BY created_at DESC LIMIT 1
      `).get(params.tool, params.key) as { operation_id: string; state: OpState; created_at: number } | undefined;
      if (!existing) {
        // Not a dup — some other error. Bubble up.
        throw e;
      }
      const retry_after_ms = Math.max(0, (existing.created_at + ttl_ms) - now);
      return {
        fresh: false,
        operation_id: existing.operation_id,
        state: existing.state,
        key: params.key,
        created_at: existing.created_at,
        retry_after_ms,
      };
    }
  }

  commit(operation_id: string, result_hash: string | null = null): void {
    const info = this.db.prepare(`
      UPDATE operations SET state='committed', result_hash=?, updated_at=?
       WHERE operation_id=? AND state='pending'
    `).run(result_hash, Date.now(), operation_id);
    if (info.changes === 0) {
      throw new Error(`commit refused: operation ${operation_id} not in pending state`);
    }
  }

  rollback(operation_id: string, reason: string): void {
    const info = this.db.prepare(`
      UPDATE operations SET state='rolled_back', fail_reason=?, updated_at=?
       WHERE operation_id=? AND state='pending'
    `).run(reason, Date.now(), operation_id);
    if (info.changes === 0) {
      throw new Error(`rollback refused: operation ${operation_id} not in pending state`);
    }
  }

  fail(operation_id: string, reason: string): void {
    const info = this.db.prepare(`
      UPDATE operations SET state='failed', fail_reason=?, updated_at=?
       WHERE operation_id=? AND state='pending'
    `).run(reason, Date.now(), operation_id);
    if (info.changes === 0) {
      throw new Error(`fail refused: operation ${operation_id} not in pending state`);
    }
  }

  get(operation_id: string): OperationRow | undefined {
    return this.db.prepare(`SELECT * FROM operations WHERE operation_id = ?`).get(operation_id) as OperationRow | undefined;
  }

  /** Return all operations currently in `pending` state older than ageMs. */
  stalePending(age_ms: number): OperationRow[] {
    return this.db.prepare(`
      SELECT * FROM operations
       WHERE state='pending' AND updated_at < ?
       ORDER BY updated_at ASC
    `).all(Date.now() - age_ms) as OperationRow[];
  }

  close(): void {
    this.db.close();
  }
}
