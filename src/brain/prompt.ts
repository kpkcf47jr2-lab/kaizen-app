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
import type { EconomicEvent } from "../memory/store.js";
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
