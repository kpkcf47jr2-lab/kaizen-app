// ═══════════════════════════════════════════════════════════════════════
//  SpendTracker — running per-run USD cost of the agent
//
//  Two sources:
//    · LLM tokens — (input + output) * per-1k-token rate per model
//    · Tool-side costs — swap fees, KAME renders, gas (surfaced by tools
//      through addToolCost)
//
//  The loop reads totalUsd() between steps to enforce maxCostUsd caps.
//  When the cap is hit the loop finishes gracefully (last observation
//  is preserved) rather than crashing.
// ═══════════════════════════════════════════════════════════════════════

import type { ISpendTracker } from "./index.js";

/** Per-1k-token pricing (USD) for the model families the runtime knows.
 *  Numbers are conservative-high — better to over-estimate cost than
 *  overshoot the cap. Update as pricing changes.
 *  Layout: [inputPer1k, outputPer1k]. */
const MODEL_PRICING: Record<string, [number, number]> = {
  // NVIDIA NIM — free tier is effectively $0 but bill against a nominal
  // rate so caps still trigger during long autonomous runs.
  "meta/llama-3.2-90b-vision-instruct": [0.001, 0.002],
  "meta/llama-3.2-11b-vision-instruct": [0.00006, 0.00012],
  "deepseek-ai/deepseek-v4-flash-0731": [0.0004, 0.0008],
  // Anthropic (if the router ever fails over)
  "claude-opus-4-7": [0.015, 0.075],
  "claude-sonnet-5": [0.003, 0.015],
  // Fallback for unknown models — mid-range paid tier estimate.
  "*default*": [0.002, 0.006],
};

interface LlmCallRecord {
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

interface ToolCostRecord {
  ts: number;
  note: string;
  usd: number;
}

export class SpendTracker implements ISpendTracker {
  private readonly llmCalls: LlmCallRecord[] = [];
  private readonly toolCosts: ToolCostRecord[] = [];

  addLlmCall(inputTokens: number, outputTokens: number, model: string): void {
    const [inR, outR] = MODEL_PRICING[model] ?? MODEL_PRICING["*default*"]!;
    const usd = (inputTokens / 1000) * inR + (outputTokens / 1000) * outR;
    this.llmCalls.push({ ts: Date.now(), model, inputTokens, outputTokens, usd });
  }

  addToolCost(usd: number, note: string): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.toolCosts.push({ ts: Date.now(), note, usd });
  }

  totalUsd(): number {
    let total = 0;
    for (const c of this.llmCalls) total += c.usd;
    for (const c of this.toolCosts) total += c.usd;
    return total;
  }

  /** For the audit dashboard and cost attribution. */
  breakdown(): { llmUsd: number; toolUsd: number; llmCallCount: number; toolCostCount: number } {
    const llmUsd = this.llmCalls.reduce((s, c) => s + c.usd, 0);
    const toolUsd = this.toolCosts.reduce((s, c) => s + c.usd, 0);
    return {
      llmUsd, toolUsd,
      llmCallCount: this.llmCalls.length,
      toolCostCount: this.toolCosts.length,
    };
  }

  reset(): void {
    this.llmCalls.length = 0;
    this.toolCosts.length = 0;
  }
}
