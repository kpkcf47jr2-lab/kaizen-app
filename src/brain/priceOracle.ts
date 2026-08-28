// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Price Oracle
//
//  Two price paths:
//    1. CoinGecko simple price (for tokens with a stable coingecko id).
//       Cached 60s to avoid rate limits (free tier ~30 req/min).
//    2. Kairos Router quote (on-chain, always fresh) — asks the router
//       "how much USDC does N units of {tokenAddress} give me?" and
//       divides. Works for ANY ERC-20 with liquidity on Polygon/Base.
//
//  Both paths return { usd: number, source: string, ts: number }.
//  The scheduler uses this to mark open positions to market for exit
//  rule evaluation.
// ═══════════════════════════════════════════════════════════════════════

const COINGECKO_BASE =
  process.env.KAIZEN_COINGECKO_BASE || "https://api.coingecko.com/api/v3";
const ROUTER_BASE =
  process.env.KAIROS_ROUTER_BASE || "https://api.kairos777.com/api/router";

const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const USDC_BY_CHAIN: Record<number, { address: string; decimals: number }> = {
  137:  { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  8453: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
};

export interface Price {
  usd: number;
  source: "coingecko" | "router" | "cache";
  ts: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, Price>();

function cacheGet(key: string): Price | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) return null;
  return { ...hit, source: "cache" };
}
function cacheSet(key: string, p: Price): void {
  cache.set(key, { ...p });
}

// ── CoinGecko simple price ───────────────────────────────────────────
/** id examples: "ethereum", "matic-network", "bitcoin". */
export async function coingeckoUsd(id: string): Promise<Price> {
  const key = `cg:${id}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const url = `${COINGECKO_BASE.replace(/\/$/, "")}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
  const res = await fetchWithTimeout(url, 10_000);
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number }>;
  const usd = data?.[id]?.usd;
  if (!usd || !Number.isFinite(usd)) throw new Error(`coingecko no price for ${id}`);
  const price: Price = { usd, source: "coingecko", ts: Date.now() };
  cacheSet(key, price);
  return price;
}

// ── Kairos Router quote → derived USD price ─────────────────────────
/** Quote 1 unit of tokenAddress → USDC on the given chain, return the USDC out. */
export async function routerUsdc(
  chainId: number,
  tokenAddress: string,
  tokenDecimals: number,
): Promise<Price> {
  const key = `router:${chainId}:${tokenAddress.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const usdc = USDC_BY_CHAIN[chainId];
  if (!usdc) throw new Error(`no USDC config for chain ${chainId}`);
  if (tokenAddress.toLowerCase() === usdc.address.toLowerCase()) {
    // USDC → USDC → 1.
    const price: Price = { usd: 1, source: "router", ts: Date.now() };
    cacheSet(key, price);
    return price;
  }
  // Sell 1 whole token.
  const sellAmountWei = BigInt(10 ** tokenDecimals).toString();
  const url =
    `${ROUTER_BASE.replace(/\/$/, "")}/quote?chainId=${chainId}` +
    `&sellToken=${tokenAddress}&buyToken=${usdc.address}` +
    `&sellAmount=${sellAmountWei}`;
  const res = await fetchWithTimeout(url, 15_000);
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: { bestBuyAmount?: string; buyAmount?: string };
    error?: string;
  };
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `router ${res.status}`);
  }
  const buyAmountStr = body.data?.bestBuyAmount ?? body.data?.buyAmount;
  if (!buyAmountStr) throw new Error("router: no buyAmount in response");
  const usd = Number(buyAmountStr) / (10 ** usdc.decimals);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`router: implausible price ${usd}`);
  const price: Price = { usd, source: "router", ts: Date.now() };
  cacheSet(key, price);
  return price;
}

/**
 * Best-effort USD price for a chain-native token by chainId.
 * Polygon 137 native = POL (coingecko id "matic-network"),
 * Base 8453 native = ETH ("ethereum").
 */
export async function nativeUsd(chainId: number): Promise<Price> {
  const cgId = chainId === 137 ? "matic-network"
    : chainId === 8453 ? "ethereum"
    : chainId === 1 ? "ethereum"
    : null;
  if (!cgId) throw new Error(`no coingecko id for native of chain ${chainId}`);
  return coingeckoUsd(cgId);
}

// ── Mark-to-market a position ──────────────────────────────────────
/**
 * Given the entry snapshot + fresh price, return the current USDC value
 * and ROI. entryPriceUsd is per-unit-of-token at open time; without it we
 * can't compute a true mark and return NaN so callers know to skip.
 */
export async function markPositionUsd(input: {
  chainId: number;
  buyToken: string;
  buyTokenDecimals: number;
  entryUsd: number;
  entryPriceUsd: number | null | undefined;
}): Promise<{ currentUsd: number; roiPct: number; currentPriceUsd: number } | null> {
  if (!input.entryPriceUsd || input.entryPriceUsd <= 0) return null;
  let price: Price;
  try {
    price = await routerUsdc(input.chainId, input.buyToken, input.buyTokenDecimals);
  } catch {
    return null; // router unavailable — caller keeps waiting
  }
  const ratio = price.usd / input.entryPriceUsd;
  const currentUsd = input.entryUsd * ratio;
  const roiPct = (ratio - 1) * 100;
  return { currentUsd, roiPct, currentPriceUsd: price.usd };
}

// ── util ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...(init ?? {}), signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

export { NATIVE_SENTINEL };
