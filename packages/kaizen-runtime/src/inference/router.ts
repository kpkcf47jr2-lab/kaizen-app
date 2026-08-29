// ═══════════════════════════════════════════════════════════════════════
//  Multi-provider LLM router
//
//  Picks the best-priced healthy provider per request and falls through
//  a cascade on failure. Kaizen never dies from a single provider being
//  down or throttled.
//
//  Priority (highest first, walked on failure):
//    1. Provider marked `primary` in config (usually NIM llama-3.2-90b)
//    2. Alternate paid providers in order
//    3. Ollama local (free, always available if the host is up)
//
//  Every attempt writes to an internal health cache so consecutive
//  failures put a provider on cool-down and the router moves on.
//
//  Adapters live in ./providers/*. Each satisfies LlmChatClient from
//  ../agent/loop.ts so the router itself IS a valid LlmChatClient.
// ═══════════════════════════════════════════════════════════════════════

import type { LlmChatClient, LlmChatResponse, LlmToolSchema } from "../agent/loop.js";
import type { TrimmableMessage } from "../agent/context-trimmer.js";

export interface ProviderHandle {
  name: string;
  client: LlmChatClient;
  /** Priority — lower = tried first. */
  order: number;
  /** Rough per-turn USD estimate for planning + spend tracking. */
  approxCostUsdPerCall?: number;
  /** Whether this provider counts as "free" (Ollama, cached local models). */
  free?: boolean;
}

export interface RouterConfig {
  providers: ProviderHandle[];
  /** How long to keep a provider on cool-down after a failure (ms). */
  cooldownMs?: number;
  /** Max cascade depth per request (defensive against total outage loops). */
  maxProvidersPerRequest?: number;
}

interface ProviderHealth {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastErrorMs: number;
  lastError: string;
}

export class MultiProviderLlmRouter implements LlmChatClient {
  private readonly providers: ProviderHandle[];
  private readonly health = new Map<string, ProviderHealth>();
  private readonly cooldownMs: number;
  private readonly maxProvidersPerRequest: number;

  constructor(cfg: RouterConfig) {
    if (!cfg.providers.length) throw new Error("router requires ≥1 provider");
    this.providers = [...cfg.providers].sort((a, b) => a.order - b.order);
    this.cooldownMs = cfg.cooldownMs ?? 60_000;
    this.maxProvidersPerRequest = cfg.maxProvidersPerRequest ?? Math.max(3, this.providers.length);
    for (const p of this.providers) {
      this.health.set(p.name, { consecutiveFailures: 0, cooldownUntil: 0, lastErrorMs: 0, lastError: "" });
    }
  }

  async chat(params: { messages: TrimmableMessage[]; tools: LlmToolSchema[]; toolChoice: "auto" | "required" | "none"; maxTokens?: number }): Promise<LlmChatResponse> {
    const errors: Array<{ provider: string; message: string }> = [];
    const now = Date.now();

    // Walk the cascade in order, skipping any provider on cool-down.
    const attempted = new Set<string>();
    for (let i = 0; i < this.providers.length && attempted.size < this.maxProvidersPerRequest; i++) {
      const p = this.providers[i]!;
      const h = this.health.get(p.name)!;
      if (h.cooldownUntil > now) {
        errors.push({ provider: p.name, message: `on cool-down until ${new Date(h.cooldownUntil).toISOString()}` });
        continue;
      }
      attempted.add(p.name);
      try {
        const res = await p.client.chat(params);
        // Success: reset health.
        this.health.set(p.name, { consecutiveFailures: 0, cooldownUntil: 0, lastErrorMs: 0, lastError: "" });
        return res;
      } catch (e) {
        const msg = (e as Error).message;
        errors.push({ provider: p.name, message: msg });
        const next: ProviderHealth = {
          consecutiveFailures: h.consecutiveFailures + 1,
          lastErrorMs: Date.now(),
          lastError: msg,
          // Exponential backoff, capped by cooldownMs. 1st fail = 2s, 2nd = 4s, 3rd = 8s, ...
          cooldownUntil: Date.now() + Math.min(this.cooldownMs, 1000 * 2 ** h.consecutiveFailures),
        };
        this.health.set(p.name, next);
      }
    }

    throw new Error(`All providers failed: ${JSON.stringify(errors)}`);
  }

  /** For the owner dashboard. */
  status(): Record<string, ProviderHealth & { order: number; free: boolean }> {
    const out: Record<string, ProviderHealth & { order: number; free: boolean }> = {};
    for (const p of this.providers) {
      const h = this.health.get(p.name)!;
      out[p.name] = { ...h, order: p.order, free: !!p.free };
    }
    return out;
  }

  /** Manual reset — useful for tests or after the owner fixed an outage. */
  resetHealth(): void {
    for (const p of this.providers) {
      this.health.set(p.name, { consecutiveFailures: 0, cooldownUntil: 0, lastErrorMs: 0, lastError: "" });
    }
  }
}
