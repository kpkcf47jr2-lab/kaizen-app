// ═══════════════════════════════════════════════════════════════════════
//  La foto patrimonial de un agente — UN solo lugar.
//
//  Esto existe porque el mismo cálculo estaba copiado en SEIS sitios y se
//  fueron desincronizando uno por uno:
//
//    GET /agents/:id · heartbeat · POST /:id/run · POST /:id/tick ·
//    chat de KairosAgent · AutoTickScheduler
//
//  Arreglar el conteo de posiciones en unos y no en otros produjo el peor
//  síntoma posible: la agente se veía sana cuando la tickeabas a mano y
//  enferma cuando corría sola. El 2026-09-03 el scheduler —el camino
//  autónomo, el que importa— le mostraba $5.59 en vez de $6.55, la
//  clasificaba DEFENSIVE y le dejaba $0.84 de presupuesto. Razonaba bien
//  sobre datos falsos, que es la falla más difícil de detectar.
//
//  Y usaba tasas congeladas al arranque en vez del feed de precios vivo.
//
//  Mientras esta función sea la única fuente, esa clase de bug no vuelve.
// ═══════════════════════════════════════════════════════════════════════

/** Lo mínimo que se necesita del wallet service. */
export interface LectorDeSaldos {
  readBalances(agentId: string): Promise<{
    address: string;
    usdc: number;
    pol: number;
    native: number;
    byChain: Record<number, { usdc: number; native: number; nativeSymbol: string }>;
    holdings: Array<{ chainId: number; symbol: string; priceSymbol: string; amount: number }>;
  }>;
}

/** Lo mínimo que se necesita del stateLoader: valuar. */
export interface Valuador {
  gasUsdFor(chainId: number, nativeAmount: number): number;
  usdForSymbol(priceSymbol: string, amount: number): number;
}

export interface Financials {
  balances: Awaited<ReturnType<LectorDeSaldos["readBalances"]>>;
  /** Posiciones abiertas, valuadas. Sin esto la agente cuenta lo gastado
   *  como pérdida y no cuenta el activo comprado — y cuanto más invierte,
   *  menos se permite hacer. */
  positions: Array<{ strategy: string; asset: string; entryUsd: number; currentUsd: number }>;
  /** La forma que espera snapshot(): el gas ya valuado en USD, con tasa 1. */
  snapBalances: { usdc: number; pol: number; polUsdRate: number };
}

export async function componerFinancials(
  wallet: LectorDeSaldos,
  valuador: Valuador,
  agentId: string,
): Promise<Financials> {
  const balances = await wallet.readBalances(agentId);

  let gasUsdTotal = 0;
  for (const [idStr, per] of Object.entries(balances.byChain)) {
    gasUsdTotal += valuador.gasUsdFor(Number(idStr), per.native);
  }

  const positions = (balances.holdings || [])
    .filter((h) => h.amount > 0)
    .map((h) => {
      const markUsd = valuador.usdForSymbol(h.priceSymbol, h.amount);
      return { strategy: "held", asset: h.symbol, entryUsd: markUsd, currentUsd: markUsd };
    })
    .filter((p) => p.currentUsd > 0);

  return {
    balances,
    positions,
    snapBalances: { usdc: balances.usdc, pol: gasUsdTotal, polUsdRate: 1 },
  };
}
