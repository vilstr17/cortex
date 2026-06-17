import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the OpenAI-compatible adapter — covers URL construction,
 * Authorization header, JSON-decoded `arguments` field, and the
 * Ollama-specific quirks (placeholder API key, no `tool_choice`).
 * Chronote Cloud is implemented as another OpenAI-compat case with a
 * fixed base URL and the account id as the bearer token.
 */

const requestUrlMock = vi.fn();

vi.mock("obsidian", () => ({
  requestUrl: (...args: unknown[]) => requestUrlMock(...args),
}));

import { OpenAICompatAdapter, normalizeBaseUrl } from "../OpenAICompatAdapter.js";
import { createAdapter } from "../index.js";
import { DEFAULT_SETTINGS, ChronoteSettings } from "../../../settingsTypes.js";
import { CHRONOTE_CLOUD_BASE_URL } from "../catalog.js";

function settingsFor(
  provider: "openai" | "ollama" | "lmstudio" | "custom",
  opts: { apiKey?: string; baseUrl?: string; model?: string } = {},
): ChronoteSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      provider,
      apiKey: opts.apiKey ?? "",
      model: opts.model ?? "gpt-4o-mini",
      baseUrl: opts.baseUrl ?? "",
    },
  };
}

describe("OpenAICompatAdapter — request shape", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      },
    });
  });

  it("sends the API key in the Authorization header", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsFor("openai", { apiKey: "sk-LEAKED-KEY-12345" }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBe("Bearer sk-LEAKED-KEY-12345");
  });

  it("omits the Authorization header for Ollama when no key is provided", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsFor("ollama", { baseUrl: "http://localhost:11434/v1", model: "llama3.3" }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string>; url: string };
    // Ollama ignores auth, and newer Ollama builds actively reject
    // placeholder bearer tokens with HTTP 403 — so we send no
    // Authorization header at all when no real key is configured.
    expect(call.headers["Authorization"]).toBeUndefined();
    expect(call.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("omits the Authorization header for LM Studio when no key is provided", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsFor("lmstudio", { baseUrl: "http://localhost:1234/v1", model: "qwen3" }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  it("sends a user-supplied key for Ollama when one is provided", async () => {
    // If the user has enabled auth on their local Ollama (or fronted
    // it with a reverse proxy that requires a key), we honor the
    // configured key instead of dropping the header.
    const adapter = new OpenAICompatAdapter(
      settingsFor("ollama", {
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.3",
        apiKey: "sk-custom",
      }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBe("Bearer sk-custom");
  });

  it("omits tool_choice for Ollama (the shim rejects it)", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "ok",
              tool_calls: [
                {
                  id: "call_001",
                  type: "function",
                  function: { name: "list_events", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(
      settingsFor("ollama", { baseUrl: "http://localhost:11434/v1", model: "llama3.3" }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        {
          name: "list_events",
          description: "list",
          parameters: { type: "object", properties: { date: { type: "string" } } },
        },
      ],
    });
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    expect(body.tools).toBeDefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("includes tool_choice=auto for OpenAI by default", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsFor("openai", { apiKey: "sk-test", model: "gpt-4o-mini" }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        {
          name: "list_events",
          description: "list",
          parameters: { type: "object", properties: { date: { type: "string" } } },
        },
      ],
    });
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    expect(body.tool_choice).toBe("auto");
  });

  it("normalizes Gemini-style UPPERCASE schema types to standard JSON Schema", async () => {
    // The agent ToolRegistry declares parameters with Gemini-native
    // UPPERCASE types. OpenAI-compatible providers (OpenAI, Ollama, LM
    // Studio, custom, Chronote Cloud) reject those with an HTTP 400, so
    // the adapter must lowercase them — recursively — on the wire.
    const adapter = new OpenAICompatAdapter(
      settingsFor("openai", { apiKey: "sk-test", model: "gpt-4o-mini" }),
    );
    await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
      tools: [
        {
          name: "propose_quiz",
          description: "make a quiz",
          parameters: {
            type: "OBJECT",
            description: "quiz args",
            properties: {
              test_name: { type: "STRING", description: "name" },
              questions: {
                type: "ARRAY",
                description: "the questions",
                items: {
                  type: "OBJECT",
                  description: "one question",
                  properties: {
                    prompt: { type: "STRING", description: "q" },
                    options: {
                      type: "ARRAY",
                      items: { type: "STRING", description: "opt" },
                    },
                    correct_index: { type: "INTEGER", description: "idx" },
                  },
                  required: ["prompt", "options", "correct_index"],
                },
              },
            },
            required: ["test_name", "questions"],
          },
        },
      ],
    });
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const params = JSON.parse(call.body).tools[0].function.parameters;
    expect(params.type).toBe("object");
    expect(params.properties.test_name.type).toBe("string");
    expect(params.properties.questions.type).toBe("array");
    expect(params.properties.questions.items.type).toBe("object");
    expect(params.properties.questions.items.properties.prompt.type).toBe("string");
    expect(params.properties.questions.items.properties.options.type).toBe("array");
    expect(params.properties.questions.items.properties.options.items.type).toBe("string");
    expect(params.properties.questions.items.properties.correct_index.type).toBe("integer");
    // Non-type keys survive verbatim.
    expect(params.required).toEqual(["test_name", "questions"]);
    expect(params.properties.test_name.description).toBe("name");
    // And no UPPERCASE type leaks onto the wire.
    expect(call.body).not.toContain("OBJECT");
    expect(call.body).not.toContain("STRING");
  });
});

describe("OpenAICompatAdapter — response parsing", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("decodes JSON-encoded arguments on tool_calls", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_42",
                  type: "function",
                  function: {
                    name: "list_events",
                    arguments: '{"date":"2026-06-14"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(settingsFor("openai", { apiKey: "sk-test" }));
    const reply = await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(reply.text).toBe("");
    expect(reply.toolCalls).toEqual([
      { id: "call_42", name: "list_events", args: { date: "2026-06-14" } },
    ]);
  });

  it("tolerates malformed arguments (returns empty args, doesn't throw)", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_42",
                  type: "function",
                  function: { name: "list_events", arguments: "{not json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(settingsFor("openai", { apiKey: "sk-test" }));
    const reply = await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(reply.toolCalls).toEqual([
      { id: "call_42", name: "list_events", args: {} },
    ]);
  });

  it("returns text-only reply when model doesn't call tools", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          {
            message: { role: "assistant", content: "Hello there." },
            finish_reason: "stop",
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(settingsFor("openai", { apiKey: "sk-test" }));
    const reply = await adapter.chat({
      system: "x",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(reply.text).toBe("Hello there.");
    expect(reply.toolCalls).toEqual([]);
  });

  it("surfaces HTTP status on non-2xx responses", async () => {
    // 403 from Ollama (or any OpenAI-compat gateway) — we want the
    // upstream error message to bubble up instead of the generic
    // "unexpected response structure" complaint from parseResponse.
    requestUrlMock.mockResolvedValue({
      status: 403,
      json: { error: { message: "model 'llama3.3' not found, try pulling it first" } },
      text: "",
    });
    const adapter = new OpenAICompatAdapter(
      settingsFor("ollama", { baseUrl: "http://localhost:11434/v1", model: "llama3.3" }),
    );
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/Ollama/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/model 'llama3.3' not found/);
  });

  it("falls back to response.text when the body has no error.message", async () => {
    requestUrlMock.mockResolvedValue({
      status: 500,
      json: { unrelated: true },
      text: "upstream gateway error",
    });
    const adapter = new OpenAICompatAdapter(settingsFor("openai", { apiKey: "sk-test" }));
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/upstream gateway error/);
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1",
    );
  });
  it("keeps /v1 paths unchanged", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
  });
  it("returns empty string for empty input", () => {
    expect(normalizeBaseUrl("")).toBe("");
  });
});

describe("Chronote Cloud (via createAdapter)", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      },
    });
  });

  function settingsForCloud(accountId: string): ChronoteSettings {
    return {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "chronote_cloud",
        chronoteAccountId: accountId,
        // baseUrl / model are intentionally junk — the factory
        // should override them.
        baseUrl: "https://should-be-ignored.example/v1",
        model: "should-be-ignored",
      },
    };
  }

  it("targets the fixed cortex-proxy base URL", async () => {
    const adapter = createAdapter(settingsForCloud("acct_test_42"));
    await adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] });
    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe(`${CHRONOTE_CLOUD_BASE_URL}/chat/completions`);
  });

  it("sends the account id in the Authorization header", async () => {
    const adapter = createAdapter(settingsForCloud("acct_test_42"));
    await adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] });
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBe("Bearer acct_test_42");
  });

  it("overrides the user-configured base URL and model", async () => {
    // Sanity check: the factory should NOT honor whatever the user
    // typed into the (hidden) baseUrl / model fields. The proxy
    // is the source of truth for the model.
    const adapter = createAdapter(settingsForCloud("acct_test_42"));
    await adapter.chat({ system: "x", messages: [{ role: "user", text: "hi" }] });
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    expect(body.model).toBe("chronote-cloud-managed");
    expect(call.body).not.toContain("should-be-ignored");
  });
});

describe("OpenAICompatAdapter — embed", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      },
    });
  });

  function settingsWithEmbed(provider: "openai" | "ollama" | "lmstudio" | "custom", extras: Partial<ChronoteSettings> = {}): ChronoteSettings {
    return {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        apiKey: "",
        model: "gpt-4o-mini",
        baseUrl: "",
        ...(extras.ai ?? {}),
        // `provider` is authoritative: it must win over any `provider`
        // pulled in by spreading `extras.ai` (which often includes
        // `...DEFAULT_SETTINGS.ai`, whose default provider would
        // otherwise clobber the intended one and make embed-model
        // resolution order-dependent).
        provider,
      },
      ...extras,
    };
  }

  it("posts to ${baseUrl}/embeddings with input and model in the body", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: {
          ...DEFAULT_SETTINGS.ai,
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-LEAKED-12345",
          embeddingModel: "text-embedding-3-small",
        },
      }),
    );
    const out = await adapter.embed(["hello", "world"]);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    const call = requestUrlMock.mock.calls[0][0] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(call.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["Authorization"]).toBe("Bearer sk-LEAKED-12345");
    const body = JSON.parse(call.body);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["hello", "world"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("omits the model field for custom when ai.embeddingModel is empty", async () => {
    // `custom` has no per-provider default, so an empty embedding
    // model means we let the server pick (no `model` in the body).
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("custom", {
        ai: { ...DEFAULT_SETTINGS.ai, provider: "custom", baseUrl: "https://api.example.com/v1", apiKey: "sk-X", embeddingModel: "" },
      }),
    );
    await adapter.embed(["a"]);
    const call = requestUrlMock.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body);
    expect(body.model).toBeUndefined();
    expect(body.input).toEqual(["a"]);
  });

  it("falls back to the provider default embedding model when ai.embeddingModel is empty", async () => {
    const openai = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-X", embeddingModel: "" },
      }),
    );
    await openai.embed(["a"]);
    expect(JSON.parse((requestUrlMock.mock.calls[0][0] as { body: string }).body).model)
      .toBe("text-embedding-3-small");

    requestUrlMock.mockClear();
    const ollama = new OpenAICompatAdapter(
      settingsWithEmbed("ollama", {
        ai: { ...DEFAULT_SETTINGS.ai, provider: "ollama", baseUrl: "http://localhost:11434/v1", embeddingModel: "" },
      }),
    );
    await ollama.embed(["a"]);
    expect(JSON.parse((requestUrlMock.mock.calls[0][0] as { body: string }).body).model)
      .toBe("nomic-embed-text");
  });

  it("omits the Authorization header for Ollama when no key is configured", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("ollama", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "http://localhost:11434/v1", embeddingModel: "nomic-embed-text" },
      }),
    );
    await adapter.embed(["a"]);
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string>; url: string };
    expect(call.headers["Authorization"]).toBeUndefined();
    expect(call.url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("throws with a useful error on non-2xx, including the upstream message", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 401,
      json: { error: { message: "Incorrect API key provided" } },
    });
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com/v1", apiKey: "sk-WRONG" },
      }),
    );
    await expect(adapter.embed(["a"])).rejects.toThrow(
      /HTTP 401.*Incorrect API key provided/,
    );
  });

  it("throws on a malformed response (no data array)", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { unexpected: true },
    });
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com/v1", apiKey: "sk-X" },
      }),
    );
    await expect(adapter.embed(["a"])).rejects.toThrow(
      /0 vectors, expected 1/,
    );
  });

  it("throws when the response has the wrong number of vectors", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
    });
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com/v1", apiKey: "sk-X" },
      }),
    );
    await expect(adapter.embed(["a", "b", "c"])).rejects.toThrow(
      /1 vectors, expected 3/,
    );
  });

  it("throws when an individual row is missing the embedding array", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { data: [{ embedding: [0.1, 0.2, 0.3] }, {}] },
    });
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com/v1", apiKey: "sk-X" },
      }),
    );
    await expect(adapter.embed(["a", "b"])).rejects.toThrow(
      /index 1/,
    );
  });

  it("throws when called with an empty base URL", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "" },
      }),
    );
    await expect(adapter.embed(["a"])).rejects.toThrow(
      /no base URL configured/,
    );
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("returns an empty array for an empty input without hitting the network", async () => {
    const adapter = new OpenAICompatAdapter(
      settingsWithEmbed("openai", {
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com/v1", apiKey: "sk-X" },
      }),
    );
    const out = await adapter.embed([]);
    expect(out).toEqual([]);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });
});
