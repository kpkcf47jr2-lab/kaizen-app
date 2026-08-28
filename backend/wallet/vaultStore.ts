// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Vault store implementation (filesystem, MVP)
//
//  One JSON file per agent under $KAIZEN_STATE_DIR/vaults/{agentId}.json.
//  Files are chmod 0600. Backup with the same permissions.
//
//  Upgrade path: swap this class for one that talks to AWS KMS,
//  Fortanix, or a hardware TPM. The rest of the code doesn't change.
// ═══════════════════════════════════════════════════════════════════════

import { promises as fs } from "node:fs";
import path from "node:path";
import type { VaultBlob } from "@kaizen/wallet-core";
import type { VaultStore } from "./service.js";

export class FileVaultStore implements VaultStore {
  private readonly dir: string;

  constructor(baseDir?: string) {
    const base = baseDir || process.env.KAIZEN_STATE_DIR || path.join(process.cwd(), "data");
    this.dir = path.join(base, "vaults");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(agentId: string): string {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(agentId)) {
      throw new Error(`Invalid agentId: ${agentId}`);
    }
    return path.join(this.dir, `${agentId}.json`);
  }

  async load(agentId: string): Promise<VaultBlob | null> {
    try {
      const raw = await fs.readFile(this.fileFor(agentId), "utf-8");
      return JSON.parse(raw) as VaultBlob;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(agentId: string, blob: VaultBlob): Promise<void> {
    await this.ensureDir();
    const file = this.fileFor(agentId);
    // Write atomically: temp file + rename. Fail-safe against half-writes.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
}
