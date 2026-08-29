// ═══════════════════════════════════════════════════════════════════════
//  inference/  —  multi-provider LLM router with Ollama local fallback.
// ═══════════════════════════════════════════════════════════════════════

export {
  MultiProviderLlmRouter,
  type ProviderHandle,
  type RouterConfig,
} from "./router.js";
export {
  OpenAiCompatibleProvider,
  AnthropicProvider,
  OllamaProvider,
  type OpenAiCompatibleConfig,
  type AnthropicConfig,
  type OllamaConfig,
} from "./providers.js";
export {
  TierAwareLlm,
  type TierAwareLlmConfig,
} from "./tier-selector.js";
