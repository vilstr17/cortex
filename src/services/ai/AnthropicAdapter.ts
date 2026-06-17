/**
 * Anthropic native adapter.
 *
 * Uses the Anthropic Messages API (`POST /v1/messages`).
 *
 * Wire format notes:
 *   - `system` is a top-level field, not a message.
 *   - Tools use `input_schema` (not OpenAI's nested `function.parameters`).
 *   - The assistant turn for a tool call comes back as
 *     `content: [{ type: "tool_use", id, name, input }]` (id is `toolu_…`).
 *   - Tool results are returned as a `user` turn with
 *     `content: [{ type: "tool_result", tool_use_id, content }]`.
 *   - `stop_reason: "tool_use"` (not `"tool_calls"`).
 *   - Auth: `x-api-key: <KEY>` plus `anthropic-version: 2023-06-01`.
 *
 * Error handling: 4xx/5xx responses propagate the upstream
 * `error.message` and `error.type` (e.g. "authentication_error",
 * "not_found_error") so the user can see *why* the call failed
 * instead of the generic "unexpected response structure" complaint.
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
import { toStandardJsonSchema } from "./types.js";

// ── Anthropic native types ─────────────────────────────────────────

type AnthropicRole = "user" | "assistant";

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AssistantContent = TextBlock | ToolUseBlock;
type UserContent = TextBlock | ToolResultBlock;

interface AnthropicMessage {
  role: AnthropicRole;
  content: AssistantContent[] | UserContent[] | string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: Array<{ type: string } & Record<string, unknown>>;
  stop_reason?: string;
}

export class AnthropicAdapter implements AIProviderAdapter {
  readonly provider = "anthropic";

  private readonly apiUrl = "https://api.anthropic.com/v1/messages";

  constructor(private settings: ChronoteSettings) {}

  private get apiKey(): string {
    return this.settings.ai.apiKey;
  }

  private get model(): string {
    return this.settings.ai.model || "claude-sonnet-4-6";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.translateMessages(request.messages);
    const tools = request.tools?.length
      ? request.tools.map(toAnthropicTool)
      : undefined;

    const body: Record<string, unknown> = {
      model: this.model,
      system: request.system,
      messages,
      max_tokens: request.maxOutputTokens ?? 4096,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (tools) body.tools = tools;

    const response = await requestUrl({
      url: this.apiUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    this.checkResponseStatus(response);
    return this.parseResponse(response.json);
  }

  /**
   * Throw an informative error when the upstream returned a non-2xx
   * status. Anthropic's error body shape is
   *   { "type": "error", "error": { "type": "authentication_error", "message": "..." } }
   * — we surface both fields so the user can tell whether the failure
   * is a key problem, a missing model, a rate limit, etc.
   */
  private checkResponseStatus(response: { status?: number; text?: string; json?: unknown }): void {
    const status = response.status ?? 0;
    if (status >= 200 && status < 300) return;
    const body = response.json as
      | { error?: { type?: string; message?: string } }
      | undefined;
    const upstreamType = body?.error?.type;
    const upstreamMsg = body?.error?.message;
    const hint =
      status === 401
        ? " — check that the Anthropic API key is valid"
        : status === 404
          ? " — the model id may be invalid or removed"
          : status === 429
            ? " — rate limited, try again later or upgrade your tier"
            : "";
    const detail = upstreamMsg || response.text || "no body";
    const prefix = upstreamType ? ` [${upstreamType}]` : "";
    throw new Error(
      `Chronote: Anthropic returned HTTP ${status}${hint}.${prefix} ${detail}`,
    );
  }

  /**
   * Convert the shared `ChatMessage[]` into Anthropic's `messages`
   * format. The first turn is always `user` (per Anthropic's
   * contract — the assistant can never open the conversation).
   */
  private translateMessages(
    messages: import("./types").ChatMessage[],
  ): AnthropicMessage[] {
    const out: AnthropicMessage[] = [];
    for (const m of messages) {
      if (m.role === "tool") {
        // Tool results live inside a user turn.
        // If the immediately previous turn is also a user turn, append
        // to its content array; otherwise start a new user turn.
        const content: UserContent = {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.text,
        };
        const prev = out[out.length - 1];
        if (prev && prev.role === "user" && Array.isArray(prev.content)) {
          (prev.content as UserContent[]).push(content);
        } else {
          out.push({ role: "user", content: [content] });
        }
        continue;
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        // Assistant tool-call turn: array of tool_use blocks.
        const blocks: AssistantContent[] = m.toolCalls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args,
        }));
        // If the assistant also produced text, include it first.
        if (m.text) blocks.unshift({ type: "text", text: m.text });
        out.push({ role: "assistant", content: blocks });
        continue;
      }
      if (m.role === "user") {
        // Merge consecutive user turns into a single content array.
        const prev = out[out.length - 1];
        if (prev && prev.role === "user") {
          if (Array.isArray(prev.content)) {
            prev.content.push({ type: "text", text: m.text });
          } else {
            prev.content = [
              { type: "text", text: prev.content as string },
              { type: "text", text: m.text },
            ];
          }
          continue;
        }
        out.push({ role: "user", content: m.text });
        continue;
      }
      if (m.role === "assistant") {
        out.push({ role: "assistant", content: m.text });
        continue;
      }
    }
    return out;
  }

  private parseResponse(json: unknown): ChatResponse {
    if (!isResponse(json)) {
      throw new Error("Chronote: Anthropic returned an unexpected response structure.");
    }
    const blocks = json.content ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return { text: text.trim(), toolCalls };
  }

  /**
   * Anthropic does not ship an embeddings API. We surface a clear,
   * actionable error rather than failing silently inside the reindex
   * loop. The message points the user at providers that do support
   * embeddings.
   */
  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error(
      "Chronote: Anthropic has no embedding endpoint. To use AI search, " +
        "switch to OpenAI, Gemini, or set a Custom OpenAI-compatible " +
        "endpoint that serves /v1/embeddings.",
    );
  }
}

function isResponse(obj: unknown): obj is AnthropicResponse {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
}

function toAnthropicTool(t: ToolDeclaration): AnthropicTool {
  return {
    name: t.name,
    description: t.description,
    // Normalize Gemini-native UPPERCASE schema types to standard JSON
    // Schema — Anthropic validates `input_schema` and rejects the
    // uppercase forms with an HTTP 400.
    input_schema: toStandardJsonSchema(t.parameters),
  };
}
