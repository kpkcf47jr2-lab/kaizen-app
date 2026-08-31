import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EconomicDecisionBuilder, validateProposal, type EconomicProposal } from "../../economic/decision-builder.js";
import { EconomicEventLedger } from "../../economic/event-ledger.js";
import { BudgetReservation } from "../../economic/budget-reservation.js";
import { CircuitBreaker } from "../../economic/circuit-breaker.js";
import { IdempotencyStore } from "../../economic/idempotency-store.js";
import { PolicyEngine } from "../../economic/policy-engine.js";

const AGENT = "kaizen-fusion";

// Authoritative catalog — the model's claimed prices are checked against this.
const CATALOG: Record<string, number> = {
  "lightning/L4": 0.20,
  "runpod/A10":   0.55,
  "brev/H100":    3.00,
};

function build(opts: { walletUsd?: number; killed?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-edb-"));
  const ledger = new EconomicEventLedger({ stateDir: dir });
  const budget = new BudgetReservation({ stateDir: dir, policy: new PolicyEngine(() => opts.killed ?? false) });
  const breaker = new CircuitBreaker({ stateDir: dir, failureThreshold: 3, baseCooldownMs: 1000 });
  const idempotency = new IdempotencyStore({ stateDir: dir });
  const builder = new EconomicDecisionBuilder({
    ledger, budget, breaker, idempotency,
    readWalletBalanceUsd: async () => opts.walletUsd ?? 5,
    resolveCatalogPrice: async (provider, label) => CATALOG[`${provider}/${label}`] ?? null,
  });
  return { builder, ledger, budget, breaker, idempotency };
}

/** The adversarial scenario the owner specified: A is cheapest per hour but
 *  slowest; B costs more per hour but finishes in 1h → lower TOTAL. */
function adversarialProposal(selected: number, over: Partial<EconomicProposal> = {}): EconomicProposal {
  return {
    kind: "compute_rent",
    objective: "Run a fine-tune that needs ~$0.50 of compute",
    options_considered: [
      { provider: "lightning", label: "L4",   unit_cost_usd: 0.20, expected_units: 5,   expected_total_usd: 1.00, probability_success: 0.9,  attributes: { vram_gb: 24 } },
      { provider: "runpod",    label: "A10",  unit_cost_usd: 0.55, expected_units: 1,   expected_total_usd: 0.55, probability_success: 0.95, attributes: { vram_gb: 24 } },
      { provider: "brev",      label: "H100", unit_cost_usd: 3.00, expected_units: 0.5, expected_total_usd: 1.50, probability_success: 0.97, attributes: { vram_gb: 80 } },
    ],
    selected_index: selected,
    reason: "test",
    confidence: 0.8,
    expected_value_usd: 2.0,
    maximum_cost_usd: 2.0,
    requested_runtime_minutes: 45,
    ...over,
  };
}

describe("validateProposal", () => {
  it("accepts a well-formed proposal", () => {
    expect(validateProposal(adversarialProposal(1))).toBeNull();
  });
  it("rejects out-of-range selected_index", () => {
    expect(validateProposal(adversarialProposal(9))).toMatch(/selected_index/);
  });
  it("rejects confidence outside 0..1", () => {
    expect(validateProposal(adversarialProposal(1, { confidence: 1.5 }))).toMatch(/confidence/);
  });
  it("rejects empty options", () => {
    expect(validateProposal(adversarialProposal(0, { options_considered: [] }))).toMatch(/non-empty/);
  });
  it("rejects non-positive maximum_cost_usd", () => {
    expect(validateProposal(adversarialProposal(1, { maximum_cost_usd: 0 }))).toMatch(/maximum_cost_usd/);
  });
});

describe("EconomicDecisionBuilder.submit", () => {
  it("admits a valid proposal and returns a fully-resolved ExecutionOrder", async () => {
    const { builder, ledger } = build();
    const out = await builder.submit(AGENT, adversarialProposal(1));
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(out.order.provider).toBe("runpod");
    // authorized_max = min(model ceiling 2.0, verified 0.55 * 1.15 = 0.6325 → 0.63)
    expect(out.order.authorized_max_usd).toBeCloseTo(0.63, 2);
    expect(out.order.external_reference).toContain(out.decision_id);
    const row = ledger.get(out.decision_id)!;
    expect(row.state).toBe("BUDGET_RESERVED");
    expect(row.provider).toBe("runpod");
  });

  it("recomputes cost from the catalog — a hallucinated price does not authorize more money", async () => {
    const { builder, ledger } = build();
    // Model claims A10 is $0.05/h; catalog says $0.55.
    const lying = adversarialProposal(1);
    lying.options_considered[1]!.unit_cost_usd = 0.05;
    lying.options_considered[1]!.expected_total_usd = 0.05;
    const out = await builder.submit(AGENT, lying);
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    const row = ledger.get(out.decision_id)!;
    // Ledger records OUR verified number (0.55), not the model's 0.05.
    expect(row.expected_cost_usd).toBeCloseTo(0.55, 2);
    const sel = row.selected_option as Record<string, unknown>;
    expect(sel.verified_unit_cost_usd).toBeCloseTo(0.55, 2);
    expect(sel.price_drift_usd).toBeCloseTo(0.5, 2);
  });

  it("refuses a provider that is not in the catalog", async () => {
    const { builder } = build();
    const fake = adversarialProposal(0);
    fake.options_considered[0]!.provider = "shady-gpu-inc";
    const out = await builder.submit(AGENT, fake);
    expect(out.accepted).toBe(false);
    if (!out.accepted) expect(out.reason).toMatch(/not in catalog/);
  });

  it("rejects when the kill switch is on, and records POLICY_REJECTED", async () => {
    const { builder, ledger } = build({ killed: true });
    const out = await builder.submit(AGENT, adversarialProposal(1));
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.policy && !out.policy.allow && out.policy.kind).toBe("killed");
    const row = ledger.get(out.decision_id!)!;
    expect(row.state).toBe("POLICY_REJECTED");
  });

  it("rejects when the wallet cannot cover the authorized max", async () => {
    const { builder } = build({ walletUsd: 0.10 });
    const out = await builder.submit(AGENT, adversarialProposal(1));
    expect(out.accepted).toBe(false);
    if (!out.accepted && out.policy && !out.policy.allow) {
      expect(out.policy.kind).toBe("insufficient_wallet_balance");
    }
  });

  it("deduplicates an identical proposal within the same hour bucket", async () => {
    const { builder, ledger } = build();
    const first = await builder.submit(AGENT, adversarialProposal(1));
    expect(first.accepted).toBe(true);
    const second = await builder.submit(AGENT, adversarialProposal(1));
    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.reason).toMatch(/duplicate economic action/);
      const row = ledger.get(second.decision_id!)!;
      expect(row.state).toBe("CANCELLED");
    }
  });

  it("refuses while the provider circuit breaker is open", async () => {
    const { builder, breaker, ledger } = build();
    for (const e of ["a", "b", "c"]) breaker.recordFailure("provider:runpod", e);
    const out = await builder.submit(AGENT, adversarialProposal(1));
    expect(out.accepted).toBe(false);
    if (!out.accepted) {
      expect(out.reason).toMatch(/circuit open/);
      expect(ledger.get(out.decision_id!)!.state).toBe("POLICY_REJECTED");
    }
  });

  it("enforces one concurrent GPU — second rental refused while first is held", async () => {
    const { builder } = build({ walletUsd: 20 });
    const a = await builder.submit(AGENT, adversarialProposal(1));
    expect(a.accepted).toBe(true);
    // Different objective → different idempotency key, so this is a genuine
    // second attempt, not a dedupe.
    const b = await builder.submit(AGENT, adversarialProposal(0, { objective: "a different job" }));
    expect(b.accepted).toBe(false);
    if (!b.accepted && b.policy && !b.policy.allow) {
      expect(b.policy.kind).toBe("concurrent_gpu_over_cap");
    }
  });
});

describe("EconomicDecisionBuilder.settle", () => {
  it("success: commits budget at ACTUAL cost, closes the decision, records utility", async () => {
    const { builder, ledger, budget } = build();
    const out = await builder.submit(AGENT, adversarialProposal(1));
    if (!out.accepted) throw new Error("expected admission");
    // Drive the executor states the way a real run would
    for (const s of ["PROVIDER_REQUESTED", "PROVISIONING", "RUNNING", "WORKLOAD_RUNNING", "STOP_REQUESTED", "TERMINATED"] as const) {
      ledger.transition({ decision_id: out.decision_id, to_state: s, actor: "kaizen" });
    }
    const final = builder.settle(out.order, { ok: true, actual_cost_usd: 0.48, provider_instance_id: "inst-123", result: { logs: "ok" } });
    expect(final.state).toBe("CLOSED");
    expect(final.actual_cost_usd).toBeCloseTo(0.48);
    expect(final.profit_or_utility_usd).toBeCloseTo(2.0 - 0.48, 2);
    // Budget committed at the real cost, not the authorized ceiling
    expect(budget.totalsFor(AGENT).committed_usd).toBeCloseTo(0.48);
    expect(budget.totalsFor(AGENT).held_usd).toBeCloseTo(0);
  });

  it("confirmed failure with no charge: releases the capital", async () => {
    const { builder, ledger, budget } = build();
    const out = await builder.submit(AGENT, adversarialProposal(1));
    if (!out.accepted) throw new Error("expected admission");
    ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
    ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_FAILED", actor: "system" });
    const final = builder.settle(out.order, { ok: false, failure_reason: "provider 500, no instance created", cost_uncertain: false });
    expect(final.state).toBe("CLOSED");
    expect(budget.totalsFor(AGENT).held_usd).toBeCloseTo(0);
    expect(budget.totalsFor(AGENT).committed_usd).toBeCloseTo(0);   // freed
  });

  it("OWNER RULE — cost-uncertain failure becomes a LIABILITY, budget is NOT released", async () => {
    const { builder, ledger, budget } = build();
    const out = await builder.submit(AGENT, adversarialProposal(1));
    if (!out.accepted) throw new Error("expected admission");
    for (const s of ["PROVIDER_REQUESTED", "PROVISIONING", "RUNNING", "STOP_REQUESTED", "STOP_FAILED"] as const) {
      ledger.transition({ decision_id: out.decision_id, to_state: s, actor: "kaizen" });
    }
    const final = builder.settle(out.order, {
      ok: false, cost_uncertain: true,
      failure_reason: "stopGpu failed 3x; instance may still be billing",
    });
    expect(final.state).toBe("BILLING_DISPUTE");
    // Capital stays consumed at the authorized ceiling
    expect(budget.totalsFor(AGENT).committed_usd).toBeCloseTo(out.order.authorized_max_usd, 2);
    expect(budget.totalsFor(AGENT).held_usd).toBeCloseTo(0);
    const row = ledger.get(out.decision_id)!;
    expect(row.failure_reason).toMatch(/still be billing/);
  });

  it("failure trips the provider breaker after 3 attempts", async () => {
    const { builder, ledger, breaker } = build({ walletUsd: 20 });
    for (let i = 0; i < 3; i++) {
      const out = await builder.submit(AGENT, adversarialProposal(1, { objective: `job ${i}` }));
      if (!out.accepted) break;
      ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
      ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_FAILED", actor: "system" });
      builder.settle(out.order, { ok: false, failure_reason: `fail ${i}`, cost_uncertain: false });
    }
    expect(breaker.status("provider:runpod").state).toBe("open");
  });

  it("full audit trail is queryable for every decision", async () => {
    const { builder, ledger } = build();
    const out = await builder.submit(AGENT, adversarialProposal(1));
    if (!out.accepted) throw new Error("expected admission");
    const events = ledger.events(out.decision_id);
    const states = events.map((e) => e.to_state);
    expect(states).toContain("DECISION_CREATED");
    expect(states).toContain("POLICY_APPROVED");
    expect(states).toContain("BUDGET_RESERVED");
    // Every event has actor + timestamp
    for (const e of events) {
      expect(e.actor).toBeTruthy();
      expect(e.ts).toBeGreaterThan(0);
    }
  });
});
