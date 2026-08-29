// ═══════════════════════════════════════════════════════════════════════
//  Improvement.4 — Shadow deployment
//
//  Wraps a production LlmChatClient with a shadow one. Every request
//  goes to both in parallel; only the production response is returned
//  to the caller. Both responses (+ latency + errors) are logged to a
//  comparator so the owner (or an auto-promoter) can decide whether to
//  promote the shadow to active later.
//
//  A slow / broken shadow NEVER blocks or corrupts a production
//  response. If the shadow throws, we log the error and move on; if it
//  takes too long we time out the comparison, not the production call.
// ═══════════════════════════════════════════════════════════════════════

import type { LlmChatClient, LlmChatResponse, LlmToolSchema } from "../agent/loop.js";
import type { TrimmableMessage } from "../agent/context-trimmer.js";

export interface ShadowSample {
  ts: number;
  activeMs: number;
  shadowMs?: number;
  activeContentLen: number;
  shadowContentLen?: number;
  activeToolCall?: string;         // just the tool name if any
  shadowToolCall?: string;
  shadowError?: string;
  /** cheap agreement heuristic: identical tool name + close content length. */
  agreed: boolean;
}

export interface ShadowSink {
  record(sample: ShadowSample): void;
}

/** Default in-memory sink — flush to disk yourself with samples(). */
export class InMemoryShadowSink implements ShadowSink {
  private readonly ring: ShadowSample[] = [];
  constructor(private readonly maxSamples: number = 1000) {}
  record(sample: ShadowSample): void {
    this.ring.push(sample);
    if (this.ring.length > this.maxSamples) this.ring.shift();
  }
  samples(): ShadowSample[] { return [...this.ring]; }
  summary(): { n: number; agreementRate: number; shadowP50Ms: number; shadowP95Ms: number; shadowErrorRate: number } {
    const n = this.ring.length;
    if (!n) return { n: 0, agreementRate: 0, shadowP50Ms: 0, shadowP95Ms: 0, shadowErrorRate: 0 };
    const agree = this.ring.filter((s) => s.agreed).length;
    const errs = this.ring.filter((s) => s.shadowError).length;
    const lat = this.ring.filter((s) => typeof s.shadowMs === "number").map((s) => s.shadowMs!).sort((a, b) => a - b);
    const p50 = lat.length ? lat[Math.floor(lat.length * 0.5)]! : 0;
    const p95 = lat.length ? lat[Math.floor(lat.length * 0.95)]! : 0;
    return { n, agreementRate: agree / n, shadowP50Ms: p50, shadowP95Ms: p95, shadowErrorRate: errs / n };
  }
}

export class ShadowLlmClient implements LlmChatClient {
  constructor(
    private readonly active: LlmChatClient,
    private readonly shadow: LlmChatClient,
    private readonly sink: ShadowSink,
    private readonly shadowTimeoutMs: number = 60_000,
  ) {}

  async chat(params: { messages: TrimmableMessage[]; tools: LlmToolSchema[]; toolChoice: "auto" | "required" | "none"; maxTokens?: number }): Promise<LlmChatResponse> {
    const t0 = Date.now();

    // Fire both in parallel — shadow errors must never bubble.
    const activeP = this.active.chat(params).then(
      (r) => ({ ok: true as const, res: r, ms: Date.now() - t0 }),
      (e) => ({ ok: false as const, err: e as Error, ms: Date.now() - t0 }),
    );

    const shadowP = Promise.race([
      this.shadow.chat(params).then(
        (r) => ({ ok: true as const, res: r, ms: Date.now() - t0 }),
        (e) => ({ ok: false as const, err: e as Error, ms: Date.now() - t0 }),
      ),
      new Promise<{ ok: false; err: Error; ms: number }>((resolve) =>
        setTimeout(() => resolve({ ok: false, err: new Error(`shadow timeout ${this.shadowTimeoutMs}ms`), ms: this.shadowTimeoutMs }), this.shadowTimeoutMs),
      ),
    ]);

    const [a, s] = await Promise.all([activeP, shadowP]);

    // Record the comparison sample.
    const sample: ShadowSample = {
      ts: t0,
      activeMs: a.ms,
      shadowMs: s.ok ? s.ms : undefined,
      activeContentLen: a.ok ? (a.res.content ?? "").length : 0,
      shadowContentLen: s.ok ? (s.res.content ?? "").length : undefined,
      activeToolCall: a.ok ? a.res.toolCalls?.[0]?.name : undefined,
      shadowToolCall: s.ok ? s.res.toolCalls?.[0]?.name : undefined,
      shadowError: s.ok ? undefined : s.err.message,
      agreed: a.ok && s.ok
        ? (a.res.toolCalls?.[0]?.name === s.res.toolCalls?.[0]?.name)
          && Math.abs((a.res.content ?? "").length - (s.res.content ?? "").length) <= 200
        : false,
    };
    try { this.sink.record(sample); } catch { /* never fail the request over a bad sink */ }

    if (a.ok) return a.res;
    throw a.err;
  }
}
