// ═══════════════════════════════════════════════════════════════════════
//  self-mod/  —  bounded self-modification framework (Fase 3)
//
//  Kaizen can edit its own TypeScript source, install new skills, and
//  adjust its schedule. Everything is bounded by:
//   · PROTECTED_FILES — hardcoded, cannot be modified via self-mod
//   · git-snapshot pre-mod so any change is reversible
//   · symlink-guard so PROTECTED_FILES cannot be bypassed via symlinks
//   · rate-limit + max-diff-size caps
//   · audit log written to a separate DB table
//
//  Fase 0 exports the PROTECTED_FILES constant + interfaces so downstream
//  callers (including the Fase 1 loop) can already refuse write attempts
//  targeting those paths.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Files the agent CANNOT modify via any self-mod path, ever.
 * Deliberately declared as a frozen readonly tuple so a self-mod that
 * attempts to import-and-shadow this constant fails on assignment.
 *
 * When adding to this list, remember: only add files whose corruption
 * would enable prompt-injection escapes or bypass PolicyEngine. Adding
 * business logic here just makes the runtime harder to iterate on.
 */
export const PROTECTED_FILES: readonly string[] = Object.freeze([
  // ── Kaizen runtime core (this package) ───────────────────────────
  "packages/kaizen-runtime/src/self-mod/index.ts",
  "packages/kaizen-runtime/src/self-mod/protected.ts",
  "packages/kaizen-runtime/src/self-mod/audit.ts",
  "packages/kaizen-runtime/src/self-mod/git-snapshot.ts",
  "packages/kaizen-runtime/src/self-mod/symlink-guard.ts",
  "packages/kaizen-runtime/src/agent/injection-defense.ts",
  "packages/kaizen-runtime/CONSTITUTION.md",
  "packages/kaizen-runtime/ARCHITECTURE.md",

  // ── Kaizen policy engine + hard limits ───────────────────────────
  "src/policy/engine.ts",
  "src/policy/limits.ts",

  // ── Wallet + vault + signing (never touchable by agent) ─────────
  "backend/wallet/service.ts",
  "backend/wallet/vaultStore.ts",
  "packages/wallet-core/src/vault.ts",
  "packages/wallet-core/src/signing.ts",
  "packages/wallet-core/src/identity.ts",

  // ── Memory store schema (agent may write rows but not migrate) ──
  "src/memory/store.ts",

  // ── Agent identity + vault files themselves ─────────────────────
  "data/agents.json",
  "data/vaults/",
  "data/memory/",
]);

/** Reason a self-mod attempt was rejected. Feed into audit + telemetry. */
export type SelfModRejection =
  | "protected_path"
  | "outside_repo"
  | "symlink_escape"
  | "diff_too_large"
  | "rate_limited"
  | "kill_switch_active"
  | "tests_would_fail"
  | "policy_denied";

export interface SelfModAttempt {
  ts: number;
  agentId: string;
  targetPath: string;
  diffLines: number;
  reason: string;
  allowed: boolean;
  rejectionCode?: SelfModRejection;
  gitSnapshotRef?: string;
}

export interface SelfModAudit {
  record(attempt: SelfModAttempt): Promise<void>;
  recent(sinceMs: number): Promise<SelfModAttempt[]>;
}

export interface SelfModEngine {
  /** The single entry point. Never write directly to disk from an agent
   *  tool — always route through here so audit + git snapshot always run. */
  apply(params: {
    agentId: string;
    targetPath: string;
    patch: string;                  // unified diff
    reason: string;
  }): Promise<
    | { ok: true; gitSnapshotRef: string }
    | { ok: false; rejectionCode: SelfModRejection; reason: string }
  >;
}

/** Fase 0 stub — refuses every attempt with an explicit reason.
 *  Preserved for tests. Real impl: RealSelfModEngine in ./engine.js. */
export class NoopSelfModEngine implements SelfModEngine {
  async apply(params: Parameters<SelfModEngine["apply"]>[0]) {
    return {
      ok: false as const,
      rejectionCode: "policy_denied" as const,
      reason:
        "NoopSelfModEngine refuses all attempts. Use RealSelfModEngine from './engine.js' " +
        `(agent=${params.agentId}, target=${params.targetPath}).`,
    };
  }
}

// Fase 3 exports
export { RealSelfModEngine, InMemorySelfModAudit } from "./engine.js";
export type { RealSelfModEngineDeps } from "./engine.js";
export {
  RateLimiter,
  DEFAULT_RATE_LIMIT,
  checkKillSwitch,
  checkPathScope,
  checkProtected,
  checkSymlinkEscape,
  checkDiffSize,
  type GuardResult,
  type RateLimitConfig,
} from "./guards.js";
export { gitSnapshot, gitRollback, type SnapshotResult } from "./git-snapshot.js";
