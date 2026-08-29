// ═══════════════════════════════════════════════════════════════════════
//  TierAwareLlm — LLM adapter that picks the model based on survival tier
//
//  Wraps the multi-provider router with a per-tier model preference.
//  The Fase 2 tier-cadence table already says which model each tier
//  should use — this class actually enforces it by swapping model
//  selection at call time.
//
//  Composition:
//    heartbeat.snapshot.tier
//      ↓
//    tierSelector(snapshot) → { modelName, allowFullFeatures }
//      ↓
//    router.chat({ ..., model: modelName })
//
//  With this in place, HIBERNATING agents automatically switch to the
//  cheapest model, and STABLE agents get the flagship. No wrapper
//  code needed at the loop layer.
// ═══════════════════════════════════════════════════════════════════════

import type { LlmChatClient, LlmChatResponse, LlmToolSchema } from "../agent/loop.js";
import type { TrimmableMessage } from "../agent/context-trimmer.js";
import type { SurvivalTier } from "../types.js";

export interface TierAwareLlmConfig {
  /** Callback the runtime invokes at every chat() to learn current tier. */
  readTier: () => Promise<SurvivalTier> | SurvivalTier;
  /** Per-tier provider names (must be keys the router knows). */
  providerByTier: Record<SurvivalTier, string>;
  /** The underlying providers, keyed by name. */
  providersByName: Record<string, LlmChatClient>;
}

export class TierAwareLlm implements LlmChatClient {
  constructor(private readonly cfg: TierAwareLlmConfig) {}

  async chat(params: { messages: TrimmableMessage[]; tools: LlmToolSchema[]; toolChoice: "auto" | "required" | "none"; maxTokens?: number }): Promise<LlmChatResponse> {
    const tier = await this.cfg.readTier();
    const providerName = this.cfg.providerByTier[tier];
    const provider = this.cfg.providersByName[providerName];
    if (!provider) {
      throw new Error(`TierAwareLlm: no provider registered for tier ${tier} (looked up '${providerName}')`);
    }
    return provider.chat(params);
  }
}
