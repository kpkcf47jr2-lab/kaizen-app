// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — LLM client
//
//  Provider-agnostic. Any OpenAI-compatible /v1/chat/completions endpoint
//  works:
//    - NVIDIA NIM (Kaizen ecosystem default; free tier already integrated)
//    - vLLM serving the Kaizen-7B-v0.1 LoRA once the adapter promotes
//    - OpenAI, Anthropic-via-proxy, DeepSeek, whatever else the owner picks
//
//  The brain speaks in tool calls. The client returns the raw
//  {content, tool_calls[]} the Decision Loop consumes.
// ═══════════════════════════════════════════════════════════════════════

export interface LLMConfig {
  baseUrl: string;                 // e.g. "https://integrate.api.nvidia.com/v1"
  model: string;                   // e.g. "qwen/qwen2.5-7b-instruct" or the adapter alias
  apiKey?: string;                 // Bearer token. Optional for local vLLM w/o auth.
  temperature?: number;            // default 0.2 — decisions want reproducibility
  maxTokens?: number;              // default 1024
  timeoutMs?: number;              // default 60_000
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** For role=tool: the id of the tool_call this responds to. */
  tool_call_id?: string;
  /** For role=assistant emitting tool calls. */
  tool_calls?: ToolCallEmission[];
  /** For role=tool: which tool ran. Some providers require this. */
  name?: string;
}

export interface ToolCallEmission {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments = JSON string
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCallEmission[];
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | string;
  usage?: { prompt: number; completion: number; total: number };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

export class LLMClient {
  constructor(private readonly cfg: LLMConfig) {
    if (!cfg.baseUrl) throw new Error("LLMClient: baseUrl required");
    if (!cfg.model) throw new Error("LLMClient: model required");
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0.2,
      max_tokens: this.cfg.maxTokens ?? 1024,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LLM ${res.status} ${res.statusText}: ${errText.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: { content: string | null; tool_calls?: ToolCallEmission[] };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices?.[0];
    if (!choice) throw new Error("LLM returned no choices");

    return {
      content: choice.message.content,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason,
      usage: data.usage && {
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
        total: data.usage.total_tokens,
      },
    };
  }
}

/** Load defaults from env. Falls back to NVIDIA NIM which the Kairos ecosystem already uses. */
export function llmFromEnv(): LLMClient {
  return new LLMClient({
    baseUrl: process.env.KAIZEN_LLM_BASE_URL || "https://integrate.api.nvidia.com/v1",
    model: process.env.KAIZEN_LLM_MODEL || "qwen/qwen2.5-7b-instruct",
    apiKey: process.env.KAIZEN_LLM_API_KEY,
    temperature: Number(process.env.KAIZEN_LLM_TEMPERATURE || "0.2"),
    maxTokens: Number(process.env.KAIZEN_LLM_MAX_TOKENS || "1024"),
    timeoutMs: Number(process.env.KAIZEN_LLM_TIMEOUT_MS || "60000"),
  });
}
