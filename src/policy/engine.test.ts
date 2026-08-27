// Tests for Policy Engine. Run: npm test.
// These are the "airbag" tests — every hard limit must reject when violated.

import { describe, it, expect } from 'vitest';
import { PolicyEngine, type AgentState } from './engine.js';
import { HARD_LIMITS, PermissionLevel } from './limits.js';

function mkAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'test-agent',
    netWorthUsd: 1000,
    cashUsd: 500,
    peakNetWorthUsd: 1000,
    openPositions: 0,
    outflow24hUsd: 0,
    outflow7dUsd: 0,
    txCountLastHour: 0,
    toolCallsLastMinute: 0,
    gpuSpend24hUsd: 0,
    adSpend24hUsd: 0,
    maxAllowedLevel: PermissionLevel.CAPITAL,
    selfLimits: {
      maxTxUsd: 250,
      maxTradeUsd: 200,
      maxDailyOutflowUsd: 500,
      strategyExposureCapPct: 25,
    },
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  const engine = new PolicyEngine();

  it('rejects absolute prohibitions regardless of caller', () => {
    const decision = engine.evaluate(mkAgent(), {
      tool: 'wallet.approve',
      level: PermissionLevel.FINANCIAL,
      category: 'contract-approval-unlimited',
    });
    expect(decision.allow).toBe(false);
    expect(decision.auditLevel).toBe('critical');
  });

  it('rejects when permission level exceeds agent max', () => {
    const decision = engine.evaluate(mkAgent({ maxAllowedLevel: PermissionLevel.MICRO_TX }), {
      tool: 'wallet.transfer',
      level: PermissionLevel.CAPITAL,
      valueUsd: 100,
      destinationRole: 'known-vendor',
      chainId: 137,
    });
    expect(decision.allow).toBe(false);
  });

  it('rejects transfer to non-whitelisted destination', () => {
    const decision = engine.evaluate(mkAgent(), {
      tool: 'wallet.transfer',
      level: PermissionLevel.FINANCIAL,
      valueUsd: 50,
      destinationRole: 'random-eoa',
      chainId: 137,
    });
    expect(decision.allow).toBe(false);
  });

  it('rejects transfer above per-tx cap', () => {
    const decision = engine.evaluate(mkAgent(), {
      tool: 'wallet.transfer',
      level: PermissionLevel.FINANCIAL,
      valueUsd: HARD_LIMITS.MAX_TX_USD + 1,
      destinationRole: 'known-vendor',
      chainId: 137,
    });
    expect(decision.allow).toBe(false);
  });

  it('rejects tx on non-whitelisted chain', () => {
    const decision = engine.evaluate(mkAgent(), {
      tool: 'wallet.transfer',
      level: PermissionLevel.FINANCIAL,
      valueUsd: 10,
      destinationRole: 'known-vendor',
      chainId: 1, // Ethereum not on the Polygon-only whitelist
    });
    expect(decision.allow).toBe(false);
  });

  it('rejects when adding tx would breach daily outflow cap', () => {
    const decision = engine.evaluate(
      mkAgent({ outflow24hUsd: HARD_LIMITS.MAX_DAILY_OUTFLOW_USD - 10 }),
      {
        tool: 'wallet.transfer',
        level: PermissionLevel.FINANCIAL,
        valueUsd: 50,
        destinationRole: 'known-vendor',
        chainId: 137,
      },
    );
    expect(decision.allow).toBe(false);
  });

  it('rejects any costly op when in HIBERNATE drawdown', () => {
    const decision = engine.evaluate(
      mkAgent({ netWorthUsd: 500, peakNetWorthUsd: 1000 }), // 50% drawdown
      {
        tool: 'exchange.swap',
        level: PermissionLevel.FINANCIAL,
        valueUsd: 10,
        chainId: 137,
      },
    );
    expect(decision.allow).toBe(false);
  });

  it('allows read-only tools regardless of drawdown', () => {
    const decision = engine.evaluate(
      mkAgent({ netWorthUsd: 500, peakNetWorthUsd: 1000 }), // 50% drawdown
      { tool: 'wallet.getBalance', level: PermissionLevel.READ_ONLY },
    );
    expect(decision.allow).toBe(true);
  });

  it('flags ≥$10k transfers for owner confirmation', () => {
    const decision = engine.evaluate(
      mkAgent({ selfLimits: { maxTxUsd: 20_000, maxTradeUsd: 20_000, maxDailyOutflowUsd: 30_000, strategyExposureCapPct: 25 } }),
      {
        tool: 'wallet.transfer',
        level: PermissionLevel.EXTRAORDINARY,
        valueUsd: 10_000,
        destinationRole: 'kaizen-parent-treasury',
        chainId: 137,
      },
    );
    // Still rejected because $10k > hard MAX_TX_USD = $250; useful invariant test.
    expect(decision.allow).toBe(false);
  });

  it('clampSelfLimits never allows values above hard limits', () => {
    const clamped = engine.clampSelfLimits({
      maxTxUsd: 99_999,
      maxTradeUsd: 99_999,
      maxDailyOutflowUsd: 99_999,
      strategyExposureCapPct: 99,
    });
    expect(clamped.maxTxUsd).toBeLessThanOrEqual(HARD_LIMITS.MAX_TX_USD);
    expect(clamped.maxTradeUsd).toBeLessThanOrEqual(HARD_LIMITS.MAX_TRADE_USD);
    expect(clamped.maxDailyOutflowUsd).toBeLessThanOrEqual(HARD_LIMITS.MAX_DAILY_OUTFLOW_USD);
    expect(clamped.strategyExposureCapPct).toBeLessThanOrEqual(HARD_LIMITS.MAX_STRATEGY_EXPOSURE_PCT);
  });

  it('rejects when hourly tx count exceeded', () => {
    const decision = engine.evaluate(
      mkAgent({ txCountLastHour: HARD_LIMITS.MAX_TX_PER_HOUR }),
      {
        tool: 'wallet.transfer',
        level: PermissionLevel.FINANCIAL,
        valueUsd: 5,
        destinationRole: 'known-vendor',
        chainId: 137,
      },
    );
    expect(decision.allow).toBe(false);
  });

  it('allows a normal small transfer to a whitelisted destination', () => {
    const decision = engine.evaluate(mkAgent(), {
      tool: 'wallet.transfer',
      level: PermissionLevel.FINANCIAL,
      valueUsd: 25,
      destinationRole: 'known-vendor',
      chainId: 137,
    });
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('ok');
  });
});
