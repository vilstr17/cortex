/**
 * Shared tool-calling loop.
 *
 * Each adapter is a single `chat()` round-trip. The "execute the
 * function the model called, send the result back, repeat" flow is
 * the same regardless of provider, so it lives here.
 *
 * The loop:
 *   1. Send the conversation + tools to the adapter.
 *   2. If the response includes tool calls, run each through
 *      `executeToolCall` and append the results to the conversation.
 *   3. Repeat until the model returns a text-only response, or we
 *      hit `maxRounds` (default 10) to prevent infinite loops.
 *
 * Graceful degradation: if the request fails because the provider /
 * model doesn't support tools (e.g. a 400 on the first tool-using
 * turn), we retry once with `tools` removed and a short note in the
 * system prompt. If that retry succeeds we return its text.
 *
 * Round-budget exhaustion: a small / quantized local model sometimes
 * never stops calling tools. Rather than throw, once the round budget
 * is spent we make one final request with tools disabled and a system
 * note asking the model to answer from what it already has — so the
 * user gets a reply instead of an error. Only if that final request
 * also fails (or returns nothing) do we throw.
 */
import type {
  AIProviderAdapter,
  ChatMessage,
  ChatRequest,
  ChatResponse,
} from "./types.js";

const DEFAULT_MAX_ROUNDS = 10;

export interface ToolExecutor {
  /** Execute one tool call locally and return the string result. */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * Progress events emitted by the loop so the UI can show what the
 * agent is doing (which tools it's calling) instead of a static
 * "Thinking…" indicator. Purely observational — ignoring them does
 * not change the loop's behaviour.
 */
export type ToolProgressEvent =
  /** A new model turn is starting. `round` is 1-based. */
  | { type: "round"; round: number; maxRounds: number }
  /** The model requested a tool; we're about to execute it. */
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  /** A tool finished. `ok` is false if it threw / returned an error. */
  | { type: "tool_result"; name: string; ok: boolean }
  /** The loop is falling back to a tools-free request. */
  | { type: "fallback"; reason: "unsupported_tools" | "max_rounds" };

export interface RunWithToolsOptions {
  /**
   * Maximum number of tool-call rounds before forcing a final answer.
   * Defaults to {@link DEFAULT_MAX_ROUNDS}. Non-positive values are
   * ignored in favour of the default.
   */
  maxRounds?: number;
  /**
   * Called when the inner adapter throws on a tool-using turn.
   * If this returns true, the loop drops `tools` from the request
   * and retries the same conversation once. If it returns false
   * (or the retry also fails), the original error is rethrown.
   *
   * The default heuristic: re-throw on the first attempt, drop tools
   * on the second attempt.
   */
  shouldRetryWithoutTools?: (err: unknown, attempt: number) => boolean;
  /**
   * Notifies the caller when the loop has to fall back to a text-only
   * request because the provider / model rejected the tool-bearing call.
   * Useful for surfacing a one-time UI notice.
   */
  onFallback?: () => void;
  /**
   * Observational progress callback — see {@link ToolProgressEvent}.
   * Errors thrown here are swallowed so a buggy UI callback can never
   * break a chat turn.
   */
  onEvent?: (event: ToolProgressEvent) => void;
}

/**
 * Run a single chat request with the tool-calling loop.
 *
 * `request.system` is the user's system prompt (the call site
 * already injected the time context and any study-planner
 * instructions). `request.messages` is the rolling conversation
 * history — the loop appends to it.
 */
export async function runWithTools(
  adapter: AIProviderAdapter,
  request: ChatRequest,
  executor: ToolExecutor,
  options: RunWithToolsOptions = {},
): Promise<string> {
  const maxRounds =
    options.maxRounds && options.maxRounds > 0
      ? Math.floor(options.maxRounds)
      : DEFAULT_MAX_ROUNDS;
  const emit = (event: ToolProgressEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken UI callback must never break the chat turn.
    }
  };

  const messages: ChatMessage[] = [...request.messages];
  let baseSystem = request.system;
  let activeTools = request.tools;
  let retriedWithoutTools = false;
  let attempts = 0;

  for (let round = 0; round < maxRounds; round++) {
    emit({ type: "round", round: round + 1, maxRounds });
    attempts++;
    const req: ChatRequest = {
      system: baseSystem,
      messages,
      tools: activeTools,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
    };
    let response: ChatResponse;
    try {
      response = await adapter.chat(req);
    } catch (err) {
      // Graceful degradation: drop tools and retry once. This handles
      // the common case of a small / quantized local model that
      // doesn't support `tools` (e.g. Ollama with an older model).
      const shouldRetry =
        !retriedWithoutTools &&
        (options.shouldRetryWithoutTools
          ? options.shouldRetryWithoutTools(err, attempts)
          : attempts <= 1);
      if (shouldRetry && activeTools && activeTools.length > 0) {
        retriedWithoutTools = true;
        activeTools = undefined;
        emit({ type: "fallback", reason: "unsupported_tools" });
        options.onFallback?.();
        // Append a one-line system note explaining why the tool
        // call didn't go through, then retry.
        baseSystem = appendFallbackNote(baseSystem);
        continue;
      }
      throw err;
    }

    // Pure text response — done.
    if (response.toolCalls.length === 0) {
      return response.text;
    }

    // Append the assistant turn (with tool calls) to history.
    messages.push({
      role: "assistant",
      text: response.text,
      toolCalls: response.toolCalls,
    });

    // Execute every tool call and append the results.
    for (const call of response.toolCalls) {
      emit({ type: "tool_call", name: call.name, args: call.args });
      let result: string;
      let ok = true;
      try {
        result = await executor.execute(call.name, call.args);
      } catch (err) {
        ok = false;
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      emit({ type: "tool_result", name: call.name, ok });
      messages.push({
        role: "tool",
        text: result,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
    // Loop and call the model again with the updated history.
  }

  // Round budget exhausted and the model is still asking for tools.
  // Rather than fail the turn, make one final request with tools
  // disabled and a system note asking it to answer from what it has.
  // This recovers gracefully from small local models that never stop
  // calling tools. Only if this also fails do we surface the error.
  emit({ type: "fallback", reason: "max_rounds" });
  try {
    const finalResponse = await adapter.chat({
      system: appendMaxRoundsNote(baseSystem),
      messages,
      tools: undefined,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
    });
    if (finalResponse.text.trim().length > 0) {
      return finalResponse.text;
    }
  } catch {
    // Fall through to the thrown error below — the forced final
    // request is best-effort; if the provider rejects a tools-free
    // continuation of a tool conversation we report the round limit.
  }

  throw new Error(
    `Chronote: hit maximum tool-call rounds (${maxRounds}) without a final response.`,
  );
}

/**
 * Inject a system note when we have to drop tools because the provider
 * or model rejected the tool-bearing request. The note tells the model
 * to answer without tools and to be transparent about the limitation.
 */
function appendFallbackNote(baseSystem: string): string {
  return (
    baseSystem +
    "\n\n[System note: the previous tool call could not be sent because this model/provider does not appear to support function calling. Answer the user's request without tools, and briefly mention that tool-driven features (notes search, calendar actions, flashcards, quizzes) are unavailable with the current model.]"
  );
}

/**
 * Inject a system note for the forced final turn after the tool-call
 * round budget is exhausted. Tools are disabled for this request, so
 * the note tells the model to stop calling tools and answer directly
 * from the information already gathered in the conversation.
 */
function appendMaxRoundsNote(baseSystem: string): string {
  return (
    baseSystem +
    "\n\n[System note: you have reached the maximum number of tool-call rounds for this turn. Do NOT request any more tools. Give the user the best answer you can right now using the information already gathered above. If that information is incomplete, say so plainly and suggest the user try a more specific request.]"
  );
}
