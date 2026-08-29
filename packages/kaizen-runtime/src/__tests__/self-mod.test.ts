import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RealSelfModEngine,
  InMemorySelfModAudit,
  RateLimiter,
  checkKillSwitch,
  checkPathScope,
  checkProtected,
  checkSymlinkEscape,
  checkDiffSize,
  PROTECTED_FILES,
} from "../self-mod/index.js";

// ── Guards ───────────────────────────────────────────────────────────

describe("checkKillSwitch", () => {
  it("passes when env unset", () => {
    delete process.env.KAIZEN_KILL_TEST_A;
    expect(checkKillSwitch("KAIZEN_KILL_TEST_A").ok).toBe(true);
  });
  it("fails when env=1", () => {
    process.env.KAIZEN_KILL_TEST_A = "1";
    try {
      const r = checkKillSwitch("KAIZEN_KILL_TEST_A");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("kill_switch_active");
    } finally { delete process.env.KAIZEN_KILL_TEST_A; }
  });
});

describe("checkPathScope", () => {
  it("passes for paths inside the repo", () => {
    expect(checkPathScope("/repo", "src/foo.ts").ok).toBe(true);
    expect(checkPathScope("/repo", "./src/foo.ts").ok).toBe(true);
  });
  it("fails for ../escapes", () => {
    const r = checkPathScope("/repo", "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("outside_repo");
  });
  it("fails for absolute paths outside", () => {
    const r = checkPathScope("/repo", "/etc/passwd");
    expect(r.ok).toBe(false);
  });
});

describe("checkProtected", () => {
  it("fails on the hardcoded PROTECTED_FILES", () => {
    const r = checkProtected("/repo", "src/policy/engine.ts", PROTECTED_FILES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("protected_path");
  });
  it("fails on protected directories (trailing slash)", () => {
    const r = checkProtected("/repo", "data/vaults/x.json", PROTECTED_FILES);
    expect(r.ok).toBe(false);
  });
  it("passes on unprotected paths", () => {
    expect(checkProtected("/repo", "src/brain/economic.ts", PROTECTED_FILES).ok).toBe(true);
  });
});

// ── Symlink escape (uses real fs; scoped to a tmp dir) ───────────────

describe("checkSymlinkEscape", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kzn-selfmod-"));
    fs.mkdirSync(path.join(tmp, "safe"));
    fs.mkdirSync(path.join(tmp, "protected"));
    fs.writeFileSync(path.join(tmp, "protected", "secret.txt"), "hi");
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("passes when no symlink involved", () => {
    expect(checkSymlinkEscape(tmp, "safe/new.ts", ["protected/"]).ok).toBe(true);
  });

  it("catches a parent-dir symlink that would redirect into protected", () => {
    // safe/link → protected
    fs.symlinkSync(path.join(tmp, "protected"), path.join(tmp, "safe/link"));
    const r = checkSymlinkEscape(tmp, "safe/link/new.ts", ["protected/"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("symlink_escape");
  });
});

// ── Diff size ────────────────────────────────────────────────────────

describe("checkDiffSize", () => {
  it("counts only +/- content lines (not ---/+++ headers)", () => {
    const patch = [
      "--- a/foo",
      "+++ b/foo",
      "@@ -1,2 +1,3 @@",
      " unchanged",
      "-removed",
      "+added1",
      "+added2",
    ].join("\n");
    expect(checkDiffSize(patch, 5).ok).toBe(true);      // 3 mutations
    expect(checkDiffSize(patch, 2).ok).toBe(false);
  });
  it("fails on empty patch", () => {
    const r = checkDiffSize("", 10);
    expect(r.ok).toBe(false);
  });
});

// ── RateLimiter ──────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows up to maxModsPerHour then blocks", () => {
    let clock = 0;
    const rl = new RateLimiter({ maxModsPerHour: 2, hardCooldownMs: 60_000 }, () => clock);
    expect(rl.check().ok).toBe(true);  rl.recordAttempt(true);
    expect(rl.check().ok).toBe(true);  rl.recordAttempt(true);
    const r = rl.check();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rate_limited");
  });
  it("failures trigger exponential backoff", () => {
    let clock = 0;
    const rl = new RateLimiter({ maxModsPerHour: 100, hardCooldownMs: 60_000 }, () => clock);
    rl.recordAttempt(false);                   // 2^1 = 2s cooldown
    expect(rl.check().ok).toBe(false);
    clock += 3_000;
    expect(rl.check().ok).toBe(true);
    rl.recordAttempt(false);                   // 2^2 = 4s (or 2s consec still?)
    clock += 100;
    expect(rl.check().ok).toBe(false);
  });
  it("rolls the 1h window forward", () => {
    let clock = 0;
    const rl = new RateLimiter({ maxModsPerHour: 1, hardCooldownMs: 60_000 }, () => clock);
    rl.recordAttempt(true);
    expect(rl.check().ok).toBe(false);
    clock += 61 * 60_000;
    expect(rl.check().ok).toBe(true);
  });
});

// ── RealSelfModEngine integration (git apply mocked) ─────────────────

describe("RealSelfModEngine", () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "kzn-eng-"));
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  const makePatch = (mutations = 3) => {
    const adds = Array.from({ length: mutations }, (_, i) => `+line${i}`).join("\n");
    return `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,0 +1,${mutations} @@\n${adds}\n`;
  };

  it("rejects PROTECTED_FILES with rejectionCode=protected_path", async () => {
    const audit = new InMemorySelfModAudit();
    const eng = new RealSelfModEngine({
      repoRoot: repo,
      audit,
      killSwitchEnv: "KAIZEN_KILL_TEST_ENG",
      gitApplyImpl: async () => {},
    });
    const r = await eng.apply({
      agentId: "a", targetPath: "src/policy/engine.ts",
      patch: makePatch(), reason: "test",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejectionCode).toBe("protected_path");
    expect((await audit.recent(60_000))[0]!.allowed).toBe(false);
  });

  it("rejects when diff exceeds maxDiffLines", async () => {
    const audit = new InMemorySelfModAudit();
    const eng = new RealSelfModEngine({
      repoRoot: repo,
      audit,
      killSwitchEnv: "KAIZEN_KILL_TEST_ENG",
      maxDiffLines: 5,
      gitApplyImpl: async () => {},
    });
    const r = await eng.apply({
      agentId: "a", targetPath: "src/foo.ts",
      patch: makePatch(50), reason: "big",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejectionCode).toBe("diff_too_large");
  });

  it("rejects when kill switch is active", async () => {
    process.env.KAIZEN_KILL_TEST_ENG = "1";
    try {
      const eng = new RealSelfModEngine({
        repoRoot: repo,
        audit: new InMemorySelfModAudit(),
        killSwitchEnv: "KAIZEN_KILL_TEST_ENG",
        gitApplyImpl: async () => {},
      });
      const r = await eng.apply({
        agentId: "a", targetPath: "src/foo.ts",
        patch: makePatch(), reason: "test",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rejectionCode).toBe("kill_switch_active");
    } finally { delete process.env.KAIZEN_KILL_TEST_ENG; }
  });

  it("rejects when git apply throws (records failure, backoff)", async () => {
    // Init a minimal git repo so we get past the snapshot phase and
    // actually reach gitApplyImpl.
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "hi");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const audit = new InMemorySelfModAudit();
    const eng = new RealSelfModEngine({
      repoRoot: repo,
      audit,
      killSwitchEnv: "KAIZEN_KILL_TEST_ENG",
      gitApplyImpl: async () => { throw new Error("patch does not apply cleanly"); },
    });
    const r = await eng.apply({
      agentId: "a", targetPath: "src/new.ts",
      patch: makePatch(), reason: "will fail",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not apply cleanly/);
  });

  it("audits successful mods with gitSnapshotRef", async () => {
    // Init a real minimal git repo so gitSnapshot succeeds
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "hi");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const audit = new InMemorySelfModAudit();
    const eng = new RealSelfModEngine({
      repoRoot: repo,
      audit,
      killSwitchEnv: "KAIZEN_KILL_TEST_ENG",
      gitApplyImpl: async () => {
        // Simulate apply by writing a file so the snapshot has something.
        fs.writeFileSync(path.join(repo, "foo.ts"), "// added by test");
      },
    });
    const r = await eng.apply({
      agentId: "a", targetPath: "foo.ts",
      patch: makePatch(), reason: "add a util",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.gitSnapshotRef).toBeDefined();
    const attempt = (await audit.recent(60_000))[0]!;
    expect(attempt.allowed).toBe(true);
    expect(attempt.gitSnapshotRef).toBeDefined();
  });

  it("PROTECTED_FILES cannot be mutated even by pushing to it", () => {
    expect(Object.isFrozen(PROTECTED_FILES)).toBe(true);
    expect(() => {
      // @ts-expect-error deliberate
      PROTECTED_FILES.push("src/policy/engine.ts.evil");
    }).toThrow();
  });
});
