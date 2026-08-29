// ═══════════════════════════════════════════════════════════════════════
//  Kairos-signed HTTP 402 payments
//
//  A downstream service that wants USDC per-request emits:
//    HTTP 402 Payment Required
//    Kairos-Payment-Challenge: <base64url(JSON)>
//
//  The JSON is a PaymentChallenge signed by the SERVICE (Kairos-owned or
//  approved-vendor). The client verifies the signature against the
//  approved-payees list, moves USDC to the requested address via the
//  Secure Wallet Service (so PolicyEngine + HARD_LIMITS still apply),
//  and retries with a Kairos-Payment-Receipt header.
//
//  Not the ERC-x402 draft standard — same shape, but ours restricts
//  who Kaizen may pay so it cannot be tricked by a random 402 emitter.
// ═══════════════════════════════════════════════════════════════════════

import { Wallet, verifyMessage } from "ethers";
import type {
  IPaymentClient,
  IPaymentServer,
  PaymentChallenge,
  PaymentReceipt,
} from "./types.js";

/** Wire schema for the challenge JSON. */
export interface WireChallenge {
  v: 1;
  resource: string;
  amountUsdc: number;
  payToAddress: string;
  chainId: 137 | 8453;
  expiresAt: number;
  signerAddress: string;         // must be in the client's approved-payees list
  signature: string;             // signMessage(challengeDigest)
}

/** Canonical string signed by the service so the signature covers the
 *  full challenge and nothing else. Extra fields are ignored. */
export function challengeDigest(c: Omit<PaymentChallenge, "signature">): string {
  const canonical = [
    c.resource,
    c.amountUsdc.toString(),
    c.payToAddress.toLowerCase(),
    String(c.chainId),
    String(c.expiresAt),
  ].join("|");
  return "kairos-402:" + canonical;
}

// ── Server side: emit challenges + verify receipts ───────────────────

export interface PaymentServerConfig {
  /** The service's own private key — signs every challenge. */
  serverPrivateKey: string;
  /** Default expiry window (ms) for challenges. */
  challengeTtlMs?: number;
}

export class KairosPaymentServer implements IPaymentServer {
  private readonly wallet: Wallet;
  private readonly ttl: number;
  /** Nonce dedupe — a receipt is one-shot per (txHash, resource). */
  private readonly consumedReceipts = new Set<string>();

  constructor(cfg: PaymentServerConfig) {
    this.wallet = new Wallet(cfg.serverPrivateKey);
    this.ttl = cfg.challengeTtlMs ?? 5 * 60_000;
  }

  async signChallenge(req: { resource: string; amountUsdc: number; chainId: 137 | 8453 }): Promise<PaymentChallenge> {
    const base: Omit<PaymentChallenge, "signature"> = {
      resource: req.resource,
      amountUsdc: req.amountUsdc,
      payToAddress: this.wallet.address,
      chainId: req.chainId,
      expiresAt: Date.now() + this.ttl,
    };
    const sig = await this.wallet.signMessage(challengeDigest(base));
    return { ...base, signature: sig };
  }

  async verifyReceipt(receiptHeader: string): Promise<PaymentReceipt | null> {
    if (!receiptHeader) return null;
    let receipt: PaymentReceipt;
    try {
      receipt = JSON.parse(Buffer.from(receiptHeader, "base64url").toString("utf8"));
    } catch { return null; }
    // Fase 6 verifies the STRUCTURAL correctness of the receipt only.
    // Full on-chain verification of the tx hash → USDC transfer to
    // payToAddress lands in Fase 7 (needs an RPC dependency this file
    // deliberately avoids). Consumers may layer that check on top.
    if (!receipt || typeof receipt !== "object") return null;
    if (typeof receipt.txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(receipt.txHash)) return null;
    if (typeof receipt.paidUsdc !== "number" || receipt.paidUsdc <= 0) return null;
    const dedupeKey = receipt.txHash.toLowerCase() + ":" + receipt.challengeResource;
    if (this.consumedReceipts.has(dedupeKey)) return null;
    this.consumedReceipts.add(dedupeKey);
    return receipt;
  }
}

// ── Client side: pay + retry ────────────────────────────────────────

export interface PayerAdapter {
  /** Transfer USDC to `to` on `chainId`. Returns the tx hash after
   *  broadcast (does NOT wait for confirmation — one round trip is
   *  enough for the receipt). Must go through SecureWalletService so
   *  PolicyEngine + HARD_LIMITS still enforce. */
  payUsdc(params: { to: string; usdc: number; chainId: 137 | 8453; reason: string }): Promise<{ txHash: string }>;
}

export interface PaymentClientConfig {
  /** Approved payee addresses. Anything outside this set → refuse. */
  approvedPayees: readonly string[];
  /** How to actually send USDC (adapter over SecureWalletService). */
  payer: PayerAdapter;
  /** Max USD per single 402 payment. Default $1 to keep blast radius low. */
  maxPerPaymentUsd?: number;
  /** Rolling 24h cap across ALL 402 payments. Default $10. */
  maxDailyUsd?: number;
  /** Optional: inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class KairosPaymentClient implements IPaymentClient {
  private readonly approvedSet: Set<string>;
  private readonly maxPer: number;
  private readonly maxDaily: number;
  private readonly fetchImpl: typeof fetch;
  private dailyBudgetSpent = 0;
  private dailyBudgetWindowStart = 0;

  constructor(private readonly cfg: PaymentClientConfig) {
    this.approvedSet = new Set(cfg.approvedPayees.map((a) => a.toLowerCase()));
    this.maxPer = cfg.maxPerPaymentUsd ?? 1;
    this.maxDaily = cfg.maxDailyUsd ?? 10;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async fetchWithPay(url: string, init?: RequestInit): Promise<Response> {
    const first = await this.fetchImpl(url, init);
    if (first.status !== 402) return first;

    const challengeHeader = first.headers.get("Kairos-Payment-Challenge");
    if (!challengeHeader) throw new Error("402 without Kairos-Payment-Challenge header");

    const wireStr = Buffer.from(challengeHeader, "base64url").toString("utf8");
    let wire: WireChallenge;
    try { wire = JSON.parse(wireStr); } catch { throw new Error("Malformed Kairos payment challenge JSON"); }
    if (wire.v !== 1) throw new Error(`Unsupported challenge version: ${wire.v}`);

    // Signature check
    const digest = challengeDigest(wire);
    let recovered: string;
    try { recovered = verifyMessage(digest, wire.signature); } catch { throw new Error("Challenge signature verification failed"); }
    if (recovered.toLowerCase() !== wire.signerAddress.toLowerCase()) {
      throw new Error("Challenge signer address mismatch");
    }

    // Approved-payee check
    if (!this.approvedSet.has(wire.signerAddress.toLowerCase())) {
      throw new Error(`Refusing to pay unapproved payee ${wire.signerAddress}`);
    }
    if (wire.payToAddress.toLowerCase() !== wire.signerAddress.toLowerCase()) {
      // A signer that asks funds to be sent to a different address is a
      // classic "man in the middle" indicator. Reject.
      throw new Error("Signer/payTo mismatch — refusing to pay");
    }

    // Expiry
    if (wire.expiresAt <= Date.now()) throw new Error("Challenge expired");

    // Amount caps
    if (wire.amountUsdc > this.maxPer) {
      throw new Error(`Payment $${wire.amountUsdc} exceeds per-payment cap $${this.maxPer}`);
    }
    this.rollDailyWindow();
    if (this.dailyBudgetSpent + wire.amountUsdc > this.maxDaily) {
      throw new Error(`Would exceed daily 402 spend cap $${this.maxDaily}`);
    }

    // Pay + build receipt
    const { txHash } = await this.cfg.payer.payUsdc({
      to: wire.payToAddress,
      usdc: wire.amountUsdc,
      chainId: wire.chainId,
      reason: `402: ${wire.resource}`,
    });
    this.dailyBudgetSpent += wire.amountUsdc;

    const receipt: PaymentReceipt = {
      challengeResource: wire.resource,
      paidUsdc: wire.amountUsdc,
      txHash,
      chainId: wire.chainId,
      timestamp: Date.now(),
    };
    const receiptHeader = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");

    // Retry with receipt attached
    const retryInit: RequestInit = { ...(init ?? {}), headers: { ...(init?.headers as Record<string, string> ?? {}), "Kairos-Payment-Receipt": receiptHeader } };
    return this.fetchImpl(url, retryInit);
  }

  private rollDailyWindow(): void {
    const dayMs = 24 * 60 * 60_000;
    const now = Date.now();
    if (now - this.dailyBudgetWindowStart > dayMs) {
      this.dailyBudgetWindowStart = now;
      this.dailyBudgetSpent = 0;
    }
  }

  /** Introspection for the owner dashboard. */
  status(): { dailyBudgetSpent: number; dailyBudgetCap: number; approvedPayees: number } {
    this.rollDailyWindow();
    return {
      dailyBudgetSpent: this.dailyBudgetSpent,
      dailyBudgetCap: this.maxDaily,
      approvedPayees: this.approvedSet.size,
    };
  }
}
