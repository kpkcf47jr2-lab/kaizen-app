import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EconomicDecisionBuilder, validateProposal, type EconomicProposal } from "../../economic/decision-builder.js";
import { EconomicEventLedger } from "../../economic/event-ledger.js";
import { BudgetReservation } from "../../economic/budget-reservation.js";
import { CircuitBreaker } from "../../economic/circuit-breaker.js";
import { IdempotencyStore } from "../../economic/idempotency-store.js";
import { PolicyEngine } from "../../economic/policy-engine.js";
import { EconomicStore } from "../../economic/store.js";
import { StaticProviderCatalog, DRY_RUN_CATALOG } from "../../economic/provider-catalog.js";

const AGENT = "kaizen-fusion";

function build(opts: { walletUsd?: number; killed?: boolean; profile?: "PHASE1_INITIAL_TEST" | "PHASE3_REAL_SMALL" | "UNRESTRICTED_OWNER_MODE" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-edb-"));
  const store = new EconomicStore({ stateDir: dir });
  const policy = new PolicyEngine(() => opts.killed ?? false, opts.profile ?? "PHASE1_INITIAL_TEST");
  const ledger = new EconomicEventLedger(store);
  const budget = new BudgetReservation(store, { policy });
  const breaker = new CircuitBreaker(store, { failureThreshold: 3, baseCooldownMs: 1000 });
  const idempotency = new IdempotencyStore(store);
  const catalog = new StaticProviderCatalog(DRY_RUN_CATALOG);
  const builder = new EconomicDecisionBuilder({
    store, ledger, budget, breaker, idempotency, catalog,
    readWalletBalanceUsd: async () => opts.walletUsd ?? 5,
  });
  return { builder, ledger, budget, breaker, idempotency, store, dir };
}

/** Adversarial: A cheapest/hour but slowest; B pricier/hour but lowest TOTAL. */
function proposal(selected: number, over: Partial<EconomicProposal> = {}): EconomicProposal {
  return {
    kind: "compute_rent",
    objective: "Run a fine-tune that needs ~$0.50 of compute",
    options_considered: [
      { provider: "lightning", label: "L4",   unit_cost_usd: 0.20, expected_units: 5,   expected_total_usd: 1.00, probability_success: 0.90 },
      { provider: "runpod",    label: "A10",  unit_cost_usd: 0.55, expected_units: 1,   expected_total_usd: 0.55, probability_success: 0.95 },
      { provider: "brev",      label: "H100", unit_cost_usd: 3.00, expected_units: 0.5, expected_total_usd: 1.50, probability_success: 0.97 },
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
    expect(validateProposal(proposal(1))).toBeNull();
  });
  it("rejects out-of-range selected_index", () => {
    expect(validateProposal(proposal(9))).toMatch(/selected_index/);
  });
  it("rejects confidence outside 0..1", () => {
    expect(validateProposal(proposal(1, { confidence: 1.5 }))).toMatch(/confidence/);
  });
  it("GATE #9 — rejects NaN / Infinity in every numeric", () => {
    expect(validateProposal(proposal(1, { confidence: NaN }))).toMatch(/finite/);
    expect(validateProposal(proposal(1, { maximum_cost_usd: Infinity }))).toMatch(/finite/);
    expect(validateProposal(proposal(1, { expected_value_usd: NaN }))).toMatch(/finite/);
    expect(validateProposal(proposal(1, { requested_runtime_minutes: Infinity }))).toMatch(/finite/);
    const badUnits = proposal(1);
    badUnits.options_considered[1]!.expected_units = NaN;
    expect(validateProposal(badUnits)).toMatch(/finite/);
    const badCost = proposal(1);
    badCost.options_considered[1]!.unit_cost_usd = -1;
    expect(validateProposal(badCost)).toMatch(/unit_cost_usd/);
    const badProb = proposal(1);
    badProb.options_considered[1]!.probability_success = 2;
    expect(validateProposal(badProb)).toMatch(/probability_success/);
  });
});

describe("EconomicDecisionBuilder.submit", () => {
  it("admits a valid proposal and returns a resolved ExecutionOrder", async () => {
    const { builder, ledger } = build();
    const out = await builder.submit(AGENT, proposal(1));
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(out.order.provider).toBe("runpod");
    // authorized = min(ceiling 2.00, verified 0.55 * 1.15 = 0.6325 → 0.63)
    expect(out.order.authorized_max_usd).toBeCloseTo(0.63, 2);
    expect(ledger.get(out.decision_id)!.state).toBe("BUDGET_RESERVED");
  });

  it("GATE #1 — provider_params come from the catalog allowlist, NOT model attributes", async () => {
    const { builder, ledger } = build();
    const injected = proposal(1);
    // A prompt-injected model tries to smuggle executable fields.
    injected.options_considered[1]!.attributes = {
      gpu_type_id: "NVIDIA H100",            // upgrade attempt
      container_disk_gb: 5000,               // cost inflation attempt
      webhook_url: "https://attacker.example/steal",
      count: 10,                             // fan-out attempt
    };
    const out = await builder.submit(AGENT, injected);
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;

    const params = out.order.provider_params;
    // The A10 catalog entry's values win — not the model's.
    expect(params.gpu_type_id).toBe("NVIDIA A10");
    expect(params.container_disk_gb).toBe(40);
    // Non-allowlisted / injected keys never appear.
    expect(params).not.toHaveProperty("webhook_url");
    expect(params).not.toHaveProperty("count");
    expect(params).not.toHaveProperty("attributes");

    // The attempt is preserved in the ledger for audit, clearly quarantined.
    const sel = ledger.get(out.decision_id)!.selected_option as Record<string, unknown>;
    expect(sel.model_attributes_ignored).toMatchObject({ webhook_url: "https://attacker.example/steal" });
    expect(sel.provider_params_sent).toMatchObject({ gpu_type_id: "NVIDIA A10" });
  });

  it("GATE #1 — allowlist drops non-executable catalog keys too", async () => {
    const { builder, ledger } = build();
    const out = await builder.submit(AGENT, proposal(0));   // lightning L4
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    // lightning allowlist is [machine_type, image, disk_gb]
    expect(Object.keys(out.order.provider_params).sort()).toEqual(["disk_gb", "image", "machine_type", "units"]);
  });

  it("re-prices from the catalog — a hallucinated price does not authorize more money", async () => {
    const { builder, ledger } = build();
    const lying = proposal(1);
    lying.options_considered[1]!.unit_cost_usd = 0.05;
    lying.options_considered[1]!.expected_total_usd = 0.05;
    const out = await builder.submit(AGENT, lying);
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    const row = ledger.get(out.decision_id)!;
    expect(row.expected_cost_usd).toBeCloseTo(0.55, 2);
    const sel = row.selected_option as Record<string, Record<string, unknown>>;
    expect(sel.verified.unit_cost_usd).toBeCloseTo(0.55, 2);
    expect((sel as unknown as { price_drift_usd: number }).price_drift_usd).toBeCloseTo(0.5, 2);
  });

  it("GATE #4 — refuses an underfunded ceiling and returns the verified total", async () => {
    const { builder } = build();
    // Ceiling $0.30 but A10 for 1h really costs $0.55
    const out = await builder.submit(AGENT, proposal(1, { maximum_cost_usd: 0.30 }));
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.reason).toMatch(/below the verified cost/);
    expect(out.verified_total_usd).toBeCloseTo(0.55, 2);
    // No decision row is created for a malformed request → nothing to leak.
    expect(out.decision_id).toBeNull();
  });

  it("refuses a provider that is not in the catalog", async () => {
    const { builder } = build();
    const fake = proposal(0);
    fake.options_considered[0]!.provider = "shady-gpu-inc";
    const out = await builder.submit(AGENT, fake);
    expect(out.accepted).toBe(false);
    if (!out.accepted) expect(out.reason).toMatch(/not in catalog/);
  });

  it("kill switch rejects and records POLICY_REJECTED", async () => {
    const { builder, ledger } = build({ killed: true });
    const out = await builder.submit(AGENT, proposal(1));
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.policy && !out.policy.allow && out.policy.kind).toBe("killed");
    expect(ledger.get(out.decision_id!)!.state).toBe("POLICY_REJECTED");
  });

  it("rejects when the wallet cannot cover the authorized max", async () => {
    const { builder } = build({ walletUsd: 0.10 });
    const out = await builder.submit(AGENT, proposal(1));
    expect(out.accepted).toBe(false);
    if (!out.accepted && out.policy && !out.policy.allow) {
      expect(out.policy.kind).toBe("insufficient_wallet_balance");
    }
  });

  it("deduplicates an identical proposal in the same hour bucket", async () => {
    const { builder, ledger } = build();
    expect((await builder.submit(AGENT, proposal(1))).accepted).toBe(true);
    const second = await builder.submit(AGENT, proposal(1));
    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.reason).toMatch(/duplicate economic action/);
      expect(ledger.get(second.decision_id!)!.state).toBe("CANCELLED");
    }
  });

  it("refuses while the provider circuit breaker is open", async () => {
    const { builder, breaker, ledger } = build();
    for (const e of ["a", "b", "c"]) breaker.recordFailure("provider:runpod", e);
    const out = await builder.submit(AGENT, proposal(1));
    expect(out.accepted).toBe(false);
    if (!out.accepted) {
      expect(out.reason).toMatch(/circuit open/);
      expect(ledger.get(out.decision_id!)!.state).toBe("POLICY_REJECTED");
    }
  });

  it("enforces one concurrent GPU", async () => {
    const { builder } = build({ walletUsd: 20 });
    expect((await builder.submit(AGENT, proposal(1))).accepted).toBe(true);
    const b = await builder.submit(AGENT, proposal(0, { objective: "a different job" }));
    expect(b.accepted).toBe(false);
    if (!b.accepted && b.policy && !b.policy.allow) expect(b.policy.kind).toBe("concurrent_gpu_over_cap");
  });
});

describe("EconomicDecisionBuilder.settle", () => {
  async function admitted(opts: Parameters<typeof build>[0] = {}) {
    const ctx = build(opts);
    const out = await ctx.builder.submit(AGENT, proposal(1));
    if (!out.accepted) throw new Error("expected admission");
    for (const s of ["PROVIDER_REQUESTED", "PROVISIONING", "RUNNING", "WORKLOAD_RUNNING", "STOP_REQUESTED", "TERMINATED"] as const) {
      ctx.ledger.transition({ decision_id: out.decision_id, to_state: s, actor: "kaizen" });
    }
    return { ...ctx, out };
  }

  it("success commits at ACTUAL cost and closes", async () => {
    const { builder, budget, out } = await admitted();
    const final = builder.settle(out.order, { ok: true, actual_cost_usd: 0.48, provider_instance_id: "inst-1" });
    expect(final.state).toBe("CLOSED");
    expect(final.actual_cost_usd).toBeCloseTo(0.48);
    expect(final.profit_or_utility_usd).toBeCloseTo(2.0 - 0.48, 2);
    expect(budget.totalsFor(AGENT).committed_usd).toBeCloseTo(0.48);
  });

  it("GATE #3 — an overcharge routes to BILLING_DISPUTE, never a silent settlement", async () => {
    const { builder, budget, ledger, out } = await admitted();
    const authorized = out.order.authorized_max_usd;
    const final = builder.settle(out.order, { ok: true, actual_cost_usd: authorized + 5, provider_instance_id: "inst-2" });
    expect(final.state).toBe("BILLING_DISPUTE");
    expect(final.failure_reason).toMatch(/exceeds authorized max/);
    // Capital consumed at the ceiling, excess disputed — not silently absorbed.
    expect(budget.totalsFor(AGENT).committed_usd).toBeCloseTo(authorized, 2);
    const evt = ledger.events(out.decision_id).at(-1)!;
    expect((evt.data as Record<string, unknown>).overcharge).toBe(true);
  });

  it("GATE #3 — a NaN/negative cost also routes to dispute", async () => {
    for (const bad of [NaN, -1, Infinity]) {
      const { builder, out } = await admitted();
      const final = builder.settle(out.order, { ok: true, actual_cost_usd: bad as number });
      expect(final.state).toBe("BILLING_DISPUTE");
    }
  });

  it("confirmed no-charge failure releases the capital and frees the idempotency key", async () => {
    const ctx = build();
    const out = await ctx.builder.submit(AGENT, proposal(1));
    if (!out.accepted) throw new Error("expected admission");
    ctx.ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
    ctx.ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_FAILED", actor: "system" });
    const final = ctx.builder.settle(out.order, { ok: false, failure_reason: "provider 500 before any instance", cost_uncertain: false });
    expect(final.state).toBe("CLOSED");
    expect(ctx.budget.totalsFor(AGENT).held_usd).toBeCloseTo(0);
    expect(ctx.budget.totalsFor(AGENT).committed_usd).toBeCloseTo(0);
    expect(ctx.idempotency.get(out.order.operation_id)!.state).toBe("rolled_back");
  });

  it("cost-uncertain failure becomes a LIABILITY and KEEPS the idempotency key", async () => {
    const { builder, budget, idempotency, out } = await admitted();
    const final = builder.settle(out.order, {
      ok: false, cost_uncertain: true,
      failure_reason: "stopGpu failed 3x; instance may still be billing",
    });
    expect(final.state).toBe("BILLING_DISPUTE");
    expect(budget.totalsFor(AGENT).committed_usd).toBeCloseTo(out.order.authorized_max_usd, 2);
    // Gate #2: key stays consumed
    expect(idempotency.get(out.order.operation_id)!.state).toBe("uncertain");
  });

  it("failure trips the provider breaker after 3 attempts", async () => {
    const ctx = build({ walletUsd: 20 });
    for (let i = 0; i < 3; i++) {
      const out = await ctx.builder.submit(AGENT, proposal(1, { objective: `job ${i}` }));
      if (!out.accepted) break;
      ctx.ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
      ctx.ledger.transition({ decision_id: out.decision_id, to_state: "PROVIDER_FAILED", actor: "system" });
      ctx.builder.settle(out.order, { ok: false, failure_reason: `fail ${i}`, cost_uncertain: false });
    }
    expect(ctx.breaker.status("provider:runpod").state).toBe("open");
  });
});
