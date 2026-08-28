// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Auto-tick scheduler
//
//  Turns Kaizen from "click-driven" into "actually autonomous". Every
//  agent whose registry record has autoTick.enabled=true gets ticked
//  every intervalSeconds. The scheduler polls the registry every N
//  seconds (default 30) and decides who is due.
//
//  Design choices:
//   - Single in-process interval (setInterval). Not a distributed
//     scheduler — one backend process per host. Good for MVP; upgrade
//     to a queue when we run multiple agents across nodes.
//   - Ticks run sequentially per agent to avoid double-firing on the
//     same wallet. Different agents can run concurrently (up to a small
//     concurrency limit).
//   - Every tick error is logged to the agent's economic_events as a
//     policy_violation so it shows on the dashboard for the owner.
//   - Interval clamped to ≥60s. Below that, LLM cost and RPC load rise
//     fast without much value.
// ═══════════════════════════════════════════════════════════════════════

import type { AgentRegistry, AgentRecord } from "../src/agent/registry.js";
import type { DecisionLoop } from "../src/brain/decisionLoop.js";
import type { SecureWalletService } from "./wallet/service.js";
import type { AgentStateLoader } from "./wallet/service.js";
import { MemoryStore } from "../src/memory/store.js";

export interface SchedulerConfig {
  /** How often the scheduler polls the registry for due agents (seconds). */
  pollIntervalSeconds?: number;
  /** Max agents ticking in parallel (independent wallets, so safe to overlap). */
  maxConcurrent?: number;
  /** Hard floor for any per-agent interval. */
  minTickIntervalSeconds?: number;
  /** POL/USD used by the balances → snapshot pipeline. */
  polUsdRate?: number;
}

export class AutoTickScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();
  private stopping = false;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly loop: DecisionLoop,
    private readonly wallet: SecureWalletService,
    private readonly stateLoader: AgentStateLoader,
    private readonly cfg: SchedulerConfig = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const pollMs = (this.cfg.pollIntervalSeconds ?? 30) * 1000;
    console.log(`[scheduler] starting, poll every ${pollMs / 1000}s`);
    this.timer = setInterval(() => this.pollOnce().catch(this.reportError), pollMs);
    // Fire once immediately so newly-enabled agents don't wait a full poll.
    this.pollOnce().catch(this.reportError);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Wait up to 30s for in-flight ticks to finish.
    const deadline = Date.now() + 30_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private reportError = (e: unknown): void => {
    console.error("[scheduler] error:", e);
  };

  private async pollOnce(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    const minInterval = this.cfg.minTickIntervalSeconds ?? 60;
    const maxConc = this.cfg.maxConcurrent ?? 3;

    const agents = await this.registry.list();
    const due = agents.filter((a) => this.isDue(a, now, minInterval));

    for (const a of due) {
      if (this.inFlight.size >= maxConc) break;
      if (this.inFlight.has(a.agentId)) continue;
      this.inFlight.add(a.agentId);
      // fire-and-forget — errors are captured and logged per-agent
      this.tickOne(a, now).finally(() => this.inFlight.delete(a.agentId));
    }
  }

  private isDue(a: AgentRecord, now: number, minInterval: number): boolean {
    if (!a.autoTick?.enabled) return false;
    const interval = Math.max(a.autoTick.intervalSeconds, minInterval) * 1000;
    const last = a.autoTick.lastTickTs ?? 0;
    return now - last >= interval;
  }

  private async tickOne(a: AgentRecord, tickTs: number): Promise<void> {
    try {
      const balances = await this.wallet.readBalances(a.agentId);
      const agentState = await this.stateLoader.load(a.agentId);
      const result = await this.loop.tick({
        agentId: a.agentId,
        balances: {
          usdc: balances.usdc,
          pol: balances.pol,
          polUsdRate: this.cfg.polUsdRate ?? 0.5,
        },
        agentState,
      });
      console.log(
        `[scheduler] ${a.agentId} → ${result.outcome.kind}` +
          (result.outcome.kind === "tool_call" ? ` (${result.outcome.tool})` : "") +
          (result.outcome.kind === "tool_rejected" ? ` (${result.outcome.reason})` : ""),
      );
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[scheduler] ${a.agentId} tick failed:`, msg);
      const mem = new MemoryStore(a.agentId);
      try {
        mem.recordEvent({
          ts: Date.now(),
          kind: "policy_violation",
          reason: `scheduled_tick_failed: ${msg.slice(0, 240)}`,
        });
      } finally { mem.close(); }
    } finally {
      // Update lastTickTs even on failure so a broken agent doesn't hammer.
      const current = await this.registry.get(a.agentId);
      if (current?.autoTick) {
        await this.registry.updateAutoTick(a.agentId, {
          ...current.autoTick,
          lastTickTs: tickTs,
        });
      }
    }
  }
}
