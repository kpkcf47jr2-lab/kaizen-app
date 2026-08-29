// ═══════════════════════════════════════════════════════════════════════
//  RealSelfModEngine — the one path the agent uses to change its own code
//
//  Flow:
//    1. kill switch check
//    2. path scope (must be inside repoRoot)
//    3. protected-files check
//    4. symlink escape check (re-runs 2+3 on realpath)
//    5. rate limit
//    6. diff size cap
//    7. git snapshot pre-mod
//    8. apply patch (unified diff) via `git apply --3way`
//    9. audit the attempt with rollback ref
//
//  Deliberately does NOT run tests after apply — that requires an
//  isolated sandbox that Fase 6 will add. For now the caller (typically
//  the heartbeat's self-mod task) is responsible for running tests and
//  calling gitRollback() on failure.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SelfModAudit, SelfModAttempt, SelfModEngine } from "./index.js";
import { PROTECTED_FILES } from "./index.js";
import {
  RateLimiter,
  checkDiffSize,
  checkKillSwitch,
  checkPathScope,
  checkProtected,
  checkSymlinkEscape,
} from "./guards.js";
import { gitSnapshot } from "./git-snapshot.js";

export interface RealSelfModEngineDeps {
  repoRoot: string;
  audit: SelfModAudit;
  killSwitchEnv: string;
  maxDiffLines?: number;
  rateLimiter?: RateLimiter;
  /** Extra paths to protect (merged with the hardcoded PROTECTED_FILES). */
  extraProtected?: readonly string[];
  /** Test hook — swap out `git apply` for a fake. */
  gitApplyImpl?: (repoRoot: string, patch: string, targetPath: string) => Promise<void>;
}

export class RealSelfModEngine implements SelfModEngine {
  private readonly protectedList: readonly string[];
  private readonly rate: RateLimiter;
  private readonly maxDiffLines: number;
  private readonly gitApply: NonNullable<RealSelfModEngineDeps["gitApplyImpl"]>;

  constructor(private readonly deps: RealSelfModEngineDeps) {
    this.protectedList = [...PROTECTED_FILES, ...(deps.extraProtected ?? [])];
    this.rate = deps.rateLimiter ?? new RateLimiter();
    this.maxDiffLines = deps.maxDiffLines ?? 200;
    this.gitApply = deps.gitApplyImpl ?? defaultGitApply;
  }

  async apply(params: {
    agentId: string;
    targetPath: string;
    patch: string;
    reason: string;
  }): Promise<
    | { ok: true; gitSnapshotRef: string }
    | { ok: false; rejectionCode: NonNullable<SelfModAttempt["rejectionCode"]>; reason: string }
  > {
    const attempt: SelfModAttempt = {
      ts: Date.now(),
      agentId: params.agentId,
      targetPath: params.targetPath,
      diffLines: countDiffLines(params.patch),
      reason: params.reason,
      allowed: false,
    };

    // 1. kill switch
    let g = checkKillSwitch(this.deps.killSwitchEnv);
    if (!g.ok) return this.reject(attempt, g.code, g.reason);

    // 2. path scope
    g = checkPathScope(this.deps.repoRoot, params.targetPath);
    if (!g.ok) return this.reject(attempt, g.code, g.reason);

    // 3. protected files
    g = checkProtected(this.deps.repoRoot, params.targetPath, this.protectedList);
    if (!g.ok) return this.reject(attempt, g.code, g.reason);

    // 4. symlink escape
    g = checkSymlinkEscape(this.deps.repoRoot, params.targetPath, this.protectedList);
    if (!g.ok) return this.reject(attempt, g.code, g.reason);

    // 5. rate limit
    g = this.rate.check();
    if (!g.ok) return this.reject(attempt, g.code, g.reason);

    // 6. diff size
    g = checkDiffSize(params.patch, this.maxDiffLines);
    if (!g.ok) return this.reject(attempt, g.code, g.reason);

    // 7. snapshot
    const snap = await gitSnapshot(this.deps.repoRoot);
    if (!snap.ok) {
      return this.reject(attempt, "policy_denied", `git snapshot failed: ${snap.error}`);
    }

    // 8. apply patch
    try {
      await this.gitApply(this.deps.repoRoot, params.patch, params.targetPath);
    } catch (e) {
      this.rate.recordAttempt(false);
      return this.reject(attempt, "policy_denied", `git apply failed: ${(e as Error).message}`);
    }

    // 9. success — audit + record
    this.rate.recordAttempt(true);
    attempt.allowed = true;
    attempt.gitSnapshotRef = snap.ref ?? "(clean-tree)";
    await this.deps.audit.record(attempt);
    return { ok: true, gitSnapshotRef: attempt.gitSnapshotRef };
  }

  private async reject(
    attempt: SelfModAttempt,
    code: NonNullable<SelfModAttempt["rejectionCode"]>,
    reason: string,
  ): Promise<{ ok: false; rejectionCode: NonNullable<SelfModAttempt["rejectionCode"]>; reason: string }> {
    attempt.rejectionCode = code;
    attempt.reason = `${attempt.reason} [rejected: ${reason}]`;
    // Non-success attempts also count against the failure backoff.
    this.rate.recordAttempt(false);
    await this.deps.audit.record(attempt);
    return { ok: false, rejectionCode: code, reason };
  }
}

// ── in-memory audit implementation (default) ─────────────────────────

export class InMemorySelfModAudit implements SelfModAudit {
  private readonly log: SelfModAttempt[] = [];
  async record(attempt: SelfModAttempt): Promise<void> {
    this.log.push({ ...attempt });
    if (this.log.length > 500) this.log.shift();
  }
  async recent(sinceMs: number): Promise<SelfModAttempt[]> {
    const cutoff = Date.now() - sinceMs;
    return this.log.filter((a) => a.ts >= cutoff);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function countDiffLines(patch: string): number {
  let n = 0;
  for (const line of patch.split("\n")) {
    if ((line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") && !line.startsWith("---")) n++;
  }
  return n;
}

/** Default `git apply --3way` implementation. Writes the patch to a
 *  temp file (git doesn't accept unified diff on stdin reliably across
 *  platforms) and applies it. */
async function defaultGitApply(repoRoot: string, patch: string, _targetPath: string): Promise<void> {
  const tmp = path.join(repoRoot, `.kaizen-selfmod-patch-${Date.now()}.diff`);
  await fs.writeFile(tmp, patch, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["apply", "--3way", tmp], { cwd: repoRoot });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `git apply exited ${code}`)));
      child.on("error", reject);
    });
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
