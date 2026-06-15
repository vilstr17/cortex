import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the local-model discovery helper. Both Ollama and LM
 * Studio speak the OpenAI `GET /v1/models` shape:
 *   { "data": [ { "id": "model-name" }, ... ] }
 *
 * We cover: parsing the shape, tolerating URL variants, returning []
 * on every failure path, and only sending the Authorization header
 * when a real key is supplied (newer Ollama builds 403 on placeholder
 * bearer tokens).
 */

const requestUrlMock = vi.fn();

vi.mock("obsidian", () => ({
  requestUrl: (...args: unknown[]) => requestUrlMock(...args),
}));

import { listLocalModels } from "../listLocalModels";

describe("listLocalModels — happy path", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("parses the OpenAI { data: [{ id }, ...] } shape", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        data: [
          { id: "llama3.3" },
          { id: "qwen3:8b" },
          { id: "embeddinggemma" },
        ],
      },
    });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([
      { id: "llama3.3" },
      { id: "qwen3:8b" },
      { id: "embeddinggemma" },
    ]);
  });

  it("strips trailing slashes and appends /v1/models", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [{ id: "llama3.3" }] },
    });
    await listLocalModels("http://localhost:11434/", null);
    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe("http://localhost:11434/v1/models");
  });

  it("appends /v1 to a bare host URL (no /v1 supplied)", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [] },
    });
    await listLocalModels("http://localhost:11434", null);
    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe("http://localhost:11434/v1/models");
  });

  it("does not double-up /v1 when it's already present", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [] },
    });
    await listLocalModels("http://localhost:11434/v1", null);
    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe("http://localhost:11434/v1/models");
  });

  it("trims whitespace from the baseUrl", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [] },
    });
    await listLocalModels("  http://localhost:1234/v1  ", null);
    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toBe("http://localhost:1234/v1/models");
  });
});

describe("listLocalModels — failure paths (returns [])", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("returns [] for an empty baseUrl", async () => {
    const models = await listLocalModels("", null);
    expect(models).toEqual([]);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("returns [] when requestUrl throws (network / CORS / server down)", async () => {
    requestUrlMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("returns [] on a 401 response", async () => {
    requestUrlMock.mockResolvedValue({ status: 401, json: { error: "auth" } });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("returns [] on a 403 response", async () => {
    requestUrlMock.mockResolvedValue({ status: 403, json: { error: "forbidden" } });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("returns [] on a 404 response", async () => {
    requestUrlMock.mockResolvedValue({ status: 404, json: {} });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("returns [] on a 500 response", async () => {
    requestUrlMock.mockResolvedValue({ status: 500, json: {} });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("returns [] when the body has no data array", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { models: [{ id: "x" }] }, // wrong shape
    });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("returns [] when the body is null", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: null });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([]);
  });

  it("drops entries whose id is not a string", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        data: [
          { id: "good" },
          { id: 123 },
          { id: null },
          { /* no id field at all */ },
          { id: "also-good" },
        ],
      },
    });
    const models = await listLocalModels("http://localhost:11434/v1", null);
    expect(models).toEqual([{ id: "good" }, { id: "also-good" }]);
  });
});

describe("listLocalModels — auth header", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [] },
    });
  });

  it("omits the Authorization header when apiKey is null", async () => {
    await listLocalModels("http://localhost:11434/v1", null);
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  it("omits the Authorization header when apiKey is an empty string", async () => {
    await listLocalModels("http://localhost:11434/v1", "");
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  it("omits the Authorization header when apiKey is whitespace only", async () => {
    await listLocalModels("http://localhost:11434/v1", "   ");
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  it("sends Authorization: Bearer <key> when a real key is supplied", async () => {
    await listLocalModels("http://localhost:11434/v1", "sk-custom");
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBe("Bearer sk-custom");
  });

  it("trims whitespace around the supplied key", async () => {
    await listLocalModels("http://localhost:11434/v1", "  sk-custom  ");
    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["Authorization"]).toBe("Bearer sk-custom");
  });
});
