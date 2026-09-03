// Modo hambre y pasos sin tope.
//
// El hallazgo que motivó esto: en cuatro corridas la agente investigó bien,
// concluyó correctamente que no había nada bueno, y no hizo nada. Sin costo
// de vida, esperar es gratis — y una opción gratis siempre le gana a una
// que arriesga. Ponerle precio a la inacción cambia ese cálculo.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTickMessages } from "../prompt.js";
import type { AgentRecord } from "../../agent/registry.js";
import type { Snapshot, BudgetProposal } from "../economic.js";

const agente: AgentRecord = {
  agentId: "agt_test", displayName: "Test", address: "0x" + "1".repeat(40),
  parentAgentId: null, createdAt: new Date().toISOString(),
  status: "GROWING" as AgentRecord["status"], peakNetWorthUsd: 10,
};

const snapCon = (neto: number) => ({
  agentId: "agt_test", ts: Date.now(), netWorthUsd: neto, cashUsd: 3,
  gasReserveUsd: 2, investedUsd: 1.5, outflow24hUsd: 0, outflow7dUsd: 0,
  peakNetWorthUsd: 10, drawdownPct: 0, suggestedStatus: "GROWING",
} as unknown as Snapshot);

const budget = {
  reserveUsd: 1, tradingUsd: 2, marketingUsd: 0,
  productAcquisitionUsd: 0, infrastructureUsd: 0, experimentationUsd: 1,
} as unknown as BudgetProposal;

const texto = (neto: number, hambre?: { quemaUsdDia: number; pisoUsd: number; consumidoUsd?: number }) =>
  buildTickMessages({
    agent: agente, snapshot: snapCon(neto), budget,
    recentEvents: [], toolNames: ["web.search"],
    hambre: hambre ? { consumidoUsd: 0, ...hambre } : undefined,
  }).map((m) => m.content ?? "").join("\n");

describe("modo hambre", () => {
  it("apagado, el briefing no menciona supervivencia", () => {
    expect(texto(6.55)).not.toContain("MODO HAMBRE");
  });

  it("encendido, le dice cuánto cuesta existir y cuándo se apaga", () => {
    const t = texto(6.55, { quemaUsdDia: 0.5, pisoUsd: 1 });
    expect(t).toContain("MODO HAMBRE");
    expect(t).toContain("$0.50 por día");
    expect(t).toContain("baja de $1.00");
  });

  it("con poca autonomía avisa en HORAS, que aprieta más que días", () => {
    // (2.00 − 1.00) / 1.00 = 1 día = 24 horas
    const t = texto(2, { quemaUsdDia: 1, pisoUsd: 1 });
    expect(t).toContain("TE QUEDAN 24.0 HORAS");
  });

  it("con holgura habla en días", () => {
    // (11 − 1) / 0.5 = 20 días
    const t = texto(11, { quemaUsdDia: 0.5, pisoUsd: 1 });
    expect(t).toContain("20.0 días");
  });

  it("bajo el piso no calcula autonomía negativa", () => {
    // Decirle "te quedan −13 horas" no significa nada; se satura en cero.
    const t = texto(0.5, { quemaUsdDia: 0.5, pisoUsd: 1 });
    expect(t).toContain("MODO HAMBRE");
    expect(t).toContain("0.0 HORAS");
    expect(t).not.toMatch(/-\d+(\.\d+)?\s*(HORAS|días)/);
  });

  it("empuja a actuar pero NO a apostar a ciegas", () => {
    const t = texto(6.55, { quemaUsdDia: 0.5, pisoUsd: 1 });
    // La presión sin este contrapeso produce lotería, no ingreso.
    expect(t).toContain("Esperar NO es gratis");
    expect(t).toContain("no entendés");
    expect(t).toContain("no lotería");
  });
});

// El tope de pasos vive en decisionLoop; se prueba su lectura del entorno
// a través del comportamiento observable del modo laboratorio.
describe("pasos sin tope", () => {
  beforeEach(() => { process.env.KAIZEN_LAB_MODE = "1"; });
  afterEach(() => {
    delete process.env.KAIZEN_LAB_MODE;
    delete process.env.KAIZEN_LAB_MAX_STEPS;
  });

  it("acepta 0, 'infinito' y 'sin-tope' como sin límite", async () => {
    const { pasosMaximosParaTest } = await import("../decisionLoop.js");
    for (const v of ["0", "infinito", "sin-tope"]) {
      process.env.KAIZEN_LAB_MAX_STEPS = v;
      expect(pasosMaximosParaTest(), `falló con "${v}"`).toBe(Infinity);
    }
  });

  it("un número lo respeta tal cual, sin recortarlo a 20", async () => {
    const { pasosMaximosParaTest } = await import("../decisionLoop.js");
    process.env.KAIZEN_LAB_MAX_STEPS = "150";
    expect(pasosMaximosParaTest()).toBe(150);
  });

  it("un valor basura cae al default y no rompe", async () => {
    const { pasosMaximosParaTest } = await import("../decisionLoop.js");
    process.env.KAIZEN_LAB_MAX_STEPS = "no-soy-un-numero";
    expect(pasosMaximosParaTest()).toBe(6);
  });
});

describe("el reloj del hambre lo hace real, no relato", () => {
  it("lo ya consumido se descuenta de la autonomía", () => {
    // (11 − 1 − 5) / 0.5 = 10 días, no 20.
    const t = texto(11, { quemaUsdDia: 0.5, pisoUsd: 1, consumidoUsd: 5 });
    expect(t).toContain("10.0 días");
    expect(t).toContain("consumidos $5.0000");
  });

  it("consumir lo suficiente la deja sin autonomía", () => {
    const t = texto(6.55, { quemaUsdDia: 0.5, pisoUsd: 1, consumidoUsd: 99 });
    expect(t).toContain("0.0 HORAS");
  });

  it("le muestra el consumido para que la cuenta le cierre", () => {
    // Si le decimos que existir cuesta pero su saldo nunca baja, la cuenta
    // no cierra y deja de tomárselo en serio.
    const t = texto(6.55, { quemaUsdDia: 0.5, pisoUsd: 1, consumidoUsd: 0.25 });
    expect(t).toContain("consumidos $0.2500");
  });
});

// Una herramienta puede "funcionar" y no servir. commerce.discoverProducts
// devuelve {ok:true, products:[]} sin API de Amazon: éxito para el sistema,
// pared para ella. Observado el 2026-09-03 pidiéndola tres veces seguidas.
describe("detectar herramientas que responden vacías", () => {
  let vacio: (r: unknown) => string | null;
  beforeEach(async () => {
    ({ resultadoVacioParaTest: vacio } = await import("../decisionLoop.js"));
  });

  it("marca el caso real: ok:true con lista vacía", () => {
    expect(vacio({ ok: true, scanned: ["amazon"], products: [] })).toContain("products: 0");
  });

  it("NO marca cuando trajo resultados", () => {
    expect(vacio({ ok: true, products: [{ id: 1 }] })).toBeNull();
  });

  it("NO marca si alguna colección trae algo, aunque otra esté vacía", () => {
    expect(vacio({ ok: true, products: [], results: [{ a: 1 }] })).toBeNull();
  });

  it("no opina de resultados sin colecciones — un swap devuelve un hash, no una lista", () => {
    expect(vacio({ ok: true, txHash: "0xabc" })).toBeNull();
  });

  it("deja los fallos al otro camino, que ya los registra", () => {
    expect(vacio({ ok: false, results: [] })).toBeNull();
  });

  it("no rompe con basura", () => {
    for (const x of [null, undefined, 42, "texto", []]) {
      expect(() => vacio(x)).not.toThrow();
    }
  });
});

describe("carga útil vs metadato", () => {
  let vacio: (r: unknown) => string | null;
  beforeEach(async () => {
    ({ resultadoVacioParaTest: vacio } = await import("../decisionLoop.js"));
  });

  it("una lista de textos es metadato, no contenido — el caso que falló", () => {
    // Respuesta REAL de commerce.discoverProducts sin API de Amazon.
    expect(vacio({ ok: true, scanned: ["amazon-affiliate"], products: [] }))
      .toContain("products: 0");
  });

  it("no confunde un scan que sí trajo oportunidades", () => {
    expect(vacio({ ok: true, scanned: ["predict"], opportunities: [{ id: 1 }] })).toBeNull();
  });
});
