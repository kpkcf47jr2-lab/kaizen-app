import React, { useCallback, useEffect, useState } from "react";
import { api, type AgentDetail, type AgentRecord, type EconomicEvent, type TickResult } from "./api.js";

export function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [events, setEvents] = useState<EconomicEvent[]>([]);
  const [tick, setTick] = useState<TickResult | null>(null);
  const [busy, setBusy] = useState<"none" | "loading" | "ticking" | "creating">("none");
  const [err, setErr] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    setErr(null);
    try {
      const { agents } = await api.listAgents();
      setAgents(agents);
      if (!selected && agents.length > 0) setSelected(agents[0].agentId);
    } catch (e) { setErr((e as Error).message); }
  }, [selected]);

  const refreshDetail = useCallback(async () => {
    if (!selected) { setDetail(null); setEvents([]); return; }
    setBusy("loading"); setErr(null);
    try {
      const [d, ev] = await Promise.all([api.agent(selected), api.events(selected, 20)]);
      setDetail(d);
      setEvents(ev.events);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy("none"); }
  }, [selected]);

  useEffect(() => { refreshList(); }, [refreshList]);
  useEffect(() => { refreshDetail(); }, [refreshDetail]);

  const create = async () => {
    const name = window.prompt("Display name for the new agent?", "Kaizen #" + (agents.length + 1));
    if (!name) return;
    setBusy("creating"); setErr(null);
    try {
      const created = await api.createAgent(name);
      await refreshList();
      setSelected(created.agentId);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy("none"); }
  };

  const runTick = async () => {
    if (!selected) return;
    setBusy("ticking"); setErr(null); setTick(null);
    try {
      const t = await api.tick(selected);
      setTick(t);
      await refreshDetail();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy("none"); }
  };

  const changeSchedule = async (enabled: boolean, intervalSeconds: number) => {
    if (!selected) return;
    setErr(null);
    try {
      await api.schedule(selected, enabled, intervalSeconds);
      await refreshDetail();
      await refreshList();
    } catch (e) { setErr((e as Error).message); }
  };

  // Poll detail every 15s when auto-tick is enabled so the dashboard
  // reflects the scheduler's activity without manual refresh.
  useEffect(() => {
    if (!detail?.record.autoTick?.enabled) return;
    const t = setInterval(() => { refreshDetail(); }, 15000);
    return () => clearInterval(t);
  }, [detail?.record.autoTick?.enabled, refreshDetail]);

  return (
    <div className="shell">
      <h1>Kaizen</h1>
      <div className="sub">
        Autonomous Entrepreneur AI · Kaizen LLC · Fase 1 MVP dashboard
      </div>

      {err && <div className="panel" style={{ borderColor: "var(--bad)" }}>
        <div className="row"><span className="dot err" /> {err}</div>
      </div>}

      <div className="panel">
        <h2>Agents</h2>
        <div className="row">
          {agents.length === 0 && <span className="empty">No agents yet</span>}
          {agents.map(a => (
            <button
              key={a.agentId}
              className={a.agentId === selected ? "" : "ghost"}
              onClick={() => setSelected(a.agentId)}
            >
              {a.displayName} <span className={`status ${a.status}`} style={{ marginLeft: 8 }}>{a.status}</span>
            </button>
          ))}
          <button className="ghost" onClick={create} disabled={busy !== "none"}>
            {busy === "creating" ? "Creating…" : "+ New agent"}
          </button>
        </div>
      </div>

      {detail && (
        <AgentPanel
          detail={detail}
          onTick={runTick}
          ticking={busy === "ticking"}
          tick={tick}
          onScheduleChange={changeSchedule}
        />
      )}
      {detail && <EventsPanel events={events} />}
    </div>
  );
}

function AgentPanel({ detail, onTick, ticking, tick, onScheduleChange }: {
  detail: AgentDetail; onTick: () => void; ticking: boolean; tick: TickResult | null;
  onScheduleChange: (enabled: boolean, intervalSeconds: number) => void;
}): JSX.Element {
  const s = detail.snapshot;
  const b = detail.budget;
  const autoTick = detail.record.autoTick;
  const enabled = !!autoTick?.enabled;
  const interval = autoTick?.intervalSeconds ?? 300;
  const lastTick = autoTick?.lastTickTs
    ? new Date(autoTick.lastTickTs).toISOString().slice(11, 19) + " UTC"
    : "never";
  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{detail.record.displayName}</div>
            <div className="address">{detail.record.address}</div>
          </div>
          <div className="row">
            <span className={`status ${detail.record.status}`}>{detail.record.status}</span>
            <button onClick={onTick} disabled={ticking}>
              {ticking ? "Ticking…" : "Run tick"}
            </button>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 12 }}>
          <button
            className={enabled ? "" : "ghost"}
            onClick={() => onScheduleChange(!enabled, interval)}
          >
            {enabled ? "● Auto-tick ON" : "○ Auto-tick OFF"}
          </button>
          <label style={{ color: "var(--muted)", fontSize: 12 }}>
            every&nbsp;
            <select
              value={interval}
              onChange={(e) => onScheduleChange(enabled, Number(e.target.value))}
              style={{ background: "var(--panel-alt)", color: "var(--text)", border: "1px solid var(--border)", padding: "4px 8px", borderRadius: 6, fontFamily: "var(--font-mono)", fontSize: 12 }}
            >
              <option value={60}>1 min</option>
              <option value={300}>5 min</option>
              <option value={900}>15 min</option>
              <option value={1800}>30 min</option>
              <option value={3600}>1 hour</option>
            </select>
            &nbsp;· last: {lastTick}
          </label>
        </div>
      </div>

      <div className="panel">
        <h2>Balance sheet</h2>
        <div className="kv">
          <div><span className="label">Net worth</span><span className="value">${s.netWorthUsd.toFixed(2)}</span></div>
          <div><span className="label">Cash USDC</span><span className="value">${s.cashUsd.toFixed(2)}</span></div>
          <div><span className="label">Gas POL</span><span className="value">${s.gasReserveUsd.toFixed(2)}</span></div>
          <div><span className="label">Invested</span><span className="value">${s.investedUsd.toFixed(2)}</span></div>
          <div><span className="label">Peak</span><span className="value">${s.peakNetWorthUsd.toFixed(2)}</span></div>
          <div><span className="label">Drawdown</span><span className="value">{s.drawdownPct.toFixed(1)}%</span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Budget proposal for {detail.record.status}</h2>
        <div className="kv">
          <div><span className="label">Reserve</span><span className="value">${b.reserveUsd}</span></div>
          <div><span className="label">Trading</span><span className="value">${b.tradingUsd}</span></div>
          <div><span className="label">Marketing</span><span className="value">${b.marketingUsd}</span></div>
          <div><span className="label">Product</span><span className="value">${b.productAcquisitionUsd}</span></div>
          <div><span className="label">Infrastructure</span><span className="value">${b.infrastructureUsd}</span></div>
          <div><span className="label">Experimentation</span><span className="value">${b.experimentationUsd}</span></div>
        </div>
      </div>

      {tick && <TickPanel tick={tick} />}
    </>
  );
}

function TickPanel({ tick }: { tick: TickResult }): JSX.Element {
  const o = tick.outcome;
  const badgeClass =
    o.kind === "tool_call"     ? "status GROWING" :
    o.kind === "tool_rejected" ? "status DEFENSIVE" :
    o.kind === "tool_failed"   ? "status CRITICAL" :
                                 "status STABLE";
  return (
    <div className="panel">
      <h2>Last tick</h2>
      <div className="row">
        <span className={badgeClass}>{o.kind}</span>
        {o.tool && <span className="address">{o.tool}</span>}
        {tick.usage && (
          <span className="address">tokens: {tick.usage.prompt}/{tick.usage.completion}</span>
        )}
      </div>
      {tick.llmContent && (
        <div style={{ marginTop: 10, whiteSpace: "pre-wrap", color: "var(--muted)", fontSize: 12 }}>
          {tick.llmContent}
        </div>
      )}
      {o.kind === "waited" && o.reason && (
        <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 12 }}>
          Waited: {o.reason}
        </div>
      )}
      {o.kind === "tool_rejected" && (
        <div style={{ marginTop: 10, color: "var(--warn)", fontSize: 12 }}>
          Policy rejected: {o.reason}
        </div>
      )}
      {o.kind === "tool_failed" && (
        <div style={{ marginTop: 10, color: "var(--bad)", fontSize: 12 }}>
          Failed: {o.error}
        </div>
      )}
      {o.kind === "tool_call" && (
        <pre className="tool-result">{JSON.stringify(o.result, null, 2)}</pre>
      )}
    </div>
  );
}

function EventsPanel({ events }: { events: EconomicEvent[] }): JSX.Element {
  return (
    <div className="panel">
      <h2>Recent events</h2>
      {events.length === 0
        ? <div className="empty">No events yet — run a tick or fund the wallet to generate activity.</div>
        : (
          <div className="list">
            {events.map(e => (
              <div key={e.id} className="item">
                <span className="ts">{new Date(e.ts).toISOString().replace("T", " ").slice(0, 19)}</span>
                <span className="kind">{e.kind}</span>
                {e.amountUsd != null && <span>${e.amountUsd.toFixed(2)} · </span>}
                {e.reason}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
