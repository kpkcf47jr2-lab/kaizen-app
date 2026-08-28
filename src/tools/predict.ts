// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Predict tools
//
//  The Kairos Predict Aggregator (LIVE at
//  api.kairos777.com/api/predict) surfaces markets from Polymarket +
//  Kalshi with normalized YES/NO prices. Kaizen reads the current
//  book to look for edges — big price moves, mispriced binary
//  outcomes, news-driven volatility.
//
//  Read-only for MVP. Actually placing a bet requires a separate
//  Bridge integration (Predict USDC via KairosPredictPolygon) which
//  ships in a later batch.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";

const PREDICT_BASE =
  process.env.KAIROS_PREDICT_BASE || "https://api.kairos777.com/api/predict";

// ── predict.list ─────────────────────────────────────────────────────
export interface PredictListArgs {
  q?: string;                    // search query
  limit?: number;                // default 20
  minVolumeUsd?: number;         // filter out tiny markets
  minPriceMovePct?: number;      // 24h price move filter (edge signal)
}

export interface PredictMarket {
  id: string;
  source: "polymarket" | "kalshi" | string;
  title: string;
  outcomes: Array<{ label: string; price: number }>;   // 0-1 prob
  volume24hUsd?: number;
  priceMove24hPct?: number;
  endsAt?: string;
  url?: string;
}

export interface PredictListResult {
  ok: boolean;
  markets?: PredictMarket[];
  error?: string;
}

export function makePredictListTool(): RegisteredTool<PredictListArgs, PredictListResult> {
  const exec: ToolFn<PredictListArgs, PredictListResult> = async (args) => {
    const params = new URLSearchParams();
    if (args.q) params.set("q", args.q);
    params.set("limit", String(Math.min(Math.max(args.limit ?? 20, 1), 100)));
    if (args.minVolumeUsd) params.set("minVolume", String(args.minVolumeUsd));
    if (args.minPriceMovePct) params.set("minMove", String(args.minPriceMovePct));

    const url = `${PREDICT_BASE.replace(/\/$/, "")}/markets?${params}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        markets?: PredictMarket[];
        data?: { markets?: PredictMarket[] };
      };
      if (!res.ok || data.success === false) {
        return { ok: false, error: data.error || `HTTP ${res.status}` };
      }
      const markets = data.markets ?? data.data?.markets ?? [];
      return { ok: true, markets };
    } finally { clearTimeout(t); }
  };

  return {
    def: {
      name: "predict.list",
      description:
        "List prediction markets (Polymarket + Kalshi) via the Kairos Predict " +
        "Aggregator. Read-only, no cost. Use to scan for pricing anomalies, " +
        "news-driven moves, or short-timeframe binaries with edge.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: "Optional search query (e.g. 'election', 'BTC', 'super bowl').",
          },
          limit: {
            type: "number",
            description: "Max markets to return, 1-100. Default 20.",
          },
          minVolumeUsd: {
            type: "number",
            description: "Skip markets with lower 24h volume than this.",
          },
          minPriceMovePct: {
            type: "number",
            description: "Only surface markets whose lead-outcome price moved ≥N% in 24h.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "predict.list", level: PermissionLevel.READ_ONLY }),
  };
}
