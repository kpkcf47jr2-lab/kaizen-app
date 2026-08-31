// ═══════════════════════════════════════════════════════════════════════
//  EconomicEventLedger — verifiable record of every economic decision
//
//  Owner directive (2026-08-30): "Cada decisión debe guardar decision_id,
//  agent_id, objective, available_capital, reserved_capital,
//  options_considered, selected_option, reason, confidence, expected_cost,
//  maximum_cost, expected_value, policy_result, tool_calls, provider,
//  actual_cost, actual_result, profit_or_utility, failure_reason,
//  timestamps."
//
//  This is the single source of economic truth for reconciliation, audit,
//  learning (I.1 outcome tracking), and human review. Every state
//  transition is append-only; no UPDATE-in-place allowed on core fields.
//
//  State machine per decision (owner's spec):
//    DECISION_CREATED → POLICY_APPROVED → BUDGET_RESERVED → PROVIDER_REQUESTED
//     → PROVISIONING → RUNNING → WORKLOAD_RUNNING → STOP_REQUESTED
//     → TERMINATED → RECONCILED → CLOSED
//
//    error states: POLICY_REJECTED, PROVIDER_FAILED, PROVISION_TIMEOUT,
//     WORKLOAD_FAILED, STOP_FAILED, BILLING_DISPUTE, CANCELLED, KILLED
//
//  Backed by SQLite. Two tables: `decisions` (one row per decision, mutable
//  status column) + `decision_events` (append-only audit trail of every
//  transition, immutable).
// ═══════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── State machine ─────────────────────────────────────────────────────

export const DECISION_STATES = [
  "DECISION_CREATED",
  "POLICY_APPROVED",
  "BUDGET_RESERVED",
  "PROVIDER_REQUESTED",
  "PROVISIONING",
  "RUNNING",
  "WORKLOAD_RUNNING",
  "STOP_REQUESTED",
  "TERMINATED",
  "RECONCILED",
  "CLOSED",
  // Error states
  "POLICY_REJECTED",
  "PROVIDER_FAILED",
  "PROVISION_TIMEOUT",
  "WORKLOAD_FAILED",
  "STOP_FAILED",
  "BILLING_DISPUTE",
  "CANCELLED",
  "KILLED",
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

export const TERMINAL_STATES: readonly DecisionState[] = [
  "CLOSED", "POLICY_REJECTED", "CANCELLED",
];

/** Legal forward transitions. Any missing pair is an illegal transition. */
export const LEGAL_TRANSITIONS: Record<DecisionState, DecisionState[]> = {
  DECISION_CREATED:    ["POLICY_APPROVED", "POLICY_REJECTED", "CANCELLED", "KILLED"],
  POLICY_APPROVED:     ["BUDGET_RESERVED", "CANCELLED", "KILLED"],
  BUDGET_RESERVED:     ["PROVIDER_REQUESTED", "CANCELLED", "KILLED"],
  PROVIDER_REQUESTED:  ["PROVISIONING", "PROVIDER_FAILED", "PROVISION_TIMEOUT", "KILLED"],
  PROVISIONING:        ["RUNNING", "PROVIDER_FAILED", "PROVISION_TIMEOUT", "KILLED"],
  RUNNING:             ["WORKLOAD_RUNNING", "STOP_REQUESTED", "WORKLOAD_FAILED", "KILLED"],
  WORKLOAD_RUNNING:    ["STOP_REQUESTED", "WORKLOAD_FAILED", "KILLED"],
  STOP_REQUESTED:      ["TERMINATED", "STOP_FAILED", "KILLED"],
  TERMINATED:          ["RECONCILED", "BILLING_DISPUTE"],
  RECONCILED:          ["CLOSED"],
  CLOSED:              [],
  // Error states are terminal-ish; some allow escalation
  POLICY_REJECTED:     [],
  PROVIDER_FAILED:     ["CLOSED", "BILLING_DISPUTE"],
  PROVISION_TIMEOUT:   ["STOP_REQUESTED", "CLOSED"],
  WORKLOAD_FAILED:     ["STOP_REQUESTED"],
  STOP_FAILED:         ["STOP_REQUESTED", "BILLING_DISPUTE"],       // retry allowed
  BILLING_DISPUTE:     ["CLOSED"],
  CANCELLED:           [],
  KILLED:              [],
};

// ── Data shape (17 fields per owner spec) ─────────────────────────────

export interface DecisionRecord {
  decision_id: string;
  agent_id: string;
  objective: string;
  available_capital_usd: number;
  reserved_capital_usd: number;
  options_considered: unknown[];         // json array of alternatives
  selected_option: unknown | null;       // json of chosen option
  reason: string;
  confidence: number;                    // 0..1
  expected_cost_usd: number;
  maximum_cost_usd: number;
  expected_value_usd: number;            // hypothesis of benefit
  policy_result: unknown;                // full PolicyDecision
  tool_calls: unknown[];                 // ordered log
  provider: string | null;
  actual_cost_usd: number | null;
  actual_result: unknown | null;
  profit_or_utility_usd: number | null;  // reconciled result
  failure_reason: string | null;
  state: DecisionState;
  created_at: number;
  updated_at: number;
}

export interface DecisionEvent {
  event_id: string;
  decision_id: string;
  from_state: DecisionState | null;      // null for creation event
  to_state: DecisionState;
  ts: number;
  actor: string;                         // "kaizen" | "policy" | "owner" | "system"
  data: unknown;                         // event-specific payload
}

// ── The ledger ────────────────────────────────────────────────────────

export class EconomicEventLedger {
  private readonly db: Database.Database;

  constructor(cfg: { dbPath?: string; stateDir?: string } = {}) {
    const stateDir = cfg.stateDir || path.join(process.cwd(), "data");
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = cfg.dbPath || path.join(stateDir, "economic-ledger.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id            TEXT PRIMARY KEY,
        agent_id               TEXT NOT NULL,
        objective              TEXT NOT NULL,
        available_capital_usd  REAL NOT NULL,
        reserved_capital_usd   REAL NOT NULL DEFAULT 0,
        options_considered     TEXT NOT NULL,   -- json
        selected_option        TEXT,            -- json
        reason                 TEXT NOT NULL,
        confidence             REAL NOT NULL,
        expected_cost_usd      REAL NOT NULL,
        maximum_cost_usd       REAL NOT NULL,
        expected_value_usd     REAL NOT NULL,
        policy_result          TEXT,            -- json
        tool_calls             TEXT NOT NULL DEFAULT '[]',
        provider               TEXT,
        actual_cost_usd        REAL,
        actual_result          TEXT,            -- json
        profit_or_utility_usd  REAL,
        failure_reason         TEXT,
        state                  TEXT NOT NULL,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_state_created ON decisions(state, created_at);
      CREATE INDEX IF NOT EXISTS decisions_agent_state ON decisions(agent_id, state);

      CREATE TABLE IF NOT EXISTS decision_events (
        event_id     TEXT PRIMARY KEY,
        decision_id  TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,
        from_state   TEXT,
        to_state     TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        actor        TEXT NOT NULL,
        data         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS decision_events_decision_ts ON decision_events(decision_id, ts);
    `);
  }

  /** Insert a fresh decision in DECISION_CREATED state. */
  createDecision(input: Omit<DecisionRecord, "decision_id" | "state" | "created_at" | "updated_at" | "reserved_capital_usd" | "selected_option" | "policy_result" | "tool_calls" | "provider" | "actual_cost_usd" | "actual_result" | "profit_or_utility_usd" | "failure_reason"> & { decision_id?: string; actor?: string }): DecisionRecord {
    const decision_id = input.decision_id || randomUUID();
    const now = Date.now();
    const row: DecisionRecord = {
      decision_id,
      agent_id: input.agent_id,
      objective: input.objective,
      available_capital_usd: input.available_capital_usd,
      reserved_capital_usd: 0,
      options_considered: input.options_considered,
      selected_option: null,
      reason: input.reason,
      confidence: input.confidence,
      expected_cost_usd: input.expected_cost_usd,
      maximum_cost_usd: input.maximum_cost_usd,
      expected_value_usd: input.expected_value_usd,
      policy_result: null,
      tool_calls: [],
      provider: null,
      actual_cost_usd: null,
      actual_result: null,
      profit_or_utility_usd: null,
      failure_reason: null,
      state: "DECISION_CREATED",
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO decisions (decision_id, agent_id, objective, available_capital_usd, reserved_capital_usd,
        options_considered, selected_option, reason, confidence, expected_cost_usd, maximum_cost_usd,
        expected_value_usd, policy_result, tool_calls, provider, actual_cost_usd, actual_result,
        profit_or_utility_usd, failure_reason, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.decision_id, row.agent_id, row.objective, row.available_capital_usd, row.reserved_capital_usd,
      JSON.stringify(row.options_considered), null, row.reason, row.confidence, row.expected_cost_usd,
      row.maximum_cost_usd, row.expected_value_usd, null, "[]", null, null, null, null, null,
      row.state, row.created_at, row.updated_at,
    );
    this.recordEvent({ decision_id, from_state: null, to_state: "DECISION_CREATED", actor: input.actor || "kaizen", data: { origin: "createDecision" } });
    return row;
  }

  /**
   * Transition a decision to a new state. Enforces LEGAL_TRANSITIONS.
   * Optionally patches a partial decision update in the same transaction
   * so the recorded event and the row mutation are consistent.
   */
  transition(params: {
    decision_id: string;
    to_state: DecisionState;
    actor: string;
    data?: unknown;
    patch?: Partial<Pick<DecisionRecord,
      | "reserved_capital_usd" | "selected_option" | "policy_result" | "tool_calls"
      | "provider" | "actual_cost_usd" | "actual_result" | "profit_or_utility_usd" | "failure_reason">>;
  }): DecisionRecord {
    const tx = this.db.transaction((p: typeof params) => {
      const row = this.get(p.decision_id);
      if (!row) throw new Error(`unknown decision ${p.decision_id}`);
      const legal = LEGAL_TRANSITIONS[row.state] || [];
      if (!legal.includes(p.to_state)) {
        throw new Error(`illegal transition ${row.state} → ${p.to_state} for decision ${p.decision_id}`);
      }
      // Apply patch fields
      const patchCols: string[] = [];
      const patchVals: unknown[] = [];
      if (p.patch) {
        for (const [k, v] of Object.entries(p.patch)) {
          patchCols.push(`${k} = ?`);
          patchVals.push(
            k === "selected_option" || k === "policy_result" || k === "tool_calls" || k === "actual_result"
              ? JSON.stringify(v)
              : v,
          );
        }
      }
      const now = Date.now();
      this.db.prepare(`
        UPDATE decisions SET state = ?, updated_at = ?${patchCols.length ? ", " + patchCols.join(", ") : ""}
         WHERE decision_id = ?
      `).run(p.to_state, now, ...patchVals, p.decision_id);
      this.recordEvent({ decision_id: p.decision_id, from_state: row.state, to_state: p.to_state, actor: p.actor, data: p.data ?? {} });
      return this.get(p.decision_id)!;
    });
    return tx(params);
  }

  private recordEvent(input: Omit<DecisionEvent, "event_id" | "ts"> & { ts?: number }): void {
    const event_id = randomUUID();
    const ts = input.ts ?? Date.now();
    this.db.prepare(`
      INSERT INTO decision_events (event_id, decision_id, from_state, to_state, ts, actor, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event_id, input.decision_id, input.from_state, input.to_state, ts, input.actor, JSON.stringify(input.data ?? {}));
  }

  get(decision_id: string): DecisionRecord | undefined {
    const raw = this.db.prepare(`SELECT * FROM decisions WHERE decision_id = ?`).get(decision_id) as unknown as (Record<string, unknown> & { options_considered: string; selected_option: string | null; policy_result: string | null; tool_calls: string; actual_result: string | null }) | undefined;
    if (!raw) return undefined;
    return {
      ...raw,
      options_considered: JSON.parse(raw.options_considered),
      selected_option: raw.selected_option ? JSON.parse(raw.selected_option) : null,
      policy_result: raw.policy_result ? JSON.parse(raw.policy_result) : null,
      tool_calls: JSON.parse(raw.tool_calls),
      actual_result: raw.actual_result ? JSON.parse(raw.actual_result) : null,
    } as unknown as DecisionRecord;
  }

  /** Full audit trail for a decision. */
  events(decision_id: string): DecisionEvent[] {
    const rows = this.db.prepare(`SELECT * FROM decision_events WHERE decision_id = ? ORDER BY ts ASC`).all(decision_id) as Array<Record<string, unknown> & { data: string }>;
    return rows.map((r) => ({ ...(r as unknown as DecisionEvent), data: JSON.parse(r.data) }));
  }

  /** Cumulative spent in a rolling window. Uses actual_cost_usd where present,
   *  falls back to expected_cost_usd for still-pending in-flight decisions. */
  spentInWindow(params: { agent_id?: string; window_ms: number }): { spent_usd: number; reserved_usd: number } {
    const since = Date.now() - params.window_ms;
    const agentClause = params.agent_id ? "AND agent_id = ?" : "";
    const args = params.agent_id ? [since, params.agent_id] : [since];
    // Committed spent
    const spent = this.db.prepare(`
      SELECT COALESCE(SUM(actual_cost_usd), 0) AS s FROM decisions
       WHERE state IN ('RECONCILED','CLOSED','BILLING_DISPUTE') AND updated_at >= ? ${agentClause}
    `).get(...args) as { s: number };
    // In-flight reserved (expected_cost_usd of active decisions)
    const reserved = this.db.prepare(`
      SELECT COALESCE(SUM(expected_cost_usd), 0) AS r FROM decisions
       WHERE state IN ('POLICY_APPROVED','BUDGET_RESERVED','PROVIDER_REQUESTED','PROVISIONING','RUNNING','WORKLOAD_RUNNING','STOP_REQUESTED','TERMINATED')
             AND created_at >= ? ${agentClause}
    `).get(...args) as { r: number };
    return { spent_usd: spent.s, reserved_usd: reserved.r };
  }

  close(): void { this.db.close(); }
}
