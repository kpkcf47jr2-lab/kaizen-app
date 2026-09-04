// En modo laboratorio la conversación crece con cada paso hasta reventar la
// ventana: "maximum context length is 16384 tokens" mata el ciclo entero.
//
// Lo que estos tests protegen es la interacción entre DOS arreglos: recortar
// no puede reintroducir el bug del assistant→tool huérfano. El ContextTrimmer
// del runtime corta en un punto fijo y sí puede dejar un role:"tool"
// encabezando la cola — eso es un 400.

import { describe, it, expect } from "vitest";
import { recortarConversacion } from "../decisionLoop.js";
import type { ChatMessage } from "../llm.js";

const sys = (c: string): ChatMessage => ({ role: "system", content: c });
const usr = (c: string): ChatMessage => ({ role: "user", content: c });
const asis = (c: string, id?: string): ChatMessage => ({
  role: "assistant", content: c,
  ...(id ? { tool_calls: [{ id, type: "function" as const, function: { name: "web.search", arguments: "{}" } }] } : {}),
});
const herr = (id: string, c: string): ChatMessage => ({
  role: "tool", tool_call_id: id, name: "web.search", content: c,
});

/** Invariante que no se puede romper nunca: todo tool va precedido por el
 *  assistant que lo pidió, o por la nota de recorte. */
function sinHuerfanos(msgs: ChatMessage[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role !== "tool") continue;
    const prev = msgs.slice(0, i).reverse().find((m) => m.role === "assistant");
    if (!prev?.tool_calls) return false;
  }
  return true;
}

describe("recortarConversacion", () => {
  it("no toca nada si entra en el presupuesto", () => {
    const c = [sys("s"), usr("briefing"), asis("hola")];
    expect(recortarConversacion(c, 10_000)).toBe(c);
  });

  it("recorta cuando se pasa", () => {
    const largo = "x".repeat(500);
    const c: ChatMessage[] = [sys("s"), usr("briefing")];
    for (let i = 0; i < 20; i++) { c.push(asis(largo, `c${i}`)); c.push(herr(`c${i}`, largo)); }
    const r = recortarConversacion(c, 3000);
    expect(r.length).toBeLessThan(c.length);
    expect(r.reduce((n, m) => n + (m.content?.length ?? 0), 0)).toBeLessThanOrEqual(4000);
  });

  it("NUNCA deja un tool huérfano — el bug que sería un 400", () => {
    const largo = "y".repeat(400);
    for (const presupuesto of [1200, 2000, 3000, 5000, 8000]) {
      const c: ChatMessage[] = [sys("s"), usr("briefing")];
      for (let i = 0; i < 25; i++) { c.push(asis(largo, `c${i}`)); c.push(herr(`c${i}`, largo)); }
      const r = recortarConversacion(c, presupuesto);
      expect(sinHuerfanos(r), `huérfano con presupuesto ${presupuesto}`).toBe(true);
    }
  });

  it("conserva el system y el briefing — su identidad y su tarea", () => {
    const largo = "z".repeat(600);
    const c: ChatMessage[] = [sys("SOY KAIZEN"), usr("BRIEFING CON MI ESTADO")];
    for (let i = 0; i < 20; i++) { c.push(asis(largo, `c${i}`)); c.push(herr(`c${i}`, largo)); }
    const r = recortarConversacion(c, 2500);
    expect(r[0]!.content).toBe("SOY KAIZEN");
    expect(r[1]!.content).toBe("BRIEFING CON MI ESTADO");
  });

  it("le avisa que se recortó, para que no crea que perdió la cabeza", () => {
    const largo = "w".repeat(600);
    const c: ChatMessage[] = [sys("s"), usr("b")];
    for (let i = 0; i < 20; i++) { c.push(asis(largo, `c${i}`)); c.push(herr(`c${i}`, largo)); }
    const r = recortarConversacion(c, 2500);
    expect(r.some((m) => (m.content ?? "").includes("se recortaron"))).toBe(true);
  });

  it("conserva los pasos MÁS RECIENTES, que son los que importan", () => {
    const largo = "q".repeat(500);
    const c: ChatMessage[] = [sys("s"), usr("b")];
    for (let i = 0; i < 20; i++) { c.push(asis(largo, `c${i}`)); c.push(herr(`c${i}`, `RESULTADO-${i}`)); }
    const r = recortarConversacion(c, 3000);
    const texto = r.map((m) => m.content ?? "").join(" ");
    expect(texto).toContain("RESULTADO-19");
    expect(texto).not.toContain("RESULTADO-0 ");
  });

  it("no rompe con conversaciones cortas o raras", () => {
    expect(() => recortarConversacion([], 100)).not.toThrow();
    expect(() => recortarConversacion([sys("s")], 1)).not.toThrow();
    expect(() => recortarConversacion([herr("c1", "suelto")], 1)).not.toThrow();
  });
});

// El recortador presupuestaba SÓLO los mensajes, ignorando que en la misma
// petición viajan los esquemas de las 36 herramientas (~20.000 caracteres) y
// el espacio para la respuesta. Por eso reventaba con "maximum context length
// is 16384 tokens" pese a estar recortando.
describe("presupuesto — descuenta todo lo que viaja en la petición", () => {
  it("con los esquemas reales deja un presupuesto que SÍ entra", async () => {
    const { presupuestoDeConversacion } = await import("../decisionLoop.js");
    const p = presupuestoDeConversacion(20_376);   // 36 herramientas medidas
    const tokensConversacion = p / 2.5;
    const tokensEsquemas = 20_376 / 2.5;
    expect(tokensConversacion + tokensEsquemas + 768).toBeLessThan(16_384);
  });

  it("a más herramientas, menos conversación", async () => {
    const { presupuestoDeConversacion } = await import("../decisionLoop.js");
    expect(presupuestoDeConversacion(40_000)).toBeLessThan(presupuestoDeConversacion(10_000));
  });

  it("nunca devuelve un presupuesto absurdo, aunque los esquemas sean enormes", async () => {
    const { presupuestoDeConversacion } = await import("../decisionLoop.js");
    // Sin piso, la agente quedaría sin poder mandar ni el briefing.
    expect(presupuestoDeConversacion(500_000)).toBeGreaterThanOrEqual(2000);
  });

  it("se adapta si el modelo tiene otra ventana", async () => {
    const { presupuestoDeConversacion } = await import("../decisionLoop.js");
    expect(presupuestoDeConversacion(20_376, 32_768)).toBeGreaterThan(
      presupuestoDeConversacion(20_376, 16_384));
  });
});
