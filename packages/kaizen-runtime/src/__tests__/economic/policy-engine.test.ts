import { describe, it, expect } from "vitest";
import { PolicyEngine, POLICY_PROFILES, KILL_SWITCH_ENV } from "../../economic/policy-engine.js";

const HARD_LIMITS = POLICY_PROFILES.PHASE1_INITIAL_TEST;

function snap(over: Partial<{ spent_last_24h_usd: number; reserved_usd: number; wallet_balance_usd: number }> = {}) {
  return {
    spent_last_24h_usd: 0,
    reserved_usd: 0,
    wallet_balance_usd: 50,
    ...over,
  };
}

describe("PolicyEngine", () => {
  describe("kill switch", () => {
    it("always wins — refuses every action when env=1", () => {
      const eng = new PolicyEngine(() => true, "PHASE1_INITIAL_TEST");
      const res = eng.evaluate({ kind: "compute_rent", amount_usd: 0.5, reason: "test" }, snap());
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("killed");
    });
    it("respects a mid-flight flip", () => {
      let killed = false;
      const eng = new PolicyEngine(() => killed, "PHASE1_INITIAL_TEST");
      expect(eng.evaluate({ kind: "compute_rent", amount_usd: 1, reason: "x" }, snap()).allow).toBe(true);
      killed = true;
      const res = eng.evaluate({ kind: "compute_rent", amount_usd: 1, reason: "x" }, snap());
      expect(res.allow).toBe(false);
    });
    it("reads real env var by default", () => {
      const prev = process.env[KILL_SWITCH_ENV];
      process.env[KILL_SWITCH_ENV] = "1";
      const eng = new PolicyEngine(undefined, "PHASE1_INITIAL_TEST");
      expect(eng.evaluate({ kind: "compute_rent", amount_usd: 1, reason: "x" }, snap()).allow).toBe(false);
      process.env[KILL_SWITCH_ENV] = "";
      expect(eng.evaluate({ kind: "compute_rent", amount_usd: 1, reason: "x" }, snap()).allow).toBe(true);
      if (prev !== undefined) process.env[KILL_SWITCH_ENV] = prev; else delete process.env[KILL_SWITCH_ENV];
    });
  });

  describe("single-spend cap", () => {
    const eng = new PolicyEngine(() => false, "PHASE1_INITIAL_TEST");
    it("allows exactly at the cap", () => {
      const res = eng.evaluate({ kind: "compute_rent", amount_usd: HARD_LIMITS.MAX_SINGLE_AUTONOMOUS_SPEND_USD, requested_runtime_minutes: 30, reason: "at cap" }, snap({ wallet_balance_usd: 50 }));
      expect(res.allow).toBe(true);
    });
    it("refuses 1 cent over the cap", () => {
      const res = eng.evaluate({ kind: "compute_rent", amount_usd: HARD_LIMITS.MAX_SINGLE_AUTONOMOUS_SPEND_USD + 0.01, reason: "over" }, snap());
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("single_spend_over_cap");
    });
  });

  describe("daily cumulative cap", () => {
    const eng = new PolicyEngine(() => false, "PHASE1_INITIAL_TEST");
    it("counts spent + reserved + this against MAX_DAILY_CUMULATIVE_SPEND_USD", () => {
      const already = HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD - 3;
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 4, requested_runtime_minutes: 10, reason: "push over 25" },
        snap({ spent_last_24h_usd: already, wallet_balance_usd: 50 }),
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("daily_cumulative_over_cap");
    });
    it("allows when projected total exactly equals cap", () => {
      const already = HARD_LIMITS.MAX_DAILY_CUMULATIVE_SPEND_USD - 5;
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 5, requested_runtime_minutes: 10, reason: "exactly cap" },
        snap({ spent_last_24h_usd: already, wallet_balance_usd: 50 }),
      );
      expect(res.allow).toBe(true);
    });
    it("includes in-flight reservations", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 5, requested_runtime_minutes: 10, reason: "reserved matters" },
        snap({ spent_last_24h_usd: 10, reserved_usd: 12, wallet_balance_usd: 50 }),
      );
      // 10 + 12 + 5 = 27 > 25
      expect(res.allow).toBe(false);
    });
  });

  describe("wallet balance", () => {
    const eng = new PolicyEngine(() => false, "PHASE1_INITIAL_TEST");
    it("refuses if amount + reserved exceeds current balance", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 3, requested_runtime_minutes: 10, reason: "poor" },
        snap({ wallet_balance_usd: 2 }),
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("insufficient_wallet_balance");
    });
    it("refuses if wallet holds more than MAX_WALLET_FUNDING_USD", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: 10, reason: "over-funded" },
        snap({ wallet_balance_usd: HARD_LIMITS.MAX_WALLET_FUNDING_USD + 1 }),
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("wallet_funding_over_cap");
    });
  });

  describe("GPU-specific caps", () => {
    const eng = new PolicyEngine(() => false, "PHASE1_INITIAL_TEST");
    it("refuses runtime over MAX_GPU_RUNTIME_MINUTES", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: HARD_LIMITS.MAX_GPU_RUNTIME_MINUTES + 1, reason: "long" },
        snap(),
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("gpu_runtime_over_cap");
    });
    it("refuses concurrent GPU over cap on new rent", () => {
      const res = eng.evaluate(
        { kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: 10, concurrent_gpus: HARD_LIMITS.MAX_CONCURRENT_GPU_INSTANCES, reason: "double" },
        snap(),
      );
      expect(res.allow).toBe(false);
      if (!res.allow) expect(res.kind).toBe("concurrent_gpu_over_cap");
    });
    it("allows extend on an existing GPU without increasing count", () => {
      const res = eng.evaluate(
        { kind: "compute_extend", amount_usd: 0.5, requested_runtime_minutes: 20, concurrent_gpus: HARD_LIMITS.MAX_CONCURRENT_GPU_INSTANCES, reason: "add time" },
        snap(),
      );
      expect(res.allow).toBe(true);
    });
  });

  describe("input sanity", () => {
    const eng = new PolicyEngine(() => false, "PHASE1_INITIAL_TEST");
    it("refuses NaN or negative amount", () => {
      expect(eng.evaluate({ kind: "compute_rent", amount_usd: NaN, reason: "bad" }, snap()).allow).toBe(false);
      expect(eng.evaluate({ kind: "compute_rent", amount_usd: -5, reason: "bad" }, snap()).allow).toBe(false);
    });
    it("refuses non-finite snapshot values", () => {
      expect(eng.evaluate({ kind: "compute_rent", amount_usd: 1, requested_runtime_minutes: 10, reason: "x" }, snap({ spent_last_24h_usd: Infinity })).allow).toBe(false);
    });
  });

  it("profiles are frozen — Kaizen can't mutate limits at runtime", () => {
    expect(() => { (HARD_LIMITS as any).MAX_SINGLE_AUTONOMOUS_SPEND_USD = 9999; }).toThrow();
    expect(() => { (POLICY_PROFILES as any).PHASE1_INITIAL_TEST = {}; }).toThrow();
  });
});
