// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — AgentStateLoader implementation
//
//  Composes the Agent Registry (public identity + status) and the
//  Memory Store (rolling outflows, events) into the AgentState the
//  Secure Wallet Service and Policy Engine expect.
// ═══════════════════════════════════════════════════════════════════════

import {
  erc20Balance,
  nativeBalance,
} from "@kaizen/wallet-core";
import type { AgentRegistry } from "../../src/agent/registry.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { AgentStateLoader } from "./service.js";
import type { AgentState } from "../../src/policy/engine.js";
import { PermissionLevel } from "../../src/policy/limits.js";
import { CHAINS, USDC_BY_CHAIN, NATIVE_SYMBOL_BY_CHAIN } from "./service.js";

/** Techo de permisos que fija el DUEÑO, por encima de lo que la agente
 *  pueda auto-asignarse.
 *
 *  Antes esto era FINANCIAL fijo en el código: no había forma de dejarla
 *  razonar y navegar sin darle también la capacidad de firmar. Con el techo
 *  bajo, la Policy Engine rechaza swaps y transferencias pero la agente
 *  sigue pudiendo buscar, leer y proponer — sirve para ver cómo piensa sin
 *  arriesgar un centavo.
 *
 *  KAIZEN_MAX_LEVEL: 0=solo lectura 1=sin costo 2=micro 3=financiero
 *                    4=capital 5=extraordinario.  Por defecto 3, como antes.
 */
function maxLevelFromEnv(): PermissionLevel {
  const raw = process.env.KAIZEN_MAX_LEVEL;
  if (raw === undefined || raw === "") return PermissionLevel.FINANCIAL;
  const n = Number(raw);
  // Un valor basura NO puede ampliar permisos: ante la duda, el default.
  if (!Number.isInteger(n) || n < 0 || n > PermissionLevel.EXTRAORDINARY) {
    console.warn(`[permisos] KAIZEN_MAX_LEVEL="${raw}" inválido; uso FINANCIAL`);
    return PermissionLevel.FINANCIAL;
  }
  return n as PermissionLevel;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

export class ComposedStateLoader implements AgentStateLoader {
  constructor(
    private readonly registry: AgentRegistry,
    /** USD rates por chainId. Arrancan con estos valores y los pisa el
     *  PriceFeed vía updateRates(). Ya NO son la verdad final: eran la
     *  causa de que el patrimonio se reportara 28% inflado. */
    private nativeUsdRates: Record<number, number> = { 137: 0.5, 8453: 3200 },
  ) {}

  /** Reemplaza las tasas con las del feed de precios.
   *
   *  Se ignora cualquier valor no positivo: un 0 valuaría todo en cero y
   *  dispararía una crisis fantasma que le pondría el presupuesto en cero
   *  a la agente sin que haya pasado nada.
   */
  updateRates(rates: Record<number, number>): void {
    for (const [id, usd] of Object.entries(rates)) {
      if (Number.isFinite(usd) && usd > 0) this.nativeUsdRates[Number(id)] = usd;
    }
  }

  /** Tasas vigentes — para diagnóstico y para que la UI muestre con qué
   *  precio se valuó, en vez de que el número parezca salido de la nada. */
  currentRates(): Record<number, number> {
    return { ...this.nativeUsdRates };
  }

  /** Convert an on-chain native amount to USD using the per-chain rate table. */
  gasUsdFor(chainId: number, nativeAmount: number): number {
    return nativeAmount * (this.nativeUsdRates[chainId] ?? 0);
  }

  /** Valúa una tenencia por su símbolo de precio (ej. WETH cotiza como ETH).
   *
   *  Deriva el precio de la MISMA tabla que el gas en vez de mantener una
   *  segunda: se busca la cadena cuyo nativo es ese símbolo y se usa su tasa.
   *  Sin esto haría falta copiar los 3200 de ETH, y una copia se desactualiza
   *  sola el día que se conecte un feed de precios real.
   *
   *  Devuelve 0 para un símbolo desconocido — mejor no contarlo que inventarle
   *  un precio y que la agente crea que tiene plata que no tiene.
   */
  usdForSymbol(priceSymbol: string, amount: number): number {
    for (const [idStr, rate] of Object.entries(this.nativeUsdRates)) {
      if (NATIVE_SYMBOL_BY_CHAIN[Number(idStr)] === priceSymbol) return amount * rate;
    }
    return 0;
  }

  /** Total gas value (USD) across every whitelisted chain for an address. */
  async totalGasUsdFor(address: string): Promise<number> {
    const chainIds = Object.keys(CHAINS).map(Number);
    const perChain = await Promise.all(
      chainIds.map(async (id) => {
        const chain = CHAINS[id];
        if (!chain) return 0;
        const n = await nativeBalance(chain, address).catch(() => 0);
        return n * (this.nativeUsdRates[id] ?? 0);
      }),
    );
    return perChain.reduce((s, v) => s + v, 0);
  }

  async load(agentId: string): Promise<AgentState> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} not found`);

    // Sum USDC + native across every whitelisted chain. This is a repeat of
    // SecureWalletService.readBalances(), duplicated here to avoid a circular
    // dep (service depends on stateLoader). Keep the two in sync.
    //
    // 2026-08-29: retry twice with 500ms backoff before falling back to 0 —
    // a single transient RPC failure was mis-reporting cash=0 which the
    // PolicyEngine then interpreted as HIBERNATING drawdown. Two retries
    // handle the common `429 Too Many Requests` / `503` blips without
    // adding a hard failure mode when the RPC is genuinely down.
    const withRetry = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await fn(); } catch (e) {
          lastErr = e as Error;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      console.warn(`[stateLoader] ${label} failed 3x, using fallback. Last err: ${lastErr?.message ?? "(none)"}`);
      return fallback;
    };

    const chainIds = Object.keys(CHAINS).map(Number);
    const perChain = await Promise.all(
      chainIds.map(async (id) => {
        const chain = CHAINS[id];
        const usdc = USDC_BY_CHAIN[id];
        if (!chain || !usdc) return { id, usdc: 0, native: 0 };
        const [u, n] = await Promise.all([
          withRetry(() => erc20Balance(chain, usdc.address, record.address), { formatted: 0 } as { formatted: number }, `erc20Balance(${chain.name})`),
          withRetry(() => nativeBalance(chain, record.address), 0 as number, `nativeBalance(${chain.name})`),
        ]);
        return { id, usdc: u.formatted, native: n };
      }),
    );

    let cash = 0;
    let gas = 0;
    for (const r of perChain) {
      cash += r.usdc;
      gas += r.native * (this.nativeUsdRates[r.id] ?? 0);
    }
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
        maxAllowedLevel: maxLevelFromEnv(),
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
