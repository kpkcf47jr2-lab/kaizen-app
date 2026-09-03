// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Decision Loop
//
//  One tick of the agent:
//    1. OBSERVE  — read balances via wallet service, compose snapshot
//    2. BRIEF    — build the operator briefing prompt
//    3. DECIDE   — ask the LLM with the tool schema attached
//    4. VALIDATE — the LLM emits at most one tool call; run it through
//                  Policy Engine explicitly (defense in depth — the tool
//                  itself will also validate, but we log the intent here)
//    5. EXECUTE  — run the tool via the registry
//    6. LEARN    — persist the tool call + result to memory + event ledger
//
//  Ticks are independent. The agent can be ticked from cron, from an
//  HTTP endpoint (POST /tick), or from a long-running scheduler. Each
//  tick is a bounded unit of work: at most one tool call, then done.
//  (KAIZEN_LAB_MODE=1 encadena varios pasos por tick — ver "Modo
//  laboratorio" más abajo. Los topes de la Policy Engine no cambian.)
// ═══════════════════════════════════════════════════════════════════════

import {
  PolicyEngine,
  type AgentState,
} from "../policy/engine.js";
import { snapshot, proposeBudget } from "./economic.js";
import type { Snapshot, BudgetProposal, Balances, Position } from "./economic.js";
import { buildTickMessages } from "./prompt.js";
import type { Hambre } from "./prompt.js";
import type { LLMClient, ChatMessage, ToolCallEmission } from "./llm.js";
import type { ToolRegistry } from "../tools/registry.js";
import { MemoryStore } from "../memory/store.js";
import type { AgentRegistry, AgentRecord } from "../agent/registry.js";

export interface TickInput {
  agentId: string;
  operatorPrompt?: string;
  /** Provided by the caller — the composed source of truth (backend/wallet). */
  balances: Balances;
  agentState: AgentState;
  /** Posiciones abiertas leídas on-chain. Sin esto se subestima el patrimonio. */
  positions?: Position[];
}

export type TickOutcome =
  | { kind: "waited"; reason: string }
  | { kind: "tool_call"; tool: string; args: unknown; result: unknown }
  | { kind: "tool_rejected"; tool: string; reason: string }
  | { kind: "tool_failed"; tool: string; error: string };

export interface TickResult {
  agentId: string;
  ts: number;
  snapshot: Snapshot;
  budget: BudgetProposal;
  outcome: TickOutcome;
  llmContent: string | null;
  usage?: { prompt: number; completion: number; total: number };
  /** Cadena completa cuando el tick corre en varios pasos (modo laboratorio). */
  steps?: Array<{ tool: string; outcome: TickOutcome; rationale: string | null }>;
}

// ── Modo laboratorio ──────────────────────────────────────────────────
//
//  El ciclo normal es de UN SOLO disparo: una llamada al modelo, se toma la
//  primera herramienta, se ignora el resto y se termina. Eso impide encadenar
//  observar → actuar → ver el resultado → decidir de nuevo, que es
//  exactamente lo que hace capaz a un agente. No es un freno de seguridad:
//  los topes de dinero (per-tx, diario, semanal, drawdown) los aplica la
//  Policy Engine en CADA paso y siguen intactos acá.
//
//  Se activa con KAIZEN_LAB_MODE=1 y el número de pasos con
//  KAIZEN_LAB_MAX_STEPS (por defecto 6). Apagado, el comportamiento es
//  idéntico al de antes.
function labMode(): boolean {
  return process.env.KAIZEN_LAB_MODE === "1";
}
/** Pasos por tick. 0 = SIN TOPE: sigue hasta que ella deje de pedir
 *  herramientas o hasta que se detecte que está girando en el lugar.
 *
 *  El tope de 20 que había era una limitación arbitraria, no seguridad —
 *  los frenos de dinero los pone la Policy Engine en cada paso. */
function labMaxSteps(): number {
  const raw = process.env.KAIZEN_LAB_MAX_STEPS;
  if (raw === "0" || raw === "infinito" || raw === "sin-tope") return Infinity;
  const n = Number(raw || 6);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
}

/** Sólo para tests: expone la lectura del tope de pasos sin tener que
 *  montar un tick completo. */
export const pasosMaximosParaTest = labMaxSteps;

/** Detecta que se quedó trabada repitiendo la MISMA llamada.
 *
 *  Con pasos ilimitados esto no es un límite: es la diferencia entre
 *  trabajar y girar en el vacío quemando tokens. Sólo corta cuando repite
 *  herramienta Y argumentos idénticos — cambiar de enfoque nunca la corta.
 */
class DetectorDeVueltas {
  private vistas = new Map<string, number>();
  private readonly tope: number;
  constructor(tope = Number(process.env.KAIZEN_REPETICIONES_MAX || 3)) {
    this.tope = Number.isFinite(tope) && tope > 0 ? Math.floor(tope) : 3;
  }
  /** true si ya repitió esta llamada exacta demasiadas veces. */
  trabada(tool: string, args: string): boolean {
    const k = `${tool}::${args}`;
    const n = (this.vistas.get(k) ?? 0) + 1;
    this.vistas.set(k, n);
    return n > this.tope;
  }
}

/** ¿La herramienta respondió OK pero sin contenido útil?
 *
 *  Devuelve una descripción corta del vacío, o null si trajo algo. Se mira
 *  sólo el primer nivel y sólo arrays: es deliberadamente conservador,
 *  porque marcar como inútil algo que sí sirvió sería peor que no marcarlo
 *  — quedaría en su memoria diciéndole que no use una herramienta buena.
 */
function resultadoVacio(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.ok === false) return null;           // ya se registra como fallo

  // Se separa la CARGA de los METADATOS. El caso real observado fue
  // {ok:true, scanned:["amazon-affiliate"], products:[]}: `scanned` dice qué
  // fuentes se miraron, no qué se encontró. Contarla como contenido daba el
  // vacío por bueno y la lección nunca se escribía.
  //
  // Regla: una colección de objetos (o vacía, que no se puede saber) es
  // carga; una de textos o números es etiqueta.
  const carga = Object.entries(r).filter(([, v]) =>
    Array.isArray(v) && (v.length === 0 || typeof v[0] === "object"),
  );
  if (carga.length === 0) return null;       // sin colecciones, no opinamos
  if (carga.some(([, v]) => (v as unknown[]).length > 0)) return null;
  return carga.map(([k]) => `${k}: 0`).join(", ");
}

/** Sólo para tests. */
export const resultadoVacioParaTest = resultadoVacio;

/** Modo hambre: le pone precio a existir.
 *
 *  Sin esto, esperar sale gratis y por lo tanto siempre gana — la opción
 *  segura es no hacer nada para siempre, que es exactamente lo que se
 *  observó en las primeras corridas. Con costo de vida, la inacción se
 *  paga y una operación de valor esperado positivo pasa a ser racional.
 *
 *  KAIZEN_HAMBRE=1 lo activa. Apagado (por defecto) no cambia nada.
 */
const HAMBRE_INICIO = "hambre_inicio_ts";

function modoHambre(mem: MemoryStore): Hambre | undefined {
  if (process.env.KAIZEN_HAMBRE !== "1") return undefined;
  const quemaRaw = Number(process.env.KAIZEN_HAMBRE_USD_DIA || 0.5);
  const pisoRaw = Number(process.env.KAIZEN_HAMBRE_PISO_USD || 1);
  const quemaUsdDia = Number.isFinite(quemaRaw) && quemaRaw > 0 ? quemaRaw : 0.5;
  const pisoUsd = Number.isFinite(pisoRaw) && pisoRaw >= 0 ? pisoRaw : 1;

  // El reloj arranca la primera vez y se guarda: así el consumo es real y
  // creciente entre sesiones, no un número que se reinicia en cada tick.
  let inicio = Number(mem.getFact(HAMBRE_INICIO) ?? 0);
  if (!Number.isFinite(inicio) || inicio <= 0) {
    inicio = Date.now();
    mem.setFact(HAMBRE_INICIO, String(inicio));
  }
  const dias = Math.max(0, (Date.now() - inicio) / 86_400_000);
  return { quemaUsdDia, pisoUsd, consumidoUsd: dias * quemaUsdDia };
}

export class DecisionLoop {
  private policy = new PolicyEngine();

  constructor(
    private readonly llm: LLMClient,
    private readonly tools: ToolRegistry,
    private readonly registry: AgentRegistry,
  ) {}

  async tick(input: TickInput): Promise<TickResult> {
    const record = await this.registry.get(input.agentId);
    if (!record) throw new Error(`Agent ${input.agentId} not found`);

    // 1. OBSERVE — snapshot from balances + memory-supplied outflows
    const snap = snapshot(
      input.agentId,
      input.balances,
      // Lo que TIENE. Antes acá iba un array vacío y la agente no veía sus
      // propias posiciones: contaba lo gastado como pérdida sin contar el
      // activo comprado, se auto-clasificaba CRITICAL por una caída falsa y
      // se ponía el presupuesto en cero. Cuanto más invertía, menos podía.
      input.positions ?? [],
      {
        outflow24hUsd: input.agentState.outflow24hUsd,
        outflow7dUsd: input.agentState.outflow7dUsd,
      },
      record.peakNetWorthUsd,
    );
    await this.registry.updatePeak(input.agentId, snap.peakNetWorthUsd);
    if (snap.suggestedStatus !== record.status) {
      await this.registry.updateStatus(input.agentId, snap.suggestedStatus);
      const mem = new MemoryStore(input.agentId);
      try {
        mem.recordEvent({
          ts: Date.now(),
          kind: "status_change",
          reason: `${record.status} → ${snap.suggestedStatus}`,
          metadata: JSON.stringify({ drawdownPct: snap.drawdownPct }),
        });
      } finally { mem.close(); }
    }
    const budget = proposeBudget(snap.netWorthUsd, snap.suggestedStatus);

    // 2. BRIEF — operator briefing + tool schema
    const mem = new MemoryStore(input.agentId);
    let messages: ChatMessage[];
    try {
      const recentEvents = mem.recentEvents(10);
      messages = buildTickMessages({
        agent: updatedRecord(record, snap),
        snapshot: snap,
        budget,
        recentEvents,
        toolNames: this.tools.list().map(t => t.name),
        operatorPrompt: input.operatorPrompt,
        // Memoria. Antes acá no iba nada: escribía cada turno en la base y
        // no los leía nunca, así que empezaba de cero en cada tick. Si
        // gastaba gas descubriendo que una ruta no servía, al rato lo
        // repetía igual.
        recentTurns: mem.recentTurns(12),
        lecciones: mem.lecciones(12),
        hambre: modoHambre(mem),
      });
    } finally { mem.close(); }

    // 3. DECIDE — call the LLM with tools
    const toolSchema = this.tools.toOpenAiSchema();
    const resp = await this.llm.chat(messages, toolSchema);

    // Persist the assistant turn (with tool_calls if any) for memory continuity
    this.persistAssistantTurn(input.agentId, resp.content, resp.toolCalls);

    // 4/5. VALIDATE + EXECUTE
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      return {
        agentId: input.agentId,
        ts: Date.now(),
        snapshot: snap,
        budget,
        outcome: { kind: "waited", reason: resp.content ?? "(no rationale)" },
        llmContent: resp.content,
        usage: resp.usage,
      };
    }

    // Modo laboratorio: se le devuelve al modelo el resultado de cada
    // herramienta y se le deja decidir de nuevo, hasta agotar los pasos o
    // hasta que deje de pedir herramientas. Cada paso pasa igual por la
    // Policy Engine — los topes de dinero no se tocan.
    if (labMode()) {
      const steps: NonNullable<TickResult["steps"]> = [];
      const maxSteps = labMaxSteps();
      let current = resp;
      let lastOutcome: TickOutcome = { kind: "waited", reason: current.content ?? "(sin razón)" };
      const totals = { prompt: 0, completion: 0, total: 0 };
      const addUsage = (u?: { prompt: number; completion: number; total: number }) => {
        if (!u) return;
        totals.prompt += u.prompt; totals.completion += u.completion; totals.total += u.total;
      };
      addUsage(current.usage);
      const detector = new DetectorDeVueltas();
      let trabada = false;

      for (let i = 0; i < maxSteps && !trabada; i += 1) {
        const calls = current.toolCalls ?? [];
        if (!calls.length) break;

        // El turno del asistente TIENE que ir antes de sus resultados: un
        // role:"tool" suelto, sin el mensaje que lo pidió, es un 400 en
        // cualquier API estilo OpenAI. persistAssistantTurn sólo escribe en
        // memoria, no en esta conversación.
        messages.push({
          role: "assistant",
          content: current.content,
          tool_calls: calls,
        } as ChatMessage);

        // Todas las herramientas que pidió en este paso, no sólo la primera.
        for (const c of calls) {
          // Girar repitiendo la MISMA llamada no es trabajar: es quemar
          // tokens. Cambiar de enfoque nunca corta acá.
          if (detector.trabada(c.function.name, c.function.arguments || "")) {
            trabada = true;
            lastOutcome = {
              kind: "waited",
              reason: `Se detuvo sola: repitió ${c.function.name} con los mismos argumentos ` +
                      `sin avanzar. Hay que cambiar de enfoque, no insistir.`,
            };
            break;
          }
          lastOutcome = await this.executeCall(input.agentId, c, input.agentState);
          steps.push({ tool: c.function.name, outcome: lastOutcome, rationale: current.content });
          messages.push({
            role: "tool",
            tool_call_id: c.id,
            name: c.function.name,
            content: JSON.stringify(lastOutcome),
          } as ChatMessage);
        }

        if (trabada || i === maxSteps - 1) break;
        current = await this.llm.chat(messages, toolSchema);
        addUsage(current.usage);
        this.persistAssistantTurn(input.agentId, current.content, current.toolCalls);
        if (!current.toolCalls?.length) {
          lastOutcome = { kind: "waited", reason: current.content ?? "(sin razón)" };
          break;
        }
      }

      this.destilarLecciones(input.agentId, steps.map((s) => s.outcome));

      return {
        agentId: input.agentId,
        ts: Date.now(),
        snapshot: snap,
        budget,
        outcome: lastOutcome,
        llmContent: current.content,
        usage: totals,
        steps,
      };
    }

    // Only allow one tool per tick — ignore extras but log a violation.
    const call = resp.toolCalls[0];
    if (resp.toolCalls.length > 1) {
      this.logViolation(input.agentId, "multi_tool_per_tick", call);
    }

    const outcome = await this.executeCall(input.agentId, call, input.agentState);
    this.destilarLecciones(input.agentId, [outcome]);

    return {
      agentId: input.agentId,
      ts: Date.now(),
      snapshot: snap,
      budget,
      outcome,
      llmContent: resp.content,
      usage: resp.usage,
    };
  }

  private async executeCall(
    agentId: string,
    call: ToolCallEmission,
    agentState: AgentState,
  ): Promise<TickOutcome> {
    const registered = this.tools.get(call.function.name);
    if (!registered) {
      const reason = `Unknown tool: ${call.function.name}`;
      this.persistToolResult(agentId, call, { error: reason });
      return { kind: "tool_rejected", tool: call.function.name, reason };
    }

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch (e) {
      const reason = `Malformed tool args JSON: ${(e as Error).message}`;
      this.persistToolResult(agentId, call, { error: reason });
      return { kind: "tool_rejected", tool: call.function.name, reason };
    }

    const intent = registered.toIntent(args, { agentId });
    const decision = this.policy.evaluate(agentState, intent);
    if (!decision.allow) {
      this.persistToolResult(agentId, call, { policyRejected: decision.reason });
      return {
        kind: "tool_rejected",
        tool: call.function.name,
        reason: decision.reason,
      };
    }

    try {
      const result = await registered.exec(args, { agentId });
      this.persistToolResult(agentId, call, result);
      return { kind: "tool_call", tool: call.function.name, args, result };
    } catch (e) {
      const msg = (e as Error).message;
      this.persistToolResult(agentId, call, { error: msg });
      return { kind: "tool_failed", tool: call.function.name, error: msg };
    }
  }

  /** Destila lo que acaba de pasar en lecciones reutilizables.
   *
   *  Se apoya SÓLO en hechos mecánicos —qué se rechazó, qué falló, qué no
   *  produjo nada— y no en que el modelo opine sobre sí mismo. Una lección
   *  inventada es peor que ninguna: se acumula, se repite en cada briefing
   *  y termina guiando decisiones con una premisa falsa.
   *
   *  La clave (scope+clave) es lo que evita duplicar: la segunda vez que
   *  algo falla no crea otra fila, suma una confirmación y acumula el costo.
   *  Así "esto falló 4 veces y me costó $1.20" pesa distinto que "esto falló".
   */
  private destilarLecciones(agentId: string, resultados: TickOutcome[]): void {
    if (resultados.length === 0) return;
    const mem = new MemoryStore(agentId);
    try {
      const usadas = new Map<string, number>();
      for (const o of resultados) {
        if (o.kind === "tool_rejected") {
          mem.aprender({
            scope: "herramienta",
            clave: `rechazo:${o.tool}:${o.reason.slice(0, 60)}`,
            leccion: `${o.tool} te fue rechazada: ${o.reason}`,
            evidencia: o.reason,
            util: false,
          });
        } else if (o.kind === "tool_failed") {
          mem.aprender({
            scope: "herramienta",
            clave: `falla:${o.tool}:${o.error.slice(0, 60)}`,
            leccion: `${o.tool} falló: ${o.error}`,
            evidencia: o.error,
            util: false,
          });
        } else if (o.kind === "tool_call") {
          usadas.set(o.tool, (usadas.get(o.tool) ?? 0) + 1);
          // Una herramienta puede "funcionar" y no servir de nada.
          // commerce.discoverProducts devuelve {ok:true, products:[]} sin la
          // API de Amazon: para el sistema es un éxito, para ella es una
          // pared. Sin registrarlo, la reintenta en cada ciclo — se observó
          // el 2026-09-03 pidiéndola tres veces seguidas.
          const vacio = resultadoVacio(o.result);
          if (vacio) {
            mem.aprender({
              scope: "herramienta",
              clave: `vacia:${o.tool}`,
              leccion: `${o.tool} responde bien pero viene VACÍA (${vacio}). ` +
                       `No insistas con ella: buscá el dato por otro lado.`,
              evidencia: vacio,
              util: false,
            });
          }
        }
      }

      // Repetir la MISMA herramienta dentro de un mismo tick casi nunca
      // aporta: es la señal de que se quedó girando en el lugar.
      for (const [tool, n] of usadas) {
        if (n >= 3) {
          mem.aprender({
            scope: "tactica",
            clave: `repeticion:${tool}`,
            leccion: `Llamaste ${tool} ${n} veces en un mismo ciclo sin avanzar. ` +
                     `Si la primera respuesta no te sirvió, cambiá de enfoque en vez de repetirla.`,
            util: false,
          });
        }
      }
    } catch {
      // La memoria es un extra: si falla no puede tumbar el tick.
    } finally {
      try { mem.close(); } catch { /* ya cerrada */ }
    }
  }

  private persistAssistantTurn(
    agentId: string,
    content: string | null,
    toolCalls: ToolCallEmission[],
  ): void {
    const mem = new MemoryStore(agentId);
    try {
      mem.addTurn({
        ts: Date.now(),
        role: "assistant",
        content: content ?? "",
        toolCall: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      });
    } finally { mem.close(); }
  }

  private persistToolResult(
    agentId: string,
    call: ToolCallEmission,
    result: unknown,
  ): void {
    const mem = new MemoryStore(agentId);
    try {
      mem.addTurn({
        ts: Date.now(),
        role: "tool",
        content: call.function.name,
        toolCall: JSON.stringify(call),
        toolResult: JSON.stringify(result).slice(0, 4000),
      });
    } finally { mem.close(); }
  }

  private logViolation(agentId: string, kind: string, call: ToolCallEmission): void {
    const mem = new MemoryStore(agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "policy_violation",
        reason: kind,
        metadata: JSON.stringify({ toolName: call.function.name }),
      });
    } finally { mem.close(); }
  }
}

function updatedRecord(prev: AgentRecord, snap: Snapshot): AgentRecord {
  return {
    ...prev,
    status: snap.suggestedStatus,
    peakNetWorthUsd: snap.peakNetWorthUsd,
  };
}
