/**
 * Public entry point for the multi-provider AI layer.
 *
 * `createAdapter(settings)` returns the right transport-family
 * adapter for the active provider. The chat modal and the dashboard
 * both go through this — they never instantiate an adapter class
 * directly.
 */
import type { ChronoteSettings } from "../../settingsTypes.js";
import { GeminiAdapter } from "./GeminiAdapter.js";
import { AnthropicAdapter } from "./AnthropicAdapter.js";
import { OpenAICompatAdapter } from "./OpenAICompatAdapter.js";
import type { AIProviderAdapter } from "./types.js";

export function createAdapter(settings: ChronoteSettings): AIProviderAdapter {
  switch (settings.ai.provider) {
    case "gemini":
      return new GeminiAdapter(settings);
    case "anthropic":
      return new AnthropicAdapter(settings);
    case "openai":
    case "ollama":
    case "lmstudio":
    case "custom":
      return new OpenAICompatAdapter(settings);
  }
}

export type { AIProviderAdapter } from "./types.js";
export {
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ToolCall,
  type ToolDeclaration,
  buildTimeContext,
} from "./types.js";
export { runWithTools, type ToolExecutor } from "./runWithTools.js";
export {
  RESPONSE_STYLES,
  getResponseStyle,
  type ResponseStyleEntry,
} from "./catalog.js";
