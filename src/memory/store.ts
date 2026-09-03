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
    | "trade_swap"
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

/** Una conclusión reutilizable que la agente sacó de su propia experiencia.
 *  `veces` y `costoUsd` acumulan: dicen cuánto respaldo tiene y cuánto costó
 *  averiguarlo. `util=false` marca lo que resultó ser un callejón sin salida. */
export interface Leccion {
  id: number;
  createdTs: number;
  updatedTs: number;
  /** Familia: "ruta" | "herramienta" | "mercado" | "tactica" | libre. */
  scope: string;
  /** Identidad estable de la lección — es la clave que evita duplicar. */
  clave: string;
  leccion: string;
  evidencia: string | null;
  veces: number;
  costoUsd: number;
  util: number;
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

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opened_ts INTEGER NOT NULL,
        closed_ts INTEGER,
        strategy TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        sell_token TEXT NOT NULL,
        buy_token TEXT NOT NULL,
        buy_token_decimals INTEGER,
        entry_usd REAL NOT NULL,
        entry_price_usd REAL,
        exit_usd REAL,
        pnl_usd REAL,
        open_tx TEXT,
        close_tx TEXT,
        reason_open TEXT,
        reason_close TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pos_open ON positions(opened_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_pos_strategy ON positions(strategy, opened_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_pos_status
        ON positions(closed_ts) WHERE closed_ts IS NULL;

      -- Additive migrations for positions (idempotent — ADD COLUMN throws if
      -- exists; caught in TS below).
      -- (no-op placeholder; actual ALTER handled in migrate() below)

      -- Exit rules on open positions. Populated by trading.openPosition when
      -- the LLM sets stop-loss / take-profit at open. The scheduler evaluates
      -- these against current price without invoking the LLM — fast + cheap.
      -- Added 2026-08-28.
      CREATE TABLE IF NOT EXISTS position_exit_rules (
        position_id INTEGER PRIMARY KEY REFERENCES positions(id) ON DELETE CASCADE,
        take_profit_pct REAL,
        stop_loss_pct REAL,
        trailing_stop_pct REAL,
        high_watermark_usd REAL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Idempotent additive migrations — SQLite raises "duplicate column" if
    // the column already exists, caught + ignored.
    for (const alter of [
      "ALTER TABLE positions ADD COLUMN buy_token_decimals INTEGER",
      "ALTER TABLE positions ADD COLUMN entry_price_usd REAL",
      // Improvement.1 (2026-08-29): outcome tracking on economic_events.
      // Every event that is a "decision worth learning from" gets its
      // outcome measured N hours later by the improvement:measure-outcomes
      // heartbeat task. Populates these columns so the auto-curator
      // (Improvement.2) can filter datasets by realized ROI.
      "ALTER TABLE economic_events ADD COLUMN outcome_measured_at INTEGER",
      "ALTER TABLE economic_events ADD COLUMN outcome_usd REAL",
      "ALTER TABLE economic_events ADD COLUMN outcome_metric TEXT",
      "ALTER TABLE economic_events ADD COLUMN outcome_success INTEGER",
    ]) {
      try { this.db.exec(alter); }
      catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
    }

    // Outcome measurement queue — tasks scheduled to run at `due_at` that
    // read the current world state and write back the measurement to the
    // triggering event. Keeps the schedule persistent across restarts.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outcome_measurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES economic_events(id) ON DELETE CASCADE,
        due_at INTEGER NOT NULL,           -- when to run
        kind TEXT NOT NULL,                -- 'pnl' | 'roas' | 'conversion' | ...
        params TEXT,                       -- JSON: strategy-specific measurement config
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
        result_usd REAL,
        result_success INTEGER,
        completed_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outmeas_due
        ON outcome_measurements(due_at) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS idx_outmeas_event
        ON outcome_measurements(event_id);
    `);

    this.db.exec(`
      -- Marker for later — keeps migrate() re-callable without side effects.
      SELECT 1;

      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seen_ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        edge_usd_estimate REAL,
        confidence REAL,
        payload TEXT,
        acted_on INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        UNIQUE(source, signal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_opps_seen ON opportunities(seen_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_opps_open
        ON opportunities(acted_on, seen_ts DESC) WHERE acted_on = 0;

      -- Memoria de largo plazo: lo que APRENDIÓ, no lo que hizo.
      --
      -- Antes escribía cada turno en conversation_turns y nunca los volvía
      -- a leer: tenía un diario que no abría. Si perdía 30 centavos de gas
      -- descubriendo que una ruta no servía, al día siguiente lo repetía
      -- igual. Sin esto no hay acumulación, y cada sesión es el día de la
      -- marmota.
      --
      -- Una lección es una conclusión reutilizable con evidencia: qué pasó,
      -- cuántas veces se confirmó, y cuánto costó averiguarlo. El scope la
      -- clasifica (ruta, herramienta, mercado, táctica) para poder traer
      -- sólo las relevantes sin inundar el contexto.
      CREATE TABLE IF NOT EXISTS lessons (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_ts  INTEGER NOT NULL,
        updated_ts  INTEGER NOT NULL,
        scope       TEXT NOT NULL,
        clave       TEXT NOT NULL,
        leccion     TEXT NOT NULL,
        evidencia   TEXT,
        veces       INTEGER NOT NULL DEFAULT 1,
        costo_usd   REAL NOT NULL DEFAULT 0,
        util        INTEGER NOT NULL DEFAULT 1,
        UNIQUE(scope, clave)
      );
      CREATE INDEX IF NOT EXISTS idx_lecciones_scope
        ON lessons(scope, updated_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_lecciones_utiles
        ON lessons(util, veces DESC, updated_ts DESC);
    `);
  }

  // ── lecciones (memoria de largo plazo) ────────────────────────────

  /** Guarda una lección. Si ya existía la misma (scope+clave), NO duplica:
   *  suma una confirmación, acumula el costo y actualiza el texto.
   *
   *  Esa acumulación es la que convierte una anécdota en conocimiento —
   *  "esto falló 4 veces y me costó $1.20" pesa distinto que "esto falló". */
  aprender(l: {
    scope: string; clave: string; leccion: string;
    evidencia?: string | null; costoUsd?: number; util?: boolean;
  }): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO lessons (created_ts, updated_ts, scope, clave, leccion, evidencia, veces, costo_usd, util)
       VALUES (?,?,?,?,?,?,1,?,?)
       ON CONFLICT(scope, clave) DO UPDATE SET
         updated_ts = excluded.updated_ts,
         leccion    = excluded.leccion,
         evidencia  = COALESCE(excluded.evidencia, lessons.evidencia),
         veces      = lessons.veces + 1,
         costo_usd  = lessons.costo_usd + excluded.costo_usd,
         util       = excluded.util`,
    ).run(
      now, now, l.scope, l.clave, l.leccion,
      l.evidencia ?? null, l.costoUsd ?? 0, l.util === false ? 0 : 1,
    );
  }

  /** Las lecciones más asentadas primero: las que más veces se confirmaron
   *  y, a igualdad, las más recientes. */
  lecciones(limit = 12): Leccion[] {
    return this.db.prepare(
      `SELECT id, created_ts AS createdTs, updated_ts AS updatedTs, scope, clave,
              leccion, evidencia, veces, costo_usd AS costoUsd, util
       FROM lessons ORDER BY veces DESC, updated_ts DESC LIMIT ?`,
    ).all(limit) as Leccion[];
  }

  contarLecciones(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number };
    return r.n;
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

  // ── outcome measurements (Improvement.1) ─────────────────────────
  // Every "decision" event (trade_open, campaign_spend, capital_allocation
  // to a strategy) schedules one or more measurements at future times.
  // The improvement:measure-outcomes heartbeat task drains this queue
  // and writes the resulting `outcome_usd / outcome_success` back to
  // the source event so the auto-curator (Improvement.2) can filter
  // datasets by realized win/loss.

  scheduleMeasurement(m: {
    eventId: number;
    dueAt: number;
    kind: string;
    params?: Record<string, unknown>;
  }): number {
    const info = this.db
      .prepare(
        "INSERT INTO outcome_measurements (event_id, due_at, kind, params) VALUES (?,?,?,?)",
      )
      .run(m.eventId, m.dueAt, m.kind, m.params ? JSON.stringify(m.params) : null);
    return Number(info.lastInsertRowid);
  }

  duePendingMeasurements(limit = 50): Array<{
    id: number; eventId: number; dueAt: number; kind: string; params: Record<string, unknown> | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, event_id AS eventId, due_at AS dueAt, kind, params " +
        "FROM outcome_measurements WHERE status='pending' AND due_at <= ? " +
        "ORDER BY due_at ASC LIMIT ?",
      )
      .all(Date.now(), limit) as Array<{ id: number; eventId: number; dueAt: number; kind: string; params: string | null }>;
    return rows.map((r) => ({
      ...r,
      params: r.params ? JSON.parse(r.params) as Record<string, unknown> : null,
    }));
  }

  completeMeasurement(id: number, result: {
    resultUsd: number | null;
    resultSuccess: boolean | null;
    error?: string;
  }): void {
    const status = result.error ? "failed" : "done";
    this.db
      .prepare(
        "UPDATE outcome_measurements SET status=?, result_usd=?, result_success=?, completed_at=?, error=? WHERE id=?",
      )
      .run(status, result.resultUsd, result.resultSuccess === null ? null : (result.resultSuccess ? 1 : 0), Date.now(), result.error ?? null, id);
  }

  /** Enrich an event with its measured outcome so training data can
   *  filter by realized ROI. Idempotent per (eventId, kind). */
  recordOutcome(eventId: number, outcome: {
    outcomeUsd: number;
    metric: string;
    success: boolean;
  }): void {
    this.db
      .prepare(
        "UPDATE economic_events SET outcome_measured_at=?, outcome_usd=?, outcome_metric=?, outcome_success=? WHERE id=?",
      )
      .run(Date.now(), outcome.outcomeUsd, outcome.metric, outcome.success ? 1 : 0, eventId);
  }

  /** For the Improvement.2 auto-curator: fetch events that HAVE a
   *  measured outcome, filtered by success. Includes conversation
   *  context via a LEFT JOIN so training examples come with the
   *  decision prompt + reasoning. */
  eventsWithOutcome(opts?: {
    sinceMs?: number;
    successOnly?: boolean;
    kinds?: string[];
    limit?: number;
  }): Array<EconomicEvent & { outcomeUsd: number; outcomeMetric: string; outcomeSuccess: boolean }> {
    const sinceMs = opts?.sinceMs ?? 30 * 24 * 3600_000;
    const cutoff = Date.now() - sinceMs;
    const successFilter = opts?.successOnly ? " AND outcome_success = 1" : "";
    const kindFilter = opts?.kinds && opts.kinds.length > 0
      ? " AND kind IN (" + opts.kinds.map(() => "?").join(",") + ")"
      : "";
    const limit = opts?.limit ?? 500;
    const sql =
      "SELECT id, ts, kind, strategy, amount_usd AS amountUsd, tx_hash AS txHash, " +
      "reason, confidence, outcome, metadata, " +
      "outcome_usd AS outcomeUsd, outcome_metric AS outcomeMetric, outcome_success AS outcomeSuccess " +
      "FROM economic_events " +
      "WHERE ts >= ? AND outcome_measured_at IS NOT NULL" +
      successFilter + kindFilter +
      " ORDER BY ts DESC LIMIT ?";
    const params = [cutoff, ...(opts?.kinds ?? []), limit];
    const rows = this.db.prepare(sql).all(...params) as Array<EconomicEvent & { outcomeUsd: number; outcomeMetric: string; outcomeSuccess: number }>;
    return rows.map((r) => ({ ...r, outcomeSuccess: r.outcomeSuccess === 1 }));
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

  // ── positions ─────────────────────────────────────────────────────
  openPosition(p: Omit<Position, "id" | "closedTs" | "exitUsd" | "pnlUsd" | "closeTx" | "reasonClose">): number {
    const info = this.db.prepare(
      "INSERT INTO positions " +
      "(opened_ts, strategy, chain_id, sell_token, buy_token, buy_token_decimals, " +
      "entry_usd, entry_price_usd, open_tx, reason_open, metadata) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      p.openedTs, p.strategy, p.chainId, p.sellToken, p.buyToken,
      p.buyTokenDecimals ?? null,
      p.entryUsd, p.entryPriceUsd ?? null,
      p.openTx ?? null, p.reasonOpen ?? null, p.metadata ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  closePosition(id: number, patch: { closedTs: number; exitUsd: number; pnlUsd: number; closeTx?: string; reasonClose?: string }): void {
    this.db.prepare(
      "UPDATE positions SET closed_ts = ?, exit_usd = ?, pnl_usd = ?, close_tx = ?, reason_close = ? WHERE id = ?",
    ).run(
      patch.closedTs, patch.exitUsd, patch.pnlUsd,
      patch.closeTx ?? null, patch.reasonClose ?? null, id,
    );
  }

  openPositions(strategy?: string): Position[] {
    const cols =
      "id, opened_ts AS openedTs, closed_ts AS closedTs, strategy, chain_id AS chainId, " +
      "sell_token AS sellToken, buy_token AS buyToken, buy_token_decimals AS buyTokenDecimals, " +
      "entry_usd AS entryUsd, entry_price_usd AS entryPriceUsd, exit_usd AS exitUsd, " +
      "pnl_usd AS pnlUsd, open_tx AS openTx, close_tx AS closeTx, reason_open AS reasonOpen, " +
      "reason_close AS reasonClose, metadata";
    const rows = strategy
      ? this.db.prepare(
          `SELECT ${cols} FROM positions WHERE closed_ts IS NULL AND strategy = ? ORDER BY opened_ts DESC`,
        ).all(strategy)
      : this.db.prepare(
          `SELECT ${cols} FROM positions WHERE closed_ts IS NULL ORDER BY opened_ts DESC`,
        ).all();
    return rows as Position[];
  }

  strategyStats(strategy: string): { trades: number; wins: number; grossProfit: number; grossLoss: number; netProfit: number } {
    const r = this.db.prepare(
      "SELECT COUNT(*) AS trades, " +
      "SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins, " +
      "COALESCE(SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END), 0) AS grossProfit, " +
      "COALESCE(SUM(CASE WHEN pnl_usd < 0 THEN -pnl_usd ELSE 0 END), 0) AS grossLoss, " +
      "COALESCE(SUM(pnl_usd), 0) AS netProfit " +
      "FROM positions WHERE strategy = ? AND closed_ts IS NOT NULL",
    ).get(strategy) as { trades: number; wins: number; grossProfit: number; grossLoss: number; netProfit: number };
    return r;
  }

  // ── opportunities ────────────────────────────────────────────────
  /** Insert-or-ignore. Returns id (new) or 0 (dupe on source+signalId). */
  recordOpportunity(o: Omit<Opportunity, "id" | "actedOn" | "outcome">): number {
    const info = this.db.prepare(
      "INSERT OR IGNORE INTO opportunities " +
      "(seen_ts, source, kind, signal_id, title, edge_usd_estimate, confidence, payload) " +
      "VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      o.seenTs, o.source, o.kind, o.signalId, o.title,
      o.edgeUsdEstimate ?? null, o.confidence ?? null, o.payload ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  recentOpportunities(limit = 20, unactedOnly = false): Opportunity[] {
    const sql = unactedOnly
      ? "SELECT id, seen_ts AS seenTs, source, kind, signal_id AS signalId, title, " +
        "edge_usd_estimate AS edgeUsdEstimate, confidence, payload, acted_on AS actedOn, outcome " +
        "FROM opportunities WHERE acted_on = 0 ORDER BY seen_ts DESC LIMIT ?"
      : "SELECT id, seen_ts AS seenTs, source, kind, signal_id AS signalId, title, " +
        "edge_usd_estimate AS edgeUsdEstimate, confidence, payload, acted_on AS actedOn, outcome " +
        "FROM opportunities ORDER BY seen_ts DESC LIMIT ?";
    return this.db.prepare(sql).all(limit) as Opportunity[];
  }

  markOpportunityActed(id: number, outcome?: string): void {
    this.db
      .prepare("UPDATE opportunities SET acted_on = 1, outcome = ? WHERE id = ?")
      .run(outcome ?? null, id);
  }

  // ── position exit rules ──────────────────────────────────────────

  setExitRules(positionId: number, rules: {
    takeProfitPct?: number | null;
    stopLossPct?: number | null;
    trailingStopPct?: number | null;
    highWatermarkUsd?: number | null;
  }): void {
    this.db.prepare(
      "INSERT INTO position_exit_rules " +
      "(position_id, take_profit_pct, stop_loss_pct, trailing_stop_pct, high_watermark_usd, updated_at) " +
      "VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(position_id) DO UPDATE SET " +
      "take_profit_pct=excluded.take_profit_pct, " +
      "stop_loss_pct=excluded.stop_loss_pct, " +
      "trailing_stop_pct=excluded.trailing_stop_pct, " +
      "high_watermark_usd=excluded.high_watermark_usd, " +
      "updated_at=excluded.updated_at",
    ).run(
      positionId,
      rules.takeProfitPct ?? null,
      rules.stopLossPct ?? null,
      rules.trailingStopPct ?? null,
      rules.highWatermarkUsd ?? null,
      Date.now(),
    );
  }

  getExitRules(positionId: number): {
    takeProfitPct: number | null;
    stopLossPct: number | null;
    trailingStopPct: number | null;
    highWatermarkUsd: number | null;
  } | null {
    const row = this.db.prepare(
      "SELECT take_profit_pct AS takeProfitPct, stop_loss_pct AS stopLossPct, " +
      "trailing_stop_pct AS trailingStopPct, high_watermark_usd AS highWatermarkUsd " +
      "FROM position_exit_rules WHERE position_id = ?",
    ).get(positionId) as {
      takeProfitPct: number | null;
      stopLossPct: number | null;
      trailingStopPct: number | null;
      highWatermarkUsd: number | null;
    } | undefined;
    return row ?? null;
  }

  updateHighWatermark(positionId: number, currentUsd: number): void {
    this.db.prepare(
      "UPDATE position_exit_rules SET high_watermark_usd = ?, updated_at = ? " +
      "WHERE position_id = ? AND (high_watermark_usd IS NULL OR high_watermark_usd < ?)",
    ).run(currentUsd, Date.now(), positionId, currentUsd);
  }
}

export interface Position {
  id?: number;
  openedTs: number;
  closedTs?: number | null;
  strategy: string;
  chainId: number;
  sellToken: string;
  buyToken: string;
  buyTokenDecimals?: number | null;
  entryUsd: number;
  /** USD per one whole unit of buyToken at open time. Enables mark-to-market. */
  entryPriceUsd?: number | null;
  exitUsd?: number | null;
  pnlUsd?: number | null;
  openTx?: string | null;
  closeTx?: string | null;
  reasonOpen?: string | null;
  reasonClose?: string | null;
  metadata?: string | null;
}

// ── Opportunities: signals surfaced by the Opportunity Engine ─────────
export interface Opportunity {
  id?: number;
  seenTs: number;
  source: string;              // "predict" | "trending" | "arb" | ...
  kind: string;                // free-form: "binary-mispriced" | "momentum-24h" | ...
  signalId: string;            // stable id from the source (dedupes on rescan)
  title: string;               // one-line summary for the LLM briefing
  edgeUsdEstimate?: number | null;
  confidence?: number | null;  // 0-1
  payload?: string | null;     // JSON — full source-specific data
  actedOn?: number;            // 0 = fresh, 1 = the LLM decided to act on it
  outcome?: string | null;
}
