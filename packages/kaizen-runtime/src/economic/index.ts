// ═══════════════════════════════════════════════════════════════════════
//  economic/ — Economic Foundation Layer (Fase 1)
//
//  Everything Kaizen needs to move money safely. Nothing here executes a
//  payment on its own; this layer decides WHETHER an economic action is
//  allowed, reserves the capital atomically, dedupes it, records it, and
//  hands the executor a narrow order it cannot widen.
//
//  Wiring order for a caller:
//     EconomicDecisionBuilder.submit(agent, proposal)
//        → validates shape
//        → verifies price against the authoritative catalog
//        → writes DECISION_CREATED to the ledger
//        → CircuitBreaker.allow(provider)
//        → IdempotencyStore.begin(key)
//        → BudgetReservation.reserve()  [PolicyEngine inside, atomic]
//        → returns ExecutionOrder
//     <caller executes the order against the provider>
//     EconomicDecisionBuilder.settle(order, result)
//        → commits/releases budget, closes ledger, updates breaker
// ═══════════════════════════════════════════════════════════════════════

export {
  PolicyEngine,
  HARD_LIMITS,
  KILL_SWITCH_ENV,
  type EconomicActionKind,
  type EconomicActionRequest,
  type PolicySnapshot,
  type PolicyDecision,
  type PolicyRejectionKind,
} from "./policy-engine.js";

export {
  IdempotencyStore,
  makeIdempotencyKey,
  canonicalizeArgs,
  newOperationId,
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
} from "./circuit-breaker.js";

export {
  EconomicDecisionBuilder,
  validateProposal,
  type EconomicProposal,
  type ExecutionOrder,
  type ExecutionResult,
  type SubmitOutcome,
  type DecisionBuilderDeps,
} from "./decision-builder.js";
