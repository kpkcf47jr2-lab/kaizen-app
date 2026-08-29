import { describe, it, expect } from "vitest";
import type { LlmChatClient, LlmChatResponse, LlmToolSchema } from "../agent/loop.js";
import type { TrimmableMessage } from "../agent/context-trimmer.js";
import { MultiProviderLlmRouter, TierAwareLlm } from "../inference/index.js";
import type { SurvivalTier } from "../types.js";

function stubProvider(name: string, mode: "ok" | "fail" | "counting"): LlmChatClient & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    async chat(_p): Promise<LlmChatResponse> {
      state.calls++;
      if (mode === "fail") throw new Error(`${name} down`);
      return {
        content: name,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, model: name },
        finishReason: "stop",
      };
    },
  } as LlmChatClient & { calls: number };
}

const params = {
  messages: [{ role: "user" as const, content: "hi" }] satisfies TrimmableMessage[],
  tools: [] satisfies LlmToolSchema[],
  toolChoice: "auto" as const,
};

describe("MultiProviderLlmRouter", () => {
  it("hits the first healthy provider", async () => {
    const p1 = stubProvider("p1", "ok");
    const p2 = stubProvider("p2", "ok");
    const r = new MultiProviderLlmRouter({
      providers: [
        { name: "p1", client: p1, order: 1 },
        { name: "p2", client: p2, order: 2 },
      ],
    });
    const res = await r.chat(params);
    expect(res.content).toBe("p1");
    expect(p1.calls).toBe(1);
    expect(p2.calls).toBe(0);
  });

  it("cascades on failure", async () => {
    const p1 = stubProvider("p1", "fail");
    const p2 = stubProvider("p2", "ok");
    const r = new MultiProviderLlmRouter({
      providers: [
        { name: "p1", client: p1, order: 1 },
        { name: "p2", client: p2, order: 2 },
      ],
    });
    const res = await r.chat(params);
    expect(res.content).toBe("p2");
    expect(p1.calls).toBe(1);
    expect(p2.calls).toBe(1);
  });

  it("puts a failing provider on cool-down", async () => {
    const p1 = stubProvider("p1", "fail");
    const p2 = stubProvider("p2", "ok");
    const r = new MultiProviderLlmRouter({
      providers: [
        { name: "p1", client: p1, order: 1 },
        { name: "p2", client: p2, order: 2 },
      ],
    });
    await r.chat(params);
    await r.chat(params);
    // Second call must skip p1 (still on cool-down) and go straight to p2.
    expect(p1.calls).toBe(1);
    expect(p2.calls).toBe(2);
  });

  it("throws when ALL providers fail", async () => {
    const p1 = stubProvider("p1", "fail");
    const p2 = stubProvider("p2", "fail");
    const r = new MultiProviderLlmRouter({
      providers: [
        { name: "p1", client: p1, order: 1 },
        { name: "p2", client: p2, order: 2 },
      ],
    });
    await expect(r.chat(params)).rejects.toThrow(/All providers failed/);
  });

  it("status() surfaces health per provider", async () => {
    const p1 = stubProvider("p1", "fail");
    const p2 = stubProvider("p2", "ok");
    const r = new MultiProviderLlmRouter({
      providers: [
        { name: "p1", client: p1, order: 1 },
        { name: "p2", client: p2, order: 2 },
      ],
    });
    await r.chat(params);
    const s = r.status();
    expect(s.p1.consecutiveFailures).toBe(1);
    expect(s.p2.consecutiveFailures).toBe(0);
  });
});

describe("TierAwareLlm", () => {
  it("picks the model per current survival tier", async () => {
    const flagship = stubProvider("flagship", "ok");
    const cheap = stubProvider("cheap", "ok");
    let tier: SurvivalTier = "STABLE";
    const t = new TierAwareLlm({
      readTier: () => tier,
      providerByTier: { STABLE: "flagship", DEFENSIVE: "cheap", CRITICAL: "cheap", HIBERNATING: "cheap" },
      providersByName: { flagship, cheap },
    });
    let r = await t.chat(params);
    expect(r.content).toBe("flagship");
    tier = "HIBERNATING";
    r = await t.chat(params);
    expect(r.content).toBe("cheap");
  });

  it("throws with a helpful message on missing provider", async () => {
    const t = new TierAwareLlm({
      readTier: () => "STABLE",
      providerByTier: { STABLE: "missing", DEFENSIVE: "x", CRITICAL: "x", HIBERNATING: "x" },
      providersByName: {},
    });
    await expect(t.chat(params)).rejects.toThrow(/no provider registered for tier STABLE/);
  });
});
