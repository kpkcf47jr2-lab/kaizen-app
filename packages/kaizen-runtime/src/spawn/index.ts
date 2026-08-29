// ═══════════════════════════════════════════════════════════════════════
//  spawn/  —  child agent creation + lineage (Fase 4)
//
//  A parent Kaizen can create children. Each child is a full Kaizen
//  instance with its own vault, its own memory, and inherits the
//  parent's constitution + PolicyEngine settings.
// ═══════════════════════════════════════════════════════════════════════

import type { ModuleConfig } from "../types.js";

export type ChildLifecycleState =
  | "PENDING"          // requested, nothing on-chain yet
  | "PROVISIONING"     // wallet derived, vault written
  | "GENESIS"          // seed capital transferred, genesis prompt loaded
  | "RUNNING"          // heartbeat armed
  | "HIBERNATING"      // temporarily paused (owner or drawdown)
  | "DEAD";            // terminated + funds swept back to parent

export interface GenesisPrompt {
  goal: string;                     // the child's mission
  strategyLabels: string[];         // strategies it may use
  budgetUsd: number;                // seed capital
  constitutionSha256: string;       // parent's constitution hash — child must match
  parentAgentId: string;
  parentAddress: string;
}

export interface ChildAgent {
  agentId: string;
  address: string;
  parentAgentId: string;
  createdAt: number;
  state: ChildLifecycleState;
  seedUsd: number;
  currentTierPeak?: string;
}

export interface Spawner {
  spawn(genesis: GenesisPrompt): Promise<ChildAgent>;
  terminate(agentId: string, reason: string): Promise<void>;
  list(parentAgentId: string): Promise<ChildAgent[]>;
}

export interface Lineage {
  ancestors(agentId: string): Promise<string[]>;
  descendants(agentId: string): Promise<string[]>;
  depth(agentId: string): Promise<number>;
}

export interface Inbox {
  send(fromAgentId: string, toAgentId: string, payload: unknown): Promise<void>;
  receive(agentId: string, sinceMs: number): Promise<Array<{ from: string; ts: number; payload: unknown }>>;
}

/** Fase 0 stub — refuses to spawn. Preserved for tests.
 *  Real impl: RealSpawner in ./spawner.js. */
export class NoopSpawner implements Spawner {
  constructor(private readonly cfg: ModuleConfig) {}
  async spawn(_genesis: GenesisPrompt): Promise<ChildAgent> {
    throw new Error(
      `[kaizen-runtime] NoopSpawner refuses (parent=${this.cfg.agentId}). ` +
      `Use RealSpawner from './spawner.js' instead.`,
    );
  }
  async terminate(): Promise<void> { throw new Error("NoopSpawner cannot terminate"); }
  async list(): Promise<ChildAgent[]> { return []; }
}

// Fase 4 concrete exports
export { RealSpawner, InMemoryChildRegistry } from "./spawner.js";
export type {
  ChildRegistry,
  ConstitutionSource,
  FundingBridge,
  RealSpawnerDeps,
  WalletProvisioner,
  SerializedGenesis,
} from "./spawner.js";
export {
  InMemoryLifecycleStore,
  canTransition,
  type LifecycleStore,
  type LifecycleTransition,
} from "./lifecycle.js";
export {
  serializeGenesis,
  hashGenesis,
  hashConstitutionBytes,
} from "./genesis.js";
export {
  InMemoryInbox,
  type InboxEntry,
  type InboxOptions,
} from "./inbox.js";
export {
  precheckSpawn,
  type ParentSpawnState,
  type SpawnPrecheck,
} from "./parent-limits.js";
