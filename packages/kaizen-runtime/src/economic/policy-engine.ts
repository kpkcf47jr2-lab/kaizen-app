// ═══════════════════════════════════════════════════════════════════════
//  PolicyEngine — owner-selected policy profiles + range validation
//
//  CEO gate rejection (2026-08-30):
//   #8 "Sustituir los límites fijos por perfiles de política seleccionados
//       exclusivamente por el propietario. Incluir un perfil explícito
//       UNRESTRICTED_OWNER_MODE para el entorno privado solicitado,
//       conservando kill switch, auditoría, reconciliación e invariantes
//       contables. El agente no puede cambiar el perfil."
//   #9 "Añadir validación finita y de rango para wallet balance, reserved
//       amount, runtime, GPU count, unit cost y actual cost."
//
//  Profile selection: read ONCE at construction from the environment
//  (KAIZEN_POLICY_PROFILE) or passed explicitly by the process owner.
//  There is no setter. The agent has no tool that reaches this class.
//
//  UNRESTRICTED_OWNER_MODE removes the SPENDING ceilings only. It keeps:
//    · the kill switch
//    · full ledger + audit trail
//    · reconciliation requirements
//    · accounting invariants (finite, non-negative, balance-covered)
//  "Unrestricted" means "no arbitrary cap", NOT "no bookkeeping".
// ═══════════════════════════════════════════════════════════════════════

export const KILL_SWITCH_ENV = "KAIZEN_KILL_SWITCH" as const;
export const POLICY_PROFILE_ENV = "KAIZEN_POLICY_PROFILE" as const;

export interface PolicyLimits {
  MAX_WALLET_FUNDING_USD: number;
  MAX_SINGLE_AUTONOMOUS_SPEND_USD: number;
  MAX_DAILY_CUMULATIVE_SPEND_USD: number;
  MAX_GPU_RUNTIME_MINUTES: number;
  MAX_CONCURRENT_GPU_INSTANCES: number;
}

export type PolicyProfileName =
  | "PHASE1_INITIAL_TEST"
  | "PHASE3_REAL_SMALL"
  | "STANDARD_OPERATION"
  | "UNRESTRICTED_OWNER_MODE";

/** Every profile is frozen. Selection is owner-only; mutation is impossible. */
export const POLICY_PROFILES: Readonly<Record<PolicyProfileName, Readonly<PolicyLimits>>> = Object.freeze({
  /** Fase 1/2 — dry-run. Deliberately tiny so a wiring mistake is cheap. */
  PHASE1_INITIAL_TEST: Object.freeze({
    MAX_WALLET_FUNDING_USD: 50,
    MAX_SINGLE_AUTONOMOUS_SPEND_USD: 20,
    MAX_DAILY_CUMULATIVE_SPEND_USD: 25,
    MAX_GPU_RUNTIME_MINUTES: 60,
    MAX_CONCURRENT_GPU_INSTANCES: 1,
  }),
  /** Fase 3 — first real money. Owner specified $5 wallet / $2 per action. */
  PHASE3_REAL_SMALL: Object.freeze({
    MAX_WALLET_FUNDING_USD: 5,
    MAX_SINGLE_AUTONOMOUS_SPEND_USD: 2,
    MAX_DAILY_CUMULATIVE_SPEND_USD: 4,
    MAX_GPU_RUNTIME_MINUTES: 60,
    MAX_CONCURRENT_GPU_INSTANCES: 1,
  }),
  /** Post-certification steady state. Raised only by owner authorization. */
  STANDARD_OPERATION: Object.freeze({
    MAX_WALLET_FUNDING_USD: 500,
    MAX_SINGLE_AUTONOMOUS_SPEND_USD: 50,
    MAX_DAILY_CUMULATIVE_SPEND_USD: 200,
    MAX_GPU_RUNTIME_MINUTES: 480,
    MAX_CONCURRENT_GPU_INSTANCES: 3,
  }),
  /**
   * Owner's private environment. Spending ceilings lifted; SAFETY KEPT.
   * Infinity disables the ceiling comparison but every other invariant —
   * kill switch, finite/non-negative amounts, balance coverage, ledger,
   * reconciliation — still applies. Concurrency still bounded so a runaway
   * loop cannot fork unbounded infrastructure.
   */
  UNRESTRICTED_OWNER_MODE: Object.freeze({
    MAX_WALLET_FUNDING_USD: Number.POSITIVE_INFINITY,
    MAX_SINGLE_AUTONOMOUS_SPEND_USD: Number.POSITIVE_INFINITY,
    MAX_DAILY_CUMULATIVE_SPEND_USD: Number.POSITIVE_INFINITY,
    MAX_GPU_RUNTIME_MINUTES: Number.POSITIVE_INFINITY,
    MAX_CONCURRENT_GPU_INSTANCES: 8,
  }),
});

export const DEFAULT_PROFILE: PolicyProfileName = "PHASE1_INITIAL_TEST";

export function resolveProfileName(raw?: string | null): PolicyProfileName {
  if (raw && raw in POLICY_PROFILES) return raw as PolicyProfileName;
  return DEFAULT_PROFILE;
}

// ── Types ─────────────────────────────────────────────────────────────

export type EconomicActionKind =
  | "compute_rent" | "compute_extend" | "wallet_send"
  | "exchange_swap" | "ads_campaign" | "commerce_purchase";

export interface EconomicActionRequest {
  kind: EconomicActionKind;
  amount_usd: number;
  concurrent_gpus?: number;
  requested_runtime_minutes?: number;
  reason: string;
}

export interface PolicySnapshot {
  spent_last_24h_usd: number;
  reserved_usd: number;
  wallet_balance_usd: number;
}

export type PolicyRejectionKind =
  | "killed"
  | "wallet_funding_over_cap"
  | "single_spend_over_cap"
  | "daily_cumulative_over_cap"
  | "gpu_runtime_over_cap"
  | "concurrent_gpu_over_cap"
  | "insufficient_wallet_balance"
  | "invalid_input";

export type PolicyDecision =
  | { allow: true; profile: PolicyProfileName }
  | {
      allow: false; kind: PolicyRejectionKind; reason: string;
      offending_value?: number; limit?: number; profile: PolicyProfileName;
    };

// ── Range validation (gate #9) ────────────────────────────────────────
// Every numeric that reaches money math is checked for finiteness and a
// plausible range. Infinity is allowed ONLY as a configured ceiling, never
// as an input value.

const MAX_PLAUSIBLE_USD = 1_000_000;          // sanity ceiling on any input
const MAX_PLAUSIBLE_MINUTES = 60 * 24 * 30;   // 30 days
const MAX_PLAUSIBLE_GPUS = 1_000;

export interface RangeIssue { field: string; value: unknown; reason: string; }

/** Validate an input number is finite, within [min,max], and not NaN. */
export function checkNumber(
  field: string, value: unknown, opts: { min?: number; max?: number; integer?: boolean } = {},
): RangeIssue | null {
  if (typeof value !== "number") return { field, value, reason: "must be a number" };
  if (!Number.isFinite(value)) return { field, value, reason: "must be finite (NaN/Infinity rejected)" };
  if (opts.integer && !Number.isInteger(value)) return { field, value, reason: "must be an integer" };
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (value < min) return { field, value, reason: `must be >= ${min}` };
  if (value > max) return { field, value, reason: `must be <= ${max}` };
  return null;
}

export function validateRequest(req: EconomicActionRequest): RangeIssue | null {
  const issues = [
    checkNumber("amount_usd", req.amount_usd, { min: 0, max: MAX_PLAUSIBLE_USD }),
    req.requested_runtime_minutes !== undefined
      ? checkNumber("requested_runtime_minutes", req.requested_runtime_minutes, { min: 0, max: MAX_PLAUSIBLE_MINUTES })
      : null,
    req.concurrent_gpus !== undefined
      ? checkNumber("concurrent_gpus", req.concurrent_gpus, { min: 0, max: MAX_PLAUSIBLE_GPUS, integer: true })
      : null,
  ].filter(Boolean) as RangeIssue[];
  return issues[0] ?? null;
}

export function validateSnapshot(snap: PolicySnapshot): RangeIssue | null {
  const issues = [
    checkNumber("spent_last_24h_usd", snap.spent_last_24h_usd, { min: 0, max: MAX_PLAUSIBLE_USD }),
    checkNumber("reserved_usd", snap.reserved_usd, { min: 0, max: MAX_PLAUSIBLE_USD }),
    checkNumber("wallet_balance_usd", snap.wallet_balance_usd, { min: 0, max: MAX_PLAUSIBLE_USD }),
  ].filter(Boolean) as RangeIssue[];
  return issues[0] ?? null;
}

/** Gate #3 + #9: a settled charge must be finite, non-negative, and within
 *  what was authorized. Callers use this to route over-charges to dispute. */
export function validateActualCost(
  actual_cost_usd: unknown, authorized_max_usd: number,
): { ok: true; value: number } | { ok: false; reason: string; overcharge?: boolean } {
  const issue = checkNumber("actual_cost_usd", actual_cost_usd, { min: 0, max: MAX_PLAUSIBLE_USD });
  if (issue) return { ok: false, reason: `${issue.field} ${issue.reason} (got ${String(issue.value)})` };
  const v = actual_cost_usd as number;
  if (v > authorized_max_usd) {
    return {
      ok: false, overcharge: true,
      reason: `actual cost $${v.toFixed(2)} exceeds authorized max $${authorized_max_usd.toFixed(2)}`,
    };
  }
  return { ok: true, value: v };
}

// ── The engine ────────────────────────────────────────────────────────

export class PolicyEngine {
  /** Resolved ONCE at construction. No setter exists — the agent cannot
   *  switch profiles at runtime, and nothing exposes this to a tool. */
  readonly profileName: PolicyProfileName;
  readonly limits: Readonly<PolicyLimits>;

  constructor(
    private readonly killSwitch: () => boolean = () => process.env[KILL_SWITCH_ENV] === "1",
    /** Owner-only. Normally left undefined so the env var decides. */
    profile?: PolicyProfileName,
  ) {
    this.profileName = profile ?? resolveProfileName(process.env[POLICY_PROFILE_ENV]);
    this.limits = POLICY_PROFILES[this.profileName];
  }

  evaluate(req: EconomicActionRequest, snap: PolicySnapshot): PolicyDecision {
    const profile = this.profileName;

    // Kill switch always wins — kept even in UNRESTRICTED_OWNER_MODE.
    if (this.killSwitch()) {
      return { allow: false, kind: "killed", profile,
        reason: `Kill switch active (env ${KILL_SWITCH_ENV}=1). All economic actions refused.` };
    }

    // Gate #9 — range validation on every numeric input.
    const reqIssue = validateRequest(req);
    if (reqIssue) {
      return { allow: false, kind: "invalid_input", profile,
        reason: `${reqIssue.field} ${reqIssue.reason} (got ${String(reqIssue.value)})`,
        offending_value: typeof reqIssue.value === "number" ? reqIssue.value : undefined };
    }
    const snapIssue = validateSnapshot(snap);
    if (snapIssue) {
      return { allow: false, kind: "invalid_input", profile,
        reason: `${snapIssue.field} ${snapIssue.reason} (got ${String(snapIssue.value)})`,
        offending_value: typeof snapIssue.value === "number" ? snapIssue.value : undefined };
    }

    const L = this.limits;

    if (req.amount_usd > L.MAX_SINGLE_AUTONOMOUS_SPEND_USD) {
      return { allow: false, kind: "single_spend_over_cap", profile,
        reason: `Action cost $${req.amount_usd.toFixed(2)} exceeds MAX_SINGLE_AUTONOMOUS_SPEND_USD $${L.MAX_SINGLE_AUTONOMOUS_SPEND_USD} (profile ${profile}).`,
        offending_value: req.amount_usd, limit: L.MAX_SINGLE_AUTONOMOUS_SPEND_USD };
    }

    const projected_24h = snap.spent_last_24h_usd + snap.reserved_usd + req.amount_usd;
    if (projected_24h > L.MAX_DAILY_CUMULATIVE_SPEND_USD) {
      return { allow: false, kind: "daily_cumulative_over_cap", profile,
        reason: `Projected 24h total $${projected_24h.toFixed(2)} = spent $${snap.spent_last_24h_usd.toFixed(2)} + reserved $${snap.reserved_usd.toFixed(2)} + this $${req.amount_usd.toFixed(2)} exceeds cap $${L.MAX_DAILY_CUMULATIVE_SPEND_USD} (profile ${profile}).`,
        offending_value: projected_24h, limit: L.MAX_DAILY_CUMULATIVE_SPEND_USD };
    }

    // Accounting invariant — kept in EVERY profile including UNRESTRICTED.
    // You cannot spend money you do not hold.
    const need = req.amount_usd + snap.reserved_usd;
    if (need > snap.wallet_balance_usd) {
      return { allow: false, kind: "insufficient_wallet_balance", profile,
        reason: `Need $${need.toFixed(2)} (this $${req.amount_usd.toFixed(2)} + reserved $${snap.reserved_usd.toFixed(2)}), wallet holds $${snap.wallet_balance_usd.toFixed(2)}.`,
        offending_value: need, limit: snap.wallet_balance_usd };
    }

    if (snap.wallet_balance_usd > L.MAX_WALLET_FUNDING_USD) {
      return { allow: false, kind: "wallet_funding_over_cap", profile,
        reason: `Wallet holds $${snap.wallet_balance_usd.toFixed(2)} which exceeds MAX_WALLET_FUNDING_USD $${L.MAX_WALLET_FUNDING_USD} (profile ${profile}). Refusing to operate on an over-funded wallet.`,
        offending_value: snap.wallet_balance_usd, limit: L.MAX_WALLET_FUNDING_USD };
    }

    if (req.kind === "compute_rent" || req.kind === "compute_extend") {
      const minutes = req.requested_runtime_minutes ?? 0;
      if (minutes > L.MAX_GPU_RUNTIME_MINUTES) {
        return { allow: false, kind: "gpu_runtime_over_cap", profile,
          reason: `Requested ${minutes} min exceeds MAX_GPU_RUNTIME_MINUTES ${L.MAX_GPU_RUNTIME_MINUTES} (profile ${profile}).`,
          offending_value: minutes, limit: L.MAX_GPU_RUNTIME_MINUTES };
      }
      const concurrent = req.concurrent_gpus ?? 0;
      const projected = req.kind === "compute_rent" ? concurrent + 1 : concurrent;
      if (projected > L.MAX_CONCURRENT_GPU_INSTANCES) {
        return { allow: false, kind: "concurrent_gpu_over_cap", profile,
          reason: `Would run ${projected} GPUs (currently ${concurrent}, cap ${L.MAX_CONCURRENT_GPU_INSTANCES}, profile ${profile}).`,
          offending_value: projected, limit: L.MAX_CONCURRENT_GPU_INSTANCES };
      }
    }

    return { allow: true, profile };
  }
}
