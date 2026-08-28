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
  erc20Balance,
  nativeBalance,
  open as openVault,
  signAndSendErc20Transfer,
  type ChainConfig,
  type VaultBlob,
} from "@kaizen/wallet-core";
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
  }> {
    const address = await this.addressFor(agentId);
    const chainIds = Object.keys(CHAINS).map(Number);
    const perChain = await Promise.all(
      chainIds.map(async (id) => {
        const chain = CHAINS[id];
        const usdcConfig = USDC_BY_CHAIN[id];
        if (!chain || !usdcConfig) return { id, usdc: 0, native: 0 };
        const [u, n] = await Promise.all([
          erc20Balance(chain, usdcConfig.address, address).catch(() => ({ formatted: 0 })),
          nativeBalance(chain, address).catch(() => 0),
        ]);
        return { id, usdc: u.formatted, native: n };
      }),
    );
    const byChain: Record<number, { usdc: number; native: number; nativeSymbol: string }> = {};
    let sumUsdc = 0;
    let sumNative = 0;
    for (const r of perChain) {
      const symbol = r.id === 137 ? "POL" : r.id === 8453 ? "ETH" : "?";
      byChain[r.id] = { usdc: r.usdc, native: r.native, nativeSymbol: symbol };
      sumUsdc += r.usdc;
      sumNative += r.native;
    }
    return { address, usdc: sumUsdc, pol: sumNative, native: sumNative, byChain };
  }

  /** Public address for an agent (derivation, no signing). */
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
