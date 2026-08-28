// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Opportunity Discovery Engine
//
//  Kaizen scans multiple sources for actionable signals and persists
//  them (deduped by source+signalId). The LLM can then rank / act.
//
//  Sources:
//    - "predict"  : Kalshi + Polymarket via Kairos Predict Aggregator.
//                   Signal = binary market with recent price move.
//    - "trending" : CoinGecko free /search/trending. Signal = token
//                   trending in the last 24h.
//    - "arb"      : (stub) cross-DEX spreads. Wired later when we have
//                   a second router quote source.
//
//  Kaizen calls opportunity.scan to refresh. opportunity.recent shows
//  what's been seen without hitting external APIs. Every actioned
//  opportunity gets marked so we don't re-propose it.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore, type Opportunity } from "../memory/store.js";

const PREDICT_BASE =
  process.env.KAIROS_PREDICT_BASE || "https://api.kairos777.com/api/predict";
const COINGECKO_BASE =
  process.env.KAIZEN_COINGECKO_BASE || "https://api.coingecko.com/api/v3";

// ── opportunity.scan ─────────────────────────────────────────────────
export interface ScanArgs {
  sources?: Array<"predict" | "trending">;
  limit?: number;             // per source, default 10
}

export interface ScanResult {
  ok: boolean;
  scanned: string[];
  newCount: number;           // opportunities inserted (not duplicates)
  totalReturned: number;      // opportunities across all sources this scan
  opportunities: Opportunity[];
  errors?: Record<string, string>;
}

export function makeScanTool(): RegisteredTool<ScanArgs, ScanResult> {
  const exec: ToolFn<ScanArgs, ScanResult> = async (args, ctx) => {
    const sources = args.sources && args.sources.length > 0
      ? args.sources
      : (["predict", "trending"] as const);
    const perSource = Math.min(Math.max(args.limit ?? 10, 1), 50);

    const errors: Record<string, string> = {};
    const collected: Array<Omit<Opportunity, "id" | "actedOn" | "outcome">> = [];

    if (sources.includes("predict")) {
      try {
        collected.push(...(await scanPredict(perSource)));
      } catch (e) { errors.predict = (e as Error).message; }
    }
    if (sources.includes("trending")) {
      try {
        collected.push(...(await scanTrending(perSource)));
      } catch (e) { errors.trending = (e as Error).message; }
    }

    // Persist (dedupe by source+signalId)
    let newCount = 0;
    const mem = new MemoryStore(ctx.agentId);
    try {
      for (const o of collected) {
        const id = mem.recordOpportunity(o);
        if (id > 0) newCount++;
      }
      const list = mem.recentOpportunities(perSource * sources.length, false);
      return {
        ok: true,
        scanned: [...sources],
        newCount,
        totalReturned: list.length,
        opportunities: list,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
      };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "opportunity.scan",
      description:
        "Refresh the Opportunity Board by pulling signals from external " +
        "sources (predict markets, trending crypto). Deduplicates by " +
        "signalId. Returns the current opportunity list (fresh + previously " +
        "seen but not yet acted on). Use before deciding what to work on.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: { type: "string", enum: ["predict", "trending"] },
            description: "Which sources to hit. Default: all.",
          },
          limit: {
            type: "number",
            description: "Max signals per source (1-50). Default 10.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "opportunity.scan", level: PermissionLevel.READ_ONLY }),
  };
}

// ── opportunity.recent ───────────────────────────────────────────────
export interface RecentArgs {
  limit?: number;
  unactedOnly?: boolean;
}
export interface RecentResult {
  opportunities: Opportunity[];
}

export function makeRecentTool(): RegisteredTool<RecentArgs, RecentResult> {
  const exec: ToolFn<RecentArgs, RecentResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const opps = mem.recentOpportunities(args.limit ?? 20, args.unactedOnly ?? true);
      return { opportunities: opps };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "opportunity.recent",
      description:
        "List opportunities already stored (does NOT call external APIs). " +
        "By default filters to unacted ones. Cheap; use in the middle of a " +
        "tick when you already have a scan and just want to re-inspect.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max rows, 1-100. Default 20." },
          unactedOnly: {
            type: "boolean",
            description: "true = only opportunities not yet marked acted (default).",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "opportunity.recent", level: PermissionLevel.READ_ONLY }),
  };
}

// ── opportunity.markActed ────────────────────────────────────────────
export interface MarkActedArgs {
  opportunityId: number;
  outcome: string;             // short label: "opened_position", "skipped_low_edge"
}
export interface MarkActedResult { ok: true; opportunityId: number }

export function makeMarkActedTool(): RegisteredTool<MarkActedArgs, MarkActedResult> {
  const exec: ToolFn<MarkActedArgs, MarkActedResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.markOpportunityActed(args.opportunityId, args.outcome);
      return { ok: true, opportunityId: args.opportunityId };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "opportunity.markActed",
      description:
        "Mark an opportunity as acted-on so it doesn't appear in future " +
        "unactedOnly lists. Set a short outcome label (e.g. 'opened_position', " +
        "'skipped_low_edge', 'stale_price'). Call this after you decide what " +
        "to do with an opportunity — whether you pursued it or dropped it.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["opportunityId", "outcome"],
        properties: {
          opportunityId: { type: "number", description: "opportunities.id" },
          outcome: {
            type: "string",
            description: "Short label describing what you did.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "opportunity.markActed", level: PermissionLevel.ZERO_COST }),
  };
}

// ── source scanners ──────────────────────────────────────────────────

interface PredictApiMarket {
  id?: string;
  title?: string;
  source?: string;
  outcomes?: Array<{ label: string; price: number }>;
  volume24hUsd?: number;
  priceMove24hPct?: number;
  url?: string;
}

async function scanPredict(limit: number): Promise<Array<Omit<Opportunity, "id" | "actedOn" | "outcome">>> {
  const url = `${PREDICT_BASE.replace(/\/$/, "")}/markets?limit=${limit}&minMove=5`;
  const res = await fetchWithTimeout(url, 15_000);
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    markets?: PredictApiMarket[];
    data?: { markets?: PredictApiMarket[] };
    error?: string;
  };
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const markets = data.markets ?? data.data?.markets ?? [];
  const now = Date.now();

  return markets.slice(0, limit).map((m) => {
    const source = m.source ?? "unknown";
    const signalId = `${source}:${m.id ?? m.title ?? Math.random().toString(36).slice(2)}`;
    const leadPrice = m.outcomes?.[0]?.price ?? 0.5;
    // Rough edge estimate: |0.5 - leadPrice| × volume × 0.001 (arbitrary
    // scaling — the LLM re-evaluates anyway; this is just a rank hint).
    const edge = Math.abs(0.5 - leadPrice) * (m.volume24hUsd ?? 100) * 0.001;
    return {
      seenTs: now,
      source: "predict",
      kind: "binary-mispriced",
      signalId,
      title: `[${source}] ${m.title ?? signalId} · lead ${(leadPrice * 100).toFixed(0)}% · vol $${(m.volume24hUsd ?? 0).toFixed(0)} · Δ24h ${(m.priceMove24hPct ?? 0).toFixed(1)}%`,
      edgeUsdEstimate: edge,
      confidence: null,
      payload: JSON.stringify(m),
    };
  });
}

interface CoinGeckoTrendItem {
  item?: {
    id?: string;
    name?: string;
    symbol?: string;
    market_cap_rank?: number;
    price_btc?: number;
    data?: {
      price_change_percentage_24h?: { usd?: number };
      total_volume?: string;
    };
  };
}

async function scanTrending(limit: number): Promise<Array<Omit<Opportunity, "id" | "actedOn" | "outcome">>> {
  const url = `${COINGECKO_BASE.replace(/\/$/, "")}/search/trending`;
  const res = await fetchWithTimeout(url, 10_000);
  const data = (await res.json().catch(() => ({}))) as { coins?: CoinGeckoTrendItem[] };
  const now = Date.now();
  return (data.coins ?? []).slice(0, limit).map((c) => {
    const it = c.item ?? {};
    const change = it.data?.price_change_percentage_24h?.usd ?? 0;
    const signalId = `coingecko:${it.id ?? it.symbol ?? Math.random().toString(36).slice(2)}`;
    return {
      seenTs: now,
      source: "trending",
      kind: "momentum-24h",
      signalId,
      title: `[trending] ${it.name ?? it.symbol ?? "?"} (${(it.symbol ?? "?").toUpperCase()}) · rank #${it.market_cap_rank ?? "?"} · Δ24h ${change.toFixed(1)}%`,
      edgeUsdEstimate: null,   // no meaningful edge without our own liquidity depth
      confidence: null,
      payload: JSON.stringify(it),
    };
  });
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally { clearTimeout(t); }
}
