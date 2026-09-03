// El feed de precios decide cuánto cree tener la agente, y la Policy Engine
// decide con ese número. Un fallo silencioso acá le pone el presupuesto en
// cero por una crisis que no existe, así que los modos de falla importan
// más que el camino feliz.

import { describe, it, expect } from "vitest";
import { PriceFeed } from "../feed.js";

const FALLBACK = { 137: 0.5, 8453: 3200 };

function feedCon(respuesta: unknown, ok = true): PriceFeed {
  const fake = (async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => respuesta,
  })) as unknown as typeof fetch;
  return new PriceFeed({ fallback: FALLBACK, fetchImpl: fake });
}

describe("PriceFeed", () => {
  it("arranca con las tasas de respaldo antes de consultar nada", () => {
    const f = new PriceFeed({ fallback: FALLBACK });
    expect(f.current()).toEqual(FALLBACK);
    expect(f.ageMs()).toBe(Infinity);
    expect(f.isStale()).toBe(true);
  });

  it("adopta los precios reales cuando la fuente responde bien", async () => {
    const f = feedCon({ ethereum: { usd: 2494.86 }, "matic-network": { usd: 0.23 } });
    const r = await f.refresh();
    expect(r.ok).toBe(true);
    expect(f.current()[8453]).toBe(2494.86);
    expect(f.current()[137]).toBe(0.23);
    expect(f.isStale()).toBe(false);
  });

  it("conserva la última tasa buena si la fuente se cae", async () => {
    const f = feedCon({ ethereum: { usd: 2494.86 }, "matic-network": { usd: 0.23 } });
    await f.refresh();

    const rota = new PriceFeed({
      fallback: FALLBACK,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const r = await rota.refresh();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ECONNREFUSED");
    // No se queda en cero: sigue valuando con el respaldo.
    expect(rota.current()).toEqual(FALLBACK);
  });

  it("RECHAZA un precio de cero — valuaría todo en cero y dispararía una crisis falsa", async () => {
    const f = feedCon({ ethereum: { usd: 0 }, "matic-network": { usd: 0 } });
    const r = await f.refresh();
    expect(r.ok).toBe(false);
    expect(f.current()[8453]).toBe(3200);
  });

  it("rechaza null, negativos y no-números", async () => {
    for (const malo of [null, -5, "2494", undefined, NaN]) {
      const f = feedCon({ ethereum: { usd: malo }, "matic-network": { usd: malo } });
      const r = await f.refresh();
      expect(r.ok, `aceptó ${String(malo)}`).toBe(false);
      expect(f.current()[8453]).toBe(3200);
    }
  });

  it("si sólo una cadena viene bien, actualiza esa y deja la otra intacta", async () => {
    const f = feedCon({ ethereum: { usd: 2494.86 }, "matic-network": { usd: 0 } });
    const r = await f.refresh();
    expect(r.ok).toBe(true);
    expect(f.current()[8453]).toBe(2494.86);
    expect(f.current()[137]).toBe(0.5); // el respaldo, no un cero
  });

  it("un HTTP no-OK no pisa las tasas", async () => {
    const f = feedCon({}, false);
    const r = await f.refresh();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("503");
    expect(f.current()).toEqual(FALLBACK);
  });

  it("una respuesta con forma inesperada no rompe ni pisa", async () => {
    const f = feedCon({ cualquier: "cosa" });
    const r = await f.refresh();
    expect(r.ok).toBe(false);
    expect(f.current()).toEqual(FALLBACK);
  });
});
