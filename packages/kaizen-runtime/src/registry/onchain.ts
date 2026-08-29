// ═══════════════════════════════════════════════════════════════════════
//  Onchain KairosAgentRegistry client (ethers v6)
//
//  Talks to the immutable KairosAgentRegistry contract deployed on Base
//  (or Base Sepolia for dev). Every write is signed by the agent's own
//  wallet — the runtime derives the signer from the vault via the
//  Secure Wallet Service (kaizen-app/backend/wallet/service.ts).
// ═══════════════════════════════════════════════════════════════════════

import { Contract, JsonRpcProvider, Wallet, isHexString } from "ethers";
import type { AgentCard, AgentRegistry, RegistryEntry } from "./index.js";
import type { ModuleConfig } from "../types.js";

/** Minimal ABI — everything the runtime needs, nothing more. Kept
 *  hand-written (not generated) so a repo cloner sees exactly what
 *  calls this makes. */
export const REGISTRY_ABI = [
  "function register(address parentAddress, bytes32 constitutionSha256, string agentCardUri)",
  "function updateAgentCard(string newAgentCardUri)",
  "function isRegistered(address agent) view returns (bool)",
  "function entryOf(address agent) view returns (tuple(address parentAddress, bytes32 constitutionSha256, string agentCardUri, uint64 createdBlock, uint64 createdAt, bool exists))",
  "function childCount(address parent) view returns (uint256)",
  "function childrenOf(address parent, uint256 offset, uint256 limit) view returns (address[])",
  "function totalRegistered() view returns (uint256)",
  "event Registered(address indexed agent, address indexed parent, bytes32 indexed constitutionSha256, string agentCardUri, uint256 createdBlock, uint256 createdAt)",
  "event AgentCardUpdated(address indexed agent, string newAgentCardUri)",
] as const;

/** Deployed addresses per chain. Fase 5 shipped 2026-08-28.
 *  Update this table when redeploying (only in a new hard-fork — the
 *  contract is immutable so a new version = new address). */
export const KAIROS_AGENT_REGISTRY_ADDRESSES: Record<number, string | null> = {
  // Base mainnet — deployed 2026-08-28 from 0xCee44904…
  //   tx: 0x08386d0c8907ec1dcafde3bb9aab13c65cd7cf2d967af06386b4923dd58f5afa
  //   block: 50600316
  8453:   "0x766CdF937E43820c9332f7DAeaD6bE581BD111Ea",
  84532:  null,   // Base Sepolia (not deployed — mainnet was cheap enough)
  137:    null,   // Polygon (optional dual-deploy)
};

// ── Address book helpers ────────────────────────────────────────────

export function registryAddressFor(chainId: number): string {
  const addr = KAIROS_AGENT_REGISTRY_ADDRESSES[chainId];
  if (!addr) {
    throw new Error(
      `KairosAgentRegistry not deployed on chain ${chainId}. ` +
      `Deploy via scripts/deploy-registry.ts and set the address in registry/onchain.ts.`,
    );
  }
  return addr;
}

export function setRegistryAddressForTests(chainId: number, addr: string | null): void {
  // Only useful in unit tests + the deploy script. Never called from prod code paths.
  KAIROS_AGENT_REGISTRY_ADDRESSES[chainId] = addr;
}

// ── Onchain client ──────────────────────────────────────────────────

export interface OnchainRegistryConfig {
  chainId: number;
  rpcUrl: string;
  /** For writes: the private key derived from the agent's vault.
   *  For read-only usage: omit and no signer is created. */
  privateKey?: string;
  /** Override the well-known deployed address (tests, custom deploys). */
  registryAddress?: string;
}

export class OnchainAgentRegistry implements AgentRegistry {
  private readonly provider: JsonRpcProvider;
  private readonly contract: Contract;
  private readonly writer: Contract | null;
  private readonly signerAddress: string | null;

  constructor(private readonly cfg: OnchainRegistryConfig, private readonly _mod: ModuleConfig) {
    this.provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
    const addr = cfg.registryAddress ?? registryAddressFor(cfg.chainId);
    this.contract = new Contract(addr, REGISTRY_ABI, this.provider);
    if (cfg.privateKey) {
      const signer = new Wallet(cfg.privateKey, this.provider);
      this.writer = new Contract(addr, REGISTRY_ABI, signer);
      this.signerAddress = signer.address;
    } else {
      this.writer = null;
      this.signerAddress = null;
    }
  }

  async register(entry: Omit<RegistryEntry, "createdBlock" | "createdAt">): Promise<{ txHash: string; block: number }> {
    if (!this.writer) throw new Error("register(): no signer configured");
    if (!isHexString(entry.constitutionSha256, 32)) {
      // Accept prefixed or unprefixed 64-hex; normalize once.
      const bytes32 = entry.constitutionSha256.startsWith("0x")
        ? entry.constitutionSha256
        : "0x" + entry.constitutionSha256;
      if (!isHexString(bytes32, 32)) throw new Error("constitutionSha256 must be a 32-byte hex string");
      entry = { ...entry, constitutionSha256: bytes32 };
    }
    const tx = await this.writer.register(
      entry.parentAddress ?? "0x0000000000000000000000000000000000000000",
      entry.constitutionSha256,
      entry.agentCardUri,
    );
    const receipt = await tx.wait();
    return { txHash: tx.hash as string, block: Number(receipt.blockNumber) };
  }

  async updateAgentCard(_agentId: string, card: AgentCard): Promise<{ txHash: string }> {
    if (!this.writer) throw new Error("updateAgentCard(): no signer configured");
    const uri = `data:application/json;utf8,${encodeURIComponent(JSON.stringify(card))}`;
    // Real deploy uses https://api.kairos777.com/agent-cards/<agentId>.json — the
    // data: URI form is a fallback for tests + first-boot before the API hosts it.
    const tx = await this.writer.updateAgentCard(uri);
    return { txHash: tx.hash as string };
  }

  async lookup(address: string): Promise<RegistryEntry | null> {
    const isReg = await this.contract.isRegistered(address);
    if (!isReg) return null;
    const raw = await this.contract.entryOf(address);
    return {
      agentId: address,     // on-chain we only have the address; caller maps to agentId
      address,
      parentAddress: raw.parentAddress === "0x0000000000000000000000000000000000000000" ? null : raw.parentAddress,
      constitutionSha256: raw.constitutionSha256,
      agentCardUri: raw.agentCardUri,
      createdBlock: Number(raw.createdBlock),
      createdAt: Number(raw.createdAt),
    };
  }

  async listChildren(parentAddress: string): Promise<RegistryEntry[]> {
    const count = Number(await this.contract.childCount(parentAddress));
    if (count === 0) return [];
    // Page in chunks of 50 — plenty for any reasonable parent, but bounded.
    const CHUNK = 50;
    const out: RegistryEntry[] = [];
    for (let offset = 0; offset < count; offset += CHUNK) {
      const addrs: string[] = await this.contract.childrenOf(parentAddress, offset, CHUNK);
      for (const a of addrs) {
        const e = await this.lookup(a);
        if (e) out.push(e);
      }
    }
    return out;
  }
}
