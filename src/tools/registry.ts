// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Tool System
//
//  The LLM never touches side effects directly. It emits a ToolIntent;
//  the executor looks up the tool implementation in this registry,
//  routes it through the Policy Engine, then runs it.
//
//  A Tool is a typed pair of (JSON-schema definition for the LLM, an
//  async function that executes it). Adding a tool = add a file under
//  src/tools/, register it here.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { ToolIntent } from "../policy/engine.js";

/** JSON-schema-ish signature exposed to the LLM. */
export interface ToolDefinition {
  name: string;
  description: string;
  level: PermissionLevel;
  /** Category matched against HARD_LIMITS.ABSOLUTE_PROHIBITIONS. */
  category?: string;
  /** OpenAI-compatible function schema for tool calling. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolContext {
  agentId: string;
  /** Human-readable trace for the ledger. LLM's own justification for this call. */
  reason?: string;
}

export type ToolFn<Args = unknown, Result = unknown> = (
  args: Args,
  ctx: ToolContext,
) => Promise<Result>;

export interface RegisteredTool<Args = unknown, Result = unknown> {
  def: ToolDefinition;
  exec: ToolFn<Args, Result>;
  /** Build a ToolIntent from raw args, so PolicyEngine can evaluate before exec. */
  toIntent(args: Args, ctx: ToolContext): ToolIntent;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register<Args, Result>(tool: RegisteredTool<Args, Result>): void {
    if (this.tools.has(tool.def.name)) {
      throw new Error(`Tool already registered: ${tool.def.name}`);
    }
    this.tools.set(tool.def.name, tool as unknown as RegisteredTool);
  }

  get(name: string): RegisteredTool | undefined {
    const exacto = this.tools.get(name);
    if (exacto) return exacto;

    // Tolerancia al separador. Kaizen-8B pidió `web_search` seis veces
    // seguidas (2026-09-03) en vez de `web.search`, y cada una se rechazó
    // con "Unknown tool" — su herramienta más útil quedó inalcanzable por un
    // punto. Algunos parsers de tool-calling normalizan el punto a guion
    // bajo, así que el nombre que llega no siempre es el que se publicó.
    //
    // Se resuelve acá, en un solo lugar, en vez de renombrar las 36
    // herramientas: el nombre con punto sigue siendo el canónico.
    const normal = (s: string) => s.replace(/[._-]/g, "").toLowerCase();
    const buscado = normal(name);
    for (const [registrado, tool] of this.tools) {
      if (normal(registrado) === buscado) return tool;
    }
    return undefined;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values(), (t) => t.def);
  }

  /** Serialize to the OpenAI tool-calling schema for the LLM. */
  toOpenAiSchema(): Array<{ type: "function"; function: ToolDefinition }> {
    return this.list().map((def) => ({ type: "function", function: def }));
  }
}
