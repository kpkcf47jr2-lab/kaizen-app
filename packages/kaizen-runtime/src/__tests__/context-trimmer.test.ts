import { describe, it, expect } from "vitest";
import { ContextTrimmer, estimateTokens, type TrimmableMessage } from "../agent/context-trimmer.js";

describe("estimateTokens", () => {
  it("approximates 1 token ≈ 4 chars", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("hello world")).toBe(3);   // 11 chars → 3 tokens
  });
});

describe("ContextTrimmer", () => {
  it("returns messages unchanged when under budget", async () => {
    const t = new ContextTrimmer();
    const msgs: TrimmableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const out = await t.trim(msgs, 1000);
    expect(out).toBe(msgs);
  });

  it("keeps system + last hotPairs when trimming", async () => {
    const t = new ContextTrimmer({ hotPairs: 2 });
    const msgs: TrimmableMessage[] = [
      { role: "system", content: "sys prompt" },
      { role: "user", content: "old user message ".repeat(100) },
      { role: "assistant", content: "old assistant reply ".repeat(100) },
      { role: "user", content: "another old user ".repeat(100) },
      { role: "assistant", content: "another old assistant ".repeat(100) },
      { role: "user", content: "keep me A" },
      { role: "assistant", content: "keep me A reply" },
      { role: "user", content: "keep me B" },
      { role: "assistant", content: "keep me B reply" },
    ];
    const out = await t.trim(msgs, 200);   // very small budget forces trim
    // system + summary note + last 4 messages (2 pairs)
    expect(out.length).toBeLessThanOrEqual(6);
    expect((out[0] as TrimmableMessage).role).toBe("system");
    const last = out[out.length - 1] as TrimmableMessage;
    expect(last.content).toBe("keep me B reply");
  });

  it("emits a summary note when summarizeDropped=true", async () => {
    const t = new ContextTrimmer({ hotPairs: 1, summarizeDropped: true });
    const msgs: TrimmableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a".repeat(500) },
      { role: "assistant", content: "b".repeat(500) },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const out = await t.trim(msgs, 50);
    const summaryIdx = out.findIndex((m: unknown) => (m as TrimmableMessage).content?.startsWith("[context-trimmed]"));
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
  });

  it("does not add summary when summarizeDropped=false", async () => {
    const t = new ContextTrimmer({ hotPairs: 1, summarizeDropped: false });
    const msgs: TrimmableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a".repeat(500) },
      { role: "assistant", content: "b".repeat(500) },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const out = await t.trim(msgs, 50);
    expect(out.find((m: unknown) => (m as TrimmableMessage).content?.startsWith("[context-trimmed]"))).toBeUndefined();
  });
});
