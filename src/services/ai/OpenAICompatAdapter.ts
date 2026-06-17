/**
 * OpenAI-compatible adapter.
 *
 * Used by:
 *   - OpenAI  (`https://api.openai.com/v1`)
 *   - Ollama  (`http://localhost:11434/v1`, OpenAI shim — auth ignored)
 *   - LM Studio (`http://localhost:1234/v1`, auth ignored)
 *   - Custom  (user-supplied base URL — OpenRouter, Groq, Together, vLLM, …)
 *
 * Wire format: OpenAI Chat Completions.
 *
 * Tool calling:
 *   - `tool_calls` arrives as an array of `{ id, type, function: { name, arguments } }`
 *     where `arguments` is a JSON-encoded string. We `JSON.parse` it.
 *   - Tool results are sent as `{ role: "tool", tool_call_id, content }`.
 *
 * Quirks handled:
 *   - Local providers (Ollama, LM Studio) ignore auth. We send
 *     `Authorization: Bearer <key>` ONLY when the user has typed a key;
 *     otherwise the header is omitted entirely. Newer Ollama builds
 *     (>=0.5) reject non-empty Authorization headers they don't
 *     recognize with HTTP 403.
 *   - Ollama's OpenAI shim does NOT support `tool_choice` — we omit
 *     it for that provider.
 *
 * Error handling:
 *   - We inspect `response.status` and throw a provider-aware error
 *     that includes the upstream `error.message` when present, so the
 *     "Test connection" button and chat failures surface the real
 *     reason (model not loaded, missing key, bad base URL, …) instead
 *     of a generic "unexpected response structure".
 */
import { requestUrl } from "obsidian";
import type { AIProvider, ChronoteSettings } from "../../settingsTypes.js";
import type {
  AIProviderAdapter,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from "./types.js";
import { toStandardJsonSchema } from "./types.js";
import { PROVIDER_LABELS, resolveEmbeddingModel } from "./catalog.js";

interface OpenAIToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

interface OpenAIChoice {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
}

export class OpenAICompatAdapter implements AIProviderAdapter {
  readonly provider: string;

  private readonly settings: ChronoteSettings;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly providerKey: AIProvider;

  constructor(settings: ChronoteSettings) {
    this.settings = settings;
    this.providerKey = settings.ai.provider;
    this.provider = settings.ai.provider;
    this.model = settings.ai.model;
    this.baseUrl = normalizeBaseUrl(settings.ai.baseUrl);
    this.apiKey = resolveApiKey(settings.ai.provider, settings.ai.apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.translateMessages(request);
    const tools =
      request.tools && request.tools.length > 0
        ? request.tools.map(
            (t): OpenAITool => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                // Normalize Gemini-native UPPERCASE schema types to
                // standard JSON Schema — OpenAI-compatible providers
                // reject `"OBJECT"`/`"STRING"` with an HTTP 400.
                parameters: toStandardJsonSchema(t.parameters),
              },
            }),
          )
        : undefined;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) {
      body.max_tokens = request.maxOutputTokens;
    }
    if (tools) {
      body.tools = tools;
      // Ollama's shim rejects `tool_choice`; other providers default to
      // "auto" when omitted.
      if (this.providerKey !== "ollama") body.tool_choice = "auto";
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey !== null) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Resolve (don't reject) on 4xx/5xx so checkResponseStatus can
      // read the body and surface the upstream message (e.g. Ollama's
      // tokenizer EOF) instead of Obsidian's generic "Request failed".
      throw: false,
    });

    this.checkResponseStatus(response);
    const toolNames = new Set((request.tools ?? []).map((t) => t.name));
    return this.parseResponse(response.json, toolNames);
  }

  /**
   * Throw an informative error when the upstream returned a non-2xx
   * status. `requestUrl` resolves with the response object on
   * 4xx/5xx rather than rejecting, so we have to inspect `status`
   * ourselves. We surface the upstream `error.message` when the body
   * carries it (Ollama, LM Studio, and most OpenAI-compat gateways
   * follow the same shape) so the user sees *why* the call failed.
   */
  private checkResponseStatus(response: { status?: number; text?: string; json?: unknown }): void {
    const status = response.status ?? 0;
    if (status >= 200 && status < 300) return;
    const body = response.json as { error?: { message?: string } } | undefined;
    const upstreamMsg = body?.error?.message;
    const providerHint = this.providerKey === "ollama"
      ? " — check that Ollama is running and the model is loaded"
      : this.providerKey === "lmstudio"
        ? " — check that the LM Studio local server is started and the model is loaded"
        : "";
    const detail = upstreamMsg || response.text || "no body";
    const providerLabel = PROVIDER_LABELS[this.providerKey] ?? this.providerKey;
    throw new Error(
      `Chronote: ${providerLabel} returned HTTP ${status}${providerHint}. ${detail}`,
    );
  }

  private translateMessages(
    request: ChatRequest,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    // System message first.
    if (request.system) {
      out.push({ role: "system", content: request.system });
    }
    for (const m of request.messages) {
      if (m.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: m.toolCallId ?? "",
          content: m.text,
        });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const assistantMsg: Record<string, unknown> = {
          role: "assistant",
          content: m.text || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        };
        out.push(assistantMsg);
        continue;
      }
      out.push({ role: m.role, content: m.text });
    }
    return out;
  }

  private parseResponse(
    json: unknown,
    toolNames: Set<string>,
  ): ChatResponse {
    if (!isResponse(json)) {
      throw new Error(
        "Chronote: OpenAI-compatible provider returned an unexpected response structure.",
      );
    }
    const choices = json.choices;
    if (!choices || choices.length === 0) {
      throw new Error("Chronote: OpenAI-compatible provider returned no choices.");
    }
    const message = choices[0].message;
    const nativeToolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.function.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed JSON from the model — return empty args rather than
        // throwing; the tool executor will fail gracefully.
      }
      return {
        id: tc.id,
        name: tc.function.name,
        args,
      };
    });

    // Some local / OpenAI-compatible models emit tool calls as plain text
    // JSON instead of native `tool_calls`. If the native array is empty, try
    // to parse a manual representation so those models still work.
    const text = (message.content ?? "").trim();
    const toolCalls =
      nativeToolCalls.length > 0
        ? nativeToolCalls
        : extractManualToolCalls(text, toolNames) ?? [];

    return {
      text,
      toolCalls,
    };
  }

  /**
   * Call `${baseUrl}/embeddings` with the configured embedding model.
   * Reuses the same `checkResponseStatus` and Bearer-header-omit logic
   * as `chat()`. When the embedding model field is empty we omit the
   * `model` field entirely (some local servers reject unknown ids).
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.baseUrl) {
      throw new Error(
        "Chronote: no base URL configured for the OpenAI-compatible provider. " +
          "Set it in Settings → Chronote.",
      );
    }
    const embeddingModel = resolveEmbeddingModel(
      this.settings.ai.provider,
      this.settings.ai.embeddingModel,
    );
    const body: Record<string, unknown> = { input: texts };
    if (embeddingModel.length > 0) body.model = embeddingModel;

    const url = `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey !== null) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Resolve (don't reject) on 4xx/5xx so checkResponseStatus can
      // read the body and surface the upstream message (e.g. Ollama's
      // tokenizer EOF) instead of Obsidian's generic "Request failed".
      throw: false,
    });
    this.checkResponseStatus(response);
    return this.parseEmbeddings(response.json, texts.length);
  }

  private parseEmbeddings(json: unknown, expected: number): number[][] {
    if (!isResponse(json)) {
      throw new Error(
        "Chronote: OpenAI-compatible /v1/embeddings returned an unexpected response structure.",
      );
    }
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== expected) {
      throw new Error(
        `Chronote: /v1/embeddings returned ${Array.isArray(data) ? data.length : 0} vectors, expected ${expected}.`,
      );
    }
    const out: number[][] = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i] as { embedding?: unknown } | null;
      if (!row || !Array.isArray(row.embedding)) {
        throw new Error(
          `Chronote: /v1/embeddings returned a row without an embedding vector at index ${i}.`,
        );
      }
      out.push(row.embedding as number[]);
    }
    return out;
  }
}

function isResponse(obj: unknown): obj is OpenAIResponse {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
}

/**
 * Manual tool-call fallback for OpenAI-compatible providers that do not
 * populate the native `tool_calls` field. Supports the common local-model
 * convention of wrapping a tool call in `<tool_call>...</tool_call>` tags,
 * a fenced JSON block, or a JSON object at the start/end of the message.
 */
function extractManualToolCalls(
  text: string,
  toolNames: Set<string>,
): ToolCall[] | null {
  const calls: ToolCall[] = [];

  // Prefer explicit <tool_call> markers.
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const parsed = safeJsonParse(match[1].trim());
    if (parsed) {
      const normalized = normalizeManualToolCall(parsed, toolNames);
      if (normalized) calls.push(normalized);
    }
  }
  if (calls.length > 0) return calls;

  // Fenced JSON block fallback.
  const fenceRegex = /```(?:json)?\n([\s\S]*?)\n```/g;
  while ((match = fenceRegex.exec(text)) !== null) {
    const parsed = safeJsonParse(match[1].trim());
    if (!parsed) continue;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const normalized = normalizeManualToolCall(item, toolNames);
        if (normalized) calls.push(normalized);
      }
    } else {
      const normalized = normalizeManualToolCall(parsed, toolNames);
      if (normalized) calls.push(normalized);
    }
    if (calls.length > 0) return calls;
  }

  // Last resort: the whole message is a single JSON tool call / array.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = safeJsonParse(trimmed);
    if (parsed) {
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const normalized = normalizeManualToolCall(item, toolNames);
          if (normalized) calls.push(normalized);
        }
      } else {
        const normalized = normalizeManualToolCall(parsed, toolNames);
        if (normalized) calls.push(normalized);
      }
    }
  }

  return calls.length > 0 ? calls : null;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeManualToolCall(
  value: unknown,
  toolNames: Set<string>,
): ToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || !toolNames.has(obj.name)) return null;
  const args =
    obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)
      ? (obj.arguments as Record<string, unknown>)
      : {};
  return {
    id: `manual-${obj.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: obj.name,
    args,
  };
}

/**
 * Normalize the user-supplied base URL. We accept a wide range of
 * forms (with or without trailing slash, with or without `/v1`),
 * and always produce a URL that ends in `/v1` (since the chat
 * completions endpoint is `${baseUrl}/chat/completions`).
 */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim();
  if (!url) return "";
  // Strip trailing slashes
  url = url.replace(/\/+$/, "");
  // If the user already included /v1, leave it alone
  if (/\/v1$/.test(url)) return url;
  // If the user included a path that already ends in /chat/completions
  // or similar, leave it alone — we just append chat/completions below.
  return url;
}

/**
 * Resolve the bearer token to send in the `Authorization` header.
 *
 * Returns `null` when no real key is configured. Local providers
 * (Ollama, LM Studio) don't need auth; the OpenAI-compat shim on
 * newer Ollama builds actively rejects placeholder bearer tokens
 * (e.g. `"ollama"`, `"lm-studio"`) with HTTP 403. By returning
 * `null`, the caller knows to omit the header entirely. For hosted
 * providers (OpenAI, custom) we still send the (possibly empty) key
 * — if the user hasn't set one, the upstream will return its own
 * 401 with a useful error message.
 */
function resolveApiKey(provider: AIProvider, raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (trimmed) return trimmed;
  return null;
}
