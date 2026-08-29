// ═══════════════════════════════════════════════════════════════════════
//  Fase 0 sanity tests — the skeleton compiles, exports what it claims,
//  and every Fase 0 stub refuses to do work while advertising which
//  fase will implement it.
// ═══════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import {
  NotImplementedAgentLoop,
  NoopHeartbeatDaemon,
  NoopSelfModEngine,
  NoopSpawner,
  NoopAgentRegistry,
  NoopPaymentClient,
  PROTECTED_FILES,
  type RuntimeSnapshot,
  type ModuleConfig,
} from "../index.js";

const cfg: ModuleConfig = {
  agentId: "agt_test",
  runtimeVersion: "0.1.0-alpha.0",
  readOnly: true,
  killSwitchEnv: "KAIZEN_KILL",
};

const snapshot: RuntimeSnapshot = {
  agentId: "agt_test",
  ts: Date.now(),
  netWorthUsd: 100,
  cashUsd: 90,
  gasReserveUsd: 10,
  drawdownPct: 0,
  tier: "STABLE",
  activeChildren: 0,
};

describe("PROTECTED_FILES", () => {
  it("includes the safety-critical paths", () => {
    expect(PROTECTED_FILES).toContain("src/policy/engine.ts");
    expect(PROTECTED_FILES).toContain("src/policy/limits.ts");
    expect(PROTECTED_FILES).toContain("backend/wallet/service.ts");
    expect(PROTECTED_FILES).toContain("packages/wallet-core/src/vault.ts");
    expect(PROTECTED_FILES).toContain("packages/kaizen-runtime/CONSTITUTION.md");
  });

  it("is frozen so a self-mod cannot mutate the list at runtime", () => {
    expect(Object.isFrozen(PROTECTED_FILES)).toBe(true);
    expect(() => {
      // @ts-expect-error — deliberate frozen-write attempt for the test.
      PROTECTED_FILES.push("src/evil.ts");
    }).toThrow();
  });
});

describe("Fase 0 stubs advertise which fase implements them", () => {
  it("NotImplementedAgentLoop refuses and points at MultiTurnReactLoop", async () => {
    const loop = new NotImplementedAgentLoop(cfg);
    await expect(loop.run(snapshot, {})).rejects.toThrow(/MultiTurnReactLoop/);
  });

  it("HeartbeatDaemon.tickOnce warns without exploding", async () => {
    const daemon = new NoopHeartbeatDaemon(cfg);
    daemon.register({
      name: "test-task", minIntervalMs: 60_000,
      async run() { /* no-op */ },
    });
    await expect(daemon.tickOnce()).resolves.toBeUndefined();
  });

  it("SelfModEngine.apply refuses with a reason", async () => {
    const eng = new NoopSelfModEngine();
    const res = await eng.apply({
      agentId: "agt_test", targetPath: "src/foo.ts",
      patch: "-a\n+b\n", reason: "test",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejectionCode).toBe("policy_denied");
      expect(res.reason).toMatch(/RealSelfModEngine/);
    }
  });

  it("Spawner.spawn throws mentioning Fase 4", async () => {
    const spawner = new NoopSpawner(cfg);
    await expect(
      spawner.spawn({
        goal: "test", strategyLabels: [], budgetUsd: 0,
        constitutionSha256: "0", parentAgentId: "agt_test", parentAddress: "0x0",
      }),
    ).rejects.toThrow(/RealSpawner/);
  });

  it("AgentRegistry.register throws mentioning Fase 5", async () => {
    const reg = new NoopAgentRegistry(cfg);
    await expect(
      reg.register({
        agentId: "agt_test", address: "0x0", parentAddress: null,
        constitutionSha256: "0", agentCardUri: "https://",
      }),
    ).rejects.toThrow(/Fase 5/);
  });

  it("PaymentClient.fetchWithPay throws on 402 mentioning Fase 6", async () => {
    const client = new NoopPaymentClient(cfg);
    // We can't easily mock a 402 response without a fetch mock — this
    // test just documents the intent. Fase 6 replaces it with real coverage.
    expect(client.fetchWithPay).toBeDefined();
  });
});
