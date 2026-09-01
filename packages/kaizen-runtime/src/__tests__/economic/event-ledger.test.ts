import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EconomicEventLedger, LEGAL_TRANSITIONS } from "../../economic/event-ledger.js";
import { EconomicStore } from "../../economic/store.js";

function freshLedger(): EconomicEventLedger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-ledger-"));
  return new EconomicEventLedger(new EconomicStore({ stateDir: dir }));
}

function baseDecision(over: Record<string, unknown> = {}) {
  return {
    agent_id: "kaizen-fusion",
    objective: "Complete objective X under a $2 budget",
    available_capital_usd: 5,
    options_considered: [
      { provider: "lightning", gpu: "L4", hourly: 0.20, est_hours: 5, est_total: 1.00 },
      { provider: "runpod",    gpu: "A10", hourly: 0.55, est_hours: 1, est_total: 0.55 },
      { provider: "brev",      gpu: "H100", hourly: 3.00, est_hours: 0.5, est_total: 1.50 },
    ],
    reason: "runpod A10 completes in 1h for $0.55 — lowest total cost, adequate VRAM",
    confidence: 0.78,
    expected_cost_usd: 0.55,
    maximum_cost_usd: 0.80,
    expected_value_usd: 2.00,
    ...over,
  };
}

describe("EconomicEventLedger", () => {
  let ledger: EconomicEventLedger;
  beforeEach(() => { ledger = freshLedger(); });

  it("createDecision persists all 17 fields + starts in DECISION_CREATED", () => {
    const d = ledger.createDecision(baseDecision());
    expect(d.state).toBe("DECISION_CREATED");
    const row = ledger.get(d.decision_id)!;
    expect(row.agent_id).toBe("kaizen-fusion");
    expect(row.objective).toContain("$2 budget");
    expect(row.available_capital_usd).toBe(5);
    expect(row.reserved_capital_usd).toBe(0);
    expect(row.options_considered).toHaveLength(3);
    expect(row.selected_option).toBeNull();
    expect(row.confidence).toBeCloseTo(0.78);
    expect(row.expected_cost_usd).toBeCloseTo(0.55);
    expect(row.maximum_cost_usd).toBeCloseTo(0.80);
    expect(row.expected_value_usd).toBeCloseTo(2.00);
    expect(row.policy_result).toBeNull();
    expect(row.tool_calls).toEqual([]);
    expect(row.provider).toBeNull();
    expect(row.actual_cost_usd).toBeNull();
    expect(row.actual_result).toBeNull();
    expect(row.profit_or_utility_usd).toBeNull();
    expect(row.failure_reason).toBeNull();
    expect(row.created_at).toBeGreaterThan(0);
  });

  it("records a creation event in the audit trail", () => {
    const d = ledger.createDecision(baseDecision());
    const evts = ledger.events(d.decision_id);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.from_state).toBeNull();
    expect(evts[0]!.to_state).toBe("DECISION_CREATED");
  });

  it("walks the full happy path state machine", () => {
    const d = ledger.createDecision(baseDecision());
    const path_: Array<[string, Record<string, unknown> | undefined]> = [
      ["POLICY_APPROVED",   { policy_result: { allow: true } }],
      ["BUDGET_RESERVED",   { reserved_capital_usd: 0.80 }],
      ["PROVIDER_REQUESTED",{ provider: "runpod", selected_option: { provider: "runpod", gpu: "A10" } }],
      ["PROVISIONING",      undefined],
      ["RUNNING",           undefined],
      ["WORKLOAD_RUNNING",  undefined],
      ["STOP_REQUESTED",    undefined],
      ["TERMINATED",        undefined],
      ["RECONCILED",        { actual_cost_usd: 0.58, profit_or_utility_usd: 1.42 }],
      ["CLOSED",            undefined],
    ];
    for (const [state, patch] of path_) {
      ledger.transition({ decision_id: d.decision_id, to_state: state as never, actor: "kaizen", patch: patch as never });
    }
    const final = ledger.get(d.decision_id)!;
    expect(final.state).toBe("CLOSED");
    expect(final.provider).toBe("runpod");
    expect(final.actual_cost_usd).toBeCloseTo(0.58);
    expect(final.profit_or_utility_usd).toBeCloseTo(1.42);
    expect(final.reserved_capital_usd).toBeCloseTo(0.80);
    // Audit trail: 1 creation + 10 transitions
    expect(ledger.events(d.decision_id)).toHaveLength(11);
  });

  it("refuses an illegal transition", () => {
    const d = ledger.createDecision(baseDecision());
    // DECISION_CREATED cannot jump straight to RUNNING
    expect(() => ledger.transition({ decision_id: d.decision_id, to_state: "RUNNING", actor: "kaizen" }))
      .toThrow(/illegal transition DECISION_CREATED → RUNNING/);
  });

  it("POLICY_REJECTED is terminal — nothing can follow", () => {
    const d = ledger.createDecision(baseDecision());
    ledger.transition({ decision_id: d.decision_id, to_state: "POLICY_REJECTED", actor: "policy", patch: { failure_reason: "over daily cap" } });
    expect(LEGAL_TRANSITIONS.POLICY_REJECTED).toEqual([]);
    expect(() => ledger.transition({ decision_id: d.decision_id, to_state: "BUDGET_RESERVED", actor: "kaizen" }))
      .toThrow(/illegal transition/);
  });

  it("STOP_FAILED can retry STOP_REQUESTED (owner requirement)", () => {
    const d = ledger.createDecision(baseDecision());
    for (const s of ["POLICY_APPROVED","BUDGET_RESERVED","PROVIDER_REQUESTED","PROVISIONING","RUNNING","STOP_REQUESTED","STOP_FAILED"] as const) {
      ledger.transition({ decision_id: d.decision_id, to_state: s, actor: "kaizen" });
    }
    // retry stop
    const after = ledger.transition({ decision_id: d.decision_id, to_state: "STOP_REQUESTED", actor: "kaizen", data: { retry: 1 } });
    expect(after.state).toBe("STOP_REQUESTED");
    // and STOP_FAILED can escalate to BILLING_DISPUTE
    ledger.transition({ decision_id: d.decision_id, to_state: "STOP_FAILED", actor: "system" });
    const disputed = ledger.transition({ decision_id: d.decision_id, to_state: "BILLING_DISPUTE", actor: "system", patch: { failure_reason: "provider still billing after 3 stop attempts" } });
    expect(disputed.state).toBe("BILLING_DISPUTE");
  });

  it("KILLED is reachable from every active state", () => {
    for (const from of ["DECISION_CREATED","POLICY_APPROVED","BUDGET_RESERVED","PROVIDER_REQUESTED","PROVISIONING","RUNNING","WORKLOAD_RUNNING","STOP_REQUESTED"] as const) {
      expect(LEGAL_TRANSITIONS[from]).toContain("KILLED");
    }
  });

  it("spentInWindow separates settled spend from in-flight reservations", () => {
    // Settled decision
    const a = ledger.createDecision(baseDecision({ expected_cost_usd: 1.00 }));
    for (const s of ["POLICY_APPROVED","BUDGET_RESERVED","PROVIDER_REQUESTED","PROVISIONING","RUNNING","STOP_REQUESTED","TERMINATED"] as const) {
      ledger.transition({ decision_id: a.decision_id, to_state: s, actor: "kaizen" });
    }
    ledger.transition({ decision_id: a.decision_id, to_state: "RECONCILED", actor: "system", patch: { actual_cost_usd: 0.95 } });

    // In-flight decision
    const b = ledger.createDecision(baseDecision({ expected_cost_usd: 0.60 }));
    ledger.transition({ decision_id: b.decision_id, to_state: "POLICY_APPROVED", actor: "policy" });
    ledger.transition({ decision_id: b.decision_id, to_state: "BUDGET_RESERVED", actor: "kaizen" });

    const w = ledger.spentInWindow({ window_ms: 24 * 3600 * 1000 });
    expect(w.spent_usd).toBeCloseTo(0.95);     // actual cost of settled
    expect(w.reserved_usd).toBeCloseTo(0.60);  // expected cost of in-flight
  });

  it("scopes spentInWindow by agent_id", () => {
    const a = ledger.createDecision(baseDecision({ agent_id: "agent-a", expected_cost_usd: 1 }));
    ledger.transition({ decision_id: a.decision_id, to_state: "POLICY_APPROVED", actor: "policy" });
    const b = ledger.createDecision(baseDecision({ agent_id: "agent-b", expected_cost_usd: 2 }));
    ledger.transition({ decision_id: b.decision_id, to_state: "POLICY_APPROVED", actor: "policy" });

    expect(ledger.spentInWindow({ agent_id: "agent-a", window_ms: 3600_000 }).reserved_usd).toBeCloseTo(1);
    expect(ledger.spentInWindow({ agent_id: "agent-b", window_ms: 3600_000 }).reserved_usd).toBeCloseTo(2);
  });

  it("transition is atomic — a failed patch leaves state unchanged", () => {
    const d = ledger.createDecision(baseDecision());
    // Bad column name in patch should throw and NOT move state
    expect(() => ledger.transition({
      decision_id: d.decision_id, to_state: "POLICY_APPROVED", actor: "policy",
      patch: { nonexistent_column: 1 } as never,
    })).toThrow();
    expect(ledger.get(d.decision_id)!.state).toBe("DECISION_CREATED");
  });
});
