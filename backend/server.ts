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
import { makeQuoteTool, makeSwapTool } from "../src/tools/exchange.js";
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
import {
  makeDiscoverProductsTool,
  makeAnalyzeProductTool,
  makeCreateListingTool,
} from "../src/tools/commerce.js";
import {
  makeCreateCampaignTool,
  makeRecordSpendTool,
  makeRecordRevenueTool,
  makeRoasTool,
} from "../src/tools/marketing.js";
import {
  makeTwitterPostTool,
  makeTelegramPostTool,
} from "../src/tools/social.js";
// Fase 7 gap #3: compute rental — Kaizen can now rent GPUs autonomously
import { makeComputeListTool, makeComputeRentTool, makeComputeStopTool } from "../src/tools/compute.js";
// Improvement.5: Kaizen decides when to retrain herself
import { makeTrainingStatusTool, makeTrainingTriggerTool } from "../src/tools/training.js";
// Path A: web browsing + landing pages + affiliate + ads
import { makeWebSearchTool, makeWebFetchTool, makeWebScrapeTool } from "../src/tools/web.js";
import { makeSitesDeployTool, makeAmazonLinkTool, makeMetaAdsTool } from "../src/tools/commerce_web.js";
import { MockComputeProvider, type ComputeProvider } from "../src/compute/provider.js";
import { RunpodProvider } from "../src/compute/runpod.js";
import { LightningComputeProvider } from "../src/compute/lightning.js";
import { NvidiaBrevProvider } from "../src/compute/nvidia-brev.js";
import { MultiComputeProvider } from "../src/compute/multi.js";
import { SpheronComputeProvider } from "../src/compute/spheron.js";
import { FileVaultStore } from "./wallet/vaultStore.js";
import { SecureWalletService } from "./wallet/service.js";
import { ComposedStateLoader } from "./wallet/stateLoader.js";
import { AutoTickScheduler } from "./scheduler.js";
import { appendEntry, count as waitlistCount, isValidEmail, loadEmails } from "./waitlist.js";
// Fase 1 multi-turn ReAct runtime — new endpoint POST /agents/:id/run
import { MultiTurnReactLoop } from "@kaizen/runtime/agent";
import { toRuntimeSnapshot, wireLedger, wireLlm, wireTools } from "./runtime-wire.js";
// Fase 4+5+7 spawn runtime
import { RealSpawner, hashConstitutionBytes } from "@kaizen/runtime/spawn";
import {
  wireWalletProvisioner,
  wireFundingBridge,
  wireConstitutionSource,
  wireChildRegistry,
  makeReadParentState,
} from "./spawner-wire.js";
import fs from "node:fs";
import path from "node:path";
// Fase 2 heartbeat daemon (owner-controlled via HTTP)
import {
  RealHeartbeatDaemon,
  ConsoleOwnerNotifier,
  makeAutonomousTickTask,
  makeCreditMonitorTask,
  makeHealthCheckTask,
} from "@kaizen/runtime/heartbeat";
import { MultiTurnReactLoop as MTRLoop } from "@kaizen/runtime/agent";
// Fase 5+7: on-chain self-registration for spawned children
import { makeAutoRegister } from "./onchain-register.js";
import { BASE } from "./wallet/service.js";
// Improvement.1+.2: outcome measurement + curation
import {
  OutcomeMeasurer,
  makePnlStrategy,
  AutoCurator,
} from "@kaizen/runtime";
import { wireOutcomeLedger, wireMeasurementContext, wireCuratorLedger } from "./improvement-wire.js";
import fsPromises from "node:fs/promises";

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

  /** Fuente ÚNICA de la foto patrimonial de un agente.
   *
   *  Cuatro rutas necesitaban lo mismo —GET /agents/:id, el heartbeat
   *  autónomo, POST /:id/run y POST /:id/tick— y cada una tenía su copia
   *  del cálculo. Se desincronizaron: contar las posiciones entró sólo en
   *  /tick, así que por el camino autónomo la agente seguía viendo una
   *  caída falsa (26.4% en vez de 0.5%), se clasificaba DEFENSIVE y se
   *  ponía el presupuesto en cero. Un solo lugar, un solo resultado.
   */
  async function composeFinancials(agentId: string) {
    const balances = await walletService.readBalances(agentId);
    let gasUsdTotal = 0;
    for (const [idStr, per] of Object.entries(balances.byChain)) {
      gasUsdTotal += stateLoader.gasUsdFor(Number(idStr), per.native);
    }
    // Lo que tiene comprado ES patrimonio. Sin esto cuenta lo gastado como
    // pérdida y no cuenta el activo recibido, y cuanto más invierte menos
    // se permite hacer.
    const positions = (balances.holdings || [])
      .filter((h) => h.amount > 0)
      .map((h) => {
        const markUsd = stateLoader.usdForSymbol(h.priceSymbol, h.amount);
        return { strategy: "held", asset: h.symbol, entryUsd: markUsd, currentUsd: markUsd };
      })
      .filter((p) => p.currentUsd > 0);
    return {
      balances,
      positions,
      /** Lo que espera snapshot(): el gas ya valuado, con tasa 1. */
      snapBalances: { usdc: balances.usdc, pol: gasUsdTotal, polUsdRate: 1 },
    };
  }

  const tools = new ToolRegistry();
  tools.register(makeGetBalanceTool(walletService));
  tools.register(makeTransferTool(walletService));
  tools.register(makeQuoteTool());
  tools.register(makeSwapTool(walletService));
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
  tools.register(makeDiscoverProductsTool());
  tools.register(makeAnalyzeProductTool());
  tools.register(makeCreateListingTool());
  tools.register(makeCreateCampaignTool());
  tools.register(makeRecordSpendTool());
  tools.register(makeRecordRevenueTool());
  tools.register(makeRoasTool());
  tools.register(makeTwitterPostTool());
  tools.register(makeTelegramPostTool());
  // Compute provider — assemble whatever the env allows. If nothing is
  // configured, fall back to Mock so `compute.list` still works locally.
  const availableProviders: Record<string, ComputeProvider> = {};
  if (process.env.RUNPOD_API_KEY)   availableProviders.runpod    = new RunpodProvider();
  if (process.env.LIGHTNING_API_KEY) availableProviders.lightning = new LightningComputeProvider();
  if (process.env.BREV_API_KEY)     availableProviders.nvidia    = new NvidiaBrevProvider();
  // Spheron es el único que Kaizen paga POR SÍ MISMA: escrow on-chain en USDC
  // sobre Base, firmado con su propia llave. Los otros tres cobran con API key
  // contra la tarjeta de un humano, así que con ellos no se autoabastece.
  //
  // Se activa con KAIZEN_SPHERON=1 porque gasta USDC real sin intervención.
  if (process.env.KAIZEN_SPHERON === "1") {
    availableProviders.spheron = new SpheronComputeProvider({
      networkType: process.env.KAIZEN_SPHERON_NETWORK === "testnet" ? "testnet" : "mainnet",
      // La llave se pide en el momento de firmar y no se guarda.
      getPrivateKey: () => walletService.exportPrivateKeyForSpheron(
        process.env.KAIZEN_SPHERON_AGENT_ID || "agt_demo",
      ),
    });
  }
  const computeProvider = Object.keys(availableProviders).length === 0
    ? new MockComputeProvider()
    : new MultiComputeProvider({ providers: availableProviders });
  tools.register(makeComputeListTool(computeProvider));
  tools.register(makeComputeRentTool(computeProvider));
  tools.register(makeComputeStopTool(computeProvider));
  // Improvement.5: Kaizen inspects her own learning progress + can trigger retraining
  tools.register(makeTrainingStatusTool());
  tools.register(makeTrainingTriggerTool(computeProvider));
  // Path A: web browsing + landing pages + affiliate + ads
  tools.register(makeWebSearchTool());
  tools.register(makeWebFetchTool());
  tools.register(makeWebScrapeTool());
  tools.register(makeSitesDeployTool());
  tools.register(makeAmazonLinkTool());
  tools.register(makeMetaAdsTool());

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
  // Localhost for dev; kaizen-777.com + its www + any *.pages.dev preview
  // so the landing (whether custom domain or CF preview URL) can POST here.
  app.use(cors({
    origin: [
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
      /^https?:\/\/(www\.)?kaizen-777\.com$/,
      /^https:\/\/[a-z0-9-]+\.pages\.dev$/,
    ],
  }));

  // Trust the proxy header when behind Cloudflare Tunnel so req.ip is real.
  app.set("trust proxy", true);

  app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // ── Waitlist ─────────────────────────────────────────────────────
  // Simple JSONL persistence. Idempotent: same email twice returns ok:true
  // without duplicating the row. Rate-limited softly by-IP with a 3s
  // in-memory window; anything more sophisticated waits until we actually
  // see abuse, which we don't yet.
  const waitlistWindow = new Map<string, number>();
  app.post("/waitlist", (req, res) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const source = String(req.body?.source || "unknown").slice(0, 40);
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: "invalid email" });
      }
      const ip = String(req.ip || "").slice(0, 60);
      const now = Date.now();
      const last = waitlistWindow.get(ip);
      if (last && now - last < 3000) {
        return res.status(429).json({ ok: false, error: "too many requests" });
      }
      waitlistWindow.set(ip, now);

      const existing = loadEmails();
      if (existing.has(email)) {
        return res.json({ ok: true, already: true });
      }
      appendEntry({
        email,
        source,
        ts: now,
        ip: ip || undefined,
        ua: String(req.headers["user-agent"] || "").slice(0, 200) || undefined,
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/waitlist/count", (_req, res) => {
    try {
      res.json({ count: waitlistCount() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Root handler — useful when someone opens the base URL in a browser and
  // otherwise gets Express's default "Cannot GET /" 404.
  app.get("/", (_req, res) => res.json({
    service: "Kaizen AI",
    version: "0.2",
    company: "Kaizen LLC",
    note: "Backend HTTP API. Every route is JSON. No HTML pages on this host.",
    endpoints: {
      "GET  /healthz":              "liveness probe",
      "GET  /agents":               "list agents",
      "POST /agents":               "create agent  { displayName, agentId? }",
      "GET  /agents/:id":           "agent record + on-chain balances + snapshot + budget",
      "GET  /agents/:id/events":    "recent economic events",
      "GET  /agents/:id/turns":     "recent conversation turns",
      "POST /agents/:id/schedule":  "toggle auto-tick { enabled, intervalSeconds }",
      "POST /agents/:id/tick":      "run one Decision Loop tick (LLM ~30-60s, 1 tool per call)",
      "POST /agents/:id/run":       "run Fase 1 multi-turn ReAct loop (Think→Act→Observe until done, capped)",
      "POST /agents/:id/spawn":     "Fase 4/7: spawn a child agent with real Kairos wallet + USDC seed",
      "GET  /agents/:id/children":  "list spawned children of this agent",
      "POST /agents/:id/heartbeat/start":  "Fase 2/7: start autonomous heartbeat daemon (Kaizen ticks on its own)",
      "POST /agents/:id/heartbeat/stop":   "stop the heartbeat daemon",
      "GET  /agents/:id/heartbeat/status": "daemon state + task registry",
      "POST /agents/:id/register-onchain": "Fase 5/7: child registers itself in KairosAgentRegistry on Base",
      "POST /waitlist":             "landing waitlist signup { email, source? }",
      "GET  /waitlist/count":       "public count of waitlist entries",
    },
    tools: {
      wallet: ["getBalance", "transfer"],
      exchange: ["quote"],
      kame: ["createImage", "createVideo"],
      trading: ["openPosition", "closePosition", "getPositions", "setExitRules"],
      predict: ["list"],
      opportunity: ["scan", "recent", "markActed"],
      reinvest: ["plan", "apply"],
      commerce: ["discoverProducts", "analyzeProduct", "createListing"],
      marketing: ["createCampaign", "recordSpend", "recordRevenue", "roas"],
      social: ["twitter.postTweet", "telegram.postMessage"],
      compute: ["list", "rentGpu", "stopGpu"],
      training: ["status", "trigger"],
      web: ["search", "fetch", "scrape"],
      sites: ["deployLanding"],
      affiliate: ["amazon.link"],
      ads: ["meta.createDraft"],
    },
    computeProvider: Object.keys(availableProviders).length === 0
      ? "mock"
      : `multi:${Object.keys(availableProviders).join("+")}`,
    ts: Date.now(),
  }));

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
      // Owner-flagged 2026-08-28: snapshot() used to receive a single scalar
      // polUsdRate and multiply every chain's native by it — ETH on Base was
      // being valued as if it were POL, so 0.00081 ETH ($2.60) showed up as
      // gas=$0.00. composeFinancials() ya entrega el gas valuado por cadena.
      const { balances, positions, snapBalances } = await composeFinancials(req.params.id);
      const snap = snapshot(
        req.params.id,
        snapBalances,
        positions,
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

  // ── Heartbeat daemons (one per agent, in-memory) ─────────────────
  // Fase 7 gap #1 fix: expose the Fase 2 daemon over HTTP so the owner
  // can start / stop autonomous ticks without opening a REPL.
  const daemons = new Map<string, RealHeartbeatDaemon>();

  function ensureDaemon(agentId: string): RealHeartbeatDaemon {
    const existing = daemons.get(agentId);
    if (existing) return existing;
    const notifier = new ConsoleOwnerNotifier(agentId);
    const daemon = new RealHeartbeatDaemon(
      { agentId, runtimeVersion: "0.1.0-alpha.0", readOnly: false, killSwitchEnv: "KAIZEN_KILL" },
      {
        snapshotProvider: async () => {
          const record = await registry.get(agentId);
          if (!record) throw new Error(`agent ${agentId} not found`);
          const { positions, snapBalances } = await composeFinancials(agentId);
          const snap = snapshot(agentId, snapBalances, positions,
            { outflow24hUsd: 0, outflow7dUsd: 0 }, record.peakNetWorthUsd);
          const children = (await registry.list()).filter((r) => r.parentAgentId === agentId);
          return toRuntimeSnapshot(agentId, snap, children.length);
        },
        notifier,
      },
    );
    // Built-in tasks: health check + credit monitor + autonomous tick
    daemon.register(makeHealthCheckTask({
      notifier,
      async ping() {
        // Ping our own /healthz endpoint via localhost
        const t0 = Date.now();
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
          return { ok: r.ok, latencyMs: Date.now() - t0 };
        } catch (e) {
          return { ok: false, latencyMs: -1, note: (e as Error).message };
        }
      },
    }));
    daemon.register(makeCreditMonitorTask({ minReserveUsd: 2, notifier }));
    // Autonomous tick uses the multi-turn ReAct loop
    const loop = new MTRLoop(
      { agentId, runtimeVersion: "0.1.0-alpha.0", readOnly: false, killSwitchEnv: "KAIZEN_KILL" },
      { llm: wireLlm(llmFromEnv()),
        tools: wireTools(tools, (id) => ({ agentId: id, ts: Date.now() })),
        ledger: wireLedger() },
    );
    daemon.register(makeAutonomousTickTask({
      loop,
      operatorPrompt: "Continue autonomous operation. Observe state, pick one high-value action, execute.",
      runOptions: { maxSteps: 4, maxWallMs: 90_000, maxCostUsd: 0.02 },
    }));
    // Improvement.1: measure outcomes on due decisions (PnL 1h/24h/7d).
    // Runs at least every 5 min; the OutcomeMeasurer itself drains what
    // is `due_at <= now`, so scheduling early is safe.
    const measurer = new OutcomeMeasurer(
      wireOutcomeLedger(agentId),
      wireMeasurementContext(agentId, walletService),
    );
    for (const kind of ["pnl_1h", "pnl_24h", "pnl_7d"] as const) {
      measurer.register(makePnlStrategy(kind));
    }
    daemon.register({
      name: "improvement:measure-outcomes",
      minIntervalMs: 5 * 60_000,
      async run(ctx) {
        const r = await measurer.tick(50);
        if (r.failed > 0) {
          await notifier.notify("banner", "outcome measurements failing",
            `${r.failed} failed / ${r.processed} ok`,
            { agentId: ctx.agentId, category: "improvement" });
        }
      },
    });
    // Improvement.2: curate SFT + DPO datasets every 6h. Writes JSONL
    // files to data/datasets/ ready for the next training round.
    daemon.register({
      name: "improvement:curate-dataset",
      minIntervalMs: 6 * 3600_000,
      async run(ctx) {
        const curator = new AutoCurator({ ledger: wireCuratorLedger(agentId) });
        const [sft, dpo, evalSet] = await Promise.all([
          curator.buildSft(),
          curator.buildDpo(),
          curator.buildEval(0.1),
        ]);
        const outDir = path.resolve(process.env.KAIZEN_STATE_DIR ?? "./data", "datasets", agentId);
        await fsPromises.mkdir(outDir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        await Promise.all([
          fsPromises.writeFile(path.join(outDir, `sft-${stamp}.jsonl`), sft.map((e) => JSON.stringify(e)).join("\n")),
          fsPromises.writeFile(path.join(outDir, `dpo-${stamp}.jsonl`), dpo.map((p) => JSON.stringify(p)).join("\n")),
          fsPromises.writeFile(path.join(outDir, `eval-${stamp}.jsonl`), evalSet.map((e) => JSON.stringify(e)).join("\n")),
        ]);
        if (sft.length + dpo.length > 0) {
          await notifier.notify("silent", "dataset curated",
            `${sft.length} SFT + ${dpo.length} DPO pairs ready under ${outDir}`,
            { agentId: ctx.agentId, category: "improvement" });
        }
      },
    });
    daemons.set(agentId, daemon);
    return daemon;
  }

  app.post("/agents/:id/heartbeat/start", async (req, res) => {
    try {
      const record = await registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: "not found" });
      const daemon = ensureDaemon(req.params.id);
      await daemon.start();
      res.json({ ok: true, status: daemon.status() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/agents/:id/heartbeat/stop", async (req, res) => {
    const daemon = daemons.get(req.params.id);
    if (!daemon) return res.json({ ok: true, note: "no daemon was running" });
    await daemon.stop();
    res.json({ ok: true, status: daemon.status() });
  });

  app.get("/agents/:id/heartbeat/status", (req, res) => {
    const daemon = daemons.get(req.params.id);
    if (!daemon) return res.json({ running: false, note: "no daemon initialized" });
    res.json(daemon.status());
  });

  // ── /agents/:id/spawn — Fase 4/5/7 spawn a child agent ────────
  // Creates a new Kaizen agent under `:id` as its parent, funds it with
  // `seedUsdc` on `chainId`, and (by default) registers on-chain in the
  // KairosAgentRegistry so its parent can rediscover it after a restart.
  //
  // Body:
  //   { seedUsdc: number, chainId?: 137|8453, goal: string,
  //     strategyLabels: string[], registerOnChain?: boolean }
  app.post("/agents/:id/spawn", async (req, res) => {
    try {
      const parentAgentId = req.params.id;
      const parentRec = await registry.get(parentAgentId);
      if (!parentRec) return res.status(404).json({ error: "parent not found" });

      const body = req.body ?? {};
      const seedUsdc = Number(body.seedUsdc ?? 0);
      const chainId = (Number(body.chainId ?? 8453) as 137 | 8453);
      const goal = String(body.goal ?? "").slice(0, 4_000);
      const strategyLabels = Array.isArray(body.strategyLabels) ? body.strategyLabels.map(String) : [];
      if (seedUsdc <= 0 || !Number.isFinite(seedUsdc)) {
        return res.status(400).json({ error: "seedUsdc must be a positive number" });
      }
      if (!goal) return res.status(400).json({ error: "goal required" });

      // Wire the spawner against real kaizen-app primitives.
      const passphrase = requirePassphrase();
      const spawner = new RealSpawner({
        wallets: wireWalletProvisioner(vault, registry, passphrase),
        funding: wireFundingBridge(walletService),
        constitution: wireConstitutionSource(),
        registry: wireChildRegistry(registry),
        readParentState: makeReadParentState(registry, walletService, stateLoader,
          { minNetWorthToSpawnUsd: 5, maxChildAgents: 3 }),
        chainId,
      });

      // Hash the constitution bytes so RealSpawner can verify no drift.
      const constPath = path.resolve(process.cwd(),
        "packages", "kaizen-runtime", "CONSTITUTION.md");
      const constitutionSha256 = hashConstitutionBytes(fs.readFileSync(constPath, "utf8"));

      const child = await spawner.spawn({
        goal,
        strategyLabels,
        budgetUsd: seedUsdc,
        constitutionSha256,
        parentAgentId,
        parentAddress: parentRec.address,
      });

      res.json({
        child,
        constitutionSha256,
        // Full on-chain registration is a Fase 7 backlog: the parent needs
        // its own USDC to swap into the child's ETH gas so the child can
        // register itself. Report `registered=false` for now.
        registered: false,
        note: "Child created + funded off-chain. On-chain registration deferred to child's first heartbeat.",
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── /agents/:id/register-onchain — Fase 5 self-registration ────
  // Any child agent can register itself in the KairosAgentRegistry
  // contract on Base. Uses the child's OWN wallet (its own gas). Owner
  // triggers this manually the first time; a Fase 7 heartbeat task can
  // automate it once the child has ETH.
  app.post("/agents/:id/register-onchain", async (req, res) => {
    try {
      const chainId = (Number(req.body?.chainId ?? 8453) as 137 | 8453);
      const rpcUrl = chainId === 8453
        ? (process.env.BASE_RPC_URL || BASE.rpcUrl)
        : "https://polygon-rpc.com";
      const autoReg = makeAutoRegister(vault, registry, requirePassphrase());
      const result = await autoReg({
        childAgentId: req.params.id, chainId, rpcUrl,
        agentCardUri: req.body?.agentCardUri,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json({
        ...result,
        explorerUrl: chainId === 8453 && result.txHash
          ? `https://basescan.org/tx/${result.txHash}` : undefined,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── /agents/:id/children — list spawned children ───────────────
  app.get("/agents/:id/children", async (req, res) => {
    try {
      const all = await registry.list();
      const children = all.filter((r) => r.parentAgentId === req.params.id);
      res.json({ parent: req.params.id, count: children.length, children });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── /agents/:id/run — Fase 1 multi-turn ReAct loop ─────────────
  // The autonomous entry point. Runs Think → Act → Observe → repeat until
  // the LLM emits an assistant-only message (done), any cap is hit
  // (steps, wall time, cost), the loop detector aborts, or the kill
  // switch flips. Persists every turn + every abort into the Economic
  // Ledger via wireLedger().
  app.post("/agents/:id/run", async (req, res) => {
    try {
      const record = await registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: "not found" });
      const { positions, snapBalances } = await composeFinancials(req.params.id);
      const snap = snapshot(
        req.params.id,
        snapBalances,
        positions,
        { outflow24hUsd: 0, outflow7dUsd: 0 },
        record.peakNetWorthUsd,
      );
      const runtimeSnap = toRuntimeSnapshot(req.params.id, snap);

      const loop = new MultiTurnReactLoop(
        {
          agentId: req.params.id,
          runtimeVersion: "0.1.0-alpha.0",
          readOnly: false,
          killSwitchEnv: "KAIZEN_KILL",
        },
        {
          llm: wireLlm(llmFromEnv()),
          tools: wireTools(tools, (agentId) => ({ agentId, ts: Date.now() })),
          ledger: wireLedger(),
        },
      );

      const result = await loop.run(runtimeSnap, {
        operatorPrompt: req.body?.operatorPrompt,
        maxSteps: Number(req.body?.maxSteps ?? 10),
        maxWallMs: Number(req.body?.maxWallMs ?? 5 * 60 * 1000),
        maxCostUsd: Number(req.body?.maxCostUsd ?? 0.50),
      });
      res.json({ snapshot: snap, budget: proposeBudget(snap.netWorthUsd, snap.suggestedStatus), result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/agents/:id/tick", async (req, res) => {
    try {
      const record = await registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: "not found" });
      const agentState = await stateLoader.load(req.params.id);
      const { positions, snapBalances } = await composeFinancials(req.params.id);

      const result = await decisionLoop.tick({
        agentId: req.params.id,
        operatorPrompt: req.body?.operatorPrompt,
        balances: snapBalances,
        positions,
        agentState,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Kairos-wallet compat endpoint. The wallet's KairosAgent component POSTs
  // { address, messages: [{role,content},...], isGreeting? } and expects
  // { success, content, navHints, routedVia }. We fan it into the same tick
  // path against a shared "kairos-wallet" agent so the wallet UI keeps its
  // shape while the reply comes from Kaizen. Same brain, wallet-flavored
  // presentation via `contextHint`.
  app.post("/api/agent/chat", async (req, res) => {
    try {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const isGreeting = !!req.body?.isGreeting;
      const lastUserMsg = [...messages].reverse().find((m: { role?: string; content?: string }) => m.role === "user");
      const operatorPrompt = isGreeting
        ? "El usuario acaba de abrir la wallet Kairos. Saludalo brevemente (1-2 frases), presentate como KairosAgent (powered by Kaizen), y preguntale qué quiere hacer."
        : (lastUserMsg?.content || "");
      if (!operatorPrompt.trim() && !isGreeting) {
        return res.status(400).json({ success: false, error: "empty message" });
      }
      // Route through a dedicated wallet-persona agent so its ledger + soul
      // stay separate from agt_demo. Auto-create on first hit.
      const walletAgentId = "agt_wallet_kairos";
      let record = await registry.get(walletAgentId);
      if (!record) {
        await createAgent(
          { agentId: walletAgentId, displayName: "KairosAgent (Kaizen)" },
          vault, registry, passphrase,
        );
        record = await registry.get(walletAgentId);
      }
      const agentState = await stateLoader.load(walletAgentId);
      const { positions, snapBalances } = await composeFinancials(walletAgentId);
      const contextualPrompt = [
        "[CONTEXT: llamado desde la wallet Kairos. Presentate como KairosAgent (powered by Kaizen).",
        "El usuario está usando la wallet — ofrece acciones concretas de wallet (swap, send, receive, exchange, casino, predict, elite).",
        "Sé conciso: 2-4 frases máx. No enumeres tu estado interno a menos que te lo pidan.]",
        "",
        operatorPrompt,
      ].join("\n");
      const result = await decisionLoop.tick({
        agentId: walletAgentId,
        operatorPrompt: contextualPrompt,
        balances: snapBalances,
        positions,
        agentState,
      });
      // Wallet UI expects `content`. Kaizen's tick returns `outcome.reason`
      // for wait-outcomes and llmContent for tool-execution outcomes.
      const content = result.llmContent
        || (result.outcome?.kind === "waited" ? result.outcome.reason : "")
        || "(sin respuesta)";
      res.json({
        success: true,
        content,
        navHints: [],
        routedVia: "kaizen-v0.2",
        _debug: { kaizen: true, agentId: walletAgentId, outcome: result.outcome?.kind },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
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
