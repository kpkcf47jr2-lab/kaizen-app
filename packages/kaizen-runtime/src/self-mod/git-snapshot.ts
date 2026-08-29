// ═══════════════════════════════════════════════════════════════════════
//  git-snapshot — take a reversible checkpoint before every mod
//
//  Uses `git stash create` under the hood — it captures the working
//  tree without touching the index or requiring a real commit. Returns
//  the stash SHA which the caller stores in the audit log, so any
//  future rollback is one `git stash apply <sha>` away.
// ═══════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";

export interface SnapshotResult {
  ok: boolean;
  ref?: string;
  error?: string;
}

/** Runs `git stash create` in the repo root and returns the stash SHA.
 *  If the working tree is clean, returns ok=true, ref="" — a mod of a
 *  clean tree still gets audited but with no rollback ref (since there
 *  was nothing to preserve). */
export async function gitSnapshot(repoRoot: string): Promise<SnapshotResult> {
  try {
    const out = await run("git", ["stash", "create", `kaizen-self-mod-${Date.now()}`], repoRoot);
    return { ok: true, ref: out.stdout.trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Apply a previous snapshot (rollback). */
export async function gitRollback(repoRoot: string, ref: string): Promise<SnapshotResult> {
  if (!ref) return { ok: false, error: "no ref to rollback" };
  try {
    await run("git", ["stash", "apply", ref], repoRoot);
    return { ok: true, ref };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
