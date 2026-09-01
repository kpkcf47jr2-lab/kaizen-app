// ═══════════════════════════════════════════════════════════════════════
//  economic/ — Economic Foundation Layer (Fase 1, rev 1)
//
//  Rev 1 addresses the CEO's 10 gate corrections. Notably:
//   #1 provider params come from a typed catalog + allowlist, never from
//      model-authored `attributes`
//   #2 failed/uncertain keep the idempotency key consumed until reconcile()
//   #3 actual_cost is validated; overcharges go to BILLING_DISPUTE
//   #4 an under-funded ceiling is rejected with the verified figure
//   #5 decision_events is append-only via SQLite triggers, no CASCADE
//   #6 ONE database, ONE transaction across ledger + dedupe + reserve
//   #8 owner-selected policy profiles incl. UNRESTRICTED_OWNER_MODE
//   #9 finite/range validation on every numeric that touches money
// ═══════════════════════════════════════════════════════════════════════

export { EconomicStore, type EconomicStoreConfig } from "./store.js";

export {
  PolicyEngine,
  POLICY_PROFILES,
  DEFAULT_PROFILE,
  resolveProfileName,
  checkNumber,
  validateRequest,
  validateSnapshot,
  validateActualCost,
  KILL_SWITCH_ENV,
  POLICY_PROFILE_ENV,
  type PolicyLimits,
  type PolicyProfileName,
  type EconomicActionKind,
  type EconomicActionRequest,
  type PolicySnapshot,
  type PolicyDecision,
  type PolicyRejectionKind,
  type RangeIssue,
} from "./policy-engine.js";

export {
  StaticProviderCatalog,
  DRY_RUN_CATALOG,
  PROVIDER_PARAM_ALLOWLIST,
  buildProviderParams,
  type CatalogEntry,
  type CatalogSource,
} from "./provider-catalog.js";

export {
  IdempotencyStore,
  makeIdempotencyKey,
  canonicalizeArgs,
  newOperationId,
  BLOCKING_STATES,
  RELEASING_STATES,
  type OpState,
  type BeginResult,
  type OperationRow,
} from "./idempotency-store.js";

export {
  EconomicEventLedger,
  DECISION_STATES,
  TERMINAL_STATES,
  LEGAL_TRANSITIONS,
  type DecisionState,
  type DecisionRecord,
  type DecisionEvent,
} from "./event-ledger.js";

export {
  BudgetReservation,
  type ReservationState,
  type ReservationRow,
  type ReserveResult,
  type WalletReader,
} from "./budget-reservation.js";

export {
  CircuitBreaker,
  type BreakerState,
  type BreakerRow,
  type AllowResult,
  type CircuitBreakerConfig,
} from "./circuit-breaker.js";

export {
  EconomicDecisionBuilder,
  validateProposal,
  type EconomicProposal,
  type ProposalOption,
  type ExecutionOrder,
  type ExecutionResult,
  type SubmitOutcome,
  type DecisionBuilderDeps,
} from "./decision-builder.js";
