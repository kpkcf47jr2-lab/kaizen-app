// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Commerce Engine
//
//  Sources for product discovery:
//    - "trending-crypto"  CoinGecko trending — tokens with 24h momentum
//    - "amazon-affiliate" placeholder; wired when owner activates Amazon
//                         Product Advertising API key. Returns empty for now.
//    - "web-search"       Bing Web Search API (free tier 1k/mo) OR DuckDuckGo
//                         HTML endpoint (no key). Uses DDG as MVP fallback.
//    - "predict-markets"  reuses opportunity.scan predict source
//
//  Commerce is deliberately kept as three thin tools:
//    commerce.discoverProducts { query?, categories?, limit? }
//    commerce.analyzeProduct   { productId, source }
//    commerce.createListing    { productId, campaignLabel, priceUsd, notes }
//
//  Persistence: commerce_products + commerce_listings tables in the
//  agent's SQLite. The LLM inspects discovered products, picks one,
//  runs analysis, and creates a listing. Actual sale execution
//  (payment collection, delivery) is handled by downstream flows
//  (kame content + social distribution + billing).
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore } from "../memory/store.js";

const COINGECKO_BASE =
  process.env.KAIZEN_COINGECKO_BASE || "https://api.coingecko.com/api/v3";
const AMAZON_PARTNER_TAG = process.env.KAIZEN_AMAZON_PARTNER_TAG || "";
const AMAZON_API_KEY = process.env.KAIZEN_AMAZON_API_KEY || "";
const BING_SEARCH_KEY = process.env.KAIZEN_BING_SEARCH_KEY || "";

export type CommerceSource =
  | "trending-crypto"
  | "amazon-affiliate"
  | "web-search"
  | "predict-markets";

export interface DiscoveredProduct {
  id: string;                    // source-prefixed unique id
  source: CommerceSource;
  title: string;
  category?: string;
  priceHintUsd?: number;
  demandSignal?: number;         // 0-1, source-specific interpretation
  marginHintPct?: number;        // rough estimate
  url?: string;
  imageUrl?: string;
  raw?: unknown;
}

// ── commerce.discoverProducts ────────────────────────────────────────
export interface DiscoverArgs {
  query?: string;
  sources?: CommerceSource[];
  limit?: number;                // per source, default 8
}
export interface DiscoverResult {
  ok: boolean;
  scanned: CommerceSource[];
  products: DiscoveredProduct[];
  errors?: Record<string, string>;
}

export function makeDiscoverProductsTool(): RegisteredTool<DiscoverArgs, DiscoverResult> {
  const exec: ToolFn<DiscoverArgs, DiscoverResult> = async (args, ctx) => {
    const perSource = Math.min(Math.max(args.limit ?? 8, 1), 30);
    const sources = args.sources && args.sources.length > 0
      ? args.sources
      : (["trending-crypto", "web-search"] as CommerceSource[]);

    const errors: Record<string, string> = {};
    const products: DiscoveredProduct[] = [];

    for (const source of sources) {
      try {
        if (source === "trending-crypto") {
          products.push(...(await discoverTrendingCrypto(perSource)));
        } else if (source === "amazon-affiliate") {
          products.push(...(await discoverAmazon(args.query || "", perSource)));
        } else if (source === "web-search") {
          products.push(...(await discoverWebSearch(args.query || "trending products", perSource)));
        } else if (source === "predict-markets") {
          products.push(...(await discoverPredictMarkets(perSource, args.query)));
        }
      } catch (e) {
        errors[source] = (e as Error).message;
      }
    }

    // Persist to commerce_products (upsert by id)
    const mem = new MemoryStore(ctx.agentId);
    try {
      ensureCommerceTables(mem);
      for (const p of products) {
        upsertProduct(mem, p);
      }
    } finally { mem.close(); }

    return {
      ok: true,
      scanned: sources,
      products,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
  };

  return {
    def: {
      name: "commerce.discoverProducts",
      description:
        "Discover product opportunities across sources: trending crypto tokens, " +
        "Amazon affiliate catalog (if owner has API key), web search for " +
        "trending physical/digital products, and prediction markets as " +
        "'products' (binary contracts). Persists results so subsequent tool " +
        "calls can analyze / list without re-scanning. Read-only, no cost.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, e.g. 'AI productivity tools' or 'meme coin'. Optional for source=trending-crypto.",
          },
          sources: {
            type: "array",
            items: { type: "string", enum: ["trending-crypto", "amazon-affiliate", "web-search", "predict-markets"] },
            description: "Which sources to hit. Default: [trending-crypto, web-search].",
          },
          limit: { type: "number", description: "Max products per source (1-30). Default 8." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "commerce.discoverProducts", level: PermissionLevel.READ_ONLY }),
  };
}

// ── commerce.analyzeProduct ──────────────────────────────────────────
export interface AnalyzeArgs { productId: string }
export interface AnalyzeResult {
  ok: boolean;
  productId: string;
  found: boolean;
  product?: DiscoveredProduct;
  analysis?: {
    marginEstimatePct: number;
    demandScore: number;         // 0-1
    competitionScore: number;    // 0-1 (higher = tougher)
    recommendedActionUsd: number;
    verdict: "GO" | "WAIT" | "SKIP";
    rationale: string;
  };
}

export function makeAnalyzeProductTool(): RegisteredTool<AnalyzeArgs, AnalyzeResult> {
  const exec: ToolFn<AnalyzeArgs, AnalyzeResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      ensureCommerceTables(mem);
      const product = fetchProduct(mem, args.productId);
      if (!product) return { ok: true, productId: args.productId, found: false };

      // Simple scoring — pluggable, keeps the surface honest.
      const demand = product.demandSignal ?? 0.5;
      const competition = estimateCompetition(product);
      const margin = product.marginHintPct ?? defaultMargin(product.source);

      // Verdict logic:
      //   demand high + competition low + margin > 20% → GO
      //   demand mid or competition high → WAIT (needs signal / research)
      //   margin < 10% or demand < 0.2 → SKIP
      let verdict: "GO" | "WAIT" | "SKIP";
      let rationale: string;
      if (margin < 10 || demand < 0.2) {
        verdict = "SKIP";
        rationale = `Thin margins (${margin.toFixed(1)}%) or weak demand (${demand.toFixed(2)}); not worth the effort.`;
      } else if (demand > 0.6 && competition < 0.5 && margin > 20) {
        verdict = "GO";
        rationale = `Strong demand (${demand.toFixed(2)}), open competitive space (${competition.toFixed(2)}), fat margin (${margin.toFixed(1)}%).`;
      } else {
        verdict = "WAIT";
        rationale = `Mixed signal — demand ${demand.toFixed(2)}, competition ${competition.toFixed(2)}, margin ${margin.toFixed(1)}%. Track another cycle.`;
      }

      // Suggested first spend: 2-5% of implied revenue potential capped by
      // policy defaults. Kaizen can override in the createListing call.
      const recommendedActionUsd = Math.min(
        50,
        Math.max(2, (product.priceHintUsd ?? 10) * demand * 0.5),
      );

      return {
        ok: true,
        productId: args.productId,
        found: true,
        product,
        analysis: {
          marginEstimatePct: margin,
          demandScore: demand,
          competitionScore: competition,
          recommendedActionUsd,
          verdict,
          rationale,
        },
      };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "commerce.analyzeProduct",
      description:
        "Analyze a product previously surfaced by commerce.discoverProducts. " +
        "Estimates margin, demand, competition, and returns a GO/WAIT/SKIP " +
        "verdict + recommended first-spend size. Read-only, no external API " +
        "calls (uses cached product data). Call this before createListing.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        required: ["productId"],
        properties: {
          productId: { type: "string", description: "id from commerce.discoverProducts result." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "commerce.analyzeProduct", level: PermissionLevel.READ_ONLY }),
  };
}

// ── commerce.createListing ───────────────────────────────────────────
export interface CreateListingArgs {
  productId: string;
  campaignLabel: string;         // used for tracking + reinvest strategy
  priceUsd: number;
  notes?: string;
}
export interface CreateListingResult {
  ok: true;
  listingId: number;
  productId: string;
  campaignLabel: string;
  priceUsd: number;
}

export function makeCreateListingTool(): RegisteredTool<CreateListingArgs, CreateListingResult> {
  const exec: ToolFn<CreateListingArgs, CreateListingResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      ensureCommerceTables(mem);
      const p = fetchProduct(mem, args.productId);
      if (!p) throw new Error(`Product ${args.productId} not found. Run commerce.discoverProducts first.`);
      const listingId = insertListing(mem, {
        productId: args.productId,
        campaignLabel: args.campaignLabel,
        priceUsd: args.priceUsd,
        notes: args.notes ?? null,
      });
      mem.recordEvent({
        ts: Date.now(),
        kind: "capital_allocation",
        strategy: args.campaignLabel,
        amountUsd: 0,   // listing is intent — actual spend comes via kame / social
        reason: `Listing created for ${p.title}`,
        metadata: JSON.stringify({ listingId, productId: args.productId, priceUsd: args.priceUsd }),
      });
      return { ok: true, listingId, productId: args.productId, campaignLabel: args.campaignLabel, priceUsd: args.priceUsd };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "commerce.createListing",
      description:
        "Create a commerce listing for a discovered product. This is the " +
        "book-of-record entry; the actual go-to-market (kame content + " +
        "social publish + billing) happens via subsequent tool calls, all " +
        "bound to the same campaignLabel so ROAS attribution works.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["productId", "campaignLabel", "priceUsd"],
        properties: {
          productId: { type: "string", description: "Product from discoverProducts." },
          campaignLabel: {
            type: "string",
            description: "Stable label to attribute spend + revenue to this listing (e.g. 'ai-copy-tool-v1').",
          },
          priceUsd: { type: "number", description: "Your sale price to end user in USD." },
          notes: { type: "string", description: "Optional freeform notes." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "commerce.createListing", level: PermissionLevel.ZERO_COST }),
  };
}

// ── source scanners ──────────────────────────────────────────────────

async function discoverTrendingCrypto(limit: number): Promise<DiscoveredProduct[]> {
  const url = `${COINGECKO_BASE.replace(/\/$/, "")}/search/trending`;
  const res = await fetchWithTimeout(url, 10_000);
  const data = (await res.json().catch(() => ({}))) as { coins?: Array<{ item?: {
    id?: string; name?: string; symbol?: string; market_cap_rank?: number;
    data?: { price_change_percentage_24h?: { usd?: number } };
    thumb?: string;
  } }> };
  return (data.coins ?? []).slice(0, limit).map((c) => {
    const it = c.item ?? {};
    const chg = it.data?.price_change_percentage_24h?.usd ?? 0;
    // Demand for trending crypto: normalized momentum (25% cap)
    const demand = Math.max(0, Math.min(1, (chg + 25) / 50));
    return {
      id: `crypto:${it.id ?? it.symbol ?? Math.random().toString(36).slice(2)}`,
      source: "trending-crypto" as const,
      title: `${it.name ?? it.symbol ?? "?"} (${(it.symbol ?? "?").toUpperCase()})`,
      category: "crypto",
      demandSignal: demand,
      marginHintPct: 0, // spot trading — no built-in margin, LLM decides
      url: `https://www.coingecko.com/en/coins/${it.id ?? ""}`,
      imageUrl: it.thumb,
      raw: it,
    };
  });
}

async function discoverAmazon(query: string, limit: number): Promise<DiscoveredProduct[]> {
  // Amazon Product Advertising API requires: partner tag, access key, secret,
  // + signed HMAC request. Owner has NOT enabled affiliate yet. Return empty
  // gracefully so the flow keeps working with other sources.
  if (!AMAZON_PARTNER_TAG || !AMAZON_API_KEY) return [];
  // Full implementation lands when owner shares Amazon Affiliate credentials.
  // Placeholder to prevent silent failure:
  throw new Error("Amazon Affiliate credentials configured but API integration pending owner scope");
}

interface DdgResult {
  title?: string;
  href?: string;
  body?: string;
}
async function discoverWebSearch(query: string, limit: number): Promise<DiscoveredProduct[]> {
  // Bing preferred (structured JSON). Fallback: DDG HTML endpoint scraped
  // via a simple regex. MVP keeps DDG as the zero-key path.
  if (BING_SEARCH_KEY) {
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query + " trending product")}&count=${limit}`;
    const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": BING_SEARCH_KEY } });
    const data = (await res.json().catch(() => ({}))) as { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> } };
    return (data.webPages?.value ?? []).slice(0, limit).map((v, i) => ({
      id: `web:${hashKey(v.url ?? String(i))}`,
      source: "web-search" as const,
      title: v.name ?? v.url ?? "?",
      category: "general",
      demandSignal: 0.5,           // Web-search demand is unknowable without more signal
      marginHintPct: 30,           // Assume 30% default for physical/digital resell
      url: v.url,
      raw: v,
    }));
  }

  // DuckDuckGo HTML endpoint — no key needed. Fragile but zero-config.
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query + " trending product to sell")}`;
  const res = await fetchWithTimeout(url, 10_000, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenBot/0.1)" },
  });
  const html = await res.text();
  // Very small regex-based parser — DDG HTML is fragile but works enough for MVP.
  const results: DdgResult[] = [];
  const re = /<a\s+class="result__a"\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < limit) {
    results.push({ href: decodeURIComponent(m[1].replace(/^\/l\/\?uddg=/, "").replace(/&.*$/, "")), title: m[2] });
  }
  return results.map((r, i) => ({
    id: `web:${hashKey(r.href ?? String(i))}`,
    source: "web-search" as const,
    title: r.title ?? "?",
    category: "general",
    demandSignal: 0.5,
    marginHintPct: 30,
    url: r.href,
    raw: r,
  }));
}

async function discoverPredictMarkets(limit: number, query?: string): Promise<DiscoveredProduct[]> {
  const PREDICT_BASE =
    process.env.KAIROS_PREDICT_BASE || "https://api.kairos777.com/api/predict";
  const q = query ? `&q=${encodeURIComponent(query)}` : "";
  const url = `${PREDICT_BASE.replace(/\/$/, "")}/markets?limit=${limit}${q}`;
  const res = await fetchWithTimeout(url, 12_000);
  const data = (await res.json().catch(() => ({}))) as {
    markets?: Array<{ id?: string; title?: string; outcomes?: Array<{ price?: number }>; volume24hUsd?: number; url?: string }>;
    data?: { markets?: Array<{ id?: string; title?: string; outcomes?: Array<{ price?: number }>; volume24hUsd?: number; url?: string }> };
  };
  const markets = data.markets ?? data.data?.markets ?? [];
  return markets.slice(0, limit).map((m, i) => ({
    id: `predict:${m.id ?? i}`,
    source: "predict-markets" as const,
    title: m.title ?? "?",
    category: "prediction",
    priceHintUsd: (m.outcomes?.[0]?.price ?? 0.5) * 100,
    demandSignal: Math.min(1, (m.volume24hUsd ?? 0) / 100_000),
    marginHintPct: 0,
    url: m.url,
    raw: m,
  }));
}

// ── analysis helpers ─────────────────────────────────────────────────

function estimateCompetition(p: DiscoveredProduct): number {
  // Extremely rough: crypto = highly competitive. Web/general = moderate.
  // Predict = source-defined by volume (bigger = crowded).
  if (p.source === "trending-crypto") return 0.8;
  if (p.source === "predict-markets") return Math.min(1, 0.3 + (p.demandSignal ?? 0.5));
  if (p.source === "amazon-affiliate") return 0.7;
  return 0.5;
}

function defaultMargin(source: CommerceSource): number {
  switch (source) {
    case "amazon-affiliate": return 4;   // Amazon Associates rate ~4-8%
    case "trending-crypto":  return 0;   // Spot only
    case "predict-markets":  return 0;
    case "web-search":       return 30;  // Digital resell placeholder
  }
}

// ── DB schema for commerce ───────────────────────────────────────────

function ensureCommerceTables(mem: MemoryStore): void {
  // We piggy-back on the MemoryStore's raw db via a wrapper, but the store
  // hides it. Add a lazy migration by executing a raw pragma once via the
  // facts table as a marker. For simplicity we use SQL as a facts value.
  // (Proper fix: expose a `runMigration` on MemoryStore. Deferred.)
  const marker = mem.getFact("__migrations_commerce_v1");
  if (marker === "done") return;
  // Since MemoryStore doesn't expose raw db, we set the fact + rely on the
  // migrations we bake into store.ts. For now, add commerce tables to
  // store.ts.migrate() and just mark done here.
  mem.setFact("__migrations_commerce_v1", "done");
}

interface StoredProduct extends DiscoveredProduct { seenTs: number }

function upsertProduct(mem: MemoryStore, p: DiscoveredProduct): void {
  const stored: StoredProduct = { ...p, seenTs: Date.now() };
  mem.setFact(`commerce:product:${p.id}`, JSON.stringify(stored));
}

function fetchProduct(mem: MemoryStore, id: string): StoredProduct | null {
  const raw = mem.getFact(`commerce:product:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredProduct; } catch { return null; }
}

function insertListing(
  mem: MemoryStore,
  l: { productId: string; campaignLabel: string; priceUsd: number; notes: string | null },
): number {
  // MVP: store listings as facts too (`commerce:listing:{id}`). id = incr counter fact.
  const counterKey = "commerce:listing_counter";
  const prev = Number(mem.getFact(counterKey) ?? "0");
  const id = prev + 1;
  mem.setFact(counterKey, String(id));
  mem.setFact(`commerce:listing:${id}`, JSON.stringify({
    ...l,
    id,
    createdTs: Date.now(),
    status: "draft",
  }));
  return id;
}

// ── util ─────────────────────────────────────────────────────────────

function hashKey(input: string): string {
  // Cheap non-crypto hash (FNV-1a 32-bit).
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...(init ?? {}), signal: ctrl.signal });
  } finally { clearTimeout(t); }
}
