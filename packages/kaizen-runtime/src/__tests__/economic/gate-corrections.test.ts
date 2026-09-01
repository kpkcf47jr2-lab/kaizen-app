// ═══════════════════════════════════════════════════════════════════════
//  Tests for the CEO's specific gate corrections (2026-08-30)
//    #2 failed / cost_uncertain keep the idempotency key consumed
//    #5 audit trail is append-only at the engine level
//    #8 owner-selected policy profiles incl. UNRESTRICTED_OWNER_MODE
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EconomicStore } from "../../economic/store.js";
import { EconomicEventLedger } from "../../economic/event-ledger.js";
import { BudgetReservation } from "../../economic/budget-reservation.js";
import { CircuitBreaker } from "../../economic/circuit-breaker.js";
import { IdempotencyStore, BLOCKING_STATES, RELEASING_STATES } from "../../economic/idempotency-store.js";
import { PolicyEngine, POLICY_PROFILES, POLICY_PROFILE_ENV, resolveProfileName, KILL_SWITCH_ENV, checkNumber, validateActualCost } from "../../economic/policy-engine.js";
import { EconomicDecisionBuilder, type EconomicProposal } from "../../economic/decision-builder.js";
import { StaticProviderCatalog, DRY_RUN_CATALOG } from "../../economic/provider-catalog.js";

const AGENT = "kaizen-fusion";

function ctx(opts: { walletUsd?: number; profile?: keyof typeof POLICY_PROFILES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-gate-"));
  const store = new EconomicStore({ stateDir: dir });
  const policy = new PolicyEngine(() => false, opts.profile ?? "PHASE1_INITIAL_TEST");
  const ledger = new EconomicEventLedger(store);
  const budget = new BudgetReservation(store, { policy });
  const breaker = new CircuitBreaker(store, { failureThreshold: 3, baseCooldownMs: 1000 });
  const idempotency = new IdempotencyStore(store);
  const builder = new EconomicDecisionBuilder({
    store, ledger, budget, breaker, idempotency,
    catalog: new StaticProviderCatalog(DRY_RUN_CATALOG),
    readWalletBalanceUsd: async () => opts.walletUsd ?? 5,
  });
  return { store, ledger, budget, breaker, idempotency, builder, dir };
}

function rentProposal(over: Partial<EconomicProposal> = {}): EconomicProposal {
  return {
    kind: "compute_rent",
    objective: "fine-tune job alpha",
    options_considered: [
      { provider: "runpod", label: "A10", unit_cost_usd: 0.55, expected_units: 1, expected_total_usd: 0.55 },
    ],
    selected_index: 0,
    reason: "cheapest total for the workload",
    confidence: 0.85,
    expected_value_usd: 2.0,
    maximum_cost_usd: 1.0,
    requested_runtime_minutes: 45,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  GATE #2 — a lost response must NOT create a second rental
// ═══════════════════════════════════════════════════════════════════════

describe("GATE #2 — timeout / lost response cannot create a duplicate rental", () => {
  it("state constants are wired correctly", () => {
    expect(BLOCKING_STATES).toEqual(["pending", "committed", "failed", "uncertain"]);
    expect(RELEASING_STATES).toEqual(["rolled_back", "reconciled"]);
  });

  it("END-TO-END: rent times out → retry of the SAME proposal is refused", async () => {
    const c = ctx({ walletUsd: 20 });

    // 1. First attempt is admitted and an order is produced.
    const first = await c.builder.submit(AGENT, rentProposal());
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    const firstOp = first.order.operation_id;

    // 2. The provider call times out. We do NOT know whether a GPU exists.
    c.ledger.transition({ decision_id: first.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
    c.ledger.transition({ decision_id: first.decision_id, to_state: "PROVISION_TIMEOUT", actor: "system" });
    const settled = c.builder.settle(first.order, {
      ok: false, cost_uncertain: true,
      failure_reason: "HTTP timeout after 30s — provider may have created the instance",
    });
    expect(settled.state).toBe("BILLING_DISPUTE");
    expect(c.idempotency.get(firstOp)!.state).toBe("uncertain");

    // 3. Kaizen (or a retry loop) tries the exact same thing again.
    const retry = await c.builder.submit(AGENT, rentProposal());

    // 4. IT MUST BE REFUSED. No second rental.
    expect(retry.accepted).toBe(false);
    if (retry.accepted) throw new Error("SECURITY FAILURE: duplicate rental was admitted");
    expect(retry.reason).toMatch(/duplicate economic action/);
    expect(retry.guidance).toMatch(/UNKNOWN|reconcile/i);
    // The caller is handed the reference needed to ask the provider.
    expect(retry.external_reference).toContain("kaizen-");

    // 5. Only ONE reservation was ever created (the disputed one).
    const held = c.budget.totalsFor(AGENT);
    expect(held.held_usd).toBeCloseTo(0);
    expect(held.committed_usd).toBeCloseTo(first.order.authorized_max_usd, 2);
  });

  it("after reconcile(no_side_effect) a legitimate retry IS allowed", async () => {
    const c = ctx({ walletUsd: 20 });
    const first = await c.builder.submit(AGENT, rentProposal());
    if (!first.accepted) throw new Error("expected admission");
    c.ledger.transition({ decision_id: first.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
    c.ledger.transition({ decision_id: first.decision_id, to_state: "PROVISION_TIMEOUT", actor: "system" });
    c.builder.settle(first.order, { ok: false, cost_uncertain: true, failure_reason: "timeout" });

    // Operator/automation queries the provider using external_reference and
    // confirms no instance exists.
    c.idempotency.reconcile(first.order.operation_id, {
      outcome: "no_side_effect",
      note: "queried provider by external_reference; no instance with that tag",
    });

    const retry = await c.builder.submit(AGENT, rentProposal());
    expect(retry.accepted).toBe(true);
  });

  it("`failed` (side effects possible) also blocks until reconciled", async () => {
    const c = ctx({ walletUsd: 20 });
    const op = c.idempotency.begin({ tool: "economic:compute_rent", key: "kx", actor: AGENT, external_reference: "kaizen-x" });
    c.idempotency.fail(op.operation_id, "payment charged but provisioning errored");
    const retry = c.idempotency.begin({ tool: "economic:compute_rent", key: "kx", actor: AGENT });
    expect(retry.fresh).toBe(false);
    expect(retry.state).toBe("failed");
    expect(retry.guidance).toMatch(/reconcile/i);
  });

  it("findByExternalReference lets the reconciler locate the original op", async () => {
    const c = ctx({ walletUsd: 20 });
    const first = await c.builder.submit(AGENT, rentProposal());
    if (!first.accepted) throw new Error("expected admission");
    const found = c.idempotency.findByExternalReference(first.order.external_reference);
    expect(found?.operation_id).toBe(first.order.operation_id);
  });

  it("awaitingReconciliation surfaces the operational queue", async () => {
    const c = ctx({ walletUsd: 20 });
    const first = await c.builder.submit(AGENT, rentProposal());
    if (!first.accepted) throw new Error("expected admission");
    c.ledger.transition({ decision_id: first.decision_id, to_state: "PROVIDER_REQUESTED", actor: "kaizen" });
    c.ledger.transition({ decision_id: first.decision_id, to_state: "PROVISION_TIMEOUT", actor: "system" });
    c.builder.settle(first.order, { ok: false, cost_uncertain: true, failure_reason: "timeout" });
    const queue = c.idempotency.awaitingReconciliation();
    expect(queue.map((q) => q.operation_id)).toContain(first.order.operation_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  GATE #5 — audit trail is append-only at the ENGINE level
// ═══════════════════════════════════════════════════════════════════════

describe("GATE #5 — decision_events is append-only", () => {
  it("UPDATE on decision_events is rejected by a SQLite trigger", () => {
    const c = ctx();
    const d = c.ledger.createDecision({
      agent_id: AGENT, objective: "x", available_capital_usd: 5,
      options_considered: [], reason: "r", confidence: 0.5,
      expected_cost_usd: 1, maximum_cost_usd: 1, expected_value_usd: 2,
    });
    const evt = c.ledger.events(d.decision_id)[0]!;
    expect(() =>
      c.store.db.prepare("UPDATE decision_events SET actor='forged' WHERE event_id=?").run(evt.event_id),
    ).toThrow(/append-only/);
  });

  it("DELETE on decision_events is rejected by a SQLite trigger", () => {
    const c = ctx();
    const d = c.ledger.createDecision({
      agent_id: AGENT, objective: "x", available_capital_usd: 5,
      options_considered: [], reason: "r", confidence: 0.5,
      expected_cost_usd: 1, maximum_cost_usd: 1, expected_value_usd: 2,
    });
    const evt = c.ledger.events(d.decision_id)[0]!;
    expect(() =>
      c.store.db.prepare("DELETE FROM decision_events WHERE event_id=?").run(evt.event_id),
    ).toThrow(/append-only/);
  });

  it("deleting a decision leaves its events as a tombstone (no CASCADE)", () => {
    const c = ctx();
    const d = c.ledger.createDecision({
      agent_id: AGENT, objective: "x", available_capital_usd: 5,
      options_considered: [], reason: "r", confidence: 0.5,
      expected_cost_usd: 1, maximum_cost_usd: 1, expected_value_usd: 2,
    });
    expect(c.ledger.events(d.decision_id)).toHaveLength(1);
    c.store.db.prepare("DELETE FROM decisions WHERE decision_id=?").run(d.decision_id);
    // Decision row is gone…
    expect(c.ledger.get(d.decision_id)).toBeUndefined();
    // …but the economic evidence survives.
    expect(c.ledger.events(d.decision_id)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  GATE #8 — owner-selected policy profiles
// ═══════════════════════════════════════════════════════════════════════

describe("GATE #8 — policy profiles", () => {
  it("all profiles are frozen", () => {
    expect(() => { (POLICY_PROFILES as never as Record<string, unknown>).NEW = {}; }).toThrow();
    for (const name of Object.keys(POLICY_PROFILES) as Array<keyof typeof POLICY_PROFILES>) {
      expect(() => { (POLICY_PROFILES[name] as never as Record<string, number>).MAX_SINGLE_AUTONOMOUS_SPEND_USD = 1e9; }).toThrow();
    }
  });

  it("PHASE3_REAL_SMALL matches the owner's stated first-real-money caps", () => {
    const p = POLICY_PROFILES.PHASE3_REAL_SMALL;
    expect(p.MAX_WALLET_FUNDING_USD).toBe(5);
    expect(p.MAX_SINGLE_AUTONOMOUS_SPEND_USD).toBe(2);
    expect(p.MAX_CONCURRENT_GPU_INSTANCES).toBe(1);
  });

  it("profile is chosen from the env var, defaulting safely on garbage", () => {
    expect(resolveProfileName("UNRESTRICTED_OWNER_MODE")).toBe("UNRESTRICTED_OWNER_MODE");
    expect(resolveProfileName("NOT_A_PROFILE")).toBe("PHASE1_INITIAL_TEST");
    expect(resolveProfileName(undefined)).toBe("PHASE1_INITIAL_TEST");
    expect(resolveProfileName("")).toBe("PHASE1_INITIAL_TEST");
  });

  it("the engine resolves its profile ONCE at construction — no runtime setter exists", () => {
    const prev = process.env[POLICY_PROFILE_ENV];
    process.env[POLICY_PROFILE_ENV] = "UNRESTRICTED_OWNER_MODE";
    const eng = new PolicyEngine(() => false);
    expect(eng.profileName).toBe("UNRESTRICTED_OWNER_MODE");
    // Changing the env afterwards does NOT change this instance.
    process.env[POLICY_PROFILE_ENV] = "PHASE1_INITIAL_TEST";
    expect(eng.profileName).toBe("UNRESTRICTED_OWNER_MODE");
    // And there is no setter on the instance.
    expect((eng as unknown as Record<string, unknown>).setProfile).toBeUndefined();
    if (prev !== undefined) process.env[POLICY_PROFILE_ENV] = prev; else delete process.env[POLICY_PROFILE_ENV];
  });

  describe("UNRESTRICTED_OWNER_MODE", () => {
    const eng = new PolicyEngine(() => false, "UNRESTRICTED_OWNER_MODE");

    it("lifts the spending ceilings", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 5000, requested_runtime_minutes: 10_000, reason: "big job" },
        { spent_last_24h_usd: 100_000, reserved_usd: 0, wallet_balance_usd: 900_000 },
      );
      expect(res.allow).toBe(true);
    });

    it("KEEPS the kill switch", () => {
      const killed = new PolicyEngine(() => true, "UNRESTRICTED_OWNER_MODE");
      const res = killed.evaluate(
        { kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: 10, reason: "x" },
        { spent_last_24h_usd: 0, reserved_usd: 0, wallet_balance_usd: 1000 },
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("killed");
    });

    it("KEEPS the accounting invariant — cannot spend money it does not hold", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 500, requested_runtime_minutes: 10, reason: "overdraw" },
        { spent_last_24h_usd: 0, reserved_usd: 0, wallet_balance_usd: 100 },
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("insufficient_wallet_balance");
    });

    it("KEEPS finite/range validation", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: NaN, reason: "bad" },
        { spent_last_24h_usd: 0, reserved_usd: 0, wallet_balance_usd: 1000 },
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("invalid_input");
    });

    it("KEEPS a bounded concurrency limit (no unbounded fan-out)", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: 10, concurrent_gpus: 8, reason: "fan out" },
        { spent_last_24h_usd: 0, reserved_usd: 0, wallet_balance_usd: 1000 },
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("concurrent_gpu_over_cap");
    });

    it("still records the profile on every decision for audit", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: 10, reason: "x" },
        { spent_last_24h_usd: 0, reserved_usd: 0, wallet_balance_usd: 1000 },
      );
      expect(res.profile).toBe("UNRESTRICTED_OWNER_MODE");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  GATE #9 — range validation helpers
// ═══════════════════════════════════════════════════════════════════════

describe("GATE #9 — numeric range validation", () => {
  it("checkNumber rejects NaN, Infinity, wrong type, out-of-range, non-integer", () => {
    expect(checkNumber("x", NaN)).toMatchObject({ reason: expect.stringContaining("finite") });
    expect(checkNumber("x", Infinity)).toMatchObject({ reason: expect.stringContaining("finite") });
    expect(checkNumber("x", "5" as unknown)).toMatchObject({ reason: expect.stringContaining("number") });
    expect(checkNumber("x", -1, { min: 0 })).toMatchObject({ reason: "must be >= 0" });
    expect(checkNumber("x", 11, { max: 10 })).toMatchObject({ reason: "must be <= 10" });
    expect(checkNumber("x", 1.5, { integer: true })).toMatchObject({ reason: expect.stringContaining("integer") });
    expect(checkNumber("x", 5, { min: 0, max: 10 })).toBeNull();
  });

  it("validateActualCost enforces finite, non-negative, within-authorized", () => {
    expect(validateActualCost(0.5, 1.0)).toEqual({ ok: true, value: 0.5 });
    expect(validateActualCost(1.0, 1.0)).toEqual({ ok: true, value: 1.0 });
    const over = validateActualCost(1.5, 1.0);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.overcharge).toBe(true);
    expect(validateActualCost(NaN, 1.0).ok).toBe(false);
    expect(validateActualCost(-1, 1.0).ok).toBe(false);
    expect(validateActualCost("free" as unknown, 1.0).ok).toBe(false);
  });
});
