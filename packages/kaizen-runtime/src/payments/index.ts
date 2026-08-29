// ═══════════════════════════════════════════════════════════════════════
//  payments/  —  autonomous HTTP payments (Fase 6)
//
//  Kaizen-signed 402 with Kairos-Payment-Challenge + Kairos-Payment-Receipt
//  headers. Client refuses to pay any address not in `approvedPayees`,
//  enforces per-payment + per-day USD caps, and routes every payment
//  through the injected PayerAdapter (which in prod = a wrapper over
//  SecureWalletService so PolicyEngine still runs).
// ═══════════════════════════════════════════════════════════════════════

import type { ModuleConfig } from "../types.js";
import type { IPaymentClient, IPaymentServer, PaymentChallenge, PaymentReceipt } from "./types.js";

// Re-export shared types so callers get one import path.
export type { PaymentChallenge, PaymentReceipt, IPaymentClient, IPaymentServer };

// Legacy aliases kept for source-compat with Fase 0 stub callers.
export type PaymentClient = IPaymentClient;
export type PaymentServer = IPaymentServer;

/** Fase 0 stub — passthrough fetch, refuses to pay anything.
 *  Preserved for tests. Real impl: KairosPaymentClient in ./402.js. */
export class NoopPaymentClient implements IPaymentClient {
  constructor(private readonly cfg: ModuleConfig) {}
  async fetchWithPay(url: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status === 402) {
      throw new Error(
        `[kaizen-runtime] Got 402 from ${url} but NoopPaymentClient refuses. ` +
        `Use KairosPaymentClient from './402.js' instead ` +
        `(agent=${this.cfg.agentId}).`,
      );
    }
    return res;
  }
}

// Fase 6 concrete exports
export {
  KairosPaymentClient,
  KairosPaymentServer,
  challengeDigest,
  type PaymentClientConfig,
  type PaymentServerConfig,
  type PayerAdapter,
  type WireChallenge,
} from "./402.js";
