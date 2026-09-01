// ═══════════════════════════════════════════════════════════════════════
//  IdempotencyStore — duplicate prevention with reconciliation gating
//
//  CEO gate rejection #2 (2026-08-30):
//    "Hacer que `failed` y cualquier resultado `cost_uncertain` conserven
//     consumida la clave de idempotencia hasta reconciliación explícita.
//     Añadir prueba que demuestre que un timeout o respuesta perdida no
//     puede crear un segundo alquiler."
//
//  State machine:
//     pending    → in flight; BLOCKS the key
//     committed  → succeeded;  BLOCKS the key
//     failed     → failed with unknown side effects; BLOCKS the key
//     uncertain  → response lost / timeout; BLOCKS the key  ← the dangerous one
//     rolled_back→ PROVEN no side effect; key is FREE
//     reconciled → a human or a provider query resolved it; key is FREE
//
//  The unique index covers pending|committed|failed|uncertain. So a network
//  timeout on `compute.rent` leaves the key consumed: the retry is refused
//  and the caller is handed the original operation_id plus the
//  external_reference it should use to ASK the provider what really
//  happened. Only after that answer does anyone call reconcile().
//
//  Owner requirement #6 (atomicity): this class no longer opens its own
//  database. It takes the shared EconomicStore so dedupe + reserve + ledger
//  commit or roll back together.
// ═══════════════════════════════════════════════════════════════════════

import { createHash, randomUUID } from "node:crypto";
import type { EconomicStore } from "./store.js";

export type OpState =
  | "pending" | "committed" | "failed" | "uncertain" | "rolled_back" | "reconciled";

/** States that keep the idempotency key consumed (retry refused). */
export const BLOCKING_STATES: readonly OpState[] = ["pending", "committed", "failed", "uncertain"];
/** States that free the key for a legitimate retry. */
export const RELEASING_STATES: readonly OpState[] = ["rolled_back", "reconciled"];

export interface BeginResult {
  fresh: boolean;
  operation_id: string;
  state: OpState;
  key: string;
  created_at: number;
  retry_after_ms?: number;
  /** Present when fresh=false and the blocking op has one — the caller
   *  should query the provider with this before deciding anything. */
  external_reference?: string | null;
  /** Human-actionable next step when a duplicate is refused. */
  guidance?: string;
}

export interface OperationRow {
  operation_id: string;
  tool: string;
  key: string;
  state: OpState;
  created_at: number;
  updated_at: number;
  actor: string;
  metadata: string;
  result_hash: string | null;
  fail_reason: string | null;
  external_reference: string | null;
  reconciled_at: number | null;
  reconcile_note: string | null;
}

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

export function makeIdempotencyKey(params: {
  tool: string; args: unknown; actor: string;
  now_ms?: number; bucket_seconds?: number; ignore_arg_keys?: string[];
}): string {
  const now = params.now_ms ?? Date.now();
  const bucket_s = params.bucket_seconds ?? 3600;
  const bucket = Math.floor(now / 1000 / bucket_s);
  const canonical = canonicalizeArgs(params.args, params.ignore_arg_keys);
  const h = createHash("sha256");
  h.update(params.tool); h.update("\0");
  h.update(canonical);   h.update("\0");
  h.update(params.actor); h.update("\0");
  h.update(String(bucket));
  return h.digest("hex");
}

export function newOperationId(): string { return randomUUID(); }

export class IdempotencyStore {
  constructor(private readonly store: EconomicStore) {}

  /** Insert a pending op, or report the blocking duplicate. */
  begin(params: {
    tool: string; key: string; actor: string;
    metadata?: Record<string, unknown>;
    external_reference?: string;
    ttl_seconds?: number;
  }): BeginResult {
    const op_id = newOperationId();
    const now = Date.now();
    const ttl_ms = (params.ttl_seconds ?? 3600) * 1000;
    try {
      this.store.db.prepare(`
        INSERT INTO operations (operation_id, tool, key, state, created_at, updated_at, actor, metadata, external_reference)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(op_id, params.tool, params.key, now, now, params.actor,
             JSON.stringify(params.metadata ?? {}), params.external_reference ?? null);
      return { fresh: true, operation_id: op_id, state: "pending", key: params.key, created_at: now };
    } catch (e) {
      const existing = this.store.db.prepare(`
        SELECT operation_id, state, created_at, external_reference, fail_reason FROM operations
         WHERE tool = ? AND key = ? AND state IN ('pending','committed','failed','uncertain')
         ORDER BY created_at DESC LIMIT 1
      `).get(params.tool, params.key) as
        { operation_id: string; state: OpState; created_at: number; external_reference: string | null; fail_reason: string | null } | undefined;
      if (!existing) throw e;   // not a dup — real error
      return {
        fresh: false,
        operation_id: existing.operation_id,
        state: existing.state,
        key: params.key,
        created_at: existing.created_at,
        retry_after_ms: Math.max(0, (existing.created_at + ttl_ms) - now),
        external_reference: existing.external_reference,
        guidance: guidanceFor(existing.state, existing.external_reference, existing.fail_reason),
      };
    }
  }

  commit(operation_id: string, result_hash: string | null = null): void {
    this.requireTransition(operation_id, ["pending"], `
      UPDATE operations SET state='committed', result_hash=?, updated_at=? WHERE operation_id=? AND state='pending'
    `, [result_hash, Date.now(), operation_id], "commit");
  }

  /** PROVEN no side effect (e.g. policy rejected before any provider call).
   *  Frees the key. */
  rollback(operation_id: string, reason: string): void {
    this.requireTransition(operation_id, ["pending"], `
      UPDATE operations SET state='rolled_back', fail_reason=?, updated_at=? WHERE operation_id=? AND state='pending'
    `, [reason, Date.now(), operation_id], "rollback");
  }

  /** Failed with possible side effects. KEEPS the key consumed. */
  fail(operation_id: string, reason: string): void {
    this.requireTransition(operation_id, ["pending"], `
      UPDATE operations SET state='failed', fail_reason=?, updated_at=? WHERE operation_id=? AND state='pending'
    `, [reason, Date.now(), operation_id], "fail");
  }

  /**
   * Gate #2: the response was lost / the call timed out. We do NOT know
   * whether the provider acted. The key stays consumed so a retry cannot
   * create a second rental. Caller must later query the provider using
   * external_reference and then call reconcile().
   */
  markUncertain(operation_id: string, reason: string, external_reference?: string): void {
    this.requireTransition(operation_id, ["pending"], `
      UPDATE operations SET state='uncertain', fail_reason=?, updated_at=?,
        external_reference=COALESCE(?, external_reference)
       WHERE operation_id=? AND state='pending'
    `, [reason, Date.now(), external_reference ?? null, operation_id], "markUncertain");
  }

  /**
   * Explicit resolution of a failed/uncertain operation. Only this frees
   * the key. `resolution` records what was actually true.
   */
  reconcile(operation_id: string, resolution: {
    outcome: "no_side_effect" | "side_effect_confirmed" | "resolved_by_owner";
    note: string;
  }): OperationRow {
    const row = this.get(operation_id);
    if (!row) throw new Error(`reconcile refused: unknown operation ${operation_id}`);
    if (!["failed", "uncertain"].includes(row.state)) {
      throw new Error(`reconcile refused: operation ${operation_id} is ${row.state}, expected failed|uncertain`);
    }
    const now = Date.now();
    this.store.db.prepare(`
      UPDATE operations SET state='reconciled', reconciled_at=?, reconcile_note=?, updated_at=?
       WHERE operation_id=?
    `).run(now, `${resolution.outcome}: ${resolution.note}`, now, operation_id);
    return this.get(operation_id)!;
  }

  get(operation_id: string): OperationRow | undefined {
    return this.store.db.prepare(`SELECT * FROM operations WHERE operation_id = ?`)
      .get(operation_id) as OperationRow | undefined;
  }

  /** Find an op by the reference we handed the provider — the lookup used
   *  when reconciling a lost response. */
  findByExternalReference(external_reference: string): OperationRow | undefined {
    return this.store.db.prepare(`SELECT * FROM operations WHERE external_reference = ? ORDER BY created_at DESC LIMIT 1`)
      .get(external_reference) as OperationRow | undefined;
  }

  stalePending(age_ms: number): OperationRow[] {
    return this.store.db.prepare(`
      SELECT * FROM operations WHERE state='pending' AND updated_at < ? ORDER BY updated_at ASC
    `).all(Date.now() - age_ms) as OperationRow[];
  }

  /** Operations awaiting human/provider reconciliation. Operational queue. */
  awaitingReconciliation(): OperationRow[] {
    return this.store.db.prepare(`
      SELECT * FROM operations WHERE state IN ('failed','uncertain') ORDER BY updated_at ASC
    `).all() as OperationRow[];
  }

  private requireTransition(
    operation_id: string, from: OpState[], sql: string, args: unknown[], label: string,
  ): void {
    const info = this.store.db.prepare(sql).run(...(args as never[]));
    if (info.changes === 0) {
      const row = this.get(operation_id);
      throw new Error(`${label} refused: operation ${operation_id} is ${row ? row.state : "missing"}, expected ${from.join("|")}`);
    }
  }
}

function guidanceFor(state: OpState, extref: string | null, failReason: string | null): string {
  switch (state) {
    case "pending":
      return "An identical operation is already in flight. Wait for it to settle; do not retry.";
    case "committed":
      return "This operation already succeeded. Retrying would duplicate the charge.";
    case "failed":
      return `Previous attempt failed with possible side effects (${failReason ?? "unknown"}). ` +
             `Query the provider${extref ? ` using external_reference=${extref}` : ""} to confirm, then call reconcile().`;
    case "uncertain":
      return `Previous attempt's outcome is UNKNOWN (${failReason ?? "lost response"}). ` +
             `A retry could create a duplicate rental. Query the provider${extref ? ` using external_reference=${extref}` : ""} first, then call reconcile().`;
    default:
      return "Key is free; this should not have blocked.";
  }
}
