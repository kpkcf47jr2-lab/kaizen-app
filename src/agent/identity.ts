// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Agent Identity
//
//  Creates a new agent: generates a mnemonic, derives its EVM address,
//  seals the mnemonic into a vault, records the identity in the agent
//  registry. The Secure Wallet Service reads from these two stores.
//
//  Called once per agent lifetime, then never again. The mnemonic is
//  never returned to the caller; only the address, agentId, and metadata.
// ═══════════════════════════════════════════════════════════════════════

import { deriveEvmAccount, newMnemonic, seal } from "@kaizen/wallet-core";
import type { VaultStore } from "../../backend/wallet/service.js";
import type { AgentRegistry, AgentRecord } from "./registry.js";

export interface CreateAgentInput {
  /** Human-friendly name shown in the dashboard. Not unique. */
  displayName: string;

  /** Optional agentId; auto-generated if omitted. Must be [a-zA-Z0-9_-]{3,64}. */
  agentId?: string;

  /** Parent agent that spawned this one, if any (Fase 3). */
  parentAgentId?: string;
}

export interface CreateAgentResult {
  agentId: string;
  address: string;         // EIP-55 checksum
  displayName: string;
  createdAt: string;       // ISO
}

export async function createAgent(
  input: CreateAgentInput,
  vaultStore: VaultStore,
  registry: AgentRegistry,
  passphrase: string,
): Promise<CreateAgentResult> {
  const agentId = input.agentId || generateAgentId();
  if (await registry.has(agentId)) {
    throw new Error(`Agent ${agentId} already exists`);
  }
  if (passphrase.length < 16) {
    throw new Error("Vault passphrase too short (need ≥16 chars).");
  }

  // 1. Generate a fresh mnemonic and derive the primary EVM account.
  const mnemonic = newMnemonic(128);
  const account = deriveEvmAccount(mnemonic);

  // 2. Seal the mnemonic into an encrypted vault blob.
  const blob = await seal(mnemonic, passphrase);
  await vaultStore.save(agentId, blob);

  // 3. Register the public identity (no secret material).
  const record: AgentRecord = {
    agentId,
    displayName: input.displayName,
    address: account.address,
    parentAgentId: input.parentAgentId ?? null,
    createdAt: new Date().toISOString(),
    status: "GROWING",       // Survival Economy default
    peakNetWorthUsd: 0,      // grows as first income arrives
  };
  await registry.upsert(record);

  return {
    agentId,
    address: account.address,
    displayName: input.displayName,
    createdAt: record.createdAt,
  };
}

/** URL-safe, 12-char, ~62 bits of entropy. */
function generateAgentId(): string {
  const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return "agt_" + Array.from(buf, (b) => alpha[b % alpha.length]).join("");
}
