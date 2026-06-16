import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the shared tool-calling loop: the configurable round
 * budget, the forced tools-free final answer when the budget is
 * exhausted, and the progress-event stream the chat UI renders.
 */

import { runWithTools } from "../runWithTools";
import type { ToolProgressEvent } from "../runWithTools";
import type {
  AIProviderAdapter,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from "../types";

/** A tool call shaped for the adapter response. */
function call(name: string, id = "c1"): ToolCall {
  return { id, name, args: {} };
}

/**
 * Build an adapter whose `chat()` returns the queued responses in
 * order. Once the queue is empty it keeps returning the last response,
 * so a model that "never stops" calling tools is easy to simulate.
 */
function scriptedAdapter(responses: ChatResponse[]): {
  adapter: AIProviderAdapter;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let i = 0;
  const adapter: AIProviderAdapter = {
    provider: "test",
    chat: vi.fn(async (req: ChatRequest) => {
      requests.push(req);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    }),
  };
  return { adapter, requests };
}

const baseRequest: ChatRequest = {
  system: "SYS",
  messages: [{ role: "user", text: "hi" }],
  tools: [{ name: "search_notes", description: "", parameters: {} }],
};

const noopExecutor = { execute: async () => "tool-result" };

describe("runWithTools — round budget", () => {
  it("returns the text response without exhausting the budget", async () => {
    const { adapter } = scriptedAdapter([{ text: "done", toolCalls: [] }]);
    const out = await runWithTools(adapter, baseRequest, noopExecutor);
    expect(out).toBe("done");
  });

  it("respects a custom maxRounds and forces a tools-free final answer", async () => {
    // The model asks for a tool on every round (queue never yields a
    // text-only reply) until the very last forced request.
    const looping: ChatResponse = { text: "", toolCalls: [call("search_notes")] };
    const finalText: ChatResponse = { text: "best effort answer", toolCalls: [] };
    // 2 looping rounds, then the forced final returns text.
    const { adapter, requests } = scriptedAdapter([looping, looping, finalText]);

    const out = await runWithTools(adapter, baseRequest, noopExecutor, {
      maxRounds: 2,
    });

    expect(out).toBe("best effort answer");
    // 2 loop rounds + 1 forced final = 3 chat() calls.
    expect(requests).toHaveLength(3);
    // The forced final request must have tools disabled.
    expect(requests[2].tools).toBeUndefined();
    // …and carry the round-limit system note.
    expect(requests[2].system).toContain("maximum number of tool-call rounds");
  });

  it("throws if even the forced final answer yields nothing", async () => {
    const looping: ChatResponse = { text: "", toolCalls: [call("search_notes")] };
    const emptyFinal: ChatResponse = { text: "   ", toolCalls: [] };
    const { adapter } = scriptedAdapter([looping, emptyFinal]);

    await expect(
      runWithTools(adapter, baseRequest, noopExecutor, { maxRounds: 1 }),
    ).rejects.toThrow(/maximum tool-call rounds \(1\)/);
  });
});

describe("runWithTools — progress events", () => {
  it("emits round, tool_call, tool_result and a max_rounds fallback", async () => {
    const looping: ChatResponse = { text: "", toolCalls: [call("search_notes")] };
    const finalText: ChatResponse = { text: "answer", toolCalls: [] };
    const { adapter } = scriptedAdapter([looping, finalText]);

    const events: ToolProgressEvent[] = [];
    await runWithTools(adapter, baseRequest, noopExecutor, {
      maxRounds: 1,
      onEvent: (e) => events.push(e),
    });

    expect(events).toContainEqual({ type: "round", round: 1, maxRounds: 1 });
    expect(events).toContainEqual({
      type: "tool_call",
      name: "search_notes",
      args: {},
    });
    expect(events).toContainEqual({
      type: "tool_result",
      name: "search_notes",
      ok: true,
    });
    expect(events).toContainEqual({ type: "fallback", reason: "max_rounds" });
  });

  it("reports a failing tool with ok: false but keeps running", async () => {
    const looping: ChatResponse = { text: "", toolCalls: [call("search_notes")] };
    const finalText: ChatResponse = { text: "answer", toolCalls: [] };
    const { adapter } = scriptedAdapter([looping, finalText]);
    const throwingExecutor = {
      execute: async () => {
        throw new Error("boom");
      },
    };

    const events: ToolProgressEvent[] = [];
    const out = await runWithTools(adapter, baseRequest, throwingExecutor, {
      maxRounds: 1,
      onEvent: (e) => events.push(e),
    });

    expect(out).toBe("answer");
    expect(events).toContainEqual({
      type: "tool_result",
      name: "search_notes",
      ok: false,
    });
  });

  it("never lets a throwing onEvent callback break the turn", async () => {
    const { adapter } = scriptedAdapter([{ text: "done", toolCalls: [] }]);
    const out = await runWithTools(adapter, baseRequest, noopExecutor, {
      onEvent: () => {
        throw new Error("ui blew up");
      },
    });
    expect(out).toBe("done");
  });
});
