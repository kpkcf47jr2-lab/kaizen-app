// ═══════════════════════════════════════════════════════════════════════
//  LLM provider adapters — every one satisfies LlmChatClient so the
//  router can swap them freely.
//
//  Included:
//    · OpenAiCompatibleProvider — the /v1/chat/completions shape
//      (NIM, DeepSeek, OpenAI, vLLM, LM Studio, most self-hosts)
//    · AnthropicProvider — /v1/messages shape
//    · OllamaProvider — local ollama serve, converts tool calls
//      transparently so the caller sees the same LlmToolCall array
//
//  Kept in one file so callers see the full menu at a glance.
// ═══════════════════════════════════════════════════════════════════════

import type { LlmChatClient, LlmChatResponse, LlmToolCall, LlmToolSchema } from "../agent/loop.js";
import type { TrimmableMessage } from "../agent/context-trimmer.js";

// ── OpenAI-compatible (NIM, DeepSeek, vLLM, LM Studio, self-host) ──

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;                 // e.g. https://integrate.api.nvidia.com/v1
  apiKey?: string;                 // Bearer token; omit for un-auth vLLM
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export class OpenAiCompatibleProvider implements LlmChatClient {
  constructor(private readonly cfg: OpenAiCompatibleConfig) {}

  async chat(params: { messages: TrimmableMessage[]; tools: LlmToolSchema[]; toolChoice: "auto" | "required" | "none"; maxTokens?: number }): Promise<LlmChatResponse> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages: params.messages,
      temperature: this.cfg.temperature ?? 0.2,
      max_tokens: params.maxTokens ?? this.cfg.maxTokens ?? 1024,
      tools: params.tools.map((t) => ({ type: "function", function: t })),
      tool_choice: params.toolChoice,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${this.cfg.name}: HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data = await res.json() as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const msg = choice?.message ?? {};
      const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = { _raw: tc.function.arguments }; }
        return { id: tc.id, name: tc.function.name, arguments: args };
      });
      return {
        content: msg.content ?? null,
        toolCalls,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          model: this.cfg.model,
        },
        finishReason: (choice?.finish_reason as LlmChatResponse["finishReason"]) ?? "stop",
      };
    } finally { clearTimeout(timer); }
  }
}

// ── Anthropic /v1/messages ─────────────────────────────────────────

export interface AnthropicConfig {
  name?: string;
  apiKey: string;
  model: string;                   // e.g. "claude-opus-4-7", "claude-sonnet-5"
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class AnthropicProvider implements LlmChatClient {
  private readonly cfg: Required<AnthropicConfig>;
  constructor(cfg: AnthropicConfig) {
    this.cfg = {
      name: cfg.name ?? "anthropic",
      baseUrl: cfg.baseUrl ?? "https://api.anthropic.com",
      maxTokens: cfg.maxTokens ?? 1024,
      timeoutMs: cfg.timeoutMs ?? 60_000,
      ...cfg,
    };
  }

  async chat(params: { messages: TrimmableMessage[]; tools: LlmToolSchema[]; toolChoice: "auto" | "required" | "none"; maxTokens?: number }): Promise<LlmChatResponse> {
    // Split system messages (Anthropic has a dedicated `system` field, not a message).
    const systems: string[] = [];
    const others: TrimmableMessage[] = [];
    for (const m of params.messages) {
      if (m.role === "system" && typeof m.content === "string") systems.push(m.content);
      else others.push(m);
    }
    const anthMessages = others.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user" as const,
          content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: typeof m.content === "string" ? m.content : "" }],
        };
      }
      return { role: m.role === "assistant" ? "assistant" as const : "user" as const, content: (m.content as string) ?? "" };
    });

    const body = {
      model: this.cfg.model,
      system: systems.join("\n\n"),
      messages: anthMessages,
      max_tokens: params.maxTokens ?? this.cfg.maxTokens,
      tools: params.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      // "any" ≈ required in Anthropic-speak
      tool_choice: params.toolChoice === "required" ? { type: "any" } : { type: params.toolChoice },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${this.cfg.name}: HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data = await res.json() as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      let text = "";
      const toolCalls: LlmToolCall[] = [];
      for (const blk of data.content ?? []) {
        if (blk.type === "text" && blk.text) text += blk.text;
        else if (blk.type === "tool_use" && blk.id && blk.name) {
          toolCalls.push({ id: blk.id, name: blk.name, arguments: blk.input ?? {} });
        }
      }
      return {
        content: text || null,
        toolCalls,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          model: this.cfg.model,
        },
        finishReason: data.stop_reason === "tool_use" ? "tool_calls"
          : (data.stop_reason as LlmChatResponse["finishReason"]) ?? "stop",
      };
    } finally { clearTimeout(timer); }
  }
}

// ── Ollama (local, free) ────────────────────────────────────────────

export interface OllamaConfig {
  name?: string;
  baseUrl?: string;                // default http://127.0.0.1:11434
  model: string;                   // e.g. "qwen2.5-coder:7b-instruct"
  timeoutMs?: number;
}

export class OllamaProvider implements LlmChatClient {
  private readonly cfg: Required<OllamaConfig>;
  constructor(cfg: OllamaConfig) {
    this.cfg = {
      name: cfg.name ?? "ollama-local",
      baseUrl: cfg.baseUrl ?? "http://127.0.0.1:11434",
      timeoutMs: cfg.timeoutMs ?? 90_000,
      ...cfg,
    };
  }

  async chat(params: { messages: TrimmableMessage[]; tools: LlmToolSchema[]; toolChoice: "auto" | "required" | "none"; maxTokens?: number }): Promise<LlmChatResponse> {
    const body = {
      model: this.cfg.model,
      messages: params.messages,
      tools: params.tools.map((t) => ({ type: "function", function: t })),
      stream: false,
      options: { num_predict: params.maxTokens ?? 1024 },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ollama: HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data = await res.json() as {
        message?: {
          content?: string;
          tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
        };
        eval_count?: number;
        prompt_eval_count?: number;
        done_reason?: string;
      };
      const msg = data.message ?? {};
      const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
        id: `ollama_${Date.now()}_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments ?? {},
      }));
      return {
        content: msg.content ?? null,
        toolCalls,
        usage: {
          inputTokens: data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count ?? 0,
          model: this.cfg.model,
        },
        finishReason: (data.done_reason as LlmChatResponse["finishReason"]) ?? "stop",
      };
    } finally { clearTimeout(timer); }
  }
}
