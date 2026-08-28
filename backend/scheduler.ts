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
import { evaluateExit } from "../src/brain/exitRules.js";

export interface SchedulerConfig {
  /** How often the scheduler polls the registry for due agents (seconds). */
  pollIntervalSeconds?: number;
  /** Max agents ticking in parallel (independent wallets, so safe to overlap). */
  maxConcurrent?: number;
  /** Hard floor for any per-agent interval. */
  minTickIntervalSeconds?: number;
  /** DEPRECATED, kept for backwards compat — use nativeUsdRates instead. */
  polUsdRate?: number;
  /** Per-chain native USD rate map. Multiplied by on-chain native to get
   *  gasReserveUsd in the snapshot. Without it, ETH on Base would be
   *  priced as POL and the LLM would think it has $0 gas. */
  nativeUsdRates?: Record<number, number>;
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

    // 1. Auto-close pass — cheap, no LLM. Runs every poll for every agent
    //    whose auto-tick is enabled. Skips agents with no open positions.
    for (const a of agents) {
      if (!a.autoTick?.enabled) continue;
      try {
        await this.autoCloseIfTriggered(a.agentId);
      } catch (err) {
        console.error(`[scheduler] ${a.agentId} auto-close pass failed:`, (err as Error).message);
      }
    }

    // 2. LLM tick pass — only for agents whose interval has elapsed.
    const due = agents.filter((a) => this.isDue(a, now, minInterval));
    for (const a of due) {
      if (this.inFlight.size >= maxConc) break;
      if (this.inFlight.has(a.agentId)) continue;
      this.inFlight.add(a.agentId);
      // fire-and-forget — errors are captured and logged per-agent
      this.tickOne(a, now).finally(() => this.inFlight.delete(a.agentId));
    }
  }

  /**
   * For each open position with exit rules attached, mark-to-market via a
   * quote call and check if any rule triggers. If so, record trade_close +
   * emit an event; the actual sell-side swap is handled by the LLM next
   * tick (it sees the closed position + queued swap intent). This keeps
   * the auto-close side-effect-free at the on-chain level — no gas spent
   * from the scheduler thread, only DB writes.
   *
   * MVP simplification: we don't have a live mark-to-market oracle yet.
   * We can only fire trailing-stop watermark updates using the entry as
   * current (no-op) OR we can trust the LLM to close on the next tick
   * when it sees the rule was set. When exchange.quote or a price feed
   * is wired in, this method actually starts closing positions.
   */
  private async autoCloseIfTriggered(agentId: string): Promise<void> {
    const mem = new MemoryStore(agentId);
    try {
      const open = mem.openPositions();
      for (const p of open) {
        if (!p.id) continue;
        const rules = mem.getExitRules(p.id);
        if (!rules) continue;
        // Placeholder mark: entryUsd (no price feed yet). Will not trigger
        // TP/SL, only tracks watermark once we have live pricing.
        const currentUsd = p.entryUsd;
        const decision = evaluateExit(p.entryUsd, currentUsd, rules);
        if (decision.newHighWatermark !== null) {
          mem.updateHighWatermark(p.id, decision.newHighWatermark);
        }
        if (decision.shouldClose) {
          console.log(
            `[scheduler] ${agentId} auto-close position ${p.id}: ${decision.reason}`,
          );
          mem.recordEvent({
            ts: Date.now(),
            kind: "policy_violation", // TODO: add "auto_exit_triggered" kind after schema migration
            reason: `auto_exit: ${decision.reason}`,
            metadata: JSON.stringify({ positionId: p.id, triggered: decision.triggered }),
          });
          // NOTE: actual position close happens next LLM tick. We flag it in
          // the ledger so the LLM's briefing surfaces the intent.
        }
      }
    } finally { mem.close(); }
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
      // Sum native × per-chain rate. Falls back to legacy polUsdRate if no
      // map given (single-chain agents from before Base was whitelisted).
      const rates = this.cfg.nativeUsdRates
        ?? { 137: this.cfg.polUsdRate ?? 0.5, 8453: 3200 };
      let gasUsdTotal = 0;
      for (const [idStr, per] of Object.entries(balances.byChain || {})) {
        gasUsdTotal += per.native * (rates[Number(idStr)] ?? 0);
      }
      const result = await this.loop.tick({
        agentId: a.agentId,
        balances: {
          usdc: balances.usdc,
          pol: gasUsdTotal,
          polUsdRate: 1,
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
