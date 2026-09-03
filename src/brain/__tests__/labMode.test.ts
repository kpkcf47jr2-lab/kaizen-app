// Modo laboratorio — la conversación que se le manda al modelo tiene que
// quedar bien formada entre paso y paso.
//
// El bug que estos tests custodian: los resultados de las herramientas se
// empujaban a `messages` pero el turno del asistente que las PIDIÓ no. La
// segunda llamada al modelo salía como [system, user, tool], que toda API
// estilo OpenAI rechaza con 400. El LLM falso no valida el orden, así que
// la suite pasaba y el modo laboratorio moría en producción en el paso 2.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecisionLoop } from "../decisionLoop.js";
import type { LLMClient, ChatMessage, LLMResponse, ToolSchema } from "../llm.js";
import { ToolRegistry } from "../../tools/registry.js";
import { PermissionLevel } from "../../policy/limits.js";
import type { AgentState } from "../../policy/engine.js";
import type { AgentRegistry, AgentRecord } from "../../agent/registry.js";

/** LLM falso que guarda una copia de CADA conversación que recibe. */
class RecordingLLM {
  readonly seen: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly script: LLMResponse[]) {}
  async chat(messages: ChatMessage[], _tools: ToolSchema[]): Promise<LLMResponse> {
    this.seen.push(structuredClone(messages));
    return this.script[Math.min(this.turn++, this.script.length - 1)];
  }
}

function call(id: string, name: string): NonNullable<LLMResponse["toolCalls"]>[number] {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function mkRegistry(record: AgentRecord): AgentRegistry {
  return {
    has: async () => true,
    get: async () => record,
    list: async () => [record],
    upsert: async () => {},
    updateStatus: async () => {},
    updatePeak: async () => {},
    updateAutoTick: async () => {},
  };
}

function mkTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    def: {
      name: "web.search",
      description: "buscar",
      level: PermissionLevel.ZERO_COST,
      parameters: { type: "object", properties: {} },
    },
    exec: async () => ({ hits: 2 }),
    toIntent: () => ({ tool: "web.search", level: PermissionLevel.ZERO_COST }),
  });
  return tools;
}

const agentState: AgentState = {
  agentId: "agt_lab", netWorthUsd: 100, cashUsd: 100, peakNetWorthUsd: 100,
  openPositions: 0, outflow24hUsd: 0, outflow7dUsd: 0, txCountLastHour: 0,
  toolCallsLastMinute: 0, gpuSpend24hUsd: 0, adSpend24hUsd: 0,
  maxAllowedLevel: PermissionLevel.FINANCIAL,
  selfLimits: { maxTxUsd: 50, maxTradeUsd: 50, maxDailyOutflowUsd: 100, strategyExposureCapPct: 25 },
};

const record: AgentRecord = {
  agentId: "agt_lab", displayName: "Lab", address: "0x" + "1".repeat(40),
  parentAgentId: null, createdAt: new Date().toISOString(),
  status: "HEALTHY" as AgentRecord["status"], peakNetWorthUsd: 100,
};

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaizen-lab-"));
  process.env.KAIZEN_STATE_DIR = stateDir;
  process.env.KAIZEN_LAB_MODE = "1";
});
afterEach(() => {
  delete process.env.KAIZEN_LAB_MODE;
  delete process.env.KAIZEN_LAB_MAX_STEPS;
  delete process.env.KAIZEN_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function mkLoop(script: LLMResponse[]) {
  const llm = new RecordingLLM(script);
  const loop = new DecisionLoop(llm as unknown as LLMClient, mkTools(), mkRegistry(record));
  return { llm, loop };
}

const tick = (loop: DecisionLoop) => loop.tick({
  agentId: "agt_lab",
  balances: { usdc: 100, pol: 5, polUsdRate: 1 },
  agentState,
});

describe("modo laboratorio — forma de la conversación", () => {
  it("cada role:tool va precedido por el assistant que lo pidió", async () => {
    const { llm, loop } = mkLoop([
      { content: "busco", toolCalls: [call("c1", "web.search")], finishReason: "tool_calls" },
      { content: "listo", toolCalls: [], finishReason: "stop" },
    ]);
    await tick(loop);

    // La segunda conversación es la que rompía: contenía el resultado sin
    // el pedido. Se valida sobre TODAS por las dudas.
    expect(llm.seen.length).toBeGreaterThan(1);
    for (const convo of llm.seen) {
      convo.forEach((m, i) => {
        if (m.role !== "tool") return;
        const prev = convo.slice(0, i).reverse().find((p) => p.role === "assistant");
        expect(prev, "un role:tool quedó sin assistant previo").toBeDefined();
        expect(prev!.tool_calls?.some((tc) => tc.id === m.tool_call_id)).toBe(true);
      });
    }
  });

  it("el resultado lleva el tool_call_id y el name que pide el proveedor", async () => {
    const { llm, loop } = mkLoop([
      { content: "busco", toolCalls: [call("c1", "web.search")], finishReason: "tool_calls" },
      { content: "listo", toolCalls: [], finishReason: "stop" },
    ]);
    await tick(loop);

    const toolMsg = llm.seen[1].find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("c1");
    expect(toolMsg?.name).toBe("web.search");
  });

  it("encadena varios pasos y los registra en orden", async () => {
    const { loop } = mkLoop([
      { content: "uno", toolCalls: [call("c1", "web.search")], finishReason: "tool_calls" },
      { content: "dos", toolCalls: [call("c2", "web.search")], finishReason: "tool_calls" },
      { content: "fin", toolCalls: [], finishReason: "stop" },
    ]);
    const r = await tick(loop);
    expect(r.steps?.map((s) => s.tool)).toEqual(["web.search", "web.search"]);
    expect(r.outcome.kind).toBe("waited");
  });

  it("respeta el tope de pasos y no llama al modelo de más", async () => {
    process.env.KAIZEN_LAB_MAX_STEPS = "2";
    const { llm, loop } = mkLoop([
      { content: "sigo", toolCalls: [call("c1", "web.search")], finishReason: "tool_calls" },
    ]);
    const r = await tick(loop);
    // 2 pasos = 2 llamadas al modelo; la última no vuelve a preguntar.
    expect(llm.seen.length).toBe(2);
    expect(r.steps).toHaveLength(2);
  });

  it("apagado, se comporta como antes: una sola herramienta y sin steps", async () => {
    delete process.env.KAIZEN_LAB_MODE;
    const { llm, loop } = mkLoop([
      { content: "una", toolCalls: [call("c1", "web.search")], finishReason: "tool_calls" },
    ]);
    const r = await tick(loop);
    expect(llm.seen).toHaveLength(1);
    expect(r.steps).toBeUndefined();
    expect(r.outcome.kind).toBe("tool_call");
  });
});
