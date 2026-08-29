import { describe, it, expect } from "vitest";
import { SpendTracker } from "../agent/spend-tracker.js";

describe("SpendTracker", () => {
  it("starts at zero", () => {
    const s = new SpendTracker();
    expect(s.totalUsd()).toBe(0);
    expect(s.breakdown()).toEqual({ llmUsd: 0, toolUsd: 0, llmCallCount: 0, toolCostCount: 0 });
  });

  it("prices llama-3.2-90b calls at expected rate", () => {
    const s = new SpendTracker();
    // 1000 in + 500 out = 0.001*1 + 0.002*0.5 = 0.002 USD
    s.addLlmCall(1000, 500, "meta/llama-3.2-90b-vision-instruct");
    expect(s.totalUsd()).toBeCloseTo(0.002, 6);
  });

  it("falls back to *default* pricing for unknown models", () => {
    const s = new SpendTracker();
    s.addLlmCall(1000, 500, "some/unknown-model");
    // 0.002*1 + 0.006*0.5 = 0.005
    expect(s.totalUsd()).toBeCloseTo(0.005, 6);
  });

  it("adds tool costs on top of LLM costs", () => {
    const s = new SpendTracker();
    s.addLlmCall(1000, 500, "meta/llama-3.2-11b-vision-instruct");
    s.addToolCost(0.10, "exchange.swap gas");
    const b = s.breakdown();
    expect(b.llmUsd).toBeGreaterThan(0);
    expect(b.toolUsd).toBe(0.10);
    expect(s.totalUsd()).toBeCloseTo(b.llmUsd + b.toolUsd, 8);
    expect(b.toolCostCount).toBe(1);
    expect(b.llmCallCount).toBe(1);
  });

  it("silently ignores NaN / negative tool cost", () => {
    const s = new SpendTracker();
    s.addToolCost(Number.NaN, "bug");
    s.addToolCost(-5, "bug");
    expect(s.totalUsd()).toBe(0);
  });

  it("reset clears everything", () => {
    const s = new SpendTracker();
    s.addLlmCall(100, 100, "meta/llama-3.2-90b-vision-instruct");
    s.addToolCost(0.5, "x");
    s.reset();
    expect(s.totalUsd()).toBe(0);
    expect(s.breakdown().llmCallCount).toBe(0);
  });
});
