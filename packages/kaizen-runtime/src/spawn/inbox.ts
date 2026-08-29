// ═══════════════════════════════════════════════════════════════════════
//  ParentChildInbox — asynchronous message queue between related agents
//
//  In-memory FIFO per (agentId) inbox. Fase 5+ swaps this for a shared
//  message queue backed by the on-chain registry so children can talk to
//  parents across process restarts. The interface stays.
//
//  Anti-injection: incoming messages get run through InjectionDefense
//  (source="child_message") before the receiver sees them.
// ═══════════════════════════════════════════════════════════════════════

import type { Inbox } from "./index.js";
import { InjectionDefense } from "../agent/injection-defense.js";

export interface InboxEntry {
  from: string;
  ts: number;
  payload: unknown;
}

export interface InboxOptions {
  /** Max messages per agent kept in memory. Older messages dropped. */
  perAgentCap?: number;
  /** Injection defense used to sanitize string payloads. */
  injectionDefense?: InjectionDefense;
}

export class InMemoryInbox implements Inbox {
  private readonly boxes = new Map<string, InboxEntry[]>();
  private readonly cap: number;
  private readonly defense: InjectionDefense;

  constructor(opts?: InboxOptions) {
    this.cap = opts?.perAgentCap ?? 500;
    this.defense = opts?.injectionDefense ?? new InjectionDefense();
  }

  async send(fromAgentId: string, toAgentId: string, payload: unknown): Promise<void> {
    if (fromAgentId === toAgentId) throw new Error("cannot message self");
    const sanitized = this.sanitize(payload);
    const box = this.boxes.get(toAgentId) ?? [];
    box.push({ from: fromAgentId, ts: Date.now(), payload: sanitized });
    if (box.length > this.cap) box.splice(0, box.length - this.cap);
    this.boxes.set(toAgentId, box);
  }

  async receive(agentId: string, sinceMs: number): Promise<InboxEntry[]> {
    const cutoff = Date.now() - sinceMs;
    return (this.boxes.get(agentId) ?? []).filter((e) => e.ts >= cutoff);
  }

  /** For tests + owner CLI. */
  size(agentId: string): number {
    return (this.boxes.get(agentId) ?? []).length;
  }

  private sanitize(payload: unknown): unknown {
    if (typeof payload === "string") {
      return this.defense.sanitize("child_message", payload);
    }
    if (payload && typeof payload === "object") {
      const clone: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        clone[k] = this.sanitize(v);
      }
      return clone;
    }
    return payload;
  }
}
