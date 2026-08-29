// ═══════════════════════════════════════════════════════════════════════
//  ChildLifecycle — state machine for spawned agents
//
//  Legal transitions (arrows only; no shortcuts allowed):
//    PENDING ──► PROVISIONING ──► GENESIS ──► RUNNING ──► HIBERNATING ──► DEAD
//                    │              │           │              │
//                    ▼              ▼           ▼              ▼
//                   DEAD           DEAD        DEAD           DEAD
//
//  Any failure at any state → DEAD with cleanup. That guarantees a
//  spawn attempt never leaves an orphaned wallet with real capital
//  and no supervisor.
// ═══════════════════════════════════════════════════════════════════════

import type { ChildLifecycleState } from "./index.js";

const NEXT: Record<ChildLifecycleState, readonly ChildLifecycleState[]> = {
  PENDING:      ["PROVISIONING", "DEAD"],
  PROVISIONING: ["GENESIS", "DEAD"],
  GENESIS:      ["RUNNING", "DEAD"],
  RUNNING:      ["HIBERNATING", "DEAD"],
  HIBERNATING:  ["RUNNING", "DEAD"],
  DEAD:         [],
};

export function canTransition(from: ChildLifecycleState, to: ChildLifecycleState): boolean {
  return NEXT[from].includes(to);
}

export interface LifecycleTransition {
  agentId: string;
  from: ChildLifecycleState;
  to: ChildLifecycleState;
  ts: number;
  reason?: string;
  /** Serialized side-effect summary for the audit log:
   *  wallet address created, USDC seeded, tx hashes, etc. */
  meta?: Record<string, unknown>;
}

export interface LifecycleStore {
  transition(t: LifecycleTransition): Promise<void>;
  currentState(agentId: string): Promise<ChildLifecycleState>;
  history(agentId: string): Promise<LifecycleTransition[]>;
}

/** In-memory default; a real store persists to SQLite. */
export class InMemoryLifecycleStore implements LifecycleStore {
  private readonly current = new Map<string, ChildLifecycleState>();
  private readonly log: LifecycleTransition[] = [];

  async transition(t: LifecycleTransition): Promise<void> {
    // 1. Detect state drift FIRST — if the caller lied about `from`,
    //    surface that specifically so the audit log carries the right
    //    signal (a drift is a bug in the caller; an illegal transition
    //    is a design-level mistake). Both throw, but with distinct msg.
    const now = await this.currentState(t.agentId);
    if (now !== "PENDING" && now !== t.from) {
      throw new Error(`state drift for ${t.agentId}: expected ${t.from}, actual ${now}`);
    }
    // 2. Then verify the transition itself is legal in the state machine.
    if (!canTransition(t.from, t.to)) {
      throw new Error(`illegal lifecycle transition ${t.from} → ${t.to} (agent=${t.agentId})`);
    }
    this.current.set(t.agentId, t.to);
    this.log.push({ ...t });
  }

  async currentState(agentId: string): Promise<ChildLifecycleState> {
    return this.current.get(agentId) ?? "PENDING";
  }

  async history(agentId: string): Promise<LifecycleTransition[]> {
    return this.log.filter((t) => t.agentId === agentId).map((t) => ({ ...t }));
  }
}
