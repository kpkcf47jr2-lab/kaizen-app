// ═══════════════════════════════════════════════════════════════════════
//  RealSpawner — orchestrate child creation end-to-end
//
//  Flow (each step gated; failure at any step → DEAD + cleanup):
//    1. Parent-limit precheck (net worth, child cap, seed budget)
//    2. Transition PENDING → PROVISIONING
//    3. Derive child wallet + seal vault (via WalletProvisioner injected)
//    4. Copy constitution byte-for-byte + hash
//    5. Serialize + write genesis
//    6. Transition PROVISIONING → GENESIS
//    7. Fund child from parent (via injected FundingBridge)
//    8. Register in local child registry
//    9. Transition GENESIS → RUNNING
//   10. Return ChildAgent record
//
//  This class is deliberately I/O-free — it does everything via injected
//  interfaces so unit tests can drive the whole flow with fakes.
//  Wire adapter lives in kaizen-app/backend/spawner-wire.ts (Fase 7).
// ═══════════════════════════════════════════════════════════════════════

import type { ChildAgent, GenesisPrompt, Spawner } from "./index.js";
import type { ParentSpawnState } from "./parent-limits.js";
import { precheckSpawn } from "./parent-limits.js";
import { hashGenesis, serializeGenesis, type SerializedGenesis } from "./genesis.js";
import type { LifecycleStore } from "./lifecycle.js";
import { InMemoryLifecycleStore } from "./lifecycle.js";

// ── Injected primitives ──────────────────────────────────────────────

export interface WalletProvisioner {
  /** Derive + seal a fresh Kairos wallet for a new agent. Idempotent by
   *  agentId so a retry never creates two wallets for the same child. */
  provision(agentId: string): Promise<{ address: string }>;
  /** Emergency wipe of a wallet whose spawn failed mid-flight. */
  destroy(agentId: string): Promise<void>;
}

export interface FundingBridge {
  /** Move USDC from parent → child. Returns tx hash. Must use the
   *  destinationRole "agent-owned" so PolicyEngine accepts it. */
  fund(params: {
    parentAgentId: string;
    childAddress: string;
    usdc: number;
    chainId: 137 | 8453;
  }): Promise<{ txHash: string; chain: string }>;
}

export interface ChildRegistry {
  register(child: ChildAgent): Promise<void>;
  list(parentAgentId: string): Promise<ChildAgent[]>;
  get(agentId: string): Promise<ChildAgent | null>;
  update(agentId: string, patch: Partial<ChildAgent>): Promise<void>;
}

export interface ConstitutionSource {
  /** Bytes of the parent's constitution — child inherits identical. */
  readParentBytes(): Promise<string>;
  /** Persist child's constitution copy + return its sha256. */
  persistChildCopy(childAgentId: string, bytes: string): Promise<{ sha256: string }>;
}

export interface RealSpawnerDeps {
  wallets: WalletProvisioner;
  funding: FundingBridge;
  registry: ChildRegistry;
  constitution: ConstitutionSource;
  lifecycle?: LifecycleStore;
  /** How the spawner reads the parent's live spawn state (net worth,
   *  activeChildren count, HARD_LIMITS). */
  readParentState(parentAgentId: string): Promise<ParentSpawnState>;
  /** ID generator — deterministic in tests via injection. */
  newAgentId?: () => string;
  chainId?: 137 | 8453;
}

// ── Spawner ──────────────────────────────────────────────────────────

export class RealSpawner implements Spawner {
  private readonly lifecycle: LifecycleStore;
  private readonly newAgentId: () => string;
  private readonly chainId: 137 | 8453;

  constructor(private readonly deps: RealSpawnerDeps) {
    this.lifecycle = deps.lifecycle ?? new InMemoryLifecycleStore();
    this.newAgentId = deps.newAgentId ?? (() => `agt_c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.chainId = deps.chainId ?? 8453;
  }

  async spawn(genesis: GenesisPrompt): Promise<ChildAgent> {
    const parentAgentId = genesis.parentAgentId;
    if (!parentAgentId) throw new Error("genesis.parentAgentId required");

    // 1. Precheck parent state (net worth, cap, seed budget)
    const parentState = await this.deps.readParentState(parentAgentId);
    const precheck = precheckSpawn(parentState, genesis.budgetUsd);
    if (!precheck.ok) {
      throw new Error(`spawn refused: ${precheck.reason} [${precheck.code}]`);
    }

    const childAgentId = this.newAgentId();
    await this.lifecycle.transition({
      agentId: childAgentId, from: "PENDING", to: "PROVISIONING",
      ts: Date.now(), meta: { parent: parentAgentId },
    });

    // Sink for the "always cleanup on failure" idiom.
    let provisionedWallet: { address: string } | null = null;
    try {
      // 2-4. Provision wallet + copy constitution
      provisionedWallet = await this.deps.wallets.provision(childAgentId);
      const parentBytes = await this.deps.constitution.readParentBytes();
      const child = await this.deps.constitution.persistChildCopy(childAgentId, parentBytes);
      if (child.sha256 !== genesis.constitutionSha256) {
        throw new Error(
          `constitution hash drift: expected ${genesis.constitutionSha256}, got ${child.sha256}`,
        );
      }

      // 5-6. Write genesis + transition to GENESIS
      const serialized = serializeGenesis(childAgentId, genesis);
      const genesisHash = hashGenesis(serialized);
      await this.lifecycle.transition({
        agentId: childAgentId, from: "PROVISIONING", to: "GENESIS",
        ts: Date.now(),
        meta: {
          childAddress: provisionedWallet.address,
          constitutionSha256: child.sha256,
          genesisHash,
        },
      });

      // 7. Fund
      const fundRes = await this.deps.funding.fund({
        parentAgentId,
        childAddress: provisionedWallet.address,
        usdc: genesis.budgetUsd,
        chainId: this.chainId,
      });

      // 8-9. Register + transition to RUNNING
      const record: ChildAgent = {
        agentId: childAgentId,
        address: provisionedWallet.address,
        parentAgentId,
        createdAt: Date.now(),
        state: "RUNNING",
        seedUsd: genesis.budgetUsd,
      };
      await this.deps.registry.register(record);
      await this.lifecycle.transition({
        agentId: childAgentId, from: "GENESIS", to: "RUNNING",
        ts: Date.now(),
        meta: { fundingTxHash: fundRes.txHash, fundingChain: fundRes.chain },
      });

      return record;
    } catch (e) {
      // Kill switch — reversal of ALL side effects that already ran.
      const currentState = await this.lifecycle.currentState(childAgentId);
      await this.lifecycle.transition({
        agentId: childAgentId, from: currentState, to: "DEAD",
        ts: Date.now(),
        reason: `spawn failed at ${currentState}: ${(e as Error).message}`,
      });
      if (provisionedWallet) {
        // Best-effort wallet cleanup — if this ALSO fails, we log but
        // don't shadow the original error.
        await this.deps.wallets.destroy(childAgentId).catch(() => {});
      }
      throw e;
    }
  }

  async terminate(agentId: string, reason: string): Promise<void> {
    const state = await this.lifecycle.currentState(agentId);
    if (state === "DEAD") return;
    await this.lifecycle.transition({
      agentId, from: state, to: "DEAD",
      ts: Date.now(), reason,
    });
    await this.deps.registry.update(agentId, { state: "DEAD" });
  }

  async list(parentAgentId: string): Promise<ChildAgent[]> {
    return this.deps.registry.list(parentAgentId);
  }
}

// ── in-memory child registry (for tests + Fase 4 default) ────────────

export class InMemoryChildRegistry implements ChildRegistry {
  private readonly rows = new Map<string, ChildAgent>();
  async register(child: ChildAgent): Promise<void> {
    if (this.rows.has(child.agentId)) throw new Error(`child ${child.agentId} already registered`);
    this.rows.set(child.agentId, { ...child });
  }
  async list(parentAgentId: string): Promise<ChildAgent[]> {
    return [...this.rows.values()].filter((c) => c.parentAgentId === parentAgentId);
  }
  async get(agentId: string): Promise<ChildAgent | null> {
    return this.rows.get(agentId) ?? null;
  }
  async update(agentId: string, patch: Partial<ChildAgent>): Promise<void> {
    const cur = this.rows.get(agentId);
    if (!cur) throw new Error(`unknown child ${agentId}`);
    this.rows.set(agentId, { ...cur, ...patch });
  }
}

/** For consumers who want the serialized genesis object exposed. */
export type { SerializedGenesis };
