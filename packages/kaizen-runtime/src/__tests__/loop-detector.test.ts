import { describe, it, expect } from "vitest";
import { LoopDetector, hashArgs } from "../agent/loop-detector.js";

describe("LoopDetector", () => {
  it("does not fire on first observation", () => {
    const d = new LoopDetector();
    expect(d.observe("opportunity.scan", "abc")).toBe(false);
  });

  it("fires when consecutive threshold is hit (default 3)", () => {
    const d = new LoopDetector();
    expect(d.observe("wallet.getBalance", "aa")).toBe(false);
    expect(d.observe("wallet.getBalance", "aa")).toBe(false);
    expect(d.observe("wallet.getBalance", "aa")).toBe(true);
    expect(d.lastAbortReason).toMatch(/wallet.getBalance called 3 times in a row/);
  });

  it("does NOT fire if same tool but different args", () => {
    const d = new LoopDetector();
    expect(d.observe("exchange.quote", "aa")).toBe(false);
    expect(d.observe("exchange.quote", "bb")).toBe(false);
    expect(d.observe("exchange.quote", "cc")).toBe(false);
  });

  it("fires on windowed repetition even when interleaved (K-of-W)", () => {
    const d = new LoopDetector({ windowSize: 8, windowThreshold: 4 });
    // Interleave the same tool 4x with other calls in a window of 8
    d.observe("wallet.getBalance", "same");
    d.observe("opportunity.scan", "a");
    d.observe("wallet.getBalance", "same");
    d.observe("opportunity.scan", "b");
    d.observe("wallet.getBalance", "same");
    d.observe("opportunity.scan", "c");
    expect(d.observe("wallet.getBalance", "same")).toBe(true);
    expect(d.lastAbortReason).toMatch(/wallet.getBalance.*called 4 times/);
  });

  it("respects custom thresholds", () => {
    const d = new LoopDetector({ consecutiveThreshold: 2 });
    expect(d.observe("x", "1")).toBe(false);
    expect(d.observe("x", "1")).toBe(true);
  });

  it("reset clears window and lastAbortReason", () => {
    const d = new LoopDetector();
    d.observe("a", "1"); d.observe("a", "1"); d.observe("a", "1");
    expect(d.lastAbortReason).not.toBeNull();
    d.reset();
    expect(d.lastAbortReason).toBeNull();
    expect(d.observe("a", "1")).toBe(false);      // window empty again
  });
});

describe("hashArgs", () => {
  it("returns same 8-char hex for equivalent inputs", () => {
    const a = hashArgs({ b: 1, a: 2 });
    const b = hashArgs({ b: 1, a: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different hashes for different inputs", () => {
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });

  it("handles null / undefined / empty args", () => {
    expect(hashArgs(null)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashArgs(undefined)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashArgs({})).toMatch(/^[0-9a-f]{8}$/);
  });
});
