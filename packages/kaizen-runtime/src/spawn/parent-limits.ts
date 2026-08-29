// ═══════════════════════════════════════════════════════════════════════
//  Parent-side spawn limits — enforce hard caps BEFORE any wallet is
//  derived or any USDC leaves the parent.
//
//  These are the ONLY numbers the caller must obey. They live here so
//  the spawn code path never accidentally bypasses them.
// ═══════════════════════════════════════════════════════════════════════

export interface ParentSpawnState {
  netWorthUsd: number;
  activeChildren: number;
  minNetWorthToSpawnUsd: number;
  maxChildAgents: number;
}

export type SpawnPrecheck =
  | { ok: true }
  | { ok: false; code: "insufficient_networth" | "child_cap_reached" | "invalid_budget" | "budget_exceeds_networth"; reason: string };

export function precheckSpawn(state: ParentSpawnState, seedBudgetUsd: number): SpawnPrecheck {
  if (!Number.isFinite(seedBudgetUsd) || seedBudgetUsd <= 0) {
    return { ok: false, code: "invalid_budget", reason: `budget ${seedBudgetUsd} must be a positive finite number` };
  }
  if (state.netWorthUsd < state.minNetWorthToSpawnUsd) {
    return {
      ok: false, code: "insufficient_networth",
      reason: `parent net worth $${state.netWorthUsd.toFixed(2)} < spawn floor $${state.minNetWorthToSpawnUsd}`,
    };
  }
  if (state.activeChildren >= state.maxChildAgents) {
    return {
      ok: false, code: "child_cap_reached",
      reason: `parent already has ${state.activeChildren} children ≥ cap ${state.maxChildAgents}`,
    };
  }
  // A child cannot be seeded with more than 25% of the parent's net worth.
  // Prevents runaway "spawn a bigger child than me" edge cases and keeps
  // parent solvency intact.
  const maxSeedUsd = state.netWorthUsd * 0.25;
  if (seedBudgetUsd > maxSeedUsd) {
    return {
      ok: false, code: "budget_exceeds_networth",
      reason: `seed $${seedBudgetUsd.toFixed(2)} > 25% of parent NAV ($${maxSeedUsd.toFixed(2)})`,
    };
  }
  return { ok: true };
}
