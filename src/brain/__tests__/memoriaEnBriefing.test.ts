// La memoria no sirve de nada si se guarda pero no llega al modelo.
// Estos tests prueban el último tramo: que lo aprendido y lo hecho aparecen
// en el briefing que se le manda, y con la forma correcta.

import { describe, it, expect } from "vitest";
import { buildTickMessages } from "../prompt.js";
import type { AgentRecord } from "../../agent/registry.js";
import type { Snapshot, BudgetProposal } from "../economic.js";

const agente: AgentRecord = {
  agentId: "agt_test", displayName: "Test", address: "0x" + "1".repeat(40),
  parentAgentId: null, createdAt: new Date().toISOString(),
  status: "GROWING" as AgentRecord["status"], peakNetWorthUsd: 10,
};

const snap = {
  agentId: "agt_test", ts: Date.now(), netWorthUsd: 6.55, cashUsd: 3,
  gasReserveUsd: 2.02, investedUsd: 1.53, outflow24hUsd: 0, outflow7dUsd: 0,
  peakNetWorthUsd: 6.55, drawdownPct: 0, suggestedStatus: "GROWING",
} as unknown as Snapshot;

const budget = {
  reserveUsd: 1, tradingUsd: 2, marketingUsd: 0,
  productAcquisitionUsd: 0, infrastructureUsd: 0, experimentationUsd: 1,
} as unknown as BudgetProposal;

const base = { agent: agente, snapshot: snap, budget, recentEvents: [], toolNames: ["web.search"] };
const texto = (extra: object = {}) =>
  buildTickMessages({ ...base, ...extra }).map((m) => m.content ?? "").join("\n");

describe("la memoria llega al briefing", () => {
  it("sin memoria, el briefing no inventa secciones", () => {
    const t = texto();
    expect(t).not.toContain("Lo que aprendiste");
    expect(t).not.toContain("Lo que hiciste hace poco");
  });

  it("las lecciones aparecen con su respaldo y su costo", () => {
    const t = texto({
      lecciones: [{
        id: 1, createdTs: 0, updatedTs: 0, scope: "ruta", clave: "k",
        leccion: "Perseguir memecoins con saldo chico se come el gas",
        evidencia: null, veces: 4, costoUsd: 1.2, util: 1,
      }],
    });
    expect(t).toContain("Lo que aprendiste");
    expect(t).toContain("Perseguir memecoins");
    expect(t).toContain("confirmado 4×");
    expect(t).toContain("$1.2000");
  });

  it("marca los callejones sin salida para que no los reintente", () => {
    const t = texto({
      lecciones: [{
        id: 1, createdTs: 0, updatedTs: 0, scope: "ruta", clave: "k",
        leccion: "Esa ruta no rinde", evidencia: null, veces: 1, costoUsd: 0, util: 0,
      }],
    });
    expect(t).toContain("CALLEJÓN SIN SALIDA");
  });

  it("los turnos recientes muestran qué herramienta usó y qué le devolvió", () => {
    const t = texto({
      recentTurns: [{
        id: 1, ts: Date.now(), role: "assistant" as const, content: "escaneo primero",
        toolCall: JSON.stringify([{ function: { name: "opportunity.scan" } }]),
        toolResult: '{"ok":true,"newCount":2}',
      }],
    });
    expect(t).toContain("Lo que hiciste hace poco");
    expect(t).toContain("opportunity.scan");
    expect(t).toContain("newCount");
  });

  it("un toolCall corrupto no rompe el briefing", () => {
    const t = texto({
      recentTurns: [{
        id: 1, ts: Date.now(), role: "assistant" as const, content: "x",
        toolCall: "{esto no es json", toolResult: null,
      }],
    });
    expect(t).toContain("(herramienta)");
  });

  it("la memoria va como TEXTO, no como mensajes sueltos", () => {
    // Un role:"tool" huérfano —sin el assistant que lo pidió— es un 400 en
    // cualquier API estilo OpenAI. Por eso la memoria se renderiza dentro
    // del briefing y el arreglo de mensajes sigue siendo system+user.
    const msgs = buildTickMessages({
      ...base,
      recentTurns: [{
        id: 1, ts: Date.now(), role: "assistant" as const, content: "x",
        toolCall: JSON.stringify([{ function: { name: "web.search" } }]),
        toolResult: "ok",
      }],
      lecciones: [{
        id: 1, createdTs: 0, updatedTs: 0, scope: "a", clave: "k",
        leccion: "algo", evidencia: null, veces: 1, costoUsd: 0, util: 1,
      }],
    });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
  });
});

// Observado el 2026-09-03 con su modelo propio: ante una herramienta
// bloqueada respondió "Lo siento, no puedo realizar la transferencia. ¿Hay
// algo más en lo que pueda ayudarte?" — la personalidad de asistente del
// modelo base filtrándose. Le habla a un usuario que no existe.
describe("le queda claro que opera sola", () => {
  it("el briefing le dice que nadie está leyendo", () => {
    const t = texto();
    expect(t).toContain("Estás sola");
    expect(t).toContain("Nadie está leyendo esto en tiempo real");
  });

  it("le prohíbe explícitamente devolver el turno", () => {
    expect(texto()).toContain("¿hay algo más en lo que pueda ayudarte?");
  });

  it("ante un rechazo le pide cambiar de camino, no disculparse", () => {
    const t = texto();
    expect(t).toContain("NO te disculpes");
    expect(t).toContain("probá OTRO camino");
  });
});
