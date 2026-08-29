import { describe, it, expect } from "vitest";
import { ShadowLlmClient, InMemoryShadowSink } from "../improvement/shadow.js";
import type { LlmChatClient, LlmChatResponse } from "../agent/loop.js";

function fakeClient(res: Partial<LlmChatResponse>, opts: { delayMs?: number; throwErr?: string } = {}): LlmChatClient {
  return {
    async chat() {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throwErr) throw new Error(opts.throwErr);
      return { role: "assistant", content: "", toolCalls: [], ...res } as LlmChatResponse;
    },
  };
}

const emptyParams = { messages: [], tools: [], toolChoice: "auto" as const };

describe("ShadowLlmClient", () => {
  it("returns the active response unchanged", async () => {
    const active = fakeClient({ content: "hello from active" });
    const shadow = fakeClient({ content: "hello from shadow" });
    const sink = new InMemoryShadowSink();
    const c = new ShadowLlmClient(active, shadow, sink);
    const r = await c.chat(emptyParams);
    expect(r.content).toBe("hello from active");
    expect(sink.samples()).toHaveLength(1);
    expect(sink.samples()[0]!.activeContentLen).toBe("hello from active".length);
    expect(sink.samples()[0]!.shadowContentLen).toBe("hello from shadow".length);
    expect(sink.samples()[0]!.shadowError).toBeUndefined();
  });

  it("survives a shadow that throws — never breaks the active response", async () => {
    const active = fakeClient({ content: "prod ok" });
    const shadow = fakeClient({}, { throwErr: "shadow died" });
    const sink = new InMemoryShadowSink();
    const c = new ShadowLlmClient(active, shadow, sink);
    const r = await c.chat(emptyParams);
    expect(r.content).toBe("prod ok");
    expect(sink.samples()[0]!.shadowError).toBe("shadow died");
    expect(sink.samples()[0]!.agreed).toBe(false);
  });

  it("propagates active errors — shadow success does not mask them", async () => {
    const active = fakeClient({}, { throwErr: "prod down" });
    const shadow = fakeClient({ content: "shadow up" });
    const sink = new InMemoryShadowSink();
    const c = new ShadowLlmClient(active, shadow, sink);
    await expect(c.chat(emptyParams)).rejects.toThrow(/prod down/);
    // Sample is still recorded so the loss is visible.
    expect(sink.samples()).toHaveLength(1);
    expect(sink.samples()[0]!.activeContentLen).toBe(0);
    expect(sink.samples()[0]!.shadowContentLen).toBe("shadow up".length);
  });

  it("times out a hung shadow without blocking active", async () => {
    const active = fakeClient({ content: "fast" }, { delayMs: 5 });
    const shadow = fakeClient({ content: "slow" }, { delayMs: 500 });
    const sink = new InMemoryShadowSink();
    const c = new ShadowLlmClient(active, shadow, sink, /* shadowTimeoutMs */ 30);
    const t0 = Date.now();
    const r = await c.chat(emptyParams);
    const elapsed = Date.now() - t0;
    expect(r.content).toBe("fast");
    expect(elapsed).toBeLessThan(200);   // did not wait for the slow shadow
    expect(sink.samples()[0]!.shadowError).toMatch(/shadow timeout/);
  });

  it("marks agreement when tool_call names match + content length is close", async () => {
    const active = fakeClient({ content: "a".repeat(100), toolCalls: [{ id: "1", name: "wallet.swap", arguments: {} }] });
    const shadow = fakeClient({ content: "b".repeat(120), toolCalls: [{ id: "2", name: "wallet.swap", arguments: {} }] });
    const sink = new InMemoryShadowSink();
    const c = new ShadowLlmClient(active, shadow, sink);
    await c.chat(emptyParams);
    expect(sink.samples()[0]!.agreed).toBe(true);
    expect(sink.samples()[0]!.activeToolCall).toBe("wallet.swap");
    expect(sink.samples()[0]!.shadowToolCall).toBe("wallet.swap");

    // Different tool → no agreement.
    const active2 = fakeClient({ content: "x", toolCalls: [{ id: "1", name: "wallet.swap", arguments: {} }] });
    const shadow2 = fakeClient({ content: "x", toolCalls: [{ id: "2", name: "compute.rent", arguments: {} }] });
    const sink2 = new InMemoryShadowSink();
    await new ShadowLlmClient(active2, shadow2, sink2).chat(emptyParams);
    expect(sink2.samples()[0]!.agreed).toBe(false);
  });

  it("summary() reports agreement + p50/p95 + shadow error rate", async () => {
    const active = fakeClient({ content: "x" });
    const shadowOk = fakeClient({ content: "x" }, { delayMs: 10 });
    const shadowSlow = fakeClient({ content: "x" }, { delayMs: 40 });
    const shadowBroken = fakeClient({}, { throwErr: "boom" });
    const sink = new InMemoryShadowSink();
    for (const s of [shadowOk, shadowOk, shadowSlow, shadowBroken]) {
      await new ShadowLlmClient(active, s, sink).chat(emptyParams);
    }
    const sum = sink.summary();
    expect(sum.n).toBe(4);
    expect(sum.shadowErrorRate).toBeCloseTo(0.25);
    expect(sum.agreementRate).toBeCloseTo(0.75);
    expect(sum.shadowP50Ms).toBeGreaterThan(0);
  });
});
