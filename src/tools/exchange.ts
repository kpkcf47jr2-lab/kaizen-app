// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Exchange tools
//
//  Bridges to the Kairos 777 Inc Smart Order Router at
//  api.kairos777.com/api/router. Read-only quote for now — swap
//  execution goes through the Secure Wallet Service later.
//
//  All quotes are on Polygon 137 USDC because that's the only chain
//  in HARD_LIMITS.ALLOWED_CHAINS for MVP.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";

const ROUTER_BASE = process.env.KAIROS_ROUTER_BASE || "https://api.kairos777.com/api/router";
const POLYGON_CHAIN_ID = 137;
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// ── exchange.quote ───────────────────────────────────────────────────
export interface QuoteArgs {
  sellToken: string;             // ERC-20 address, or "native"
  buyToken: string;              // same
  sellAmount: number;            // human units
  sellDecimals: number;
}

export interface QuoteResult {
  ok: boolean;
  chain: "Polygon";
  best?: {
    dex: string;
    buyAmount: number;
    priceImpactPct: number;
    feeUsdEstimate: number;
  };
  error?: string;
  raw?: unknown;
}

export function makeQuoteTool(): RegisteredTool<QuoteArgs, QuoteResult> {
  const exec: ToolFn<QuoteArgs, QuoteResult> = async (args) => {
    const sell = args.sellToken === "native" ? NATIVE : args.sellToken;
    const buy = args.buyToken === "native" ? NATIVE : args.buyToken;
    const wei = BigInt(Math.floor(args.sellAmount * 10 ** args.sellDecimals)).toString();
    const url =
      `${ROUTER_BASE}/quote?chainId=${POLYGON_CHAIN_ID}` +
      `&sellToken=${sell}&buyToken=${buy}&sellAmount=${wei}`;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally { clearTimeout(timeout); }

    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: {
        bestDex?: string;
        bestBuyAmount?: string;
        buyAmount?: string;
        dex?: string;
        priceImpactPct?: number;
        feeUsd?: number;
      };
    };

    if (!res.ok || body.success === false) {
      return { ok: false, chain: "Polygon", error: body.error || `HTTP ${res.status}`, raw: body };
    }

    const d = body.data ?? {};
    const buyAmountStr = d.bestBuyAmount ?? d.buyAmount;
    const dex = d.bestDex ?? d.dex ?? "unknown";
    if (!buyAmountStr) {
      return { ok: false, chain: "Polygon", error: "No buyAmount in router response", raw: body };
    }

    // Router returns wei-style integer strings; we don't know decimals for
    // the buy token here, so we surface the raw number too. The Decision
    // Loop can pull decimals from a token registry if it needs the human
    // form. Keeping this simple for MVP.
    return {
      ok: true,
      chain: "Polygon",
      best: {
        dex,
        buyAmount: Number(buyAmountStr),
        priceImpactPct: d.priceImpactPct ?? 0,
        feeUsdEstimate: d.feeUsd ?? 0,
      },
    };
  };

  return {
    def: {
      name: "exchange.quote",
      description:
        "Get the best on-chain swap quote for a token pair on Polygon (137) via " +
        "the Kairos Smart Order Router. Read-only, no gas cost. Use before " +
        "wallet.transfer or before any capital-allocation decision.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        required: ["sellToken", "buyToken", "sellAmount", "sellDecimals"],
        properties: {
          sellToken: {
            type: "string",
            description: "ERC-20 address to sell, or the literal 'native' for POL.",
          },
          buyToken: {
            type: "string",
            description: "ERC-20 address to buy, or the literal 'native' for POL.",
          },
          sellAmount: {
            type: "number",
            description: "Amount to sell in human units (e.g. 10 = 10 USDC).",
          },
          sellDecimals: {
            type: "number",
            description: "Decimals of sellToken (6 for USDC, 18 for most others).",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "exchange.quote", level: PermissionLevel.READ_ONLY }),
  };
}
