import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Direct unit tests for the Gemini adapter — covers auth header
 * placement (x-goog-api-key, NOT Authorization), URL construction,
 * text-only and tool-call response parsing, and the
 * status-code-surfacing behavior added so the user can debug
 * model-access issues (e.g. 403 PERMISSION_DENIED when the API key
 * isn't allow-listed for a preview model).
 */

const requestUrlMock = vi.fn();

vi.mock("obsidian", () => ({
  requestUrl: (...args: unknown[]) => requestUrlMock(...args),
}));

import { GeminiAdapter } from "../GeminiAdapter.js";
import { DEFAULT_SETTINGS, ChronoteSettings } from "../../../settingsTypes.js";

function settingsFor(model = "gemini-2.5-flash", apiKey = "AIzaLEAKED"): ChronoteSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      provider: "gemini",
      geminiModel: model,
      geminiApiKey: apiKey,
      // `ai.embeddingModel` is a global override that the resolver
      // deliberately ignores for hosted providers like Gemini (it
      // would otherwise leak a local provider's model id and 404).
      // So the embed() tests assert against Gemini's canonical
      // default, "gemini-embedding-001".
      embeddingModel: "gemini-embedding-model",
    },
  };
}

describe("GeminiAdapter — request shape", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        candidates: [
          {
            content: { parts: [{ text: "ok" }] },
          },
        ],
      },
    });
  });

  it("sends the API key in x-goog-api-key (not Authorization)", async () => {
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", "AIzaLEAKED-KEY-12345"));
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["x-goog-api-key"]).toBe("AIzaLEAKED-KEY-12345");
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  it("targets the generateContent endpoint for the configured model", async () => {
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-pro"));
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
  });

  it("sends systemInstruction as a top-level field", async () => {
    const adapter = new GeminiAdapter(settingsFor());
    await adapter.chat({
      system: "TOP LEVEL SYSTEM",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    expect(body.systemInstruction.parts[0].text).toBe("TOP LEVEL SYSTEM");
  });
});

describe("GeminiAdapter — response parsing", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("returns assistant text from a candidates[0].content.parts response", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        candidates: [
          { content: { parts: [{ text: "Hello there." }] } },
        ],
      },
    });
    const adapter = new GeminiAdapter(settingsFor());
    const reply = await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(reply.text).toBe("Hello there.");
    expect(reply.toolCalls).toEqual([]);
  });

  it("parses functionCall parts into ChatResponse.toolCalls", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "list_events",
                    args: { date: "2026-06-14" },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const adapter = new GeminiAdapter(settingsFor());
    const reply = await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0].name).toBe("list_events");
    expect(reply.toolCalls[0].args).toEqual({ date: "2026-06-14" });
  });

  it("preserves part-level thought_signature in providerMetadata", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "search_notes",
                    args: { query: "test" },
                  },
                  thoughtSignature: "sig-123",
                },
              ],
            },
          },
        ],
      },
    });
    const adapter = new GeminiAdapter(settingsFor());
    const reply = await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0].providerMetadata).toEqual({
      thoughtSignature: "sig-123",
    });
  });

  it("echoes thought_signature back to Gemini at the part level on the next turn", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: "done" }] } }] },
    });

    const adapter = new GeminiAdapter(settingsFor());
    await adapter.chat({
      system: "x",
      messages: [
        { role: "user", text: "hi" },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            {
              id: "gemini-search_notes-123-0",
              name: "search_notes",
              args: { query: "test" },
              providerMetadata: { thoughtSignature: "sig-123" },
            },
          ],
        },
        {
          role: "tool",
          text: "results",
          toolCallId: "gemini-search_notes-123-0",
          toolName: "search_notes",
        },
      ],
    });

    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    const modelTurn = body.contents.find((c: { role: string }) => c.role === "model");
    expect(modelTurn.parts[0].functionCall).toEqual({
      name: "search_notes",
      args: { query: "test" },
    });
    expect(modelTurn.parts[0].thoughtSignature).toBe("sig-123");
    // Our internal synthetic id must NOT leak into the wire format.
    expect(modelTurn.parts[0].functionCall.id).toBeUndefined();
  });
});

describe("GeminiAdapter — error surfacing", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("surfaces Google's error.message and error.status on 403", async () => {
    // 403 from Google AI Studio for an allow-listed model. The user
    // needs to see "API key does not have access to model X" plus
    // [PERMISSION_DENIED] so they can fix the right field.
    requestUrlMock.mockResolvedValue({
      status: 403,
      json: {
        error: {
          code: 403,
          message: "API key does not have access to model gemini-3-flash-preview",
          status: "PERMISSION_DENIED",
        },
      },
      text: "",
    });
    const adapter = new GeminiAdapter(settingsFor("gemini-3-flash-preview"));
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/gemini-3-flash-preview/);
  });

  it("includes a 404-specific hint for missing models", async () => {
    requestUrlMock.mockResolvedValue({
      status: 404,
      json: {
        error: {
          code: 404,
          message: "models/gemini-99-fake is not found",
          status: "NOT_FOUND",
        },
      },
      text: "",
    });
    const adapter = new GeminiAdapter(settingsFor("gemini-99-fake"));
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/model id may be invalid/);
  });

  it("falls back to response.text when the body has no error.message", async () => {
    requestUrlMock.mockResolvedValue({
      status: 500,
      json: { unrelated: true },
      text: "internal server error",
    });
    const adapter = new GeminiAdapter(settingsFor());
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/internal server error/);
  });
});

describe("GeminiAdapter — embed", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        embeddings: [{ values: [0.1, 0.2, 0.3] }],
      },
    });
  });

  it("posts to :batchEmbedContents with x-goog-api-key and the embedding model", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        embeddings: [
          { values: [0.1, 0.2, 0.3] },
          { values: [0.4, 0.5, 0.6] },
        ],
      },
    });
    const adapter = new GeminiAdapter(
      settingsFor("gemini-2.5-flash", "AIza-LEAKED"),
    );
    const out = await adapter.embed(["hello", "world"]);
    const call = requestUrlMock.mock.calls[0][0] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["x-goog-api-key"]).toBe("AIza-LEAKED");
    expect(call.headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(call.body);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "hello" }] },
    });
    expect(body.requests[1].content.parts[0].text).toBe("world");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("defaults to gemini-embedding-001 when ai.embeddingModel is empty", async () => {
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", "AIza-X"));
    // Override the default settingsFor() model with an empty
    // embedding model so the adapter falls back to the documented
    // default ("gemini-embedding-001").
    (adapter as unknown as { settings: ChronoteSettings }).settings.ai.embeddingModel =
      "";
    await adapter.embed(["a"]);
    const call = requestUrlMock.mock.calls[0][0] as { url: string; body: string };
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    const body = JSON.parse(call.body);
    expect(body.requests[0].model).toBe("models/gemini-embedding-001");
  });

  it("surfaces the upstream error message on non-2xx", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 403,
      json: {
        error: { message: "Permission denied on resource" },
      },
    });
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", "AIza-X"));
    await expect(adapter.embed(["a"])).rejects.toThrow(
      /HTTP 403.*Permission denied/,
    );
  });

  it("throws when the response has the wrong number of embeddings", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { embeddings: [{ values: [0.1, 0.2, 0.3] }] },
    });
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", "AIza-X"));
    await expect(adapter.embed(["a", "b", "c"])).rejects.toThrow(
      /1 vectors, expected 3/,
    );
  });

  it("throws when a row is missing the values array", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { embeddings: [{ values: [0.1, 0.2, 0.3] }, {}] },
    });
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", "AIza-X"));
    await expect(adapter.embed(["a", "b"])).rejects.toThrow(/index 1/);
  });

  it("throws when no API key is configured", async () => {
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", ""));
    await expect(adapter.embed(["a"])).rejects.toThrow(
      /no Gemini API key configured/,
    );
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("returns an empty array for an empty input without hitting the network", async () => {
    const adapter = new GeminiAdapter(settingsFor("gemini-2.5-flash", "AIza-X"));
    const out = await adapter.embed([]);
    expect(out).toEqual([]);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });
});
