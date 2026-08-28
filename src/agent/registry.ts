// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Agent Registry
//
//  Public identity + Survival Economy state per agent. NO secret
//  material here — the vault is separate (backend/wallet/vaultStore).
//
//  MVP: JSON file. Prod: Postgres or SQLite with WAL. Interface stays
//  the same, swap the impl.
// ═══════════════════════════════════════════════════════════════════════

import { promises as fs } from "node:fs";
import path from "node:path";

export type SurvivalStatus =
  | "GROWING"
  | "PROFITABLE"
  | "STABLE"
  | "DEFENSIVE"
  | "CRITICAL"
  | "HIBERNATING";

export interface AgentRecord {
  agentId: string;
  displayName: string;
  address: string;                 // EIP-55
  parentAgentId: string | null;
  createdAt: string;               // ISO
  status: SurvivalStatus;
  peakNetWorthUsd: number;
}

export interface AgentRegistry {
  has(agentId: string): Promise<boolean>;
  get(agentId: string): Promise<AgentRecord | null>;
  list(): Promise<AgentRecord[]>;
  upsert(record: AgentRecord): Promise<void>;
  updateStatus(agentId: string, status: SurvivalStatus): Promise<void>;
  updatePeak(agentId: string, peakUsd: number): Promise<void>;
}

export class FileAgentRegistry implements AgentRegistry {
  private readonly file: string;

  constructor(baseDir?: string) {
    const base = baseDir || process.env.KAIZEN_STATE_DIR || path.join(process.cwd(), "data");
    this.file = path.join(base, "agents.json");
  }

  private async readAll(): Promise<Record<string, AgentRecord>> {
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  private async writeAll(all: Record<string, AgentRecord>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async has(agentId: string): Promise<boolean> {
    const all = await this.readAll();
    return agentId in all;
  }

  async get(agentId: string): Promise<AgentRecord | null> {
    const all = await this.readAll();
    return all[agentId] ?? null;
  }

  async list(): Promise<AgentRecord[]> {
    const all = await this.readAll();
    return Object.values(all);
  }

  async upsert(record: AgentRecord): Promise<void> {
    const all = await this.readAll();
    all[record.agentId] = record;
    await this.writeAll(all);
  }

  async updateStatus(agentId: string, status: SurvivalStatus): Promise<void> {
    const all = await this.readAll();
    if (!all[agentId]) throw new Error(`Agent ${agentId} not found`);
    all[agentId].status = status;
    await this.writeAll(all);
  }

  async updatePeak(agentId: string, peakUsd: number): Promise<void> {
    const all = await this.readAll();
    if (!all[agentId]) throw new Error(`Agent ${agentId} not found`);
    if (peakUsd > all[agentId].peakNetWorthUsd) {
      all[agentId].peakNetWorthUsd = peakUsd;
      await this.writeAll(all);
    }
  }
}
