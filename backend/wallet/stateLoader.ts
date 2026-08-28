// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — AgentStateLoader implementation
//
//  Composes the Agent Registry (public identity + status) and the
//  Memory Store (rolling outflows, events) into the AgentState the
//  Secure Wallet Service and Policy Engine expect.
// ═══════════════════════════════════════════════════════════════════════

import {
  nativeBalance,
  erc20Balance,
} from "@kaizen/wallet-core";
import type { AgentRegistry } from "../../src/agent/registry.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { AgentStateLoader } from "./service.js";
import type { AgentState } from "../../src/policy/engine.js";
import { PermissionLevel } from "../../src/policy/limits.js";
import { POLYGON, USDC_POLYGON } from "./service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

export class ComposedStateLoader implements AgentStateLoader {
  constructor(
    private readonly registry: AgentRegistry,
    /** POL/USD from a price feed. MVP: hardcode; later inject a source. */
    private readonly polUsdRate: number = 0.5,
  ) {}

  async load(agentId: string): Promise<AgentState> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} not found`);

    const [usdcBal, polNative] = await Promise.all([
      erc20Balance(POLYGON, USDC_POLYGON.address, record.address),
      nativeBalance(POLYGON, record.address),
    ]);
    const cash = usdcBal.formatted;
    const gas = polNative * this.polUsdRate;
    const net = cash + gas; // MVP: no open positions tracked yet

    const mem = new MemoryStore(agentId);
    try {
      const outflow24hUsd = mem.rollingOutflow(DAY_MS);
      const outflow7dUsd = mem.rollingOutflow(WEEK_MS);
      const txCountLastHour = countEvents(mem, HOUR_MS, "transfer_out");
      const toolCallsLastMinute = countTurns(mem, MIN_MS, "assistant");

      return {
        agentId,
        netWorthUsd: net,
        cashUsd: cash,
        peakNetWorthUsd: Math.max(record.peakNetWorthUsd, net),
        openPositions: 0,
        outflow24hUsd,
        outflow7dUsd,
        txCountLastHour,
        toolCallsLastMinute,
        gpuSpend24hUsd: 0,     // filled once compute.rentGpu tool ships
        adSpend24hUsd: 0,      // filled once social.publishAd tool ships
        maxAllowedLevel: PermissionLevel.FINANCIAL,
        selfLimits: {
          // Sensible starting caps — the agent may lower these later.
          maxTxUsd: 100,
          maxTradeUsd: 100,
          maxDailyOutflowUsd: 300,
          strategyExposureCapPct: 20,
        },
      };
    } finally {
      mem.close();
    }
  }

  async recordOutflow(agentId: string, valueUsd: number): Promise<void> {
    const mem = new MemoryStore(agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "transfer_out",
        amountUsd: valueUsd,
        reason: "wallet.transfer",
      });
    } finally {
      mem.close();
    }
  }

  async recordTxHash(agentId: string, hash: string, valueUsd: number): Promise<void> {
    const mem = new MemoryStore(agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "transfer_out",
        amountUsd: valueUsd,
        txHash: hash,
        reason: "on-chain confirmed",
      });
    } finally {
      mem.close();
    }
  }
}

function countEvents(
  mem: MemoryStore,
  windowMs: number,
  kind: "transfer_out",
): number {
  const cutoff = Date.now() - windowMs;
  return mem.recentEvents(500, kind).filter((e) => e.ts >= cutoff).length;
}

function countTurns(mem: MemoryStore, windowMs: number, role: "assistant"): number {
  const cutoff = Date.now() - windowMs;
  return mem.recentTurns(500).filter((t) => t.role === role && t.ts >= cutoff).length;
}
