import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the OpenAI-compatible adapter's manual tool-call fallback.
 *
 * Some local models emit tool calls as plain text JSON instead of the
 * native `tool_calls` field. The adapter should parse those so the shared
 * tool-calling loop can still execute them.
 */

const requestUrlMock = vi.fn();

vi.mock("obsidian", () => ({
  requestUrl: (...args: unknown[]) => requestUrlMock(...args),
}));

import { OpenAICompatAdapter } from "../OpenAICompatAdapter.js";
import { DEFAULT_SETTINGS, ChronoteSettings } from "../../../settingsTypes.js";

function settingsFor(): ChronoteSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      provider: "custom",
      baseUrl: "https://example.com/v1",
      model: "local-model",
    },
  };
}

describe("OpenAICompatAdapter — manual tool-call fallback", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("parses a single <tool_call> marker into a tool call", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content:
                'Thinking...\n<tool_call>{"name":"search_notes","arguments":{"query":"Czech literature"}}</tool_call>',
            },
          },
        ],
      },
    });

    const adapter = new OpenAICompatAdapter(settingsFor());
    const response = await adapter.chat({
      system: "sys",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        {
          name: "search_notes",
          description: "Search notes",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe("search_notes");
    expect(response.toolCalls[0].args).toEqual({ query: "Czech literature" });
  });

  it("prefers native tool_calls and ignores text markers", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "fallback text",
              tool_calls: [
                {
                  id: "native-1",
                  type: "function",
                  function: {
                    name: "read_note",
                    arguments: JSON.stringify({ path: "Note.md" }),
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const adapter = new OpenAICompatAdapter(settingsFor());
    const response = await adapter.chat({
      system: "sys",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        { name: "read_note", description: "Read", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].id).toBe("native-1");
    expect(response.toolCalls[0].name).toBe("read_note");
  });

  it("ignores text that does not match a known tool name", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Just answering normally.",
            },
          },
        ],
      },
    });

    const adapter = new OpenAICompatAdapter(settingsFor());
    const response = await adapter.chat({
      system: "sys",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        { name: "search_notes", description: "Search", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(response.toolCalls).toHaveLength(0);
    expect(response.text).toBe("Just answering normally.");
  });
});
