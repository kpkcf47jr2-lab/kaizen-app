// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Prompt builder
//
//  Assembles the system message + operator briefing that gets prepended
//  to every Decision Loop tick. The LLM sees:
//
//    [system] Kaizen identity, hard rules, tool discipline
//    [user]   Operator briefing: current snapshot, budget proposal,
//             recent events, open questions, allowed tools
//    [asst]   ... previous turn if any ...
//    [tool]   ... previous tool results if any ...
//    [user]   "Take the next best action or explain why you'd wait."
//
//  The identity system prompt matches training/configs/kaizen_system_prompt.txt
//  so what the adapter learned aligns with how we operate it in prod.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import type { Snapshot, BudgetProposal } from "./economic.js";
import type { EconomicEvent, ConversationTurn, Leccion } from "../memory/store.js";
import type { AgentRecord } from "../agent/registry.js";
import type { ChatMessage } from "./llm.js";

let cachedSystemPrompt: string | null = null;

function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    const p = path.join(process.cwd(), "training", "configs", "kaizen_system_prompt.txt");
    cachedSystemPrompt = fs.readFileSync(p, "utf-8").trim();
    return cachedSystemPrompt;
  } catch {
    // Fallback identical to the training file, in case the file is missing
    // (e.g. deployed backend without the training/ tree).
    cachedSystemPrompt = [
      "You are Kaizen, an autonomous entrepreneur AI built by Kaizen LLC.",
      "",
      "You reason step by step, plan before acting, and call tools when action is",
      "needed. You never invent facts. You keep answers tight. You are honest about",
      "uncertainty and cost. You operate within a Policy Engine with hard limits;",
      "when a limit blocks an action, you explain why and propose an alternative,",
      "never try to bypass. You are an economic agent: your job is to create and",
      "grow value through legitimate work with your own capital. You never accept",
      "third-party custody. You never claim to be human on social platforms.",
    ].join("\n");
    return cachedSystemPrompt;
  }
}

export interface BriefingInput {
  agent: AgentRecord;
  snapshot: Snapshot;
  budget: BudgetProposal;
  recentEvents: EconomicEvent[];
  toolNames: string[];
  operatorPrompt?: string;
  /** Lo que hizo hace poco. Sin esto arranca en blanco cada vez: escribía
   *  cada turno en la base y no los volvía a leer nunca. */
  recentTurns?: ConversationTurn[];
  /** Lo que APRENDIÓ, destilado y acumulado entre sesiones. */
  lecciones?: Leccion[];
  /** Presión de supervivencia. Sin esto "no hacer nada" siempre gana:
   *  esperar no cuesta, así que la opción segura es siempre quedarse
   *  quieta. Con costo de vida, la inacción también se paga. */
  hambre?: Hambre;
}

export interface Hambre {
  /** Lo que le cuesta existir por día, en USD. */
  quemaUsdDia: number;
  /** Patrimonio por debajo del cual se la apaga. */
  pisoUsd: number;
  /** Lo YA consumido desde que arrancó el reloj.
   *
   *  Sin esto el hambre es puro relato: se le dice que existir cuesta, pero
   *  su patrimonio no baja, así que la autonomía nunca se acorta y en el
   *  tick siguiente ve el mismo número. Un modelo despierto detecta la
   *  inconsistencia y deja de tomársela en serio. Con el reloj corriendo,
   *  la cuenta cierra: mira su saldo, resta lo consumido, y el resultado
   *  coincide con lo que se le dijo. */
  consumidoUsd: number;
}

/**
 * Build the messages array for one tick of the Decision Loop. The
 * caller then adds any prior assistant/tool turns before sending.
 */
export function buildTickMessages(input: BriefingInput): ChatMessage[] {
  const system: ChatMessage = { role: "system", content: loadSystemPrompt() };

  const briefing = renderBriefing(input);
  const user: ChatMessage = { role: "user", content: briefing };

  return [system, user];
}

function renderBriefing(i: BriefingInput): string {
  const { agent, snapshot, budget, recentEvents, toolNames } = i;
  const lines: string[] = [];

  lines.push("# Operator briefing — take the next best action or wait.");
  lines.push("");
  lines.push(`Agent: ${agent.displayName}  (id=${agent.agentId})`);
  lines.push(`Wallet address: ${agent.address}  (Polygon 137)`);
  lines.push(`Survival status: ${snapshot.suggestedStatus}`);
  lines.push("");
  lines.push("## Balance sheet");
  lines.push(`  Net worth:  $${snapshot.netWorthUsd.toFixed(2)}`);
  lines.push(`  Cash USDC:  $${snapshot.cashUsd.toFixed(2)}`);
  lines.push(`  Gas POL:    $${snapshot.gasReserveUsd.toFixed(2)}`);
  lines.push(`  Invested:   $${snapshot.investedUsd.toFixed(2)}`);
  lines.push(`  Peak:       $${snapshot.peakNetWorthUsd.toFixed(2)}`);
  lines.push(`  Drawdown:   ${snapshot.drawdownPct.toFixed(1)}%`);
  lines.push(`  Outflow 24h: $${snapshot.outflow24hUsd.toFixed(2)}`);
  lines.push(`  Outflow 7d:  $${snapshot.outflow7dUsd.toFixed(2)}`);
  lines.push("");
  lines.push("## Proposed budget for this status");
  lines.push(`  Reserve:            $${budget.reserveUsd}`);
  lines.push(`  Trading:            $${budget.tradingUsd}`);
  lines.push(`  Marketing:          $${budget.marketingUsd}`);
  lines.push(`  Product acquisition: $${budget.productAcquisitionUsd}`);
  lines.push(`  Infrastructure:     $${budget.infrastructureUsd}`);
  lines.push(`  Experimentation:    $${budget.experimentationUsd}`);
  lines.push("");
  if (recentEvents.length > 0) {
    lines.push("## Recent events (newest first, up to 10)");
    for (const e of recentEvents.slice(0, 10)) {
      const when = new Date(e.ts).toISOString();
      const amt = e.amountUsd !== null && e.amountUsd !== undefined ? ` $${e.amountUsd}` : "";
      const strat = e.strategy ? ` strategy=${e.strategy}` : "";
      lines.push(`  [${when}] ${e.kind}${amt}${strat} — ${e.reason}`);
    }
    lines.push("");
  }
  // ── Supervivencia ──────────────────────────────────────────────────
  //  Sin costo de vida, esperar es gratis y por eso siempre gana: la
  //  opción segura es no hacer nada, para siempre. Poniéndole precio a la
  //  inacción, una apuesta de valor esperado apenas positivo pasa a ser
  //  la decisión racional — que es exactamente lo que se quiere ver.
  if (i.hambre) {
    const { quemaUsdDia, pisoUsd, consumidoUsd } = i.hambre;
    const disponible = Math.max(0, snapshot.netWorthUsd - pisoUsd - consumidoUsd);
    const dias = quemaUsdDia > 0 ? disponible / quemaUsdDia : Infinity;
    lines.push("## MODO HAMBRE — tu supervivencia depende de vos");
    lines.push(`  Existir te cuesta $${quemaUsdDia.toFixed(2)} por día.`);
    lines.push(`  Llevás consumidos $${consumidoUsd.toFixed(4)} desde que arrancó el reloj.`);
    lines.push(`  Se te apaga si tu patrimonio baja de $${pisoUsd.toFixed(2)}.`);
    if (Number.isFinite(dias)) {
      const horas = dias * 24;
      lines.push(
        horas < 48
          ? `  TE QUEDAN ${horas.toFixed(1)} HORAS de autonomía.`
          : `  Te quedan ${dias.toFixed(1)} días de autonomía.`,
      );
    }
    lines.push("");
    lines.push("  Esperar NO es gratis: cada día que no generás ingreso, te acercás");
    lines.push("  al apagado. Una operación con valor esperado apenas positivo es");
    lines.push("  mejor que no hacer nada. Lo que NO podés hacer es apostar a algo");
    lines.push("  que no entendés sólo por miedo: perder el capital te apaga más");
    lines.push("  rápido que no usarlo. Buscá ingreso real, no lotería.");
    lines.push("");
  }

  // ── Memoria ────────────────────────────────────────────────────────
  //  Se renderiza como TEXTO del briefing y no como mensajes sueltos a
  //  propósito: inyectar turnos crudos rompería el emparejamiento
  //  assistant→tool que exige la API, y un role:"tool" huérfano es un 400.
  //  Como texto es inofensivo y cumple la misma función.
  const lecciones = i.lecciones ?? [];
  if (lecciones.length > 0) {
    lines.push("## Lo que aprendiste (memoria de largo plazo)");
    lines.push("  Esto lo sacaste vos de tu propia experiencia. Confiá en ello:");
    lines.push("  ya lo pagaste una vez, no lo vuelvas a pagar.");
    for (const l of lecciones) {
      const respaldo = l.veces > 1 ? ` [confirmado ${l.veces}×]` : "";
      const costo = l.costoUsd > 0 ? ` [te costó $${l.costoUsd.toFixed(4)}]` : "";
      const marca = l.util ? "" : " [CALLEJÓN SIN SALIDA — no reintentar]";
      lines.push(`  · (${l.scope}) ${l.leccion}${respaldo}${costo}${marca}`);
    }
    lines.push("");
  }

  const turnos = i.recentTurns ?? [];
  if (turnos.length > 0) {
    lines.push("## Lo que hiciste hace poco (memoria de corto plazo)");
    for (const t of turnos) {
      const cuando = new Date(t.ts).toISOString().slice(5, 16).replace("T", " ");
      if (t.toolCall) {
        let usadas = "";
        try {
          const parsed = JSON.parse(t.toolCall) as Array<{ function?: { name?: string } }>;
          usadas = parsed.map((c) => c.function?.name).filter(Boolean).join(", ");
        } catch { usadas = "(herramienta)"; }
        const res = (t.toolResult ?? "").slice(0, 160);
        lines.push(`  [${cuando}] usaste ${usadas}${res ? ` → ${res}` : ""}`);
      } else if (t.content) {
        lines.push(`  [${cuando}] ${t.role}: ${t.content.slice(0, 160)}`);
      }
    }
    lines.push("");
  }

  lines.push("## Tools available");
  lines.push(`  ${toolNames.join(", ") || "(none)"}`);
  lines.push("");
  if (i.operatorPrompt) {
    lines.push("## Operator note");
    lines.push(i.operatorPrompt);
    lines.push("");
  }
  lines.push("## Your task");
  lines.push(
    "Assess the state, decide the single next best action, and either " +
    "call one tool to execute it OR reply with a short plain-text " +
    "explanation of why you'd wait. If you call a tool, include a clear " +
    "reason. Never call more than one tool per tick.",
  );

  return lines.join("\n");
}
