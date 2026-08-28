// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Memory Engine
//
//  Per-agent SQLite database. Three tables:
//    - conversation_turns : chat history (short-term retrieval)
//    - economic_events    : every decision + tx (long-term audit + training)
//    - facts              : long-term key/value memory (RAG grounding)
//
//  The DB file lives at $KAIZEN_STATE_DIR/memory/{agentId}.sqlite.
//  Small enough to sync to iCloud as backup; large enough to survive
//  the LLM's ephemeral context.
// ═══════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ConversationTurn {
  id?: number;
  ts: number;
  role: Role;
  content: string;
  toolCall?: string | null;    // JSON, if role=assistant emitted a tool call
  toolResult?: string | null;  // JSON, if role=tool
}

/**
 * Every meaningful state change the agent makes. This IS the audit log
 * and, later, the training corpus for reinforcement fine-tuning.
 */
export interface EconomicEvent {
  id?: number;
  ts: number;
  kind:
    | "capital_allocation"
    | "trade_open"
    | "trade_close"
    | "transfer_out"
    | "transfer_in"
    | "campaign_spend"
    | "campaign_revenue"
    | "policy_violation"
    | "status_change";
  strategy?: string | null;
  amountUsd?: number | null;
  txHash?: string | null;
  reason: string;
  confidence?: number | null;   // 0-1 from the LLM's own self-report
  outcome?: string | null;      // filled later when known
  metadata?: string | null;     // JSON for extra fields
}

export interface Fact {
  key: string;
  value: string;
  updatedAt: number;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(agentId: string, baseDir?: string) {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(agentId)) {
      throw new Error(`Invalid agentId: ${agentId}`);
    }
    const base = baseDir || process.env.KAIZEN_STATE_DIR || path.join(process.cwd(), "data");
    const dir = path.join(base, "memory");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${agentId}.sqlite`);
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
        content TEXT NOT NULL,
        tool_call TEXT,
        tool_result TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_turns_ts ON conversation_turns(ts DESC);

      CREATE TABLE IF NOT EXISTS economic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        strategy TEXT,
        amount_usd REAL,
        tx_hash TEXT,
        reason TEXT NOT NULL,
        confidence REAL,
        outcome TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON economic_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON economic_events(kind, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_events_strategy ON economic_events(strategy, ts DESC);

      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // ── conversation turns ────────────────────────────────────────────
  addTurn(t: Omit<ConversationTurn, "id">): number {
    const stmt = this.db.prepare(
      "INSERT INTO conversation_turns (ts, role, content, tool_call, tool_result) VALUES (?,?,?,?,?)",
    );
    const info = stmt.run(t.ts, t.role, t.content, t.toolCall ?? null, t.toolResult ?? null);
    return Number(info.lastInsertRowid);
  }

  recentTurns(limit = 20): ConversationTurn[] {
    return this.db
      .prepare(
        "SELECT id, ts, role, content, tool_call AS toolCall, tool_result AS toolResult " +
        "FROM conversation_turns ORDER BY ts DESC LIMIT ?",
      )
      .all(limit)
      .reverse() as ConversationTurn[];
  }

  // ── economic events ───────────────────────────────────────────────
  recordEvent(e: Omit<EconomicEvent, "id">): number {
    const info = this.db
      .prepare(
        "INSERT INTO economic_events " +
        "(ts, kind, strategy, amount_usd, tx_hash, reason, confidence, outcome, metadata) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        e.ts, e.kind, e.strategy ?? null, e.amountUsd ?? null,
        e.txHash ?? null, e.reason, e.confidence ?? null,
        e.outcome ?? null, e.metadata ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  recentEvents(limit = 100, kind?: EconomicEvent["kind"]): EconomicEvent[] {
    const rows = kind
      ? this.db.prepare(
          "SELECT id, ts, kind, strategy, amount_usd AS amountUsd, tx_hash AS txHash, " +
          "reason, confidence, outcome, metadata FROM economic_events " +
          "WHERE kind = ? ORDER BY ts DESC LIMIT ?",
        ).all(kind, limit)
      : this.db.prepare(
          "SELECT id, ts, kind, strategy, amount_usd AS amountUsd, tx_hash AS txHash, " +
          "reason, confidence, outcome, metadata FROM economic_events " +
          "ORDER BY ts DESC LIMIT ?",
        ).all(limit);
    return rows as EconomicEvent[];
  }

  /** Total USD moved out in the last N ms. Feeds the Policy Engine. */
  rollingOutflow(sinceMs: number): number {
    const cutoff = Date.now() - sinceMs;
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_usd), 0) AS s FROM economic_events " +
        "WHERE ts >= ? AND kind IN ('transfer_out','campaign_spend','trade_open')",
      )
      .get(cutoff) as { s: number };
    return row.s;
  }

  // ── facts (long-term key/value memory) ────────────────────────────
  setFact(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO facts (key, value, updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, value, Date.now());
  }

  getFact(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM facts WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  allFacts(): Fact[] {
    return this.db
      .prepare("SELECT key, value, updated_at AS updatedAt FROM facts ORDER BY key")
      .all() as Fact[];
  }
}
