// ═══════════════════════════════════════════════════════════════════════
//  registry/  —  KairosAgentRegistry on-chain identity (Fase 5)
//
//  Every Kaizen agent registers on Base 8453 in our own registry contract.
//  The chain becomes the source of truth for: which addresses are Kaizen
//  agents, their parent lineage, their constitution hash, agent-card URI.
// ═══════════════════════════════════════════════════════════════════════

import type { ModuleConfig } from "../types.js";

export interface RegistryEntry {
  agentId: string;
  address: string;               // EVM address
  parentAddress: string | null;
  constitutionSha256: string;
  agentCardUri: string;          // https://api.kairos777.com/agent-cards/<agentId>.json
  createdBlock: number;
  createdAt: number;
}

export interface AgentCard {
  agentId: string;
  displayName: string;
  createdAt: number;
  parentAgentId: string | null;
  constitutionSha256: string;
  publicCapabilities: string[];    // tool names the agent advertises
  contact: {
    inboxEndpoint?: string;        // Kairos-signed inbox URL for other agents
  };
  provenance: {
    createdBy: "kaizen-llc" | string;
    runtimeVersion: string;
  };
}

export interface AgentRegistry {
  register(entry: Omit<RegistryEntry, "createdBlock" | "createdAt">): Promise<{ txHash: string; block: number }>;
  lookup(address: string): Promise<RegistryEntry | null>;
  listChildren(parentAddress: string): Promise<RegistryEntry[]>;
  updateAgentCard(agentId: string, card: AgentCard): Promise<{ txHash: string }>;
}

// Fase 5 concrete exports
export {
  OnchainAgentRegistry,
  REGISTRY_ABI,
  KAIROS_AGENT_REGISTRY_ADDRESSES,
  registryAddressFor,
  setRegistryAddressForTests,
  type OnchainRegistryConfig,
} from "./onchain.js";

/** Fase 0 stub. */
export class NoopAgentRegistry implements AgentRegistry {
  constructor(private readonly cfg: ModuleConfig) {}
  async register(_entry: Omit<RegistryEntry, "createdBlock" | "createdAt">): Promise<{ txHash: string; block: number }> {
    throw new Error(
      `[kaizen-runtime] AgentRegistry.register() is unimplemented in Fase 0 (agent=${this.cfg.agentId}). ` +
      `Fase 5 deploys the KairosAgentRegistry contract to Base and wires this method.`,
    );
  }
  async lookup(_address: string): Promise<RegistryEntry | null> { return null; }
  async listChildren(_parentAddress: string): Promise<RegistryEntry[]> { return []; }
  async updateAgentCard(_agentId: string, _card: AgentCard): Promise<{ txHash: string }> {
    throw new Error("AgentRegistry unimplemented in Fase 0");
  }
}
