// ═══════════════════════════════════════════════════════════════════════
//  Genesis — the initial config + goal a child inherits from its parent
//
//  A GenesisPrompt is what the parent hands to the child at birth. Once
//  written into the child's config directory, it is immutable — the
//  child can extend its own state file (SOUL.md-style) but cannot
//  rewrite the genesis.
// ═══════════════════════════════════════════════════════════════════════

import type { GenesisPrompt } from "./index.js";
import { createHash } from "node:crypto";

export interface SerializedGenesis {
  version: 1;
  agentId: string;
  parentAgentId: string;
  parentAddress: string;
  goal: string;
  strategyLabels: string[];
  budgetUsd: number;
  constitutionSha256: string;
  bornAt: number;
}

export function serializeGenesis(agentId: string, g: GenesisPrompt, now = Date.now()): SerializedGenesis {
  return {
    version: 1,
    agentId,
    parentAgentId: g.parentAgentId,
    parentAddress: g.parentAddress,
    goal: g.goal.slice(0, 4_000),
    strategyLabels: g.strategyLabels.slice(0, 16),
    budgetUsd: Math.max(0, Number(g.budgetUsd) || 0),
    constitutionSha256: g.constitutionSha256,
    bornAt: now,
  };
}

/** SHA-256 of the raw genesis for on-chain audit. */
export function hashGenesis(g: SerializedGenesis): string {
  const canonical = JSON.stringify(g, Object.keys(g).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Hash the constitution BYTES (not the file path). Used to verify a
 *  child inherited the same constitution byte-for-byte from its parent. */
export function hashConstitutionBytes(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
