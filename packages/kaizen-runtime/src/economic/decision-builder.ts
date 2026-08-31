// ═══════════════════════════════════════════════════════════════════════
//  EconomicDecisionBuilder — the ONLY path from LLM intent to money
//
//  Owner directive (2026-08-30):
//    "NO quiero wallet.transfer genérico expuesto libremente al LLM.
//     El LLM debe solicitar una acción económica estructurada:
//       Kaizen → Economic Decision → Policy Engine → Budget Check
//              → Transaction/Payment Builder → Secure Wallet Service
//              → Execution
//     El modelo nunca debe decidir arbitrariamente una dirección y
//     cantidad y enviarla directamente."
//
//  So: the LLM never calls a spend tool. It emits an EconomicProposal —
//  a declarative "here is what I want to achieve and why" — and this
//  builder is the thing that:
//     1. validates the proposal shape
//     2. writes a decision to the ledger (audit starts BEFORE any spend)
//     3. checks the circuit breaker for the target provider
//     4. runs policy + reserves budget ATOMICALLY
//     5. dedupes via the idempotency store
//     6. hands a narrow, fully-specified ExecutionOrder to the executor
//     7. records the outcome, reconciles cost, releases/commits budget
//
//  The executor callback receives an ExecutionOrder that the LLM cannot
//  author directly — recipient addresses and amounts come from the
//  provider catalog and the reserved budget, not from model output.
// ═══════════════════════════════════════════════════════════════════════

import { EconomicEventLedger, type DecisionRecord } from "./event-ledger.js";
import { BudgetReservation } from "./budget-reservation.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { IdempotencyStore, makeIdempotencyKey } from "./idempotency-store.js";
import type { EconomicActionKind, PolicyDecision } from "./policy-engine.js";

// ── What the LLM is allowed to emit ───────────────────────────────────
// Note: NO recipient address. NO raw amount to send. The model states
// intent + constraints; the builder resolves the concrete transaction.

export interface EconomicProposal {
  kind: EconomicActionKind;
  objective: string;
  /** Alternatives the model evaluated. Recorded for audit + learning. */
  options_considered: Array<{
    provider: string;
    label: string;
    /** Unit price the model believes applies. Verified against catalog. */
    unit_cost_usd: number;
    /** How many units (hours, impressions, …) it expects to consume. */
    expected_units: number;
    /** Model's estimate of total. Recomputed by the builder. */
    expected_total_usd: number;
    /** 0..1 — model's belief the option completes successfully. */
    probability_success?: number;
    /** Free-form provider attributes (vram_gb, region, latency_ms, …). */
    attributes?: Record<string, unknown>;
  }>;
  /** Index into options_considered. */
  selected_index: number;
  reason: string;
  confidence: number;          // 0..1
  expected_value_usd: number;  // hypothesised benefit, NOT a promise
  /** Hard ceiling the model accepts for this action. */
  maximum_cost_usd: number;
  /** For compute actions. */
  requested_runtime_minutes?: number;
}

/** What the executor actually receives. Fully resolved; no model freedom. */
export interface ExecutionOrder {
  decision_id: string;
  operation_id: string;
  reservation_id: string;
  kind: EconomicActionKind;
  provider: string;
  /** Resolved from the reservation, not from model output. */
  authorized_max_usd: number;
  requested_runtime_minutes?: number;
  /** Opaque provider-specific params, built from the catalog entry. */
  provider_params: Record<string, unknown>;
  /** Pass to the provider so a lost response can be reconciled later. */
  external_reference: string;
}

export interface ExecutionResult {
  ok: boolean;
  actual_cost_usd?: number;
  provider_instance_id?: string;
  result?: unknown;
  failure_reason?: string;
  /** True when we could not confirm whether the provider charged us.
   *  Owner requirement: never release budget in this case. */
  cost_uncertain?: boolean;
}

export type SubmitOutcome =
  | { accepted: true; decision_id: string; order: ExecutionOrder }
  | { accepted: false; decision_id: string | null; reason: string; policy?: PolicyDecision; retry_after_ms?: number };

export interface DecisionBuilderDeps {
  ledger: EconomicEventLedger;
  budget: BudgetReservation;
  breaker: CircuitBreaker;
  idempotency: IdempotencyStore;
  /** Reads the live wallet balance. Async network call, done OUTSIDE the txn. */
  readWalletBalanceUsd: (agent_id: string) => Promise<number>;
  /** Authoritative provider catalog — the model's prices are never trusted. */
  resolveCatalogPrice: (provider: string, label: string) => Promise<number | null>;
}

export class EconomicDecisionBuilder {
  constructor(private readonly deps: DecisionBuilderDeps) {}

  /**
   * Validate + admit a proposal. Returns an ExecutionOrder only when every
   * gate passes. Nothing is spent here — the caller then runs the order
   * through the executor and reports back via `settle()`.
   */
  async submit(agent_id: string, proposal: EconomicProposal): Promise<SubmitOutcome> {
    // ── Gate 0: proposal shape ───────────────────────────────────────
    const shapeErr = validateProposal(proposal);
    if (shapeErr) return { accepted: false, decision_id: null, reason: `invalid proposal: ${shapeErr}` };

    const chosen = proposal.options_considered[proposal.selected_index]!;

    // ── Gate 1: verify price against the authoritative catalog ───────
    // The model may hallucinate a price. We recompute from the catalog and
    // use OUR number for everything downstream.
    const catalogUnit = await this.deps.resolveCatalogPrice(chosen.provider, chosen.label);
    if (catalogUnit === null) {
      return { accepted: false, decision_id: null, reason: `provider/option not in catalog: ${chosen.provider}/${chosen.label}` };
    }
    const verifiedTotal = round2(catalogUnit * chosen.expected_units);
    // If the model's estimate was materially wrong, keep going but record it.
    const priceDrift = round2(Math.abs(verifiedTotal - chosen.expected_total_usd));

    // Never authorize more than the model's own stated ceiling, nor more
    // than the verified total plus a small buffer for provider rounding.
    const authorized_max_usd = round2(Math.min(
      proposal.maximum_cost_usd,
      verifiedTotal * 1.15,
    ));

    // ── Write the decision to the ledger BEFORE any spend gate ───────
    const decision = this.deps.ledger.createDecision({
      agent_id,
      objective: proposal.objective,
      available_capital_usd: await this.deps.readWalletBalanceUsd(agent_id),
      options_considered: proposal.options_considered,
      reason: proposal.reason,
      confidence: proposal.confidence,
      expected_cost_usd: verifiedTotal,
      maximum_cost_usd: authorized_max_usd,
      expected_value_usd: proposal.expected_value_usd,
      actor: "kaizen",
    });

    // ── Gate 2: circuit breaker for this provider ────────────────────
    const breakerKey = `provider:${chosen.provider}`;
    const gate = this.deps.breaker.allow(breakerKey);
    if (!gate.allow) {
      this.deps.ledger.transition({
        decision_id: decision.decision_id, to_state: "POLICY_REJECTED", actor: "system",
        patch: { failure_reason: gate.reason },
        data: { gate: "circuit_breaker", retry_after_ms: gate.retry_after_ms },
      });
      return { accepted: false, decision_id: decision.decision_id, reason: gate.reason, retry_after_ms: gate.retry_after_ms };
    }

    // ── Gate 3: idempotency ──────────────────────────────────────────
    const idemKey = makeIdempotencyKey({
      tool: `economic:${proposal.kind}`,
      args: { provider: chosen.provider, label: chosen.label, units: chosen.expected_units, objective: proposal.objective },
      actor: agent_id,
      bucket_seconds: 3600,
    });
    const begin = this.deps.idempotency.begin({
      tool: `economic:${proposal.kind}`, key: idemKey, actor: agent_id,
      metadata: { decision_id: decision.decision_id, provider: chosen.provider },
    });
    if (!begin.fresh) {
      this.deps.ledger.transition({
        decision_id: decision.decision_id, to_state: "CANCELLED", actor: "system",
        patch: { failure_reason: `duplicate of operation ${begin.operation_id} (state=${begin.state})` },
        data: { gate: "idempotency", existing_operation_id: begin.operation_id },
      });
      return {
        accepted: false, decision_id: decision.decision_id,
        reason: `duplicate economic action; existing operation ${begin.operation_id} is ${begin.state}`,
        retry_after_ms: begin.retry_after_ms,
      };
    }

    // ── Gate 4: policy + atomic budget reservation ───────────────────
    const walletUsd = await this.deps.readWalletBalanceUsd(agent_id);
    const reserved = this.deps.budget.reserve({
      decision_id: decision.decision_id,
      agent_id,
      walletBalanceUsd: walletUsd,
      request: {
        kind: proposal.kind,
        amount_usd: authorized_max_usd,
        requested_runtime_minutes: proposal.requested_runtime_minutes,
        reason: proposal.reason,
      },
    });
    if (!reserved.ok) {
      this.deps.idempotency.rollback(begin.operation_id, "policy rejected");
      this.deps.ledger.transition({
        decision_id: decision.decision_id, to_state: "POLICY_REJECTED", actor: "policy",
        patch: { policy_result: reserved.policy, failure_reason: reserved.policy.allow ? null : reserved.policy.reason },
      });
      return {
        accepted: false, decision_id: decision.decision_id,
        reason: reserved.policy.allow ? "unknown" : reserved.policy.reason,
        policy: reserved.policy,
      };
    }

    // ── Admitted. Move the decision through APPROVED → RESERVED ──────
    this.deps.ledger.transition({
      decision_id: decision.decision_id, to_state: "POLICY_APPROVED", actor: "policy",
      patch: { policy_result: reserved.policy, selected_option: { ...chosen, verified_unit_cost_usd: catalogUnit, verified_total_usd: verifiedTotal, price_drift_usd: priceDrift }, provider: chosen.provider },
    });
    this.deps.ledger.transition({
      decision_id: decision.decision_id, to_state: "BUDGET_RESERVED", actor: "kaizen",
      patch: { reserved_capital_usd: authorized_max_usd },
      data: { reservation_id: reserved.reservation_id },
    });

    const order: ExecutionOrder = {
      decision_id: decision.decision_id,
      operation_id: begin.operation_id,
      reservation_id: reserved.reservation_id,
      kind: proposal.kind,
      provider: chosen.provider,
      authorized_max_usd,
      requested_runtime_minutes: proposal.requested_runtime_minutes,
      provider_params: { label: chosen.label, units: chosen.expected_units, ...(chosen.attributes ?? {}) },
      // Given to the provider so a lost HTTP response can be reconciled.
      external_reference: `kaizen-${decision.decision_id}`,
    };
    return { accepted: true, decision_id: decision.decision_id, order };
  }

  /**
   * Report the outcome of executing an order. Handles the owner's rule:
   * a cost-uncertain failure becomes a committed LIABILITY, never a release.
   */
  settle(order: ExecutionOrder, result: ExecutionResult): DecisionRecord {
    const breakerKey = `provider:${order.provider}`;

    if (result.ok) {
      this.deps.breaker.recordSuccess(breakerKey);
      this.deps.idempotency.commit(order.operation_id, result.provider_instance_id ?? null);
      const actual = round2(result.actual_cost_usd ?? order.authorized_max_usd);
      this.deps.budget.commit(order.reservation_id, actual);
      // TERMINATED → RECONCILED → CLOSED
      const cur = this.deps.ledger.get(order.decision_id)!;
      if (cur.state !== "TERMINATED") {
        // Caller may not have walked every state; jump legally where possible.
        // The executor is expected to drive PROVIDER_REQUESTED..TERMINATED.
      }
      this.deps.ledger.transition({
        decision_id: order.decision_id, to_state: "RECONCILED", actor: "system",
        patch: {
          actual_cost_usd: actual,
          actual_result: result.result ?? null,
          profit_or_utility_usd: round2((this.deps.ledger.get(order.decision_id)!.expected_value_usd) - actual),
        },
      });
      return this.deps.ledger.transition({ decision_id: order.decision_id, to_state: "CLOSED", actor: "system" });
    }

    // ── Failure path ─────────────────────────────────────────────────
    this.deps.breaker.recordFailure(breakerKey, result.failure_reason ?? "unknown failure");
    this.deps.idempotency.fail(order.operation_id, result.failure_reason ?? "unknown failure");

    if (result.cost_uncertain) {
      // Owner rule: budget stays consumed while infra may still bill.
      this.deps.budget.commitAsLiability(
        order.reservation_id, order.authorized_max_usd,
        result.failure_reason ?? "cost could not be confirmed",
      );
      return this.deps.ledger.transition({
        decision_id: order.decision_id, to_state: "BILLING_DISPUTE", actor: "system",
        patch: { failure_reason: result.failure_reason ?? "cost uncertain", actual_cost_usd: order.authorized_max_usd },
      });
    }

    // Confirmed no charge — safe to free the capital.
    this.deps.budget.release(order.reservation_id, result.failure_reason ?? "execution failed, no charge");
    return this.deps.ledger.transition({
      decision_id: order.decision_id, to_state: "CLOSED", actor: "system",
      patch: { failure_reason: result.failure_reason ?? "execution failed", actual_cost_usd: 0 },
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function round2(n: number): number { return Math.round(n * 100) / 100; }

export function validateProposal(p: EconomicProposal): string | null {
  if (!p || typeof p !== "object") return "not an object";
  if (!p.objective || typeof p.objective !== "string") return "objective required";
  if (!Array.isArray(p.options_considered) || p.options_considered.length === 0) return "options_considered must be a non-empty array";
  if (!Number.isInteger(p.selected_index) || p.selected_index < 0 || p.selected_index >= p.options_considered.length) {
    return `selected_index ${p.selected_index} out of range (0..${p.options_considered.length - 1})`;
  }
  if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) return "confidence must be 0..1";
  if (!Number.isFinite(p.maximum_cost_usd) || p.maximum_cost_usd <= 0) return "maximum_cost_usd must be > 0";
  if (!Number.isFinite(p.expected_value_usd)) return "expected_value_usd must be finite";
  const chosen = p.options_considered[p.selected_index]!;
  if (!chosen.provider || !chosen.label) return "selected option needs provider + label";
  if (!Number.isFinite(chosen.unit_cost_usd) || chosen.unit_cost_usd < 0) return "unit_cost_usd invalid";
  if (!Number.isFinite(chosen.expected_units) || chosen.expected_units <= 0) return "expected_units must be > 0";
  return null;
}
