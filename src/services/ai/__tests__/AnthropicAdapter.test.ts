import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression test for the Anthropic adapter's auth headers, system
 * field placement, and tool_use ↔ tool_result round-trip.
 */

const requestUrlMock = vi.fn();

vi.mock("obsidian", () => ({
  requestUrl: (...args: unknown[]) => requestUrlMock(...args),
}));

import { AnthropicAdapter } from "../AnthropicAdapter.js";
import { DEFAULT_SETTINGS, CortexSettings } from "../../../settingsTypes.js";
import { runWithTools } from "../runWithTools.js";

function settingsWithKey(key: string, model = "claude-sonnet-4-6"): CortexSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, provider: "anthropic", apiKey: key, model },
  };
}

describe("AnthropicAdapter — auth headers", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      },
    });
  });

  it("sends the API key in x-api-key (not Authorization)", async () => {
    const adapter = new AnthropicAdapter(settingsWithKey("sk-ant-LEAKED-KEY-12345"));
    await adapter.chat({
      system: "you are a test",
      messages: [{ role: "user", text: "hi" }],
    });

    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["x-api-key"]).toBe("sk-ant-LEAKED-KEY-12345");
    expect(call.headers["Authorization"]).toBeUndefined();
    expect(call.headers["x-api-key"]).not.toContain("Bearer");
  });

  it("includes anthropic-version: 2023-06-01", async () => {
    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    await adapter.chat({
      system: "you are a test",
      messages: [{ role: "user", text: "hi" }],
    });

    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sends system as a top-level field (not a message)", async () => {
    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    await adapter.chat({
      system: "TOP LEVEL SYSTEM",
      messages: [{ role: "user", text: "hi" }],
    });

    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    expect(body.system).toBe("TOP LEVEL SYSTEM");
    // The system string MUST NOT appear inside the messages array
    for (const m of body.messages) {
      const contentStr = JSON.stringify(m.content);
      expect(contentStr).not.toContain("TOP LEVEL SYSTEM");
    }
  });

  it("targets the Anthropic messages endpoint", async () => {
    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });

    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("AnthropicAdapter — tool_use round-trip", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("normalizes Gemini-style UPPERCASE schema types in input_schema", async () => {
    // The agent ToolRegistry declares parameters with Gemini-native
    // UPPERCASE types; Anthropic validates input_schema and rejects
    // those with an HTTP 400, so the adapter must lowercase them.
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    });
    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        {
          name: "list_events",
          description: "list",
          parameters: {
            type: "OBJECT",
            description: "args",
            properties: {
              date: { type: "STRING", description: "iso date" },
              tags: { type: "ARRAY", items: { type: "STRING", description: "tag" } },
            },
            required: ["date"],
          },
        },
      ],
    });
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const schema = JSON.parse(call.body).tools[0].input_schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.date.type).toBe("string");
    expect(schema.properties.tags.type).toBe("array");
    expect(schema.properties.tags.items.type).toBe("string");
    expect(schema.required).toEqual(["date"]);
    expect(call.body).not.toContain("OBJECT");
    expect(call.body).not.toContain("STRING");
  });

  it("parses a tool_use response into ChatResponse.toolCalls", async () => {
    // First response: model calls a tool
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        content: [
          { type: "text", text: "Let me look that up." },
          {
            type: "tool_use",
            id: "toolu_test_001",
            name: "list_events",
            input: { date: "2026-06-14" },
          },
        ],
        stop_reason: "tool_use",
      },
    });
    // Second response: model gives a final answer
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        content: [{ type: "text", text: "You have 2 events." }],
        stop_reason: "end_turn",
      },
    });

    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    const result = await runWithTools(
      adapter,
      {
        system: "x",
        messages: [{ role: "user", text: "what's on my calendar?" }],
        tools: [
          {
            name: "list_events",
            description: "list events for a date",
            parameters: { type: "object", properties: { date: { type: "string" } } },
          },
        ],
      },
      {
        execute: async (name, args) => {
          expect(name).toBe("list_events");
          expect(args).toEqual({ date: "2026-06-14" });
          return "Found: standup, lunch";
        },
      },
    );

    expect(result).toBe("You have 2 events.");
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
  });

  it("echoes tool_use_id back as a tool_result block in a user turn", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        content: [
          {
            type: "tool_use",
            id: "toolu_echo_42",
            name: "list_events",
            input: { date: "2026-06-14" },
          },
        ],
        stop_reason: "tool_use",
      },
    });
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    });

    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    await runWithTools(
      adapter,
      {
        system: "x",
        messages: [{ role: "user", text: "check" }],
        tools: [
          {
            name: "list_events",
            description: "list events",
            parameters: { type: "object", properties: { date: { type: "string" } } },
          },
        ],
      },
      { execute: async () => "result string" },
    );

    // The second call's body must include a tool_result block with
    // tool_use_id === "toolu_echo_42" and the executor's output.
    const secondCall = requestUrlMock.mock.calls[1][0] as { body: string };
    const body = JSON.parse(secondCall.body);
    const toolResultBlock = body.messages
      .flatMap((m: { content: unknown[] }) => m.content)
      .find(
        (b: { type: string }) => typeof b === "object" && b !== null && (b as { type: string }).type === "tool_result",
      );
    expect(toolResultBlock).toBeDefined();
    expect((toolResultBlock as { tool_use_id: string }).tool_use_id).toBe("toolu_echo_42");
    expect((toolResultBlock as { content: string }).content).toBe("result string");
  });
});

describe("AnthropicAdapter — error surfacing", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("surfaces Anthropic's error.type and error.message on 401", async () => {
    // 401 with a typical Anthropic auth-error body. The user needs
    // to see the actual reason (revoked key, wrong key, etc.) rather
    // than the generic "unexpected response structure".
    requestUrlMock.mockResolvedValue({
      status: 401,
      json: {
        type: "error",
        error: {
          type: "authentication_error",
          message: "invalid x-api-key",
        },
      },
      text: "",
    });
    const adapter = new AnthropicAdapter(settingsWithKey("sk-ant-BAD"));
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 401/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/authentication_error/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/invalid x-api-key/);
  });

  it("includes a 404-specific hint for missing models", async () => {
    requestUrlMock.mockResolvedValue({
      status: 404,
      json: {
        type: "error",
        error: {
          type: "not_found_error",
          message: "model: claude-fake-99",
        },
      },
      text: "",
    });
    const adapter = new AnthropicAdapter(settingsWithKey("k", "claude-fake-99"));
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/model id may be invalid/);
  });
});

describe("AnthropicAdapter — embed (no embedding API)", () => {
  // Anthropic has no embedding endpoint. The adapter's embed()
  // throws a clear error so `runIndex` can surface it as a single
  // actionable notice to the user. No HTTP call should ever be made.
  it("throws a clear error and never calls requestUrl", async () => {
    requestUrlMock.mockReset();
    const adapter = new AnthropicAdapter(settingsWithKey("k"));
    await expect(adapter.embed(["a"])).rejects.toThrow(
      /Anthropic has no embedding endpoint/,
    );
    expect(requestUrlMock).not.toHaveBeenCalled();
  });
});
