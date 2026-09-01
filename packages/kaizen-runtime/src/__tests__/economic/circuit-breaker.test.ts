import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CircuitBreaker } from "../../economic/circuit-breaker.js";
import { EconomicStore } from "../../economic/store.js";

function fresh(nowRef: { t: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-cb-"));
  return new CircuitBreaker(new EconomicStore({ stateDir: dir }), {
    failureThreshold: 3, baseCooldownMs: 1000, maxCooldownMs: 60_000,
    now: () => nowRef.t,
  });
}

describe("CircuitBreaker", () => {
  let now: { t: number };
  let cb: CircuitBreaker;
  beforeEach(() => { now = { t: 1_000_000 }; cb = fresh(now); });

  it("starts closed and allows calls", () => {
    const r = cb.allow("provider:lightning");
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.state).toBe("closed");
  });

  it("stays closed under the failure threshold", () => {
    cb.recordFailure("p", "err1");
    cb.recordFailure("p", "err2");
    expect(cb.status("p").state).toBe("closed");
    expect(cb.allow("p").allow).toBe(true);
  });

  it("opens at the threshold and refuses calls", () => {
    cb.recordFailure("p", "e1");
    cb.recordFailure("p", "e2");
    const row = cb.recordFailure("p", "e3 boom");
    expect(row.state).toBe("open");
    expect(row.consecutive_failures).toBe(3);
    const r = cb.allow("p");
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.state).toBe("open");
      expect(r.reason).toContain("e3 boom");
      expect(r.retry_after_ms).toBeGreaterThan(0);
    }
  });

  it("moves to half_open after cooldown and allows exactly one probe", () => {
    for (const e of ["a", "b", "c"]) cb.recordFailure("p", e);
    expect(cb.status("p").cooldown_ms).toBe(1000);
    now.t += 1001;
    const probe = cb.allow("p");
    expect(probe.allow).toBe(true);
    if (probe.allow) expect(probe.probe).toBe(true);
    // A second concurrent caller is refused while the probe is in flight
    const second = cb.allow("p");
    expect(second.allow).toBe(false);
  });

  it("probe success closes the circuit", () => {
    for (const e of ["a", "b", "c"]) cb.recordFailure("p", e);
    now.t += 1001;
    cb.allow("p");              // half_open
    cb.recordSuccess("p");
    expect(cb.status("p").state).toBe("closed");
    expect(cb.status("p").consecutive_failures).toBe(0);
    expect(cb.allow("p").allow).toBe(true);
  });

  it("probe failure re-opens with an exponentially longer cooldown", () => {
    for (const e of ["a", "b", "c"]) cb.recordFailure("p", e);
    expect(cb.status("p").cooldown_ms).toBe(1000);   // 2^0 * 1000
    now.t += 1001;
    cb.allow("p");                                    // half_open probe
    cb.recordFailure("p", "probe failed");            // re-open
    expect(cb.status("p").state).toBe("open");
    expect(cb.status("p").cooldown_ms).toBe(2000);    // 2^1 * 1000
    now.t += 2001;
    cb.allow("p");
    cb.recordFailure("p", "probe failed again");
    expect(cb.status("p").cooldown_ms).toBe(4000);    // 2^2 * 1000
  });

  it("caps the cooldown at maxCooldownMs", () => {
    for (let i = 0; i < 12; i++) {
      // force repeated opens
      cb.recordFailure("p", `f${i}`);
      cb.recordFailure("p", `f${i}b`);
      cb.recordFailure("p", `f${i}c`);
      now.t += cb.status("p").cooldown_ms + 1;
      cb.allow("p");
    }
    expect(cb.status("p").cooldown_ms).toBeLessThanOrEqual(60_000);
  });

  it("a success resets the failure counter", () => {
    cb.recordFailure("p", "a");
    cb.recordFailure("p", "b");
    cb.recordSuccess("p");
    expect(cb.status("p").consecutive_failures).toBe(0);
    cb.recordFailure("p", "c");
    expect(cb.status("p").state).toBe("closed");   // counter restarted
  });

  it("breakers are isolated per key", () => {
    for (const e of ["a", "b", "c"]) cb.recordFailure("provider:runpod", e);
    expect(cb.status("provider:runpod").state).toBe("open");
    expect(cb.allow("provider:lightning").allow).toBe(true);
  });

  it("state survives a new CircuitBreaker instance on the same dir (crash-loop safety)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-cb-persist-"));
    const t = { t: 5_000_000 };
    const storeOne = new EconomicStore({ stateDir: dir });
    const one = new CircuitBreaker(storeOne, { failureThreshold: 2, baseCooldownMs: 10_000, now: () => t.t });
    one.recordFailure("p", "x"); one.recordFailure("p", "y");
    expect(one.status("p").state).toBe("open");
    storeOne.close();
    const two = new CircuitBreaker(new EconomicStore({ stateDir: dir }), { failureThreshold: 2, baseCooldownMs: 10_000, now: () => t.t });
    expect(two.status("p").state).toBe("open");     // NOT reset by restart
    expect(two.allow("p").allow).toBe(false);
  });

  it("reset() lets an operator force-close a tripped breaker", () => {
    for (const e of ["a", "b", "c"]) cb.recordFailure("p", e);
    expect(cb.status("p").state).toBe("open");
    cb.reset("p");
    expect(cb.status("p").state).toBe("closed");
    expect(cb.allow("p").allow).toBe(true);
  });
});
