// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Secure Wallet Service
//
//  Every transfer / trade / spend request from the agent lands here.
//  The service:
//    1. Loads the agent's current state (net_worth, outflows, drawdown)
//    2. Asks the Policy Engine to evaluate the intent
//    3. If allowed, opens the vault, signs the tx, zeros the key
//    4. Emits an event to the Economic Ledger
//    5. Returns the tx hash to the caller
//
//  The LLM never sees a private key. It sends a ToolIntent and gets a
//  txHash or a rejection reason.
// ═══════════════════════════════════════════════════════════════════════

import {
  deriveEvmAccount,
  erc20Allowance,
  erc20Balance,
  nativeBalance,
  open as openVault,
  signAndSendErc20Approve,
  signAndSendErc20Transfer,
  signAndSendNativeTransfer,
  signAndSendUniv2Swap,
  type ChainConfig,
  type VaultBlob,
} from "@kaizen/wallet-core";
import { parseUnits } from "ethers";
import { PolicyEngine } from "../../src/policy/engine.js";
import type { AgentState } from "../../src/policy/engine.js";
import { PermissionLevel } from "../../src/policy/limits.js";

// ── Chain registry ───────────────────────────────────────────────────
export const POLYGON: ChainConfig = {
  chainId: 137,
  rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  name: "Polygon",
};

// Base added 2026-08-28 — owner funded the agent with 5 USDC on Base
// (Casino / Predict already use Polygon, but the seed capital arrived
// here). Adding Base lets Kaizen operate on both without a bridge.
export const BASE: ChainConfig = {
  chainId: 8453,
  rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  name: "Base",
};

export const CHAINS: Record<number, ChainConfig> = {
  137: POLYGON,
  8453: BASE,
};

/** USDC native on Polygon 137. Same address Casino + Predict use. */
export const USDC_POLYGON = {
  address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  decimals: 6,
  symbol: "USDC",
};

/** USDC native on Base 8453 (Circle direct-issued). */
export const USDC_BASE = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  symbol: "USDC",
};

export const USDC_BY_CHAIN: Record<number, typeof USDC_POLYGON> = {
  137: USDC_POLYGON,
  8453: USDC_BASE,
};


// ── Tokens que cuentan como POSICIÓN ──────────────────────────────────
//
//  Sin esto la agente es CIEGA a lo que compra: `readBalances` sólo leía USDC
//  y el nativo, así que un swap a WETH le desaparecía del patrimonio. Contaba
//  el dinero gastado como perdido y no contaba el activo recibido.
//
//  El efecto era una trampa que se refuerza sola: cada inversión hundía su
//  drawdown, el drawdown la clasificaba CRITICAL, y CRITICAL le ponía el
//  presupuesto en cero. Cuanto más invertía, menos se permitía hacer.
//  Medido el 2026-09-03: creía tener $5.59 con 26.4% de caída; tenía $7.05
//  con 7.2%.
export interface PositionToken {
  address: string;
  decimals: number;
  symbol: string;
  /** Símbolo con el que se le pide el precio al motor de mercado. */
  priceSymbol: string;
}

export const POSITION_TOKENS_BY_CHAIN: Record<number, PositionToken[]> = {
  8453: [
    { address: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH", priceSymbol: "ETH" },
  ],
  137: [
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, symbol: "WETH", priceSymbol: "ETH" },
  ],
};

// ── Vault store abstraction ──────────────────────────────────────────
// For MVP: JSON file on disk. Prod: KMS / HSM / hardware-backed store.
export interface VaultStore {
  load(agentId: string): Promise<VaultBlob | null>;
  save(agentId: string, blob: VaultBlob): Promise<void>;
}

// ── Agent state loader ───────────────────────────────────────────────
export interface AgentStateLoader {
  load(agentId: string): Promise<AgentState>;
  recordOutflow(agentId: string, valueUsd: number): Promise<void>;
  recordTxHash(agentId: string, hash: string, valueUsd: number): Promise<void>;
}

// ── Transfer request coming from the agent ───────────────────────────
export interface TransferRequest {
  agentId: string;
  to: string;                        // destination address
  destinationRole: string;           // must match Policy Engine whitelist
  amountUsdc: number;                // human units
  reason: string;                    // short label for the ledger
  /** Chain to send USDC on. Defaults to Polygon; must be in USDC_BY_CHAIN. */
  chainId?: number;
}

export interface TransferResult {
  ok: true;
  txHash: string;
  chain: string;
  amountUsdc: number;
}

export interface TransferRejected {
  ok: false;
  reason: string;
  auditLevel: "debug" | "info" | "warn" | "critical";
}

// ── Swap request coming from the agent ───────────────────────────────
export interface SwapRequest {
  agentId: string;
  chainId: number;
  buyToken: string;              // ERC-20 to receive
  buyTokenDecimals: number;
  amountUsdc: number;            // human units — USDC to sell
  strategy: string;              // strategy label for the ledger
  reason: string;                // short thesis
  slippageBps?: number;          // default 50 = 0.5%
}

export interface SwapResult {
  ok: true;
  chain: string;
  strategy: string;
  amountUsdcIn: number;
  buyToken: string;
  buyAmountRaw: string;          // raw wei from receipt (parsed from logs later)
  minBuyAmountRaw: string;
  bestDex: string;
  routerAddress: string;
  approveTxHash?: string;        // only if approval was needed
  swapTxHash: string;
  quoteFeeUsd: number;
  gasSpentEth?: string;
}

export interface SwapRejected {
  ok: false;
  reason: string;
  auditLevel: "debug" | "info" | "warn" | "critical";
}

// ── The Service ──────────────────────────────────────────────────────

export class SecureWalletService {
  constructor(
    private readonly vaultStore: VaultStore,
    private readonly stateLoader: AgentStateLoader,
    private readonly policy: PolicyEngine = new PolicyEngine(),
    private readonly passphrase: string = requirePassphrase(),
  ) {}

  /**
   * Return the agent's on-chain balances across every whitelisted chain.
   * `usdc` and `native` (formerly `pol`) are TOTALS across chains; `byChain`
   * carries the per-chain split so the Decision Loop can reason about where
   * the capital sits (and pick a chainId when calling transferUsdc()).
   */
  async readBalances(agentId: string): Promise<{
    address: string;
    usdc: number;
    /** POL alias — kept for backwards compatibility with the old
     *  { address, usdc, pol } shape. Sums native across chains. */
    pol: number;
    native: number;
    byChain: Record<number, { usdc: number; native: number; nativeSymbol: string }>;
    /** Tokens que la agente TIENE. Sin esto no ve lo que compra. */
    holdings: Array<{ chainId: number; symbol: string; priceSymbol: string; amount: number }>;
  }> {
    const address = await this.addressFor(agentId);
    const chainIds = Object.keys(CHAINS).map(Number);
    const perChain = await Promise.all(
      chainIds.map(async (id) => {
        const chain = CHAINS[id];
        const usdcConfig = USDC_BY_CHAIN[id];
        if (!chain || !usdcConfig) return { id, usdc: 0, native: 0 };
        const [u, n, held] = await Promise.all([
          erc20Balance(chain, usdcConfig.address, address).catch(() => ({ formatted: 0 })),
          nativeBalance(chain, address).catch(() => 0),
          Promise.all(
            (POSITION_TOKENS_BY_CHAIN[id] || []).map(async (t) => ({
              symbol: t.symbol,
              priceSymbol: t.priceSymbol,
              amount: (await erc20Balance(chain, t.address, address).catch(() => ({ formatted: 0 }))).formatted,
            })),
          ),
        ]);
        return { id, usdc: u.formatted, native: n, held: held.filter((h) => h.amount > 0) };
      }),
    );
    const byChain: Record<number, { usdc: number; native: number; nativeSymbol: string }> = {};
    const holdings: Array<{ chainId: number; symbol: string; priceSymbol: string; amount: number }> = [];
    let sumUsdc = 0;
    let sumNative = 0;
    for (const r of perChain) {
      const symbol = r.id === 137 ? "POL" : r.id === 8453 ? "ETH" : "?";
      byChain[r.id] = { usdc: r.usdc, native: r.native, nativeSymbol: symbol };
      sumUsdc += r.usdc;
      sumNative += r.native;
      for (const h of (r as { held?: Array<{ symbol: string; priceSymbol: string; amount: number }> }).held || []) {
        holdings.push({ chainId: r.id, symbol: h.symbol, priceSymbol: h.priceSymbol, amount: h.amount });
      }
    }
    return { address, usdc: sumUsdc, pol: sumNative, native: sumNative, byChain, holdings };
  }

  /** Public address for an agent (derivation, no signing). */
  /** ⚠️ ÚNICA salida de la llave privada fuera de esta clase.
   *
   *  El resto del servicio mantiene la invariante de no exponerla nunca: abre
   *  el vault, firma adentro y descarta. Pero el SDK de Spheron EXIGE la llave
   *  en su constructor y no acepta un signer, así que para que Kaizen pueda
   *  pagar su propio cómputo hay que entregársela.
   *
   *  Se aísla acá, con nombre rastreable, para que una auditoría encuentre de
   *  un grep todos los lugares que la sacan. No la cachea, no la loguea, y el
   *  llamador debe usarla y soltarla.
   *
   *  Si algún día Spheron acepta un signer externo, este método se borra.
   */
  async exportPrivateKeyForSpheron(agentId: string): Promise<string> {
    const blob = await this.vaultStore.load(agentId);
    if (!blob) throw new Error(`No vault for agent ${agentId}`);
    const mnemonic = await openVault(blob, this.passphrase);
    return deriveEvmAccount(mnemonic).privateKey;
  }

  async addressFor(agentId: string): Promise<string> {
    const blob = await this.vaultStore.load(agentId);
    if (!blob) throw new Error(`No vault for agent ${agentId}`);
    // We need the mnemonic to derive; open + immediately re-close.
    const mnemonic = await openVault(blob, this.passphrase);
    try {
      return deriveEvmAccount(mnemonic).address;
    } finally {
      // JS strings are immutable; the GC will drop it. We just make sure
      // no reference lives beyond this scope.
      // (For hardware-backed vaults this whole path becomes unnecessary.)
    }
  }

  /** Sign + broadcast a USDC transfer if Policy Engine approves.
   *  chainId defaults to Polygon when the caller doesn't specify. Any
   *  chainId not in CHAINS (and thus not in HARD_LIMITS.ALLOWED_CHAINS)
   *  is rejected up-front. */
  async transferUsdc(req: TransferRequest): Promise<TransferResult | TransferRejected> {
    const chainId = req.chainId ?? POLYGON.chainId;
    const chain = CHAINS[chainId];
    const usdcConfig = USDC_BY_CHAIN[chainId];
    if (!chain || !usdcConfig) {
      return {
        ok: false,
        reason: `Chain ${chainId} not registered in Secure Wallet Service`,
        auditLevel: "critical",
      };
    }

    const state = await this.stateLoader.load(req.agentId);
    const decision = this.policy.evaluate(state, {
      tool: "wallet.transfer",
      level: PermissionLevel.FINANCIAL,
      valueUsd: req.amountUsdc,
      destinationRole: req.destinationRole,
      chainId,
    });

    if (!decision.allow) {
      return { ok: false, reason: decision.reason, auditLevel: decision.auditLevel };
    }

    if (decision.requiresConfirmation) {
      // MVP: reject and surface for owner review. Later: publish to owner
      // channel and wait for signed approval.
      return {
        ok: false,
        reason: `Requires owner confirmation (value $${req.amountUsdc} ≥ $10k)`,
        auditLevel: "warn",
      };
    }

    const blob = await this.vaultStore.load(req.agentId);
    if (!blob) throw new Error(`No vault for agent ${req.agentId}`);
    const mnemonic = await openVault(blob, this.passphrase);
    const account = deriveEvmAccount(mnemonic);

    const tx = await signAndSendErc20Transfer({
      chain,
      privateKey: account.privateKey,
      tokenAddress: usdcConfig.address,
      tokenDecimals: usdcConfig.decimals,
      to: req.to,
      amount: req.amountUsdc,
    });

    await this.stateLoader.recordOutflow(req.agentId, req.amountUsdc);
    await this.stateLoader.recordTxHash(req.agentId, tx.hash, req.amountUsdc);

    return {
      ok: true,
      txHash: tx.hash,
      chain: chain.name,
      amountUsdc: req.amountUsdc,
    };
  }

  /** Sign + broadcast a native (ETH / POL) transfer. Same policy gate as
   *  ERC-20: PolicyEngine.evaluate is run with `tool="wallet.transferNative"`
   *  before the vault is opened. Intended for gas-seeding child agents
   *  during spawn (small amounts) — the destinationRole must be
   *  `agent-owned` and the amount respected by MAX_TX_USD when converted
   *  at the injected native/USD rate. */
  async transferNative(req: {
    agentId: string;
    to: string;
    destinationRole: string;
    amountEth: number;
    chainId: 137 | 8453;
    nativeUsdRate: number;      // e.g. 3200 for ETH, 0.5 for POL
    reason: string;
  }): Promise<TransferResult | TransferRejected> {
    const chain = CHAINS[req.chainId];
    if (!chain) return { ok: false, reason: `Chain ${req.chainId} not registered`, auditLevel: "critical" };

    const state = await this.stateLoader.load(req.agentId);
    const valueUsd = req.amountEth * req.nativeUsdRate;
    const decision = this.policy.evaluate(state, {
      tool: "wallet.transfer",
      level: PermissionLevel.FINANCIAL,
      valueUsd,
      destinationRole: req.destinationRole,
      chainId: req.chainId,
    });
    if (!decision.allow) return { ok: false, reason: decision.reason, auditLevel: decision.auditLevel };

    const blob = await this.vaultStore.load(req.agentId);
    if (!blob) throw new Error(`No vault for agent ${req.agentId}`);
    const mnemonic = await openVault(blob, this.passphrase);
    const account = deriveEvmAccount(mnemonic);

    const tx = await signAndSendNativeTransfer({
      chain, privateKey: account.privateKey, to: req.to, amountEth: req.amountEth,
    });
    await this.stateLoader.recordOutflow(req.agentId, valueUsd);
    await this.stateLoader.recordTxHash(req.agentId, tx.hash, valueUsd);
    return { ok: true, txHash: tx.hash, chain: chain.name, amountUsdc: valueUsd };
  }

  /** Execute a DEX swap: USDC -> buyToken via the Kairos Router's chosen
   *  UniswapV2-compatible venue. Full flow:
   *    1. Fetch a fresh quote from the router (bestRouter + path + minOut)
   *    2. Policy Engine check (as exchange.swap intent with valueUsd = amountUsdc)
   *    3. Approve router for USDC if allowance < amount
   *    4. Call swapExactTokensForTokens
   *    5. Register outflow + tx in the Economic Ledger loader
   *  Never exposes the private key beyond openVault → local Wallet instance. */
  async swapExactUsdcFor(req: SwapRequest): Promise<SwapResult | SwapRejected> {
    const chain = CHAINS[req.chainId];
    const usdcConfig = USDC_BY_CHAIN[req.chainId];
    if (!chain || !usdcConfig) {
      return {
        ok: false,
        reason: `Chain ${req.chainId} not registered in Secure Wallet Service`,
        auditLevel: "critical",
      };
    }

    // ── 1) Fresh quote from router ──────────────────────────────────
    const sellAmountRaw = parseUnits(req.amountUsdc.toString(), usdcConfig.decimals);
    const ROUTER_BASE = process.env.KAIROS_ROUTER_BASE || "https://api.kairos777.com/api/router";
    const quoteUrl =
      `${ROUTER_BASE}/quote?chainId=${req.chainId}` +
      `&sellToken=${usdcConfig.address}` +
      `&buyToken=${req.buyToken}` +
      `&sellAmount=${sellAmountRaw.toString()}`;
    const qres = await fetch(quoteUrl);
    const qbody = (await qres.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: {
        buyAmount?: string;
        bestBuyAmount?: string;
        minBuyAmount?: string;
        bestDex?: string;
        bestRouter?: string;
        path?: string[];
        feeUsd?: number;
      };
    };
    if (!qres.ok || !qbody.success || !qbody.data?.bestRouter) {
      return {
        ok: false,
        reason: `Router quote failed: ${qbody.error || `HTTP ${qres.status}`}`,
        auditLevel: "warn",
      };
    }
    const routerAddress = qbody.data.bestRouter;
    const path = qbody.data.path || [usdcConfig.address, req.buyToken];
    const bestDex = qbody.data.bestDex || "unknown";
    const buyAmountRaw = BigInt(qbody.data.bestBuyAmount || qbody.data.buyAmount || "0");
    // Apply owner slippage on top of the router's minBuyAmount (defensive).
    const routerMinRaw = BigInt(qbody.data.minBuyAmount || buyAmountRaw.toString());
    const slippageBps = BigInt(req.slippageBps ?? 50);
    const ourMinRaw = (buyAmountRaw * (10000n - slippageBps)) / 10000n;
    const minBuyAmountRaw = ourMinRaw < routerMinRaw ? ourMinRaw : routerMinRaw;

    // ── 2) Policy check ────────────────────────────────────────────
    const state = await this.stateLoader.load(req.agentId);
    const decision = this.policy.evaluate(state, {
      tool: "exchange.swap",
      level: PermissionLevel.FINANCIAL,
      valueUsd: req.amountUsdc,
      chainId: req.chainId,
      // NB: swaps are NOT outflow (money changes token but stays in-wallet),
      // so no destinationRole check; PolicyEngine skips whitelist for swaps.
      metadata: { strategyExposureUsd: req.amountUsdc },
    });
    if (!decision.allow) {
      return { ok: false, reason: decision.reason, auditLevel: decision.auditLevel };
    }

    // ── 3) Open vault (single time), derive account ────────────────
    const blob = await this.vaultStore.load(req.agentId);
    if (!blob) throw new Error(`No vault for agent ${req.agentId}`);
    const mnemonic = await openVault(blob, this.passphrase);
    const account = deriveEvmAccount(mnemonic);

    // ── 4) Ensure allowance ────────────────────────────────────────
    let approveTxHash: string | undefined;
    const currentAllow = await erc20Allowance(chain, usdcConfig.address, account.address, routerAddress);
    if (currentAllow < sellAmountRaw) {
      const approveTx = await signAndSendErc20Approve({
        chain,
        privateKey: account.privateKey,
        tokenAddress: usdcConfig.address,
        spender: routerAddress,
        amountRaw: sellAmountRaw,        // exact-amount approval, not unlimited
      });
      approveTxHash = approveTx.hash;
      await approveTx.wait();            // block until confirmed
    }

    // ── 5) Swap ────────────────────────────────────────────────────
    const deadline = Math.floor(Date.now() / 1000) + 600;   // +10 min
    const swapTx = await signAndSendUniv2Swap({
      chain,
      privateKey: account.privateKey,
      routerAddress,
      amountInRaw: sellAmountRaw,
      amountOutMinRaw: minBuyAmountRaw,
      path,
      to: account.address,
      deadline,
    });
    const receipt = await swapTx.wait();
    const gasSpentWei = receipt ? (receipt.gasUsed * (receipt.gasPrice ?? 0n)) : 0n;
    const gasSpentEth = (Number(gasSpentWei) / 1e18).toFixed(8);

    // ── 6) Record ledger side-effects ──────────────────────────────
    // Swaps stay in-wallet (USDC → token), so outflow doesn't grow. Record
    // the tx hash for audit; the caller (tool wrapper) also writes an
    // economic_event with the strategy label.
    await this.stateLoader.recordTxHash(req.agentId, swapTx.hash, req.amountUsdc);

    return {
      ok: true,
      chain: chain.name,
      strategy: req.strategy,
      amountUsdcIn: req.amountUsdc,
      buyToken: req.buyToken,
      buyAmountRaw: buyAmountRaw.toString(),
      minBuyAmountRaw: minBuyAmountRaw.toString(),
      bestDex,
      routerAddress,
      approveTxHash,
      swapTxHash: swapTx.hash,
      quoteFeeUsd: qbody.data.feeUsd || 0,
      gasSpentEth,
    };
  }
}

function requirePassphrase(): string {
  const p = process.env.KAIZEN_VAULT_PASSPHRASE;
  if (!p || p.length < 16) {
    throw new Error(
      "KAIZEN_VAULT_PASSPHRASE env var missing or too short (need ≥16 chars).",
    );
  }
  return p;
}
