// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Policy Engine
//
//  Every tool call flows through this before the executor runs it.
//  The engine checks:
//    1. Absolute prohibitions
//    2. Permission level ≤ agent's max level
//    3. Rate limits
//    4. Hard limits (per-tx caps, daily/weekly outflow, drawdown)
//    5. Destination whitelist for transfers
//    6. Compliance module (CTR/SAR triggers)
//
//  Never LLM → tx. Always LLM → tool intent → Policy Engine → Executor.
// ═══════════════════════════════════════════════════════════════════════

import {
  HARD_LIMITS,
  PermissionLevel,
  DEFAULT_AGENT_MAX_LEVEL,
  type PolicyDecision,
} from './limits.js';

export interface AgentState {
  agentId: string;
  netWorthUsd: number;
  cashUsd: number;
  peakNetWorthUsd: number;      // rolling all-time peak for drawdown calc
  openPositions: number;
  outflow24hUsd: number;
  outflow7dUsd: number;
  txCountLastHour: number;
  toolCallsLastMinute: number;
  gpuSpend24hUsd: number;
  adSpend24hUsd: number;
  maxAllowedLevel: PermissionLevel;
  selfLimits: SelfLimits;
}

/** Agent-mutable limits — always must satisfy: self <= HARD. */
export interface SelfLimits {
  maxTxUsd: number;
  maxTradeUsd: number;
  maxDailyOutflowUsd: number;
  strategyExposureCapPct: number;
}

export interface ToolIntent {
  tool: string;                  // e.g. "wallet.transfer"
  level: PermissionLevel;
  valueUsd?: number;             // if it moves value
  destinationRole?: string;      // if it's an on-chain call to a specific role
  chainId?: number;              // if on-chain
  category?: string;             // for absolute-prohibition matching
  metadata?: Record<string, unknown>;
}

export class PolicyEngine {
  private violationLog: Array<{ ts: number; intent: ToolIntent; reason: string }> = [];

  evaluate(agent: AgentState, intent: ToolIntent): PolicyDecision {
    // 1. Absolute prohibitions — checked first, never overridable.
    if (intent.category && (HARD_LIMITS.ABSOLUTE_PROHIBITIONS as readonly string[]).includes(intent.category)) {
      return this.reject(intent, `Absolute prohibition: ${intent.category}`, 'critical');
    }

    // 2. Permission level
    if (intent.level > agent.maxAllowedLevel) {
      return this.reject(
        intent,
        `Level ${intent.level} exceeds agent max ${agent.maxAllowedLevel}`,
        'warn',
      );
    }

    // 3. Rate limits
    if (agent.toolCallsLastMinute >= HARD_LIMITS.MAX_TOOL_CALLS_PER_MINUTE) {
      return this.reject(intent, 'Tool-call rate limit exceeded', 'warn');
    }

    // 4. Chain whitelist for any on-chain intent
    if (intent.chainId !== undefined && !(HARD_LIMITS.ALLOWED_CHAINS as readonly number[]).includes(intent.chainId)) {
      return this.reject(intent, `Chain ${intent.chainId} not whitelisted`, 'critical');
    }

    // 5. Transfer-specific checks
    if (this.isTransferOrTrade(intent)) {
      const value = intent.valueUsd ?? 0;

      // 5a. Destination role whitelist
      if (intent.destinationRole !== undefined &&
          !(HARD_LIMITS.ALLOWED_DESTINATION_ROLES as readonly string[]).includes(intent.destinationRole)) {
        return this.reject(intent, `Destination role "${intent.destinationRole}" not whitelisted`, 'critical');
      }

      // 5b. Per-tx cap (min of hard limit and self limit)
      const perTxCap = intent.tool === 'exchange.swap' ? HARD_LIMITS.MAX_TRADE_USD : HARD_LIMITS.MAX_TX_USD;
      const selfTxCap = intent.tool === 'exchange.swap' ? agent.selfLimits.maxTradeUsd : agent.selfLimits.maxTxUsd;
      const effectiveCap = Math.min(perTxCap, selfTxCap);
      if (value > effectiveCap) {
        return this.reject(intent, `Value $${value} exceeds per-tx cap $${effectiveCap}`, 'warn');
      }

      // 5c. Rolling outflow caps (only outbound tx count as outflow)
      if (this.isOutflow(intent)) {
        if (agent.txCountLastHour >= HARD_LIMITS.MAX_TX_PER_HOUR) {
          return this.reject(intent, 'Hourly tx count exceeded', 'warn');
        }
        if (agent.outflow24hUsd + value > Math.min(HARD_LIMITS.MAX_DAILY_OUTFLOW_USD, agent.selfLimits.maxDailyOutflowUsd)) {
          return this.reject(intent, 'Daily outflow cap would be exceeded', 'warn');
        }
        if (agent.outflow7dUsd + value > HARD_LIMITS.MAX_WEEKLY_OUTFLOW_USD) {
          return this.reject(intent, 'Weekly outflow cap would be exceeded', 'warn');
        }
      }
    }

    // 6. Drawdown state — reject expensive ops if below HIBERNATE threshold
    const drawdownPct = this.drawdown(agent);
    if (drawdownPct >= HARD_LIMITS.HIBERNATE_DRAWDOWN_PCT && intent.level >= PermissionLevel.MICRO_TX) {
      return this.reject(intent, `Agent in HIBERNATION (drawdown ${drawdownPct.toFixed(1)}%) — no costly operations`, 'critical');
    }

    // 7. Trading-specific: check strategy exposure cap
    if (intent.tool === 'exchange.swap' && intent.metadata?.strategyExposureUsd !== undefined) {
      const exposure = intent.metadata.strategyExposureUsd as number;
      const capUsd = agent.netWorthUsd * (agent.selfLimits.strategyExposureCapPct / 100);
      if (exposure > capUsd) {
        return this.reject(intent, `Strategy exposure $${exposure} exceeds ${agent.selfLimits.strategyExposureCapPct}% of NAV`, 'warn');
      }
    }

    // 8. Ad spend caps
    if (intent.tool === 'social.publishAd') {
      const value = intent.valueUsd ?? 0;
      if (value > HARD_LIMITS.MAX_AD_SPEND_PER_CREATIVE_USD) {
        return this.reject(intent, `Ad spend $${value} exceeds per-creative cap`, 'warn');
      }
      if (agent.adSpend24hUsd + value > HARD_LIMITS.MAX_DAILY_MARKETING_USD) {
        return this.reject(intent, 'Daily marketing cap would be exceeded', 'warn');
      }
    }

    // 9. Compute spend caps
    if (intent.tool === 'compute.rentGpu') {
      const hourly = (intent.metadata?.hourlyUsd as number | undefined) ?? 0;
      if (hourly > HARD_LIMITS.MAX_GPU_HOURLY_USD) {
        return this.reject(intent, `GPU rate $${hourly}/h exceeds hourly cap`, 'warn');
      }
      if (agent.gpuSpend24hUsd + (intent.valueUsd ?? 0) > HARD_LIMITS.MAX_GPU_DAILY_USD) {
        return this.reject(intent, 'Daily GPU spend cap would be exceeded', 'warn');
      }
    }

    // 10. CTR trigger — informational only; the executor logs & files
    let requiresConfirmation = false;
    if ((intent.valueUsd ?? 0) >= 10_000) {
      requiresConfirmation = true; // Anything ≥$10k → owner confirmation + CTR draft
    }

    return {
      allow: true,
      reason: 'ok',
      requiresConfirmation,
      auditLevel: (intent.valueUsd ?? 0) > 50 ? 'info' : 'debug',
    };
  }

  /** Clamp self-defined limits so they never exceed hard limits. */
  clampSelfLimits(desired: SelfLimits): SelfLimits {
    return {
      maxTxUsd: Math.min(desired.maxTxUsd, HARD_LIMITS.MAX_TX_USD),
      maxTradeUsd: Math.min(desired.maxTradeUsd, HARD_LIMITS.MAX_TRADE_USD),
      maxDailyOutflowUsd: Math.min(desired.maxDailyOutflowUsd, HARD_LIMITS.MAX_DAILY_OUTFLOW_USD),
      strategyExposureCapPct: Math.min(desired.strategyExposureCapPct, HARD_LIMITS.MAX_STRATEGY_EXPOSURE_PCT),
    };
  }

  /** Recent violations for the owner dashboard. */
  recentViolations(sinceMs: number): typeof this.violationLog {
    const cutoff = Date.now() - sinceMs;
    return this.violationLog.filter((v) => v.ts >= cutoff);
  }

  // ── helpers ─────────────────────────────────────────────────────

  private isTransferOrTrade(intent: ToolIntent): boolean {
    return (
      intent.tool.startsWith('wallet.transfer') ||
      intent.tool === 'exchange.swap' ||
      intent.tool === 'commerce.purchase' ||
      intent.tool === 'social.publishAd' ||
      intent.tool === 'compute.rentGpu'
    );
  }

  private isOutflow(intent: ToolIntent): boolean {
    // Trades between assets the agent owns are not outflows for whitelist purposes,
    // but they DO count for hourly tx-rate limits (handled separately).
    return (
      intent.tool.startsWith('wallet.transfer') ||
      intent.tool === 'commerce.purchase' ||
      intent.tool === 'social.publishAd' ||
      intent.tool === 'compute.rentGpu'
    );
  }

  private drawdown(agent: AgentState): number {
    if (agent.peakNetWorthUsd <= 0) return 0;
    return ((agent.peakNetWorthUsd - agent.netWorthUsd) / agent.peakNetWorthUsd) * 100;
  }

  private reject(intent: ToolIntent, reason: string, auditLevel: PolicyDecision['auditLevel']): PolicyDecision {
    this.violationLog.push({ ts: Date.now(), intent, reason });
    return { allow: false, reason, auditLevel };
  }
}
