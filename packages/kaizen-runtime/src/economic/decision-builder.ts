// ═══════════════════════════════════════════════════════════════════════
//  EconomicDecisionBuilder — the ONLY path from LLM intent to money
//
//  Fase-1-rev-1 addresses CEO gate rejections #1, #3, #4, #6.
//
//  #1  provider_params is BUILT from a typed catalog entry through a
//      per-provider allowlist. Model-authored `attributes` are recorded
//      for audit and NEVER reach the executor.
//  #3  actual_cost_usd is validated (finite, >= 0, <= authorized). An
//      overcharge routes to BILLING_DISPUTE, never a silent settlement.
//  #4  maximum_cost_usd < verifiedTotal is REJECTED with the verified
//      figure returned, instead of producing an underfunded order.
//  #6  submit() runs dedupe + reserve + ledger transitions inside ONE
//      EconomicStore transaction, so a crash between them is impossible.
// ═══════════════════════════════════════════════════════════════════════

import { EconomicEventLedger, type DecisionRecord } from "./event-ledger.js";
import { BudgetReservation } from "./budget-reservation.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { IdempotencyStore, makeIdempotencyKey } from "./idempotency-store.js";
import type { EconomicStore } from "./store.js";
import {
  validateActualCost, checkNumber,
  type EconomicActionKind, type PolicyDecision,
} from "./policy-engine.js";
import {
  buildProviderParams, type CatalogEntry, type CatalogSource,
} from "./provider-catalog.js";

// ── What the LLM is allowed to emit ───────────────────────────────────
// No recipient address. No raw amount to send. No executable parameters.

export interface ProposalOption {
  provider: string;
  label: string;
  /** Model's belief about unit price. Verified; never trusted. */
  unit_cost_usd: number;
  expected_units: number;
  expected_total_usd: number;
  probability_success?: number;
  /**
   * Model's free-form annotations. Gate #1: recorded in the ledger for
   * audit and belief-vs-reality comparison. NEVER forwarded to a provider.
   */
  attributes?: Record<string, unknown>;
}

export interface EconomicProposal {
  kind: EconomicActionKind;
  objective: string;
  options_considered: ProposalOption[];
  selected_index: number;
  reason: string;
  confidence: number;
  expected_value_usd: number;
  maximum_cost_usd: number;
  requested_runtime_minutes?: number;
}

export interface ExecutionOrder {
  decision_id: string;
  operation_id: string;
  reservation_id: string;
  kind: EconomicActionKind;
  provider: string;
  authorized_max_usd: number;
  requested_runtime_minutes?: number;
  /** Gate #1: built from the catalog + allowlist. Contains no model data. */
  provider_params: Record<string, string | number | boolean>;
  external_reference: string;
}

export interface ExecutionResult {
  ok: boolean;
  actual_cost_usd?: number;
  provider_instance_id?: string;
  result?: unknown;
  failure_reason?: string;
  /** Gate #2: outcome unknown (timeout / lost response). Keeps the
   *  idempotency key consumed and the budget committed as a liability. */
  cost_uncertain?: boolean;
}

export type SubmitOutcome =
  | { accepted: true; decision_id: string; order: ExecutionOrder }
  | {
      accepted: false; decision_id: string | null; reason: string;
      policy?: PolicyDecision; retry_after_ms?: number;
      /** Gate #4: when the ceiling was too low, tell the caller the real number. */
      verified_total_usd?: number;
      /** Gate #2: what the caller must do before retrying. */
      guidance?: string;
      external_reference?: string | null;
    };

export interface DecisionBuilderDeps {
  store: EconomicStore;
  ledger: EconomicEventLedger;
  budget: BudgetReservation;
  breaker: CircuitBreaker;
  idempotency: IdempotencyStore;
  catalog: CatalogSource;
  readWalletBalanceUsd: (agent_id: string) => Promise<number>;
}

export class EconomicDecisionBuilder {
  constructor(private readonly deps: DecisionBuilderDeps) {}

  async submit(agent_id: string, proposal: EconomicProposal): Promise<SubmitOutcome> {
    // ── Gate 0: proposal shape + numeric ranges ──────────────────────
    const shapeErr = validateProposal(proposal);
    if (shapeErr) return { accepted: false, decision_id: null, reason: `invalid proposal: ${shapeErr}` };

    const chosen = proposal.options_considered[proposal.selected_index]!;

    // ── Gate 1: authoritative catalog lookup ─────────────────────────
    const entry = await this.deps.catalog.lookup(chosen.provider, chosen.label);
    if (!entry) {
      return { accepted: false, decision_id: null,
        reason: `provider/option not in catalog: ${chosen.provider}/${chosen.label}` };
    }
    if (entry.availability === "unavailable") {
      return { accepted: false, decision_id: null,
        reason: `catalog entry ${entry.provider}/${entry.label} is unavailable` };
    }

    // Price comes from the catalog, never from the model.
    const verifiedTotal = round2(entry.unit_cost_usd * chosen.expected_units);
    const priceDrift = round2(Math.abs(verifiedTotal - chosen.expected_total_usd));

    // ── Gate 4: refuse an underfunded order ──────────────────────────
    if (proposal.maximum_cost_usd < verifiedTotal) {
      return {
        accepted: false, decision_id: null,
        reason: `maximum_cost_usd $${proposal.maximum_cost_usd.toFixed(2)} is below the verified cost $${verifiedTotal.toFixed(2)} for ${entry.provider}/${entry.label}. Raise the ceiling or choose a cheaper option.`,
        verified_total_usd: verifiedTotal,
      };
    }

    // Authorize the verified cost plus a small buffer, never more than the
    // model's own stated ceiling.
    const authorized_max_usd = round2(Math.min(proposal.maximum_cost_usd, verifiedTotal * 1.15));

    const walletUsd = await this.deps.readWalletBalanceUsd(agent_id);
    const walletIssue = checkNumber("wallet_balance_usd", walletUsd, { min: 0, max: 1_000_000 });
    if (walletIssue) {
      return { accepted: false, decision_id: null,
        reason: `wallet read invalid: ${walletIssue.field} ${walletIssue.reason}` };
    }

    // Gate #1: executable params projected from the catalog through the
    // allowlist. `chosen.attributes` is deliberately NOT part of this.
    const { params: provider_params, dropped } = buildProviderParams(entry, chosen.expected_units);

    const idemKey = makeIdempotencyKey({
      tool: `economic:${proposal.kind}`,
      args: { provider: entry.provider, label: entry.label, units: chosen.expected_units, objective: proposal.objective },
      actor: agent_id,
      bucket_seconds: 3600,
    });

    // ── Gate 6: ONE transaction for ledger + dedupe + reserve ────────
    // Everything below either all commits or all rolls back.
    type TxnOutcome =
      | { kind: "ok"; decision_id: string; operation_id: string; reservation_id: string }
      | { kind: "breaker"; decision_id: string; reason: string; retry_after_ms: number }
      | { kind: "dup"; decision_id: string; reason: string; retry_after_ms?: number; guidance?: string; external_reference?: string | null }
      | { kind: "policy"; decision_id: string; policy: PolicyDecision };

    const txnResult: TxnOutcome = this.deps.store.atomic((): TxnOutcome => {
      // Audit starts before any gate, so even a rejection is recorded.
      const decision = this.deps.ledger.createDecision({
        agent_id,
        objective: proposal.objective,
        available_capital_usd: walletUsd,
        options_considered: proposal.options_considered,
        reason: proposal.reason,
        confidence: proposal.confidence,
        expected_cost_usd: verifiedTotal,
        maximum_cost_usd: authorized_max_usd,
        expected_value_usd: proposal.expected_value_usd,
        actor: "kaizen",
      });
      const external_reference = `kaizen-${decision.decision_id}`;

      // Gate 2 — circuit breaker
      const gate = this.deps.breaker.allow(`provider:${entry.provider}`);
      if (!gate.allow) {
        this.deps.ledger.transition({
          decision_id: decision.decision_id, to_state: "POLICY_REJECTED", actor: "system",
          patch: { failure_reason: gate.reason },
          data: { gate: "circuit_breaker", retry_after_ms: gate.retry_after_ms },
        });
        return { kind: "breaker", decision_id: decision.decision_id, reason: gate.reason, retry_after_ms: gate.retry_after_ms };
      }

      // Gate 3 — idempotency (blocking states include failed + uncertain)
      const begin = this.deps.idempotency.begin({
        tool: `economic:${proposal.kind}`, key: idemKey, actor: agent_id,
        metadata: { decision_id: decision.decision_id, provider: entry.provider },
        external_reference,
      });
      if (!begin.fresh) {
        this.deps.ledger.transition({
          decision_id: decision.decision_id, to_state: "CANCELLED", actor: "system",
          patch: { failure_reason: `duplicate of operation ${begin.operation_id} (state=${begin.state})` },
          data: { gate: "idempotency", existing_operation_id: begin.operation_id, existing_state: begin.state },
        });
        return {
          kind: "dup", decision_id: decision.decision_id,
          reason: `duplicate economic action; existing operation ${begin.operation_id} is ${begin.state}`,
          retry_after_ms: begin.retry_after_ms,
          guidance: begin.guidance,
          external_reference: begin.external_reference,
        };
      }

      // Gate 4 — policy + atomic reservation
      const reserved = this.deps.budget.reserveWithin({
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
        this.deps.idempotency.rollback(begin.operation_id, "policy rejected — no side effect");
        this.deps.ledger.transition({
          decision_id: decision.decision_id, to_state: "POLICY_REJECTED", actor: "policy",
          patch: { policy_result: reserved.policy, failure_reason: reserved.policy.allow ? null : reserved.policy.reason },
        });
        return { kind: "policy", decision_id: decision.decision_id, policy: reserved.policy };
      }

      this.deps.ledger.transition({
        decision_id: decision.decision_id, to_state: "POLICY_APPROVED", actor: "policy",
        patch: {
          policy_result: reserved.policy,
          provider: entry.provider,
          selected_option: {
            // What the model claimed
            model_claimed: { ...chosen },
            // What we verified
            verified: {
              provider: entry.provider, label: entry.label,
              unit_cost_usd: entry.unit_cost_usd, unit: entry.unit,
              spec: entry.spec, total_usd: verifiedTotal,
            },
            price_drift_usd: priceDrift,
            // Gate #1 evidence: what the allowlist dropped
            provider_params_sent: provider_params,
            provider_params_dropped: dropped,
            model_attributes_ignored: chosen.attributes ?? null,
          },
        },
      });
      this.deps.ledger.transition({
        decision_id: decision.decision_id, to_state: "BUDGET_RESERVED", actor: "kaizen",
        patch: { reserved_capital_usd: authorized_max_usd },
        data: { reservation_id: reserved.reservation_id },
      });

      return { kind: "ok", decision_id: decision.decision_id, operation_id: begin.operation_id, reservation_id: reserved.reservation_id };
    });

    switch (txnResult.kind) {
      case "breaker":
        return { accepted: false, decision_id: txnResult.decision_id, reason: txnResult.reason, retry_after_ms: txnResult.retry_after_ms };
      case "dup":
        return {
          accepted: false, decision_id: txnResult.decision_id, reason: txnResult.reason,
          retry_after_ms: txnResult.retry_after_ms, guidance: txnResult.guidance,
          external_reference: txnResult.external_reference,
        };
      case "policy":
        return {
          accepted: false, decision_id: txnResult.decision_id,
          reason: txnResult.policy.allow ? "unknown" : txnResult.policy.reason,
          policy: txnResult.policy,
        };
      case "ok":
        return {
          accepted: true,
          decision_id: txnResult.decision_id,
          order: {
            decision_id: txnResult.decision_id,
            operation_id: txnResult.operation_id,
            reservation_id: txnResult.reservation_id,
            kind: proposal.kind,
            provider: entry.provider,
            authorized_max_usd,
            requested_runtime_minutes: proposal.requested_runtime_minutes,
            provider_params,
            external_reference: `kaizen-${txnResult.decision_id}`,
          },
        };
    }
  }

  /**
   * Report the outcome. Gate #3 validates the charge; an overcharge or a
   * malformed number routes to BILLING_DISPUTE rather than settling.
   */
  settle(order: ExecutionOrder, result: ExecutionResult): DecisionRecord {
    const breakerKey = `provider:${order.provider}`;

    // ── Uncertain outcome (gate #2) ──────────────────────────────────
    if (result.cost_uncertain) {
      return this.deps.store.atomic(() => {
        this.deps.breaker.recordFailure(breakerKey, result.failure_reason ?? "outcome unknown");
        // Key stays consumed until an explicit reconcile().
        this.deps.idempotency.markUncertain(
          order.operation_id,
          result.failure_reason ?? "response lost / timeout",
          order.external_reference,
        );
        this.deps.budget.commitAsLiability(
          order.reservation_id, order.authorized_max_usd,
          result.failure_reason ?? "cost could not be confirmed",
        );
        return this.deps.ledger.transition({
          decision_id: order.decision_id, to_state: "BILLING_DISPUTE", actor: "system",
          patch: { failure_reason: result.failure_reason ?? "cost uncertain", actual_cost_usd: order.authorized_max_usd },
          data: { external_reference: order.external_reference, requires_reconciliation: true },
        });
      });
    }

    // ── Failure with a confirmed no-charge ───────────────────────────
    if (!result.ok) {
      return this.deps.store.atomic(() => {
        this.deps.breaker.recordFailure(breakerKey, result.failure_reason ?? "unknown failure");
        // Confirmed no side effect → the key may be freed for a retry.
        this.deps.idempotency.rollback(order.operation_id, result.failure_reason ?? "execution failed, no charge");
        this.deps.budget.release(order.reservation_id, result.failure_reason ?? "execution failed, no charge");
        return this.deps.ledger.transition({
          decision_id: order.decision_id, to_state: "CLOSED", actor: "system",
          patch: { failure_reason: result.failure_reason ?? "execution failed", actual_cost_usd: 0 },
        });
      });
    }

    // ── Success — gate #3 validates the charge ───────────────────────
    const costCheck = validateActualCost(result.actual_cost_usd ?? order.authorized_max_usd, order.authorized_max_usd);
    if (!costCheck.ok) {
      return this.deps.store.atomic(() => {
        // An overcharge is a billing problem, not a normal settlement.
        this.deps.breaker.recordFailure(breakerKey, costCheck.reason);
        this.deps.idempotency.markUncertain(order.operation_id, costCheck.reason, order.external_reference);
        // Consume the authorized ceiling; the excess is disputed.
        this.deps.budget.commitAsLiability(order.reservation_id, order.authorized_max_usd, costCheck.reason);
        return this.deps.ledger.transition({
          decision_id: order.decision_id, to_state: "BILLING_DISPUTE", actor: "system",
          patch: {
            failure_reason: costCheck.reason,
            actual_cost_usd: typeof result.actual_cost_usd === "number" && Number.isFinite(result.actual_cost_usd)
              ? result.actual_cost_usd : order.authorized_max_usd,
            actual_result: result.result ?? null,
          },
          data: { overcharge: costCheck.overcharge === true, authorized_max_usd: order.authorized_max_usd, claimed_cost: result.actual_cost_usd },
        });
      });
    }

    const actual = round2(costCheck.value);
    return this.deps.store.atomic(() => {
      this.deps.breaker.recordSuccess(breakerKey);
      this.deps.idempotency.commit(order.operation_id, result.provider_instance_id ?? null);
      this.deps.budget.commit(order.reservation_id, actual);
      const cur = this.deps.ledger.get(order.decision_id)!;
      this.deps.ledger.transition({
        decision_id: order.decision_id, to_state: "RECONCILED", actor: "system",
        patch: {
          actual_cost_usd: actual,
          actual_result: result.result ?? null,
          profit_or_utility_usd: round2(cur.expected_value_usd - actual),
        },
      });
      return this.deps.ledger.transition({ decision_id: order.decision_id, to_state: "CLOSED", actor: "system" });
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
  const conf = checkNumber("confidence", p.confidence, { min: 0, max: 1 });
  if (conf) return `${conf.field} ${conf.reason}`;
  const maxCost = checkNumber("maximum_cost_usd", p.maximum_cost_usd, { min: 0.000001, max: 1_000_000 });
  if (maxCost) return `${maxCost.field} ${maxCost.reason}`;
  const ev = checkNumber("expected_value_usd", p.expected_value_usd, { min: -1_000_000, max: 1_000_000 });
  if (ev) return `${ev.field} ${ev.reason}`;
  if (p.requested_runtime_minutes !== undefined) {
    const rt = checkNumber("requested_runtime_minutes", p.requested_runtime_minutes, { min: 0, max: 60 * 24 * 30 });
    if (rt) return `${rt.field} ${rt.reason}`;
  }
  const chosen = p.options_considered[p.selected_index]!;
  if (!chosen.provider || !chosen.label) return "selected option needs provider + label";
  const unit = checkNumber("unit_cost_usd", chosen.unit_cost_usd, { min: 0, max: 1_000_000 });
  if (unit) return `${unit.field} ${unit.reason}`;
  const units = checkNumber("expected_units", chosen.expected_units, { min: 0.000001, max: 1_000_000 });
  if (units) return `${units.field} ${units.reason}`;
  if (chosen.probability_success !== undefined) {
    const ps = checkNumber("probability_success", chosen.probability_success, { min: 0, max: 1 });
    if (ps) return `${ps.field} ${ps.reason}`;
  }
  return null;
}
