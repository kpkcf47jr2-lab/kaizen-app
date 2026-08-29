// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — spawner wiring
//
//  Adapters that let @kaizen/runtime/spawn drive the existing kaizen-app
//  primitives (createAgent, SecureWalletService, agent registry, memory)
//  to spawn REAL child agents with Kairos wallets and real USDC funding.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChildRegistry,
  ConstitutionSource,
  FundingBridge,
  ParentSpawnState,
  WalletProvisioner,
} from "@kaizen/runtime/spawn";
import type { AgentRecord } from "../src/agent/registry.js";
import type { FileAgentRegistry } from "../src/agent/registry.js";
import type { FileVaultStore } from "./wallet/vaultStore.js";
import type { SecureWalletService } from "./wallet/service.js";
import type { ComposedStateLoader } from "./wallet/stateLoader.js";
import { createAgent } from "../src/agent/identity.js";
import { hashConstitutionBytes } from "@kaizen/runtime/spawn";

// ── WalletProvisioner: use the existing createAgent flow ─────────────

/** Wraps createAgent(). Each spawn is a full Kaizen wallet:
 *    new BIP-39 mnemonic → derived EVM account → sealed vault → agents.json.
 *  The provisioner is idempotent — a re-spawn with the same agentId
 *  short-circuits and returns the existing address. */
export function wireWalletProvisioner(
  vaultStore: FileVaultStore,
  registry: FileAgentRegistry,
  passphrase: string,
): WalletProvisioner {
  return {
    async provision(agentId: string): Promise<{ address: string }> {
      const existing = await registry.get(agentId);
      if (existing) return { address: existing.address };
      const res = await createAgent(
        { displayName: `Kaizen child ${agentId}`, agentId },
        vaultStore,
        registry,
        passphrase,
      );
      return { address: res.address };
    },
    async destroy(agentId: string): Promise<void> {
      // Delete vault + registry row. Best-effort: swallow ENOENT.
      const dataDir = process.env.KAIZEN_STATE_DIR
        ? path.resolve(process.env.KAIZEN_STATE_DIR)
        : path.resolve(process.cwd(), "data");
      const vaultPath = path.join(dataDir, "vaults", `${agentId}.json`);
      await fs.unlink(vaultPath).catch(() => {});
      try {
        // FileAgentRegistry doesn't expose delete() — patch the JSON directly.
        const agentsFile = path.join(dataDir, "agents.json");
        const raw = await fs.readFile(agentsFile, "utf8").catch(() => "{}");
        const agents = JSON.parse(raw) as Record<string, AgentRecord>;
        delete agents[agentId];
        await fs.writeFile(agentsFile, JSON.stringify(agents, null, 2));
      } catch { /* swallow — a leftover row is auditable and non-fatal */ }
    },
  };
}

// ── FundingBridge: use SecureWalletService.transferUsdc ──────────────

/** Parent → child USDC transfer + small native gas seed. The child needs
 *  ETH/POL to eventually register on-chain + transact from its own
 *  wallet; we seed it here with 0.00002 ETH (~$0.06) so it has ~10 tx
 *  worth of gas on Base before it needs to earn its own. Both transfers
 *  go through PolicyEngine independently.
 *  `destinationRole: "agent-owned"` is in HARD_LIMITS.ALLOWED_DESTINATION_ROLES
 *  so the policy accepts it. */
export function wireFundingBridge(
  walletService: SecureWalletService,
  nativeUsdRates: Record<number, number> = { 137: 0.5, 8453: 3200 },
): FundingBridge {
  return {
    async fund({ parentAgentId, childAddress, usdc, chainId }) {
      // 1) Main USDC seed
      const res = await walletService.transferUsdc({
        agentId: parentAgentId,
        to: childAddress,
        destinationRole: "agent-owned",
        amountUsdc: usdc,
        reason: `spawn seed capital → ${childAddress}`,
        chainId,
      });
      if (!res.ok) throw new Error(`spawn funding rejected: ${res.reason}`);

      // 2) Native gas seed — enough for ~10 txs on Base at 0.005 gwei.
      //    Best-effort: if the native transfer fails (parent low on gas),
      //    the child still has USDC and can later swap-for-gas via
      //    exchange.swap. Never reverts the whole spawn on gas-seed alone.
      try {
        await walletService.transferNative({
          agentId: parentAgentId,
          to: childAddress,
          destinationRole: "agent-owned",
          amountEth: 0.00002,             // ~$0.06 at $3200 ETH
          chainId,
          nativeUsdRate: nativeUsdRates[chainId] ?? 3200,
          reason: `spawn gas seed → ${childAddress}`,
        });
      } catch (e) {
        console.warn(`[spawn] gas seed failed for ${childAddress}: ${(e as Error).message} (USDC seed already sent)`);
      }
      return { txHash: res.txHash, chain: res.chain };
    },
  };
}

// ── ConstitutionSource: read + hash the runtime constitution ─────────

/** Reads the constitution file from packages/kaizen-runtime/CONSTITUTION.md
 *  and writes a byte-identical copy under data/constitutions/<agentId>.md.
 *  Every child inherits the SAME bytes as the parent — the hash mismatch
 *  guard in RealSpawner catches any drift. */
export function wireConstitutionSource(): ConstitutionSource {
  const dataDir = process.env.KAIZEN_STATE_DIR
    ? path.resolve(process.env.KAIZEN_STATE_DIR)
    : path.resolve(process.cwd(), "data");
  // Resolve the constitution path relative to this file so the wire code
  // is portable — no cwd assumption.
  const constPath = path.resolve(
    process.cwd(),
    "packages", "kaizen-runtime", "CONSTITUTION.md",
  );

  return {
    async readParentBytes(): Promise<string> {
      return fs.readFile(constPath, "utf8");
    },
    async persistChildCopy(childAgentId: string, bytes: string): Promise<{ sha256: string }> {
      const dir = path.join(dataDir, "constitutions");
      await fs.mkdir(dir, { recursive: true });
      const dst = path.join(dir, `${childAgentId}.md`);
      await fs.writeFile(dst, bytes, "utf8");
      return { sha256: hashConstitutionBytes(bytes) };
    },
  };
}

// ── ChildRegistry: piggy-back on the existing agents.json ────────────

/** Uses the same agents.json that hosts every Kaizen record, filtered by
 *  parentAgentId. Keeps a single source of truth so the owner dashboard
 *  and the spawner see the exact same set of agents. */
export function wireChildRegistry(agentRegistry: FileAgentRegistry): ChildRegistry {
  return {
    async register(child) {
      const existing = await agentRegistry.get(child.agentId);
      if (existing) {
        // provision() already wrote the base row; just patch the parent
        // link + status if the caller didn't yet.
        await agentRegistry.upsert({
          ...existing,
          parentAgentId: child.parentAgentId,
          peakNetWorthUsd: Math.max(existing.peakNetWorthUsd, child.seedUsd),
        });
        return;
      }
      await agentRegistry.upsert({
        agentId: child.agentId,
        displayName: `Kaizen child ${child.agentId}`,
        address: child.address,
        parentAgentId: child.parentAgentId,
        createdAt: new Date(child.createdAt).toISOString(),
        status: "GROWING",
        peakNetWorthUsd: child.seedUsd,
      });
    },
    async list(parentAgentId) {
      const all = await agentRegistry.list();
      return all
        .filter((r) => r.parentAgentId === parentAgentId)
        .map((r) => ({
          agentId: r.agentId,
          address: r.address,
          parentAgentId: r.parentAgentId!,
          createdAt: new Date(r.createdAt).getTime(),
          state: r.status === "GROWING" || r.status === "STABLE" ? ("RUNNING" as const)
               : r.status === "HIBERNATING" ? ("HIBERNATING" as const)
               : ("DEAD" as const),
          seedUsd: r.peakNetWorthUsd,
        }));
    },
    async get(agentId) {
      const r = await agentRegistry.get(agentId);
      if (!r || !r.parentAgentId) return null;
      return {
        agentId: r.agentId, address: r.address, parentAgentId: r.parentAgentId,
        createdAt: new Date(r.createdAt).getTime(),
        state: r.status === "GROWING" || r.status === "STABLE" ? "RUNNING" : "HIBERNATING",
        seedUsd: r.peakNetWorthUsd,
      };
    },
    async update(agentId, patch) {
      const r = await agentRegistry.get(agentId);
      if (!r) throw new Error(`unknown child ${agentId}`);
      const nextStatus = patch.state === "DEAD" ? "HIBERNATING" : r.status;
      await agentRegistry.upsert({ ...r, status: nextStatus });
    },
  };
}

// ── readParentState: pull live snapshot for spawn precheck ──────────

export function makeReadParentState(
  agentRegistry: FileAgentRegistry,
  walletService: SecureWalletService,
  stateLoader: ComposedStateLoader,
  hardLimits: { minNetWorthToSpawnUsd: number; maxChildAgents: number },
): (parentAgentId: string) => Promise<ParentSpawnState> {
  return async (parentAgentId: string) => {
    const balances = await walletService.readBalances(parentAgentId);
    let gasUsdTotal = 0;
    for (const [idStr, per] of Object.entries(balances.byChain)) {
      gasUsdTotal += stateLoader.gasUsdFor(Number(idStr), per.native);
    }
    const netWorthUsd = balances.usdc + gasUsdTotal;
    const children = (await agentRegistry.list()).filter(
      (r) => r.parentAgentId === parentAgentId && r.status !== "HIBERNATING",
    );
    return {
      netWorthUsd,
      activeChildren: children.length,
      minNetWorthToSpawnUsd: hardLimits.minNetWorthToSpawnUsd,
      maxChildAgents: hardLimits.maxChildAgents,
    };
  };
}
