/**
 * Gemini native adapter.
 *
 * Implements the Gemini `generateContent` REST shape directly, since
 * Gemini does NOT speak the OpenAI Chat Completions protocol. The
 * function-calling round-trip is preserved exactly as it shipped in
 * the original `GeminiService`.
 *
 * SECURITY: the API key is passed in the `x-goog-api-key` header,
 * NOT as a `?key=` query parameter. Query-string keys are logged by
 * intermediaries, cached in browser history, and forwarded in referer
 * headers. The header form is the documented authentication channel.
 *
 * ERROR HANDLING: 4xx/5xx responses propagate the upstream
 * `error.message` and `error.status` (e.g. "PERMISSION_DENIED",
 * "NOT_FOUND") verbatim, so the user sees *which* model / key is the
 * problem rather than a generic "unexpected response structure". This
 * is especially important for the 3-series previews where free-tier
 * keys are often allow-listed only for the 2.5 family.
 */
import { requestUrl } from "obsidian";
import type { ChronoteSettings } from "../../settingsTypes.js";
import type {
  AIProviderAdapter,
  ChatRequest,
  ChatResponse,
  ToolCall,
  ToolDeclaration,
} from "./types.js";
import { buildTimeContext } from "./types.js";
import { resolveEmbeddingModel } from "./catalog.js";

// ── Gemini native types (mirrors the wire format) ──────────────────

interface GeminiContentPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: {
    name: string;
    response: { result: string; details?: string };
  };
  /**
   * Gemini thinking models attach a `thoughtSignature` (or
   * `thought_signature`) to the content part that carries a function call.
   * The signature must be echoed back verbatim in the same part on the
   * following turn, otherwise the API returns HTTP 400 INVALID_ARGUMENT.
   */
  thoughtSignature?: string;
  thought_signature?: string;
  [key: string]: unknown;
}

interface GeminiContent {
  role: string;
  parts: GeminiContentPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[] };
}

interface GeminiApiResponse {
  candidates?: GeminiCandidate[];
}

export class GeminiAdapter implements AIProviderAdapter {
  readonly provider = "gemini";

  private readonly apiBase = "https://generativelanguage.googleapis.com/v1beta/models";

  constructor(private settings: ChronoteSettings) {}

  private get model(): string {
    return this.settings.ai.geminiModel || "gemini-2.5-flash";
  }

  private get apiKey(): string {
    return this.settings.ai.geminiApiKey;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Translate the shared message format into Gemini's `contents` shape.
    // - role "user" stays "user"
    // - role "assistant" becomes "model"
    // - tool replies become a "function" turn with a `functionResponse` part
    // - assistant turns that contain tool calls become a "model" turn
    //   with a `functionCall` part
    const contents: GeminiContent[] = request.messages.map((m) => {
      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "function",
          parts: [
            {
              functionResponse: {
                name: m.toolName ?? m.toolCallId,
                response: {
                  result: "Success",
                  details: m.text,
                },
              },
            },
          ],
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "model",
          parts: m.toolCalls.map((tc) => {
            // Strip the internal `id` from providerMetadata — Gemini's
            // functionCall object only accepts `name` and `args`, so
            // sending our synthetic id produces "Unknown name 'id'".
            const { id: _id, ...extras } = tc.providerMetadata ?? {};
            return {
              functionCall: { name: tc.name, args: tc.args },
              // Echo any provider-specific extras (e.g. thought_signature)
              // at the part level, which is where Gemini returns them.
              ...extras,
            };
          }),
        };
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }],
      };
    });

    const url = `${this.apiBase}/${this.model}:generateContent`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
    };

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxOutputTokens ?? 4096,
      },
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: normalizeSchemaForGemini(t.parameters),
          })),
        },
      ];
    }

    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Resolve on non-2xx so checkResponseStatus surfaces the
      // upstream error message instead of Obsidian's generic throw.
      throw: false,
    });

    this.checkResponseStatus(response);
    return this.parseResponse(response.json);
  }

  /**
   * Throw an informative error when the upstream returned a non-2xx
   * status. Google's error body shape is
   *   { "error": { "code": 403, "message": "...", "status": "PERMISSION_DENIED" } }
   * — we surface `message` and `status` so the user can tell whether
   * the failure is a key-permission issue, a missing model, quota, etc.
   */
  private checkResponseStatus(response: { status?: number; text?: string; json?: unknown }): void {
    const status = response.status ?? 0;
    if (status >= 200 && status < 300) return;
    const body = response.json as
      | { error?: { message?: string; status?: string; code?: number } }
      | undefined;
    const upstreamMsg = body?.error?.message;
    const upstreamStatus = body?.error?.status;
    const hint =
      status === 403
        ? " — check that the API key is valid and has access to the selected model"
        : status === 404
          ? " — the model id may be invalid or removed"
          : status === 429
            ? " — quota exceeded, try again later or upgrade the API key tier"
            : "";
    const detail = upstreamMsg || response.text || "no body";
    const prefix = upstreamStatus ? ` [${upstreamStatus}]` : "";
    throw new Error(
      `Chronote: Gemini returned HTTP ${status}${hint}.${prefix} ${detail}`,
    );
  }

  private parseResponse(json: unknown): ChatResponse {
    if (!isApiResponse(json)) {
      throw new Error("Chronote: Gemini returned an unexpected response structure.");
    }
    const candidates = json.candidates;
    if (!candidates || candidates.length === 0) {
      throw new Error("Chronote: Gemini returned no candidates.");
    }
    const parts: GeminiContentPart[] = candidates[0]?.content?.parts ?? [];

    const functionCallParts = parts.filter(
      (p): p is { functionCall: NonNullable<GeminiContentPart["functionCall"]> } &
        Record<string, unknown> => !!p.functionCall,
    );
    if (functionCallParts.length > 0) {
      const toolCalls: ToolCall[] = functionCallParts.map((p, i) => {
        // Capture any provider-specific extras both as siblings of the
        // functionCall on the content part and inside the functionCall
        // object itself. Gemini 3.x thinking models return the
        // thought_signature as a part-level sibling; older formats may
        // embed it inside the call. We restore all extras as part-level
        // siblings, which is what the current API expects.
        const {
          text: _text,
          functionResponse: _fr,
          functionCall,
          ...partExtras
        } = p;
        const { name, args, ...callExtras } = functionCall;
        return {
          // Gemini doesn't return a tool-call id. We mint a synthetic
          // one — the model doesn't need to echo it back, we just
          // need *some* opaque id for the assistant message round-trip.
          id: `gemini-${name}-${Date.now()}-${i}`,
          name,
          args: args ?? {},
          providerMetadata: { ...partExtras, ...callExtras },
        };
      });
      return { text: "", toolCalls };
    }

    const text = parts.map((p) => p.text ?? "").join("");
    return { text: text.trim(), toolCalls: [] };
  }

  private get embeddingModel(): string {
    return resolveEmbeddingModel(
      this.settings.ai.provider,
      this.settings.ai.embeddingModel,
    );
  }

  /**
   * Batch-embed via Gemini's `:batchEmbedContents` endpoint. Mirrors
   * the wire format of the original `GeminiEmbeddingProvider` —
   * x-goog-api-key header, `{ requests: [{ model, content: { parts } }] }`
   * body, response shape `{ embeddings: [{ values: number[] }] }`.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error(
        "Chronote: no Gemini API key configured. Set one in Settings → Chronote.",
      );
    }
    const model = this.embeddingModel;
    const body = {
      requests: texts.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
      })),
    };
    const url = `${this.apiBase}/${model}:batchEmbedContents`;
    const response = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      // Resolve on non-2xx so checkResponseStatus surfaces the
      // upstream error message instead of Obsidian's generic throw.
      throw: false,
    });
    this.checkResponseStatus(response);
    return this.parseEmbeddings(response.json, texts.length);
  }

  private parseEmbeddings(json: unknown, expected: number): number[][] {
    const obj = json as { embeddings?: Array<{ values?: unknown }> } | undefined;
    const embeddings = obj?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== expected) {
      throw new Error(
        `Chronote: Gemini /batchEmbedContents returned ${Array.isArray(embeddings) ? embeddings.length : 0} vectors, expected ${expected}.`,
      );
    }
    const out: number[][] = [];
    for (let i = 0; i < embeddings.length; i++) {
      const values = embeddings[i]?.values;
      if (!Array.isArray(values)) {
        throw new Error(
          `Chronote: Gemini /batchEmbedContents returned a row without values at index ${i}.`,
        );
      }
      out.push(values as number[]);
    }
    return out;
  }
}

function isApiResponse(obj: unknown): obj is GeminiApiResponse {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
}

/**
 * Gemini's `parameters` schema is a JSON Schema subset. The
 * `type: "object"` field requires a slightly different shape than
 * some other providers (uppercase `STRING`/`OBJECT` is accepted in
 * the old API, but the lowercase form is canonical and is what the
 * current docs use). This is a no-op for typical schemas; if the
 * user supplies something exotic we just pass it through.
 */
function normalizeSchemaForGemini(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return schema;
}

/** Re-export so legacy import paths keep working. */
export { buildTimeContext };
