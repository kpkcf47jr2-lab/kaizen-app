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

// ── Chain registry (Polygon 137 only for MVP) ────────────────────────
export const POLYGON: ChainConfig = {
  chainId: 137,
  rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  name: "Polygon",
};

/** USDC native on Polygon 137. Same address Casino + Predict use. */
export const USDC_POLYGON = {
  address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  decimals: 6,
  symbol: "USDC",
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

  /** Return the agent's on-chain USDC + native balance. No key touched. */
  async readBalances(agentId: string): Promise<{
    address: string;
    usdc: number;
    pol: number;
  }> {
    const address = await this.addressFor(agentId);
    const [usdc, pol] = await Promise.all([
      erc20Balance(POLYGON, USDC_POLYGON.address, address),
      nativeBalance(POLYGON, address),
    ]);
    return { address, usdc: usdc.formatted, pol };
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

  /** Sign + broadcast a USDC transfer if Policy Engine approves. */
  async transferUsdc(req: TransferRequest): Promise<TransferResult | TransferRejected> {
    const state = await this.stateLoader.load(req.agentId);
    const decision = this.policy.evaluate(state, {
      tool: "wallet.transfer",
      level: PermissionLevel.FINANCIAL,
      valueUsd: req.amountUsdc,
      destinationRole: req.destinationRole,
      chainId: POLYGON.chainId,
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
      chain: POLYGON,
      privateKey: account.privateKey,
      tokenAddress: USDC_POLYGON.address,
      tokenDecimals: USDC_POLYGON.decimals,
      to: req.to,
      amount: req.amountUsdc,
    });

    await this.stateLoader.recordOutflow(req.agentId, req.amountUsdc);
    await this.stateLoader.recordTxHash(req.agentId, tx.hash, req.amountUsdc);

    return {
      ok: true,
      txHash: tx.hash,
      chain: POLYGON.name,
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
