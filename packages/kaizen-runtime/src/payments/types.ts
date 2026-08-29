// ═══════════════════════════════════════════════════════════════════════
//  Shared payments types — kept in a separate file so the index.ts
//  interface exports and the 402.ts concrete impl agree on shapes.
// ═══════════════════════════════════════════════════════════════════════

export interface PaymentChallenge {
  resource: string;
  amountUsdc: number;
  payToAddress: string;
  signature: string;
  expiresAt: number;
  chainId: 137 | 8453;
}

export interface PaymentReceipt {
  challengeResource: string;
  paidUsdc: number;
  txHash: string;
  chainId: number;
  timestamp: number;
}

export interface IPaymentClient {
  fetchWithPay(url: string, init?: RequestInit): Promise<Response>;
}

export interface IPaymentServer {
  /** Async — signing takes one crypto call. Use signChallenge()
   *  in real code; challenge() is kept for interface parity but
   *  throws (see notes in 402.ts). */
  signChallenge(req: { resource: string; amountUsdc: number; chainId: 137 | 8453 }): Promise<PaymentChallenge>;
  verifyReceipt(receiptHeader: string): Promise<PaymentReceipt | null>;
}
