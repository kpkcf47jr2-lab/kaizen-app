import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import {
  KairosPaymentClient,
  KairosPaymentServer,
  challengeDigest,
  type PayerAdapter,
  type WireChallenge,
} from "../payments/402.js";
import { NoopPaymentClient } from "../payments/index.js";
import type { ModuleConfig } from "../types.js";

const cfg: ModuleConfig = {
  agentId: "agt_pay", runtimeVersion: "0.1.0-alpha.0",
  readOnly: false, killSwitchEnv: "KAIZEN_KILL_PAY",
};

// ── Server: challenge + verify ──────────────────────────────────────

describe("KairosPaymentServer", () => {
  const serverPk = "0x" + "a".repeat(64);
  const serverAddr = new Wallet(serverPk).address;

  it("signChallenge produces a challenge whose signature recovers to the server", async () => {
    const srv = new KairosPaymentServer({ serverPrivateKey: serverPk, challengeTtlMs: 60_000 });
    const c = await srv.signChallenge({ resource: "/api/x", amountUsdc: 0.05, chainId: 8453 });
    expect(c.payToAddress).toBe(serverAddr);
    expect(c.expiresAt).toBeGreaterThan(Date.now());
    // Signature must recover to serverAddr via challengeDigest
    const digest = challengeDigest(c);
    const { verifyMessage } = await import("ethers");
    expect(verifyMessage(digest, c.signature).toLowerCase()).toBe(serverAddr.toLowerCase());
  });

  it("verifyReceipt accepts a structurally valid receipt", async () => {
    const srv = new KairosPaymentServer({ serverPrivateKey: serverPk });
    const receipt = {
      challengeResource: "/api/x", paidUsdc: 0.05,
      txHash: "0x" + "b".repeat(64), chainId: 8453, timestamp: Date.now(),
    };
    const hdr = Buffer.from(JSON.stringify(receipt)).toString("base64url");
    const r = await srv.verifyReceipt(hdr);
    expect(r).not.toBeNull();
    expect(r!.txHash).toBe(receipt.txHash);
  });

  it("verifyReceipt rejects malformed input", async () => {
    const srv = new KairosPaymentServer({ serverPrivateKey: serverPk });
    expect(await srv.verifyReceipt("")).toBeNull();
    expect(await srv.verifyReceipt("not-base64!!")).toBeNull();
  });

  it("verifyReceipt de-dupes same (txHash, resource) pair", async () => {
    const srv = new KairosPaymentServer({ serverPrivateKey: serverPk });
    const receipt = {
      challengeResource: "/api/x", paidUsdc: 0.05,
      txHash: "0x" + "c".repeat(64), chainId: 8453, timestamp: Date.now(),
    };
    const hdr = Buffer.from(JSON.stringify(receipt)).toString("base64url");
    expect(await srv.verifyReceipt(hdr)).not.toBeNull();
    expect(await srv.verifyReceipt(hdr)).toBeNull();
  });
});

// ── Client: fetch + pay + retry ─────────────────────────────────────

function makeFakePayer(): PayerAdapter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async payUsdc(params) {
      calls.push(params);
      return { txHash: "0x" + "d".repeat(64) };
    },
  };
}

async function makeChallengeHeader(serverPk: string, resource: string, usdc: number): Promise<string> {
  const srv = new KairosPaymentServer({ serverPrivateKey: serverPk });
  const c = await srv.signChallenge({ resource, amountUsdc: usdc, chainId: 8453 });
  const wire: WireChallenge = {
    v: 1,
    resource: c.resource,
    amountUsdc: c.amountUsdc,
    payToAddress: c.payToAddress,
    chainId: c.chainId,
    expiresAt: c.expiresAt,
    signerAddress: c.payToAddress,      // signer == payTo (approved case)
    signature: c.signature,
  };
  return Buffer.from(JSON.stringify(wire)).toString("base64url");
}

describe("KairosPaymentClient", () => {
  const serverPk = "0x" + "a".repeat(64);
  const serverAddr = new Wallet(serverPk).address;

  it("passes through non-402 responses unchanged", async () => {
    const payer = makeFakePayer();
    const client = new KairosPaymentClient({
      approvedPayees: [serverAddr], payer,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const res = await client.fetchWithPay("https://svc/x");
    expect(res.status).toBe(200);
    expect(payer.calls).toHaveLength(0);
  });

  it("happy path: 402 → pay → retry with receipt", async () => {
    const payer = makeFakePayer();
    const challengeHeader = await makeChallengeHeader(serverPk, "/api/x", 0.05);
    let call = 0;
    const client = new KairosPaymentClient({
      approvedPayees: [serverAddr], payer,
      fetchImpl: async (_url, init) => {
        call++;
        if (call === 1) return new Response("pay please", {
          status: 402, headers: { "Kairos-Payment-Challenge": challengeHeader },
        });
        // Retry should carry Kairos-Payment-Receipt
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        expect(hdrs["Kairos-Payment-Receipt"]).toBeDefined();
        return new Response("done", { status: 200 });
      },
    });
    const res = await client.fetchWithPay("https://svc/api/x");
    expect(res.status).toBe(200);
    expect(payer.calls).toHaveLength(1);
    expect((payer.calls[0] as { to: string }).to.toLowerCase()).toBe(serverAddr.toLowerCase());
  });

  it("refuses to pay an unapproved payee", async () => {
    const payer = makeFakePayer();
    const challengeHeader = await makeChallengeHeader(serverPk, "/api/x", 0.05);
    const client = new KairosPaymentClient({
      approvedPayees: ["0x1234567890123456789012345678901234567890"],   // different addr
      payer,
      fetchImpl: async () => new Response("pay", {
        status: 402, headers: { "Kairos-Payment-Challenge": challengeHeader },
      }),
    });
    await expect(client.fetchWithPay("https://svc/x")).rejects.toThrow(/unapproved payee/);
    expect(payer.calls).toHaveLength(0);
  });

  it("refuses when amount exceeds per-payment cap", async () => {
    const payer = makeFakePayer();
    const challengeHeader = await makeChallengeHeader(serverPk, "/api/x", 5);
    const client = new KairosPaymentClient({
      approvedPayees: [serverAddr], payer, maxPerPaymentUsd: 1,
      fetchImpl: async () => new Response("pay", {
        status: 402, headers: { "Kairos-Payment-Challenge": challengeHeader },
      }),
    });
    await expect(client.fetchWithPay("https://svc/x")).rejects.toThrow(/exceeds per-payment cap/);
  });

  it("refuses expired challenges", async () => {
    // Craft a challenge whose expiry is already in the past.
    // NB: capture the expiresAt ONCE — signing + wire construction
    // must see the same value or the signature won't recover.
    const expiredAt = Date.now() - 1_000;
    const wire: WireChallenge = {
      v: 1, resource: "/api/x", amountUsdc: 0.05,
      payToAddress: serverAddr, chainId: 8453,
      expiresAt: expiredAt, signerAddress: serverAddr,
      signature: await new Wallet(serverPk).signMessage(challengeDigest({
        resource: "/api/x", amountUsdc: 0.05, payToAddress: serverAddr,
        chainId: 8453, expiresAt: expiredAt,
      })),
    };
    const hdr = Buffer.from(JSON.stringify(wire)).toString("base64url");
    const payer = makeFakePayer();
    const client = new KairosPaymentClient({
      approvedPayees: [serverAddr], payer,
      fetchImpl: async () => new Response("pay", {
        status: 402, headers: { "Kairos-Payment-Challenge": hdr },
      }),
    });
    await expect(client.fetchWithPay("https://svc/x")).rejects.toThrow(/expired/);
  });

  it("refuses on tampered signature", async () => {
    // Sign with a different key so recovery mismatches.
    // Note: "0x" + "f".repeat(64) exceeds the secp256k1 curve order and is
    // rejected by ethers. Use a valid distinct key.
    const otherPk = "0x" + "b".repeat(64);
    const badSigWallet = new Wallet(otherPk);
    const now = Date.now() + 60_000;
    const wire: WireChallenge = {
      v: 1, resource: "/api/x", amountUsdc: 0.05,
      payToAddress: serverAddr, chainId: 8453, expiresAt: now,
      signerAddress: serverAddr,                        // CLAIMS to be server
      signature: await badSigWallet.signMessage(challengeDigest({
        resource: "/api/x", amountUsdc: 0.05, payToAddress: serverAddr,
        chainId: 8453, expiresAt: now,
      })),
    };
    const hdr = Buffer.from(JSON.stringify(wire)).toString("base64url");
    const payer = makeFakePayer();
    const client = new KairosPaymentClient({
      approvedPayees: [serverAddr], payer,
      fetchImpl: async () => new Response("pay", {
        status: 402, headers: { "Kairos-Payment-Challenge": hdr },
      }),
    });
    await expect(client.fetchWithPay("https://svc/x")).rejects.toThrow(/signer address mismatch/);
  });

  it("respects the rolling 24h cap", async () => {
    const payer = makeFakePayer();
    const client = new KairosPaymentClient({
      approvedPayees: [serverAddr], payer,
      maxPerPaymentUsd: 10, maxDailyUsd: 0.10,
      fetchImpl: async () => {
        const hdr = await makeChallengeHeader(serverPk, "/x", 0.06);
        return new Response("pay", { status: 402, headers: { "Kairos-Payment-Challenge": hdr } });
      },
    });
    // Would work once (0.06 <= 0.10), throw on second (0.06 + 0.06 > 0.10)
    // First call returns 402 twice — the fetchImpl always returns 402, so
    // the client would loop. Prevent that by only running one .fetchWithPay
    // for the "under-budget" attempt, then a second .fetchWithPay for the
    // "over-budget" one; each is exactly one 402 → pay → retry, but the
    // retry also gets a 402 (fake server never satisfies) so we swallow.
    await client.fetchWithPay("https://svc/first").catch(() => {});
    expect(payer.calls.length).toBeGreaterThanOrEqual(1);
    // Second payment should be refused by the cap.
    await expect(client.fetchWithPay("https://svc/second")).rejects.toThrow(/daily 402 spend cap/);
  });
});

describe("NoopPaymentClient", () => {
  it("throws on 402 with fase-6 error", async () => {
    const client = new NoopPaymentClient(cfg);
    // Cheap fetch stub for the node global
    const orig = global.fetch;
    global.fetch = (async () => new Response("nope", { status: 402 })) as typeof fetch;
    try {
      await expect(client.fetchWithPay("https://svc/x")).rejects.toThrow(/NoopPaymentClient refuses/);
    } finally { global.fetch = orig; }
  });
});
