import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetReservation } from "../../economic/budget-reservation.js";
import { PolicyEngine, POLICY_PROFILES } from "../../economic/policy-engine.js";
import { EconomicStore } from "../../economic/store.js";

const HARD_LIMITS = POLICY_PROFILES.PHASE1_INITIAL_TEST;

function fresh(killed = false): BudgetReservation {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-budget-"));
  return new BudgetReservation(new EconomicStore({ stateDir: dir }), {
    policy: new PolicyEngine(() => killed, "PHASE1_INITIAL_TEST"),
  });
}

const AGENT = "kaizen-fusion";

function req(over: Record<string, unknown> = {}) {
  return {
    kind: "compute_rent" as const,
    amount_usd: 1.0,
    requested_runtime_minutes: 30,
    reason: "test rental",
    ...over,
  };
}

describe("BudgetReservation", () => {
  let b: BudgetReservation;
  beforeEach(() => { b = fresh(); });

  it("reserve() succeeds and holds capital", () => {
    const r = b.reserve({ decision_id: "d1", agent_id: AGENT, request: req(), walletBalanceUsd: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const row = b.get(r.reservation_id)!;
      expect(row.state).toBe("held");
      expect(row.amount_usd).toBeCloseTo(1.0);
    }
    expect(b.totalsFor(AGENT).held_usd).toBeCloseTo(1.0);
  });

  it("held reservations count against the daily cap for the NEXT reserve", () => {
    // Reserve up to just under the daily cap
    const chunk = 4;
    let held = 0;
    for (let i = 0; i < 6; i++) {
      const r = b.reserve({
        decision_id: `d-${i}`, agent_id: AGENT,
        request: req({ amount_usd: chunk }), walletBalanceUsd: 50,
        concurrent_gpus: 0,
      });
      if (r.ok) held += chunk;
    }
    // MAX_DAILY_CUMULATIVE_SPEND_USD is 25 → at most 6 x 4 = 24 fits
    expect(held).toBeLessThanOrEqual(HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD);
    // The next one must be refused
    const over = b.reserve({ decision_id: "d-over", agent_id: AGENT, request: req({ amount_usd: 4 }), walletBalanceUsd: 50, concurrent_gpus: 0 });
    expect(over.ok).toBe(false);
    if (!over.ok && !over.policy.allow) expect(over.policy.kind).toBe("daily_cumulative_over_cap");
  });

  it("ATOMICITY: sequential reserves cannot collectively exceed the cap", () => {
    // Simulate the race the owner described: many callers each individually
    // under the single-spend cap, together over the daily cap.
    const results: boolean[] = [];
    for (let i = 0; i < 40; i++) {
      const r = b.reserve({
        decision_id: `race-${i}`, agent_id: AGENT,
        request: req({ amount_usd: 1 }), walletBalanceUsd: 50, concurrent_gpus: 0,
      });
      results.push(r.ok);
    }
    const accepted = results.filter(Boolean).length;
    // Every accepted reservation is $1; total held must respect the cap.
    expect(b.totalsFor(AGENT).held_usd).toBeLessThanOrEqual(HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD);
    expect(accepted).toBe(HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD);
  });

  it("commit() moves held → committed and records actual cost", () => {
    const r = b.reserve({ decision_id: "d2", agent_id: AGENT, request: req({ amount_usd: 2 }), walletBalanceUsd: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = b.commit(r.reservation_id, 1.75);
    expect(row.state).toBe("committed");
    expect(row.actual_cost_usd).toBeCloseTo(1.75);
    const t = b.totalsFor(AGENT);
    expect(t.held_usd).toBeCloseTo(0);
    expect(t.committed_usd).toBeCloseTo(1.75);   // actual, not the reserved 2
  });

  it("release() frees capital back", () => {
    const r = b.reserve({ decision_id: "d3", agent_id: AGENT, request: req({ amount_usd: 3 }), walletBalanceUsd: 5 });
    if (!r.ok) throw new Error("expected reserve to succeed");
    expect(b.totalsFor(AGENT).held_usd).toBeCloseTo(3);
    b.release(r.reservation_id, "provider returned 500");
    const t = b.totalsFor(AGENT);
    expect(t.held_usd).toBeCloseTo(0);
    expect(t.committed_usd).toBeCloseTo(0);
  });

  it("commit/release refuse on a non-held reservation", () => {
    const r = b.reserve({ decision_id: "d4", agent_id: AGENT, request: req(), walletBalanceUsd: 5 });
    if (!r.ok) throw new Error("expected ok");
    b.commit(r.reservation_id, 1);
    expect(() => b.commit(r.reservation_id, 1)).toThrow(/expected held/);
    expect(() => b.release(r.reservation_id, "late")).toThrow(/expected held/);
  });

  it("commitAsLiability keeps capital consumed when infra may still bill", () => {
    const r = b.reserve({ decision_id: "d5", agent_id: AGENT, request: req({ amount_usd: 2 }), walletBalanceUsd: 5 });
    if (!r.ok) throw new Error("expected ok");
    const row = b.commitAsLiability(r.reservation_id, 2.0, "stopGpu failed 3x; instance may still run");
    expect(row.state).toBe("committed");
    expect(row.actual_cost_usd).toBeCloseTo(2.0);
    expect(row.release_reason).toContain("LIABILITY");
    // Capital is NOT freed
    expect(b.totalsFor(AGENT).committed_usd).toBeCloseTo(2.0);
    expect(b.totalsFor(AGENT).held_usd).toBeCloseTo(0);
  });

  it("enforces MAX_CONCURRENT_GPU_INSTANCES via held GPU reservations", () => {
    const first = b.reserve({ decision_id: "g1", agent_id: AGENT, request: req({ amount_usd: 1 }), walletBalanceUsd: 20 });
    expect(first.ok).toBe(true);
    // Second GPU while the first is still held → refused (cap is 1)
    const second = b.reserve({ decision_id: "g2", agent_id: AGENT, request: req({ amount_usd: 1 }), walletBalanceUsd: 20 });
    expect(second.ok).toBe(false);
    if (!second.ok && !second.policy.allow) expect(second.policy.kind).toBe("concurrent_gpu_over_cap");
    // After committing the first, a new one is allowed
    if (first.ok) b.commit(first.reservation_id, 0.9);
    const third = b.reserve({ decision_id: "g3", agent_id: AGENT, request: req({ amount_usd: 1 }), walletBalanceUsd: 20 });
    expect(third.ok).toBe(true);
  });

  it("kill switch blocks reservation entirely", () => {
    const killed = fresh(true);
    const r = killed.reserve({ decision_id: "k1", agent_id: AGENT, request: req(), walletBalanceUsd: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok && !r.policy.allow) expect(r.policy.kind).toBe("killed");
    expect(killed.totalsFor(AGENT).held_usd).toBe(0);
  });

  it("refuses when wallet balance can't cover amount + existing holds", () => {
    const a = b.reserve({ decision_id: "w1", agent_id: AGENT, request: req({ amount_usd: 3 }), walletBalanceUsd: 5 });
    expect(a.ok).toBe(true);
    if (a.ok) b.commit(a.reservation_id, 3);
    // wallet now effectively $2; ask for $3
    const bb = b.reserve({ decision_id: "w2", agent_id: AGENT, request: req({ amount_usd: 3 }), walletBalanceUsd: 2 });
    expect(bb.ok).toBe(false);
    if (!bb.ok && !bb.policy.allow) expect(bb.policy.kind).toBe("insufficient_wallet_balance");
  });

  it("staleHeld surfaces leaked reservations", () => {
    const r = b.reserve({ decision_id: "s1", agent_id: AGENT, request: req(), walletBalanceUsd: 5 });
    if (!r.ok) throw new Error("expected ok");
    (b as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("UPDATE reservations SET updated_at=? WHERE reservation_id=?")
      .run(Date.now() - 600_000, r.reservation_id);
    expect(b.staleHeld(300_000).map((x) => x.reservation_id)).toContain(r.reservation_id);
    expect(b.staleHeld(900_000).map((x) => x.reservation_id)).not.toContain(r.reservation_id);
  });

  it("agents are isolated from each other's budgets", () => {
    b.reserve({ decision_id: "a1", agent_id: "agent-a", request: req({ amount_usd: 5 }), walletBalanceUsd: 20 });
    b.reserve({ decision_id: "b1", agent_id: "agent-b", request: req({ amount_usd: 7 }), walletBalanceUsd: 20 });
    expect(b.totalsFor("agent-a").held_usd).toBeCloseTo(5);
    expect(b.totalsFor("agent-b").held_usd).toBeCloseTo(7);
  });
});
