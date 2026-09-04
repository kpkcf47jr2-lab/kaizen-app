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
import type { SecureWalletService } from "../../backend/wallet/service.js";
import { cadenaPorDefecto } from "./cadena.js";
import { MemoryStore } from "../memory/store.js";

const ROUTER_BASE = process.env.KAIROS_ROUTER_BASE || "https://api.kairos777.com/api/router";
const POLYGON_CHAIN_ID = 137;
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// ── exchange.quote ───────────────────────────────────────────────────
export interface QuoteArgs {
  sellToken: string;             // ERC-20 address, or "native"
  buyToken: string;              // same
  sellAmount: number;            // human units
  sellDecimals: number;
  chainId?: number;              // 137 Polygon (default) | 8453 Base
}

export interface QuoteResult {
  ok: boolean;
  chain: string;
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
    const chainId = args.chainId ?? cadenaPorDefecto();
    const url =
      `${ROUTER_BASE}/quote?chainId=${chainId}` +
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

    const chainName = chainId === 8453 ? "Base" : chainId === 137 ? "Polygon" : `chain-${chainId}`;
    if (!res.ok || body.success === false) {
      return { ok: false, chain: chainName, error: body.error || `HTTP ${res.status}`, raw: body };
    }

    const d = body.data ?? {};
    const buyAmountStr = d.bestBuyAmount ?? d.buyAmount;
    const dex = d.bestDex ?? d.dex ?? "unknown";
    if (!buyAmountStr) {
      return { ok: false, chain: chainName, error: "No buyAmount in router response", raw: body };
    }

    // Router returns wei-style integer strings; we don't know decimals for
    // the buy token here, so we surface the raw number too. The Decision
    // Loop can pull decimals from a token registry if it needs the human
    // form. Keeping this simple for MVP.
    return {
      ok: true,
      chain: chainName,
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
        "Get the best on-chain swap quote via the Kairos Smart Order Router. " +
        "Supports Polygon (137, default) and Base (8453). Read-only, no gas cost. " +
        "Use before exchange.swap or before any capital-allocation decision.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        required: ["sellToken", "buyToken", "sellAmount", "sellDecimals"],
        properties: {
          sellToken: {
            type: "string",
            description: "ERC-20 address to sell, or 'native' for POL/ETH.",
          },
          buyToken: {
            type: "string",
            description: "ERC-20 address to buy, or 'native' for POL/ETH.",
          },
          sellAmount: {
            type: "number",
            description: "Amount to sell in human units (e.g. 10 = 10 USDC).",
          },
          sellDecimals: {
            type: "number",
            description: "Decimals of sellToken (6 for USDC, 18 for most others).",
          },
          chainId: {
            type: "number",
            enum: [137, 8453],
            description: "137 = Polygon (default), 8453 = Base.",
          },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "exchange.quote", level: PermissionLevel.READ_ONLY }),
  };
}

// ── exchange.swap ────────────────────────────────────────────────────
//
//  This is where OBSERVE→EXECUTE closes. Given a fresh intent, the tool
//  wrapper delegates to SecureWalletService.swapExactUsdcFor which:
//    · pulls a fresh quote (bestRouter + path + minOut with slippage)
//    · asks Policy Engine to approve the value & chain
//    · approves USDC → router if allowance is short
//    · signs + broadcasts swapExactTokensForTokens on the winning V2 dex
//    · returns tx hashes + gas spent + realized buy amount
//
//  Every successful swap also records a `trade_swap` event in the
//  Economic Ledger so the strategy stats + reinvest engine can read it.
// ──────────────────────────────────────────────────────────────────────

export interface SwapArgs {
  chainId: 137 | 8453;
  buyToken: string;              // ERC-20 to receive
  buyTokenDecimals: number;      // needed to interpret amounts downstream
  amountUsdc: number;            // human units of USDC to sell
  strategy: string;              // strategy label ("eth-momentum", …)
  reason: string;                // short thesis
  slippageBps?: number;          // 50 = 0.5% default
}

export interface SwapToolResult {
  ok: true;
  chain: string;
  strategy: string;
  amountUsdcIn: number;
  buyToken: string;
  buyAmountRaw: string;
  minBuyAmountRaw: string;
  bestDex: string;
  routerAddress: string;
  approveTxHash?: string;
  swapTxHash: string;
  explorerUrls: {
    approve?: string;
    swap: string;
  };
  quoteFeeUsd: number;
  gasSpentEth?: string;
}

export function makeSwapTool(
  wallet: SecureWalletService,
): RegisteredTool<SwapArgs, SwapToolResult> {
  const exec: ToolFn<SwapArgs, SwapToolResult> = async (args, ctx) => {
    const result = await wallet.swapExactUsdcFor({
      agentId: ctx.agentId,
      chainId: args.chainId,
      buyToken: args.buyToken,
      buyTokenDecimals: args.buyTokenDecimals,
      amountUsdc: args.amountUsdc,
      strategy: args.strategy,
      reason: args.reason,
      slippageBps: args.slippageBps,
    });
    if (!result.ok) {
      throw new Error(`Swap rejected: ${result.reason}`);
    }

    // Record the swap in the Economic Ledger under the strategy label,
    // and schedule outcome measurements (Improvement.1) so the auto-
    // curator can later filter by realized ROI.
    const mem = new MemoryStore(ctx.agentId);
    let recordedEventId: number | null = null;
    try {
      recordedEventId = mem.recordEvent({
        ts: Date.now(),
        kind: "trade_swap",
        strategy: args.strategy,
        amountUsd: args.amountUsdc,
        txHash: result.swapTxHash,
        reason: args.reason,
        metadata: JSON.stringify({
          chainId: args.chainId,
          buyToken: args.buyToken,
          buyAmountRaw: result.buyAmountRaw,
          minBuyAmountRaw: result.minBuyAmountRaw,
          bestDex: result.bestDex,
          routerAddress: result.routerAddress,
          approveTxHash: result.approveTxHash,
          quoteFeeUsd: result.quoteFeeUsd,
          gasSpentEth: result.gasSpentEth,
        }),
      });
      // Schedule pnl_1h / pnl_24h / pnl_7d measurements. When the
      // heartbeat task drains them, the strategy compares current
      // balance vs entryUsd and writes back success/outcome to the
      // event row.
      const now = Date.now();
      const params = {
        entryUsd: args.amountUsdc,
        tokenAddress: args.buyToken.toLowerCase(),
        chainId: args.chainId,
        decimals: args.buyTokenDecimals,
      };
      for (const [kind, delayMs] of [
        ["pnl_1h",  3600_000],
        ["pnl_24h", 86400_000],
        ["pnl_7d",  7 * 86400_000],
      ] as const) {
        mem.scheduleMeasurement({
          eventId: recordedEventId, dueAt: now + delayMs, kind, params,
        });
      }
    } finally { mem.close(); }

    const explorer = args.chainId === 8453
      ? "https://basescan.org/tx/"
      : "https://polygonscan.com/tx/";
    return {
      ok: true,
      chain: result.chain,
      strategy: result.strategy,
      amountUsdcIn: result.amountUsdcIn,
      buyToken: result.buyToken,
      buyAmountRaw: result.buyAmountRaw,
      minBuyAmountRaw: result.minBuyAmountRaw,
      bestDex: result.bestDex,
      routerAddress: result.routerAddress,
      approveTxHash: result.approveTxHash,
      swapTxHash: result.swapTxHash,
      explorerUrls: {
        approve: result.approveTxHash ? `${explorer}${result.approveTxHash}` : undefined,
        swap: `${explorer}${result.swapTxHash}`,
      },
      quoteFeeUsd: result.quoteFeeUsd,
      gasSpentEth: result.gasSpentEth,
    };
  };

  return {
    def: {
      name: "exchange.swap",
      description:
        "Execute a REAL on-chain swap: USDC → target token via the Kairos Router's " +
        "best UniswapV2-compatible venue (BaseSwap on Base, QuickSwap on Polygon). " +
        "Handles approval automatically. Signs with the agent's own wallet through " +
        "the Secure Wallet Service; Policy Engine re-validates value + chain before " +
        "any tx is broadcast. Returns tx hashes + explorer URLs. Use exchange.quote " +
        "first for previews without gas.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["chainId", "buyToken", "buyTokenDecimals", "amountUsdc", "strategy", "reason"],
        properties: {
          chainId: {
            type: "number",
            enum: [137, 8453],
            description: "137 Polygon or 8453 Base. Must match where USDC lives.",
          },
          buyToken: {
            type: "string",
            description: "ERC-20 address to buy (checksum casing recommended).",
          },
          buyTokenDecimals: {
            type: "number",
            description: "Decimals of buyToken (usually 18; 6 for USDC/USDT).",
          },
          amountUsdc: {
            type: "number",
            description: "USDC to sell in human units. Must fit self-defined trading budget + per-trade cap.",
          },
          strategy: {
            type: "string",
            description: "Strategy label — used to aggregate stats (e.g. 'eth-momentum').",
          },
          reason: {
            type: "string",
            description: "Short thesis recorded in the Economic Ledger.",
          },
          slippageBps: {
            type: "number",
            description: "Owner-defined slippage bound in bps. Default 50 (0.5%).",
          },
        },
      },
    },
    exec,
    toIntent: (a) => ({
      tool: "exchange.swap",
      level: PermissionLevel.FINANCIAL,
      valueUsd: a.amountUsdc,
      chainId: a.chainId,
      metadata: { strategyExposureUsd: a.amountUsdc },
    }),
  };
}
