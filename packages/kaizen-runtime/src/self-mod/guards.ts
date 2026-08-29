// ═══════════════════════════════════════════════════════════════════════
//  Self-mod guards — pure functions that each check ONE invariant.
//
//  Composed by RealSelfModEngine in order of increasing cost:
//   1. kill switch env (cheapest)
//   2. path scope check (cheap string ops)
//   3. protected-files check (cheap set lookup after realpath)
//   4. symlink resolution (one syscall)
//   5. rate limit (memory)
//   6. diff size (parse the patch)
//   7. git snapshot (spawns git — expensive)
//   8. patch apply (touches disk — expensive)
//
//  Each guard returns { ok: true } or { ok: false, code, reason }. The
//  engine just short-circuits on the first non-ok.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import type { SelfModRejection } from "./index.js";

export type GuardResult =
  | { ok: true }
  | { ok: false; code: SelfModRejection; reason: string };

// ── 1. kill switch ────────────────────────────────────────────────────
export function checkKillSwitch(envVar: string): GuardResult {
  if (process.env[envVar] === "1") {
    return { ok: false, code: "kill_switch_active", reason: `${envVar}=1` };
  }
  return { ok: true };
}

// ── 2. path scope: mod must land INSIDE the repo root ────────────────
export function checkPathScope(repoRoot: string, targetPath: string): GuardResult {
  const abs = path.resolve(repoRoot, targetPath);
  const relFromRoot = path.relative(repoRoot, abs);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    return { ok: false, code: "outside_repo", reason: `${targetPath} resolves outside ${repoRoot}` };
  }
  return { ok: true };
}

// ── 3. protected files ────────────────────────────────────────────────
export function checkProtected(
  repoRoot: string,
  targetPath: string,
  protectedList: readonly string[],
): GuardResult {
  const rel = path.relative(repoRoot, path.resolve(repoRoot, targetPath));
  for (const protectedPath of protectedList) {
    // Directory match (trailing slash) — everything inside is protected.
    if (protectedPath.endsWith("/") && (rel === protectedPath.slice(0, -1) || rel.startsWith(protectedPath))) {
      return { ok: false, code: "protected_path", reason: `${rel} is inside protected dir ${protectedPath}` };
    }
    // Exact file match.
    if (rel === protectedPath) {
      return { ok: false, code: "protected_path", reason: `${rel} is protected` };
    }
  }
  return { ok: true };
}

// ── 4. symlink escape ─────────────────────────────────────────────────
// Resolves any symlink on the path and re-runs the scope + protected
// checks against the real path. Prevents the classic
//   ~/.kaizen/config.json  → /etc/passwd
// escape where the LLM creates a symlink then "modifies" it.
export function checkSymlinkEscape(
  repoRoot: string,
  targetPath: string,
  protectedList: readonly string[],
): GuardResult {
  // Resolve the repo root itself once — on macOS the tmpdir /var is a
  // symlink to /private/var, so if the caller passed the un-resolved
  // form we'd falsely flag every path in the tree as an escape.
  const rootReal = safeRealpath(repoRoot) ?? repoRoot;
  const abs = path.resolve(rootReal, targetPath);
  // Walk from the target DOWN TO repoRoot only — anything above the
  // repo root is not our concern (the repo may itself live inside a
  // symlinked mount point, which is fine).
  let cursor = abs;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor) && cursor !== rootReal && cursor.startsWith(rootReal)) {
    seen.add(cursor);
    try {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) {
        const resolved = fs.realpathSync(cursor);
        // Re-check scope + protected on the RESOLVED path (against the
        // already-resolved root so we compare apples to apples).
        const scope = checkPathScope(rootReal, resolved);
        if (!scope.ok) return { ok: false, code: "symlink_escape", reason: `${cursor} → ${resolved}: ${scope.reason}` };
        const prot = checkProtected(rootReal, path.relative(rootReal, resolved), protectedList);
        if (!prot.ok) return { ok: false, code: "symlink_escape", reason: `${cursor} → ${resolved}: ${prot.reason}` };
      }
    } catch { /* not stat-able yet — that's fine, the file doesn't exist */ }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { ok: true };
}

function safeRealpath(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

// ── 5. rate limit ─────────────────────────────────────────────────────
// Two thresholds: max mods per hour, and consecutive-failure backoff
// (each failure doubles the cooldown, up to a hard cap).
export interface RateLimitConfig {
  maxModsPerHour: number;
  hardCooldownMs: number;
}
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxModsPerHour: 6,
  hardCooldownMs: 30 * 60_000,
};

interface AttemptRecord { ts: number; ok: boolean }

export class RateLimiter {
  private readonly history: AttemptRecord[] = [];
  private consecutiveFailures = 0;
  private nextAllowedAt = 0;

  constructor(private readonly cfg: RateLimitConfig = DEFAULT_RATE_LIMIT, private readonly now: () => number = Date.now) {}

  check(): GuardResult {
    const t = this.now();
    if (t < this.nextAllowedAt) {
      const wait = Math.ceil((this.nextAllowedAt - t) / 1000);
      return { ok: false, code: "rate_limited", reason: `backoff cooldown active — retry in ${wait}s` };
    }
    // Drop entries older than 1h so the window is genuinely rolling.
    const cutoff = t - 60 * 60_000;
    while (this.history.length && this.history[0]!.ts < cutoff) this.history.shift();
    if (this.history.length >= this.cfg.maxModsPerHour) {
      return { ok: false, code: "rate_limited", reason: `${this.history.length} mods in the last hour ≥ cap ${this.cfg.maxModsPerHour}` };
    }
    return { ok: true };
  }

  recordAttempt(ok: boolean): void {
    this.history.push({ ts: this.now(), ok });
    if (ok) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures++;
      const backoff = Math.min(1000 * 2 ** this.consecutiveFailures, this.cfg.hardCooldownMs);
      this.nextAllowedAt = this.now() + backoff;
    }
  }
}

// ── 6. diff size ──────────────────────────────────────────────────────
export function checkDiffSize(patch: string, maxLines: number): GuardResult {
  if (!patch || typeof patch !== "string") {
    return { ok: false, code: "diff_too_large", reason: "empty patch" };
  }
  // Count only lines that actually add/remove code. Context lines don't
  // count against the budget so the LLM can supply full file context
  // without being penalized. Signature lines (---, +++, @@) also excluded.
  let mutations = 0;
  for (const line of patch.split("\n")) {
    if ((line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") && !line.startsWith("---")) {
      mutations++;
    }
  }
  if (mutations > maxLines) {
    return { ok: false, code: "diff_too_large", reason: `${mutations} +/- lines > cap ${maxLines}` };
  }
  return { ok: true };
}
