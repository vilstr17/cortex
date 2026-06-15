/**
 * Provider-agnostic types for the multi-provider AI layer.
 *
 * The chat layer (`CortexChatModal`) and the dashboard both speak
 * these types and never touch a provider's native request shape
 * directly. Adapters in this directory translate between this shape
 * and each provider's wire format.
 */
import type { CortexSettings } from "../../settingsTypes";

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** Present on assistant messages that contain tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `role: "tool"` messages that follow up a tool call. */
  toolCallId?: string;
  /** Used by Anthropic (always) and the OpenAI-compat loop for tool replies. */
  toolName?: string;
}

/** A single tool invocation requested by the model. */
export interface ToolCall {
  /**
   * Provider-specific id — `call_xxx` for OpenAI, `toolu_xxx` for
   * Anthropic, or a synthetic id we mint for Gemini. The id is
   * opaque to the chat layer; it's just echoed back so the model
   * knows which result corresponds to which call.
   */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Provider-specific fields that must be echoed back verbatim in
   * multi-turn conversations. For Gemini this preserves the
   * `thought_signature` (and any future extras) attached to a
   * `functionCall` part.
   */
  providerMetadata?: Record<string, unknown>;
}

/** JSON-Schema tool declaration, shared across all adapters. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Normalize a tool's `parameters` to standard (lowercase) JSON Schema.
 *
 * The agent's `ToolRegistry` declares schemas with Gemini-native
 * UPPERCASE type names (`OBJECT`, `STRING`, `INTEGER`, `NUMBER`,
 * `BOOLEAN`, `ARRAY`). Gemini's `v1beta` endpoint accepts those, but
 * the OpenAI Chat Completions and Anthropic Messages APIs validate
 * `parameters` / `input_schema` as standard JSON Schema and reject the
 * uppercase forms with an HTTP 400 (e.g. "'OBJECT' is not valid under
 * any of the given schemas"). Without this, tool calling silently
 * degrades to a text-only fallback for every non-Gemini provider.
 *
 * We lowercase every `type` string and recurse into the two places a
 * nested schema can appear — `properties` (a map of schemas) and
 * `items` (a single schema). All other keys (`description`, `required`,
 * `enum`, …) are preserved verbatim. Already-lowercase schemas (the
 * canonical shape used by the adapter tests) pass through unchanged, so
 * this is safe to apply unconditionally.
 */
export function toStandardJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const out: Record<string, unknown> = { ...schema };

  if (typeof schema.type === "string") {
    out.type = schema.type.toLowerCase();
  }

  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      normalized[key] = toStandardJsonSchema(value as Record<string, unknown>);
    }
    out.properties = normalized;
  }

  const items = schema.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    out.items = toStandardJsonSchema(items as Record<string, unknown>);
  }

  return out;
}

/** A single LLM request, normalized across providers. */
export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
}

/** A single LLM response, normalized across providers. */
export interface ChatResponse {
  /** Concatenated assistant text. Empty if the model only called tools. */
  text: string;
  /** Tool calls requested by the model. Empty for a pure text reply. */
  toolCalls: ToolCall[];
}

/**
 * One transport-family adapter. Each provider family (Gemini native,
 * Anthropic native, OpenAI-compatible) implements this.
 */
export interface AIProviderAdapter {
  /** Identifier (matches `AIProvider`). */
  readonly provider: string;

  /**
   * Send one normalized chat request. The adapter is responsible for
   * translating to the provider's wire format, making the HTTP call,
   * and translating the response back to `ChatResponse`.
   *
   * Adapters MUST NOT execute tool calls — that is the chat layer's
   * job, via `runWithTools()`.
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Optional embedding endpoint. Adapters that expose one implement
   * this — e.g. OpenAI-compatible adapters and the Gemini adapter.
   * Anthropic does not, so it does not implement this method.
   *
   * Returns one `number[]` per input text, in the same order. Vectors
   * are NOT normalized — the embedder factory wraps each row in a
   * `Float32Array` and the `InMemoryCosineIndex` normalizes on `add()`.
   *
   * Throws on HTTP / auth / network failure with a provider-tagged
   * error message (e.g. "Cortex: Ollama returned HTTP 404. …").
   */
  embed?(texts: string[]): Promise<number[][]>;
}

/**
 * Build the time-context preamble that gets prepended to every system
 * prompt. Centralized here so the Anthropic / OpenAI-compat adapters
 * can reuse the same wording as Gemini (it was lifted out of the
 * original `GeminiService.getTimeContext()`).
 */
export function buildTimeContext(settings: CortexSettings): string {
  const now = new Date();
  const locale = undefined;
  const dateStr = now.toLocaleDateString(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const isoDate = formatLocalISODate(now);
  const timeStr = now.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const timeZone =
    settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[System Note: Current date is ${dateStr} (${isoDate}), current local time is ${timeStr}. Timezone is ${timeZone}. NEVER use UTC/Z-suffix. All times are local. Always respond in the language the user uses.]`;
}

/**
 * Local-time YYYY-MM-DD. Lifted from the existing `dateUtils` so this
 * file stays dependency-free; the implementations are identical.
 */
function formatLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
