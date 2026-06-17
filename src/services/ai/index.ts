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
import { CHRONOTE_CLOUD_BASE_URL } from "./catalog.js";
import type { AIProviderAdapter } from "./types.js";

export function createAdapter(settings: ChronoteSettings): AIProviderAdapter {
  switch (settings.ai.provider) {
    case "gemini":
      return new GeminiAdapter(settings);
    case "anthropic":
      return new AnthropicAdapter(settings);
    case "chronote_cloud":
      // The proxy picks the model — we never let the user configure
      // one. Override settings with a synthetic `apiKey` (the account
      // id) and the fixed base URL. We use a non-empty placeholder
      // when no account id is configured so the Authorization header
      // is always present — the proxy then returns its own 401 with
      // a useful error message.
      return new OpenAICompatAdapter({
        ...settings,
        ai: {
          ...settings.ai,
          apiKey: settings.ai.chronoteAccountId || "chronote-cloud",
          model: "chronote-cloud-managed",
          baseUrl: CHRONOTE_CLOUD_BASE_URL,
        },
      });
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
