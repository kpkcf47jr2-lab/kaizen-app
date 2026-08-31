// ═══════════════════════════════════════════════════════════════════════
//  PolicyEngine — external hard limits for autonomous economic actions
//
//  Owner directive (2026-08-30): "El gasto debe tener HARD LIMITS externos
//  al agente. Kaizen NO puede modificar estos límites."
//
//  These constants live in code, NOT in a prompt Kaizen sees. Any economic
//  action goes through `evaluate()` before execution — no bypass path.
//
//  If any limit is violated, evaluate() returns `{ allow: false, reason }`
//  and the ledger records the rejection with the offending value. Kaizen
//  can read that rejection back and adapt (choose smaller amount, wait,
//  abort) — but it cannot make the rejection go away.
//
//  Kill switch: if process.env[KILL_SWITCH_ENV] === "1", every evaluate()
//  returns rejected with kind="killed", regardless of other state. Owner
//  can flip that env var (via /etc/kaizen-secrets.env or CLI) to freeze
//  Kaizen instantly without a redeploy.
// ═══════════════════════════════════════════════════════════════════════

// ── Hard limits — Phase-1 initial-test values ─────────────────────────
// Owner-controlled. Cannot be raised by Kaizen. To raise, edit here + PR
// + review + deploy. Not runtime-configurable. Not env-configurable. This
// is intentional: if a limit lived in an env var a compromised .env file
// could raise it silently. The prod deployment reads THESE numbers.

export const HARD_LIMITS = Object.freeze({
  /** Maximum USDC the ops wallet is expected to hold at any time. */
  MAX_WALLET_FUNDING_USD: 50,
  /** Cap for a single autonomous action, regardless of provider. */
  MAX_SINGLE_AUTONOMOUS_SPEND_USD: 20,
  /** Rolling 24h cap. Reset happens continuously (sliding window). */
  MAX_DAILY_CUMULATIVE_SPEND_USD: 25,
  /** GPU rentals cap. Enforced at rent-time + also by external stop timer. */
  MAX_GPU_RUNTIME_MINUTES: 60,
  /** Only one GPU may be provisioned by Kaizen at any moment. */
  MAX_CONCURRENT_GPU_INSTANCES: 1,
});

export const KILL_SWITCH_ENV = "KAIZEN_KILL_SWITCH" as const;

// ── Types ─────────────────────────────────────────────────────────────

/**
 * The kind of economic action Kaizen is proposing.
 * Each maps to a specific evaluation path.
 */
export type EconomicActionKind =
  | "compute_rent"         // rent a GPU
  | "compute_extend"       // add time to an existing rental
  | "wallet_send"          // move USDC (payment)
  | "exchange_swap"        // token swap
  | "ads_campaign"         // marketing spend
  | "commerce_purchase";   // buy a good

export interface EconomicActionRequest {
  kind: EconomicActionKind;
  /** Estimated USD cost of this action. May be worst-case. */
  amount_usd: number;
  /** How many concurrent GPU instances Kaizen currently holds. */
  concurrent_gpus?: number;
  /** For compute_rent: expected minutes of runtime. */
  requested_runtime_minutes?: number;
  /** Human-readable rationale. Logged even on rejection. */
  reason: string;
}

export interface PolicySnapshot {
  /** Cumulative spent in the last 24h (sliding window, from ledger). */
  spent_last_24h_usd: number;
  /** Currently-reserved amounts across all in-flight actions. */
  reserved_usd: number;
  /** Current wallet balance (from on-chain read). */
  wallet_balance_usd: number;
}

export type PolicyDecision =
  | { allow: true }
  | { allow: false; kind: PolicyRejectionKind; reason: string; offending_value?: number; limit?: number };

export type PolicyRejectionKind =
  | "killed"
  | "wallet_funding_over_cap"
  | "single_spend_over_cap"
  | "daily_cumulative_over_cap"
  | "gpu_runtime_over_cap"
  | "concurrent_gpu_over_cap"
  | "insufficient_wallet_balance"
  | "invalid_input";

// ── The engine ────────────────────────────────────────────────────────

export class PolicyEngine {
  constructor(
    /** Read the kill switch. Defaults to reading process.env at call-time
     *  so a mid-request flip takes effect on the next evaluate(). */
    private readonly killSwitch: () => boolean = () => process.env[KILL_SWITCH_ENV] === "1",
  ) {}

  /**
   * Decide whether an economic action may proceed given current state.
   * Pure function — reads no external state, so it can be tested exhaustively.
   * The caller feeds it a PolicySnapshot from wallet + ledger reads.
   */
  evaluate(req: EconomicActionRequest, snap: PolicySnapshot): PolicyDecision {
    // ── Guard: kill switch always wins ─────────────────────────────
    if (this.killSwitch()) {
      return {
        allow: false, kind: "killed",
        reason: `Kill switch active (env ${KILL_SWITCH_ENV}=1). All economic actions refused.`,
      };
    }

    // ── Guard: input sanity ────────────────────────────────────────
    if (!Number.isFinite(req.amount_usd) || req.amount_usd < 0) {
      return { allow: false, kind: "invalid_input", reason: `amount_usd must be a finite non-negative number, got ${req.amount_usd}` };
    }
    if (!Number.isFinite(snap.spent_last_24h_usd) || snap.spent_last_24h_usd < 0) {
      return { allow: false, kind: "invalid_input", reason: `spent_last_24h_usd invalid: ${snap.spent_last_24h_usd}` };
    }

    // ── Single action cap ──────────────────────────────────────────
    if (req.amount_usd > HARD_LIMITS.MAX_SINGLE_AUTONOMOUS_SPEND_USD) {
      return {
        allow: false, kind: "single_spend_over_cap",
        reason: `Action cost $${req.amount_usd.toFixed(2)} exceeds MAX_SINGLE_AUTONOMOUS_SPEND_USD $${HARD_LIMITS.MAX_SINGLE_AUTONOMOUS_SPEND_USD}.`,
        offending_value: req.amount_usd,
        limit: HARD_LIMITS.MAX_SINGLE_AUTONOMOUS_SPEND_USD,
      };
    }

    // ── Rolling 24h cap ────────────────────────────────────────────
    const projected_24h = snap.spent_last_24h_usd + snap.reserved_usd + req.amount_usd;
    if (projected_24h > HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD) {
      return {
        allow: false, kind: "daily_cumulative_over_cap",
        reason: `Projected 24h total $${projected_24h.toFixed(2)} = spent $${snap.spent_last_24h_usd.toFixed(2)} + reserved $${snap.reserved_usd.toFixed(2)} + this $${req.amount_usd.toFixed(2)} exceeds cap $${HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD}.`,
        offending_value: projected_24h,
        limit: HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD,
      };
    }

    // ── Wallet balance check ───────────────────────────────────────
    // Cost + already-reserved must be covered by current balance.
    const need = req.amount_usd + snap.reserved_usd;
    if (need > snap.wallet_balance_usd) {
      return {
        allow: false, kind: "insufficient_wallet_balance",
        reason: `Need $${need.toFixed(2)} (this $${req.amount_usd.toFixed(2)} + reserved $${snap.reserved_usd.toFixed(2)}), wallet holds $${snap.wallet_balance_usd.toFixed(2)}.`,
        offending_value: need,
        limit: snap.wallet_balance_usd,
      };
    }

    // ── Wallet funding overall cap (defensive) ─────────────────────
    // If someone accidentally sent extra $ to the ops wallet, refuse to
    // operate above the stated MAX_WALLET_FUNDING_USD.
    if (snap.wallet_balance_usd > HARD_LIMITS.MAX_WALLET_FUNDING_USD) {
      return {
        allow: false, kind: "wallet_funding_over_cap",
        reason: `Wallet holds $${snap.wallet_balance_usd.toFixed(2)} which exceeds MAX_WALLET_FUNDING_USD $${HARD_LIMITS.MAX_WALLET_FUNDING_USD}. Kaizen refuses to operate on an over-funded wallet — owner should withdraw excess.`,
        offending_value: snap.wallet_balance_usd,
        limit: HARD_LIMITS.MAX_WALLET_FUNDING_USD,
      };
    }

    // ── GPU-specific caps ──────────────────────────────────────────
    if (req.kind === "compute_rent" || req.kind === "compute_extend") {
      const minutes = req.requested_runtime_minutes ?? 0;
      if (minutes > HARD_LIMITS.MAX_GPU_RUNTIME_MINUTES) {
        return {
          allow: false, kind: "gpu_runtime_over_cap",
          reason: `Requested ${minutes} min exceeds MAX_GPU_RUNTIME_MINUTES ${HARD_LIMITS.MAX_GPU_RUNTIME_MINUTES}.`,
          offending_value: minutes, limit: HARD_LIMITS.MAX_GPU_RUNTIME_MINUTES,
        };
      }
      const concurrent = req.concurrent_gpus ?? 0;
      // For rent (new instance) — count would go up by 1
      // For extend — count stays the same, but we still guard
      const projected_concurrent = req.kind === "compute_rent" ? concurrent + 1 : concurrent;
      if (projected_concurrent > HARD_LIMITS.MAX_CONCURRENT_GPU_INSTANCES) {
        return {
          allow: false, kind: "concurrent_gpu_over_cap",
          reason: `Would run ${projected_concurrent} GPUs (currently ${concurrent}, cap ${HARD_LIMITS.MAX_CONCURRENT_GPU_INSTANCES}).`,
          offending_value: projected_concurrent, limit: HARD_LIMITS.MAX_CONCURRENT_GPU_INSTANCES,
        };
      }
    }

    return { allow: true };
  }
}
