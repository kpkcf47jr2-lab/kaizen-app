// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — precio real de los tokens nativos.
//
//  Hasta ahora las tasas estaban hardcodeadas: ETH a $3200 y POL a $0.50.
//  El 2026-09-03 ETH valía $2494.86, o sea que el patrimonio de la agente
//  se reportaba 28% inflado — decía $7.55 cuando tenía $6.55.
//
//  Eso no es un detalle cosmético: la Policy Engine decide con ese número.
//  Con un precio inventado la agente puede creer que ganó plata que no
//  ganó, o al revés clasificarse en crisis por una caída que no ocurrió.
//  Y hace imposible responder la pregunta del dueño —¿ganó 50 centavos por
//  mérito propio?— porque el ruido del precio falso tapa la señal.
//
//  Diseño: se consulta una fuente pública, se cachea, y ante CUALQUIER
//  fallo se conserva la última tasa buena. Nunca devuelve 0 ni rompe el
//  arranque: una caída de la API no puede dejar a la agente sin poder
//  valuar lo que tiene.
// ═══════════════════════════════════════════════════════════════════════

/** Símbolo de CoinGecko para el nativo de cada cadena. */
const COINGECKO_ID_BY_CHAIN: Record<number, string> = {
  137: "matic-network",   // POL (ex-MATIC)
  8453: "ethereum",       // Base usa ETH
};

export interface PriceFeedOptions {
  /** Tasas de arranque. Se usan hasta el primer refresh y como red de
   *  seguridad si la fuente nunca responde. */
  fallback: Record<number, number>;
  /** Cuánto vale una consulta antes de repetirla. Por defecto 5 minutos. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}

export class PriceFeed {
  private rates: Record<number, number>;
  private lastOkTs = 0;
  private readonly ttlMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: PriceFeedOptions) {
    this.rates = { ...opts.fallback };
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Última tasa conocida por cadena. Siempre devuelve algo usable. */
  current(): Record<number, number> {
    return { ...this.rates };
  }

  /** Edad de la última consulta exitosa, en ms. Infinity si nunca hubo. */
  ageMs(): number {
    return this.lastOkTs === 0 ? Infinity : Date.now() - this.lastOkTs;
  }

  /** true si la tasa vigente es la de arranque y no una consultada. */
  isStale(): boolean {
    return this.ageMs() > this.ttlMs;
  }

  /** Consulta la fuente y actualiza. No lanza: ante un fallo deja las
   *  tasas como estaban y avisa por el valor de retorno. */
  async refresh(): Promise<{ ok: boolean; rates: Record<number, number>; reason?: string }> {
    const ids = [...new Set(Object.values(COINGECKO_ID_BY_CHAIN))].join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      let body: Record<string, { usd?: number }>;
      try {
        const res = await this.doFetch(url, { signal: ctl.signal });
        if (!res.ok) return { ok: false, rates: this.current(), reason: `HTTP ${res.status}` };
        body = (await res.json()) as Record<string, { usd?: number }>;
      } finally {
        clearTimeout(timer);
      }

      // Se acepta la respuesta sólo si trae un número positivo. Un 0 o un
      // null valuaría todo en cero y dispararía una crisis fantasma.
      const next: Record<number, number> = { ...this.rates };
      let algunaBuena = false;
      for (const [chainIdStr, cgId] of Object.entries(COINGECKO_ID_BY_CHAIN)) {
        const usd = body?.[cgId]?.usd;
        if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
          next[Number(chainIdStr)] = usd;
          algunaBuena = true;
        }
      }
      if (!algunaBuena) {
        return { ok: false, rates: this.current(), reason: "respuesta sin precios válidos" };
      }

      this.rates = next;
      this.lastOkTs = Date.now();
      return { ok: true, rates: this.current() };
    } catch (e) {
      return { ok: false, rates: this.current(), reason: (e as Error).message };
    }
  }
}
