// ═══════════════════════════════════════════════════════════════════════
//  TierCadence — map SurvivalTier → cadence + model choice
//
//  Owner-tuned defaults. Adjustable at runtime via the daemon config.
// ═══════════════════════════════════════════════════════════════════════

import type { SurvivalTier } from "../types.js";

export interface TierPolicy {
  /** Base cadence between heartbeat ticks in this tier (ms). */
  intervalMs: number;
  /** Which LLM the runtime should ask the router for in this tier. */
  llmModel: string;
  /** Which non-essential task categories to skip in this tier. */
  skipCategories: readonly string[];
  /** Whether the runtime may spawn new children in this tier. */
  allowSpawn: boolean;
}

/** Defaults grounded in what we already ship:
 *   · STABLE       — full behavior, 90b model, 30s cadence.
 *   · DEFENSIVE    — draw-down 10-25%, 11b model, 60s cadence, no marketing.
 *   · CRITICAL     — draw-down 25-40%, 11b model, 180s, no marketing/no spawn.
 *   · HIBERNATING  — draw-down >40%, cheapest model, 15min cadence,
 *                    only survival tasks (funding request, health check).
 *  Numbers picked to be conservative — Fase 6 tests will tune. */
export const DEFAULT_TIER_POLICY: Record<SurvivalTier, TierPolicy> = {
  STABLE: {
    intervalMs: 30_000,
    llmModel: "meta/llama-3.2-90b-vision-instruct",
    skipCategories: [],
    allowSpawn: true,
  },
  DEFENSIVE: {
    intervalMs: 60_000,
    llmModel: "meta/llama-3.2-11b-vision-instruct",
    skipCategories: ["marketing", "experimentation"],
    allowSpawn: false,
  },
  CRITICAL: {
    intervalMs: 180_000,
    llmModel: "meta/llama-3.2-11b-vision-instruct",
    skipCategories: ["marketing", "experimentation", "commerce"],
    allowSpawn: false,
  },
  HIBERNATING: {
    intervalMs: 15 * 60_000,
    llmModel: "meta/llama-3.2-11b-vision-instruct",
    skipCategories: ["marketing", "experimentation", "commerce", "trading"],
    allowSpawn: false,
  },
} as const;

export function policyFor(tier: SurvivalTier, custom?: Partial<Record<SurvivalTier, Partial<TierPolicy>>>): TierPolicy {
  const base = DEFAULT_TIER_POLICY[tier];
  const override = custom?.[tier];
  return override ? { ...base, ...override } : base;
}
