// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — HTTP API (backend)
//
//  Minimal Express server exposing:
//    POST /agents                       create a new agent
//    GET  /agents                       list all agents
//    GET  /agents/:id                   agent record + on-chain balances + snapshot
//    GET  /agents/:id/events            recent economic events
//    GET  /agents/:id/turns             recent conversation turns
//    POST /agents/:id/tick              run one Decision Loop tick
//
//  Bind to 127.0.0.1 by default — this is the agent runtime, not a
//  public API. The Dashboard UI (Vite dev server) talks to it locally.
// ═══════════════════════════════════════════════════════════════════════

import express from "express";
import cors from "cors";
import { createAgent } from "../src/agent/identity.js";
import { FileAgentRegistry } from "../src/agent/registry.js";
import { snapshot, proposeBudget } from "../src/brain/economic.js";
import { MemoryStore } from "../src/memory/store.js";
import { DecisionLoop } from "../src/brain/decisionLoop.js";
import { llmFromEnv } from "../src/brain/llm.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeGetBalanceTool, makeTransferTool } from "../src/tools/wallet.js";
import { makeQuoteTool } from "../src/tools/exchange.js";
import { makeCreateImageTool, makeCreateVideoTool } from "../src/tools/kame.js";
import {
  makeOpenPositionTool,
  makeClosePositionTool,
  makeGetPositionsTool,
  makeSetExitRulesTool,
} from "../src/tools/trading.js";
import { makePredictListTool } from "../src/tools/predict.js";
import {
  makeScanTool,
  makeRecentTool,
  makeMarkActedTool,
} from "../src/tools/opportunity.js";
import { makeReinvestPlanTool, makeReinvestApplyTool } from "../src/tools/reinvest.js";
import { FileVaultStore } from "./wallet/vaultStore.js";
import { SecureWalletService } from "./wallet/service.js";
import { ComposedStateLoader } from "./wallet/stateLoader.js";
import { AutoTickScheduler } from "./scheduler.js";

const PORT = Number(process.env.KAIZEN_PORT || 4711);
const HOST = process.env.KAIZEN_HOST || "127.0.0.1";
const POL_USD_RATE = Number(process.env.KAIZEN_POL_USD_RATE || 0.5);

function requirePassphrase(): string {
  const p = process.env.KAIZEN_VAULT_PASSPHRASE;
  if (!p || p.length < 16) {
    throw new Error("KAIZEN_VAULT_PASSPHRASE env var missing or too short (≥16 chars).");
  }
  return p;
}

function makeApp() {
  const passphrase = requirePassphrase();

  const registry = new FileAgentRegistry();
  const vault = new FileVaultStore();
  const stateLoader = new ComposedStateLoader(registry, {
    137: POL_USD_RATE,
    8453: Number(process.env.KAIZEN_ETH_USD_RATE || 3200),
  });
  const walletService = new SecureWalletService(vault, stateLoader);

  const tools = new ToolRegistry();
  tools.register(makeGetBalanceTool(walletService));
  tools.register(makeTransferTool(walletService));
  tools.register(makeQuoteTool());
  tools.register(makeCreateImageTool());
  tools.register(makeCreateVideoTool());
  tools.register(makeOpenPositionTool());
  tools.register(makeClosePositionTool());
  tools.register(makeGetPositionsTool());
  tools.register(makeSetExitRulesTool());
  tools.register(makePredictListTool());
  tools.register(makeScanTool());
  tools.register(makeRecentTool());
  tools.register(makeMarkActedTool());
  tools.register(makeReinvestPlanTool());
  tools.register(makeReinvestApplyTool());

  const decisionLoop = new DecisionLoop(llmFromEnv(), tools, registry);

  const scheduler = new AutoTickScheduler(
    registry,
    decisionLoop,
    walletService,
    stateLoader,
    {
      pollIntervalSeconds: Number(process.env.KAIZEN_SCHEDULER_POLL_SEC || "30"),
      maxConcurrent: Number(process.env.KAIZEN_SCHEDULER_CONCURRENCY || "3"),
      minTickIntervalSeconds: 60,
      nativeUsdRates: {
        137: POL_USD_RATE,
        8453: Number(process.env.KAIZEN_ETH_USD_RATE || 3200),
      },
    },
  );
  scheduler.start();

  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // ── Agents CRUD ──────────────────────────────────────────────────
  app.post("/agents", async (req, res) => {
    try {
      const { displayName, agentId } = req.body ?? {};
      if (!displayName) return res.status(400).json({ error: "displayName required" });
      const out = await createAgent({ displayName, agentId }, vault, registry, passphrase);
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/agents", async (_req, res) => {
    const all = await registry.list();
    res.json({ agents: all });
  });

  app.get("/agents/:id", async (req, res) => {
    try {
      const record = await registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: "not found" });
      const balances = await walletService.readBalances(req.params.id);
      // Owner-flagged 2026-08-28: snapshot() used to receive a single scalar
      // polUsdRate and multiply every chain's native by it — ETH on Base was
      // being valued as if it were POL, so 0.00081 ETH ($2.60) showed up as
      // gas=$0.00. Now we compute total gas USD across chains via stateLoader
      // and pass it as (pol=totalGasUsd, polUsdRate=1) so snapshot arithmetic
      // stays correct without changing its signature.
      let gasUsdTotal = 0;
      for (const [idStr, per] of Object.entries(balances.byChain)) {
        gasUsdTotal += stateLoader.gasUsdFor(Number(idStr), per.native);
      }
      const snap = snapshot(
        req.params.id,
        { usdc: balances.usdc, pol: gasUsdTotal, polUsdRate: 1 },
        [],
        { outflow24hUsd: 0, outflow7dUsd: 0 },
        record.peakNetWorthUsd,
      );
      const budget = proposeBudget(snap.netWorthUsd, snap.suggestedStatus);
      res.json({ record, balances, snapshot: snap, budget });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/agents/:id/events", async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const mem = new MemoryStore(req.params.id);
    try {
      res.json({ events: mem.recentEvents(limit) });
    } finally {
      mem.close();
    }
  });

  app.get("/agents/:id/turns", async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 30), 200);
    const mem = new MemoryStore(req.params.id);
    try {
      res.json({ turns: mem.recentTurns(limit) });
    } finally {
      mem.close();
    }
  });

  app.post("/agents/:id/schedule", async (req, res) => {
    try {
      const record = await registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: "not found" });
      const { enabled, intervalSeconds } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) required" });
      }
      const interval = Math.max(60, Number(intervalSeconds) || 300);
      await registry.updateAutoTick(req.params.id, {
        enabled,
        intervalSeconds: interval,
        lastTickTs: record.autoTick?.lastTickTs,
      });
      const updated = await registry.get(req.params.id);
      res.json({ record: updated });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/agents/:id/tick", async (req, res) => {
    try {
      const record = await registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: "not found" });
      const balances = await walletService.readBalances(req.params.id);
      const agentState = await stateLoader.load(req.params.id);
      // Same fix as GET /agents/:id — compute total gas USD via per-chain
      // rates instead of applying a single scalar polUsdRate to every native.
      let gasUsdTotal = 0;
      for (const [idStr, per] of Object.entries(balances.byChain)) {
        gasUsdTotal += stateLoader.gasUsdFor(Number(idStr), per.native);
      }
      const result = await decisionLoop.tick({
        agentId: req.params.id,
        operatorPrompt: req.body?.operatorPrompt,
        balances: { usdc: balances.usdc, pol: gasUsdTotal, polUsdRate: 1 },
        agentState,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return { app, scheduler };
}

function main(): void {
  const { app, scheduler } = makeApp();
  const server = app.listen(PORT, HOST, () => {
    console.log(`Kaizen backend listening on http://${HOST}:${PORT}`);
    console.log(`  → GET  /healthz`);
    console.log(`  → POST /agents                  { displayName }`);
    console.log(`  → GET  /agents`);
    console.log(`  → GET  /agents/:id`);
    console.log(`  → GET  /agents/:id/events`);
    console.log(`  → GET  /agents/:id/turns`);
    console.log(`  → POST /agents/:id/schedule     { enabled, intervalSeconds }`);
    console.log(`  → POST /agents/:id/tick         { operatorPrompt? }`);
  });

  // Graceful shutdown so in-flight ticks finish before we die.
  const shutdown = async (sig: string) => {
    console.log(`[server] ${sig} received, shutting down…`);
    server.close();
    await scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
