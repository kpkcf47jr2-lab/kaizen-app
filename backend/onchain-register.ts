// ═══════════════════════════════════════════════════════════════════════
//  On-chain self-registration for spawned children
//
//  Given a child agentId, opens its vault, derives its private key, and
//  calls KairosAgentRegistry.register() from the CHILD's own wallet.
//  This is the last step of "birth": after gas is seeded, the child
//  writes itself into the chain-of-truth. From then on any owner or
//  parent can discover it by scanning `childrenOf(parent)` in the
//  contract.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import type { FileVaultStore } from "./wallet/vaultStore.js";
import type { FileAgentRegistry } from "../src/agent/registry.js";
import {
  deriveEvmAccount,
  open as openVault,
} from "@kaizen/wallet-core";
import {
  OnchainAgentRegistry,
  hashConstitutionBytes,
} from "@kaizen/runtime";

export interface AutoRegisterParams {
  childAgentId: string;
  chainId: 137 | 8453;
  rpcUrl: string;
  agentCardUri?: string;
}

export interface AutoRegisterResult {
  ok: boolean;
  txHash?: string;
  block?: number;
  reason?: string;
  alreadyRegistered?: boolean;
}

export function makeAutoRegister(
  vaultStore: FileVaultStore,
  registry: FileAgentRegistry,
  passphrase: string,
): (p: AutoRegisterParams) => Promise<AutoRegisterResult> {
  return async ({ childAgentId, chainId, rpcUrl, agentCardUri }) => {
    const childRec = await registry.get(childAgentId);
    if (!childRec) return { ok: false, reason: `agent ${childAgentId} not found` };
    if (!childRec.parentAgentId) {
      return { ok: false, reason: "auto-register is for CHILD agents (need parentAgentId)" };
    }
    const parentRec = await registry.get(childRec.parentAgentId);
    if (!parentRec) return { ok: false, reason: `parent ${childRec.parentAgentId} not found` };

    // Read constitution + hash — must match what the spawner promised.
    const constPath = path.resolve(process.cwd(),
      "packages", "kaizen-runtime", "CONSTITUTION.md");
    const constitutionSha256 = "0x" + hashConstitutionBytes(await fs.readFile(constPath, "utf8"));

    // Open child's vault + derive private key.
    const blob = await vaultStore.load(childAgentId);
    if (!blob) return { ok: false, reason: `no vault for ${childAgentId}` };
    const mnemonic = await openVault(blob, passphrase);
    const account = deriveEvmAccount(mnemonic);

    // Prod agent-card URI defaults to the Kairos hosted path. Callers
    // can override for tests. Data-URI fallback lands as text on-chain.
    const cardUri = agentCardUri
      ?? `https://api.kairos777.com/agent-cards/${childAgentId}.json`;

    const onchain = new OnchainAgentRegistry(
      { chainId, rpcUrl, privateKey: account.privateKey },
      { agentId: childAgentId, runtimeVersion: "0.1.0-alpha.0",
        readOnly: false, killSwitchEnv: "KAIZEN_KILL" },
    );

    // Idempotence: don't re-register.
    const existing = await onchain.lookup(childRec.address);
    if (existing) return { ok: true, alreadyRegistered: true };

    try {
      const { txHash, block } = await onchain.register({
        agentId: childAgentId,
        address: childRec.address,
        parentAddress: parentRec.address,
        constitutionSha256,
        agentCardUri: cardUri,
      });
      return { ok: true, txHash, block };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  };
}
