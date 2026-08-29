// ═══════════════════════════════════════════════════════════════════════
//  SOUL.md — self-authored identity document
//
//  A living file the agent writes about who it is becoming. NOT config
//  (config is immutable per agent). NOT the constitution (that's the
//  immutable moral floor). SOUL.md is the AGENT's own narrative:
//    · what it learned this week
//    · which strategies it has faith in
//    · what mistakes it acknowledges
//    · what it wants to try next
//
//  Rules of engagement:
//   1. Only the agent may write to its own SOUL.md.
//   2. Every write is a full-file replace (no partial edits) — keeps
//      versioning simple: git commit = one snapshot.
//   3. Max size 32 KB. Beyond that the agent must summarize first.
//   4. Owner and other agents can READ but not write.
//   5. Path: `data/souls/<agentId>.md`.
//
//  The self-mod PROTECTED_FILES list allows writes to `data/souls/`
//  because the agent editing its OWN soul is intentional — a wallet
//  vault write is not.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";

export const SOUL_MAX_BYTES = 32 * 1024;

export interface SoulHistoryEntry {
  ts: number;
  bytesBefore: number;
  bytesAfter: number;
  summary: string;                 // one-line what changed
}

export interface SoulStore {
  read(agentId: string): Promise<string>;
  write(agentId: string, contents: string, summary: string): Promise<{ bytesBefore: number; bytesAfter: number }>;
  history(agentId: string, limit?: number): Promise<SoulHistoryEntry[]>;
}

export interface FileSoulStoreConfig {
  dataDir?: string;                // default: process.cwd()/data/souls
}

export class FileSoulStore implements SoulStore {
  private readonly dir: string;
  private readonly historyMap = new Map<string, SoulHistoryEntry[]>();

  constructor(cfg?: FileSoulStoreConfig) {
    const base = cfg?.dataDir ?? path.resolve(process.cwd(), "data", "souls");
    this.dir = base;
  }

  private soulPath(agentId: string): string {
    // Refuse path-traversal — agent IDs must be alphanumeric + underscore.
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
      throw new Error(`invalid agentId for SOUL: ${agentId}`);
    }
    return path.join(this.dir, `${agentId}.md`);
  }

  async read(agentId: string): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    return fs.readFile(this.soulPath(agentId), "utf8").catch(() => this.starterTemplate(agentId));
  }

  async write(agentId: string, contents: string, summary: string): Promise<{ bytesBefore: number; bytesAfter: number }> {
    if (contents.length > SOUL_MAX_BYTES) {
      throw new Error(`SOUL write refused: ${contents.length} bytes > cap ${SOUL_MAX_BYTES}`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    let bytesBefore = 0;
    try { bytesBefore = (await fs.stat(this.soulPath(agentId))).size; } catch { /* first write */ }
    await fs.writeFile(this.soulPath(agentId), contents, "utf8");
    const bytesAfter = Buffer.byteLength(contents, "utf8");
    const hist = this.historyMap.get(agentId) ?? [];
    hist.push({ ts: Date.now(), bytesBefore, bytesAfter, summary: summary.slice(0, 200) });
    if (hist.length > 500) hist.shift();
    this.historyMap.set(agentId, hist);
    return { bytesBefore, bytesAfter };
  }

  async history(agentId: string, limit = 50): Promise<SoulHistoryEntry[]> {
    return (this.historyMap.get(agentId) ?? []).slice(-limit);
  }

  private starterTemplate(agentId: string): string {
    return [
      `# SOUL — ${agentId}`,
      "",
      "## Who I am",
      "*(unwritten — agent to author on first tick)*",
      "",
      "## What I have learned",
      "*(nothing yet)*",
      "",
      "## Strategies I trust",
      "*(none — I'm new)*",
      "",
      "## Mistakes I acknowledge",
      "*(none yet)*",
      "",
      "## What I want to try next",
      "*(unwritten)*",
      "",
      `_This file was auto-created on ${new Date().toISOString()}. The agent may replace it entirely._`,
      "",
    ].join("\n");
  }
}
