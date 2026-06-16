import { describe, it, expect } from "vitest";
import {
  providerMissingFields,
  embeddingMissingFields,
  resolveEmbeddingModel,
  CORTEX_CLOUD_BASE_URL,
} from "../catalog.js";

/**
 * Tests for the per-provider "what's still missing?" helper used by
 * the chat modal and the dashboard button to decide whether the user
 * can actually send a request yet.
 */

const baseConfig = {
  cortexAccountId: "",
  geminiApiKey: "",
  geminiModel: "",
  apiKey: "",
  model: "",
  baseUrl: "",
};

describe("providerMissingFields", () => {
  it("cortex_cloud: requires only the account id", () => {
    expect(providerMissingFields("cortex_cloud", baseConfig)).toEqual([
      "Cortex account id",
    ]);
    expect(
      providerMissingFields("cortex_cloud", {
        ...baseConfig,
        cortexAccountId: "acct_42",
      }),
    ).toEqual([]);
  });

  it("gemini: requires api key + model", () => {
    expect(providerMissingFields("gemini", baseConfig)).toEqual([
      "Gemini API key",
      "Gemini model",
    ]);
    expect(
      providerMissingFields("gemini", {
        ...baseConfig,
        geminiApiKey: "sk",
        geminiModel: "gemini-2.5-flash",
      }),
    ).toEqual([]);
  });

  it("openai: requires api key + model", () => {
    expect(providerMissingFields("openai", baseConfig)).toEqual([
      "OpenAI API key",
      "OpenAI model",
    ]);
  });

  it("anthropic: requires api key + model", () => {
    expect(providerMissingFields("anthropic", baseConfig)).toEqual([
      "Anthropic API key",
      "Anthropic model",
    ]);
  });

  it("ollama/lmstudio: requires base URL + model (no api key)", () => {
    expect(providerMissingFields("ollama", baseConfig)).toEqual([
      "Base URL",
      "Model",
    ]);
    expect(providerMissingFields("lmstudio", baseConfig)).toEqual([
      "Base URL",
      "Model",
    ]);
    // baseUrl + model suffice; apiKey is optional
    expect(
      providerMissingFields("ollama", {
        ...baseConfig,
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.3",
      }),
    ).toEqual([]);
  });

  it("custom: requires base URL + model (api key is optional)", () => {
    // The Custom provider accommodates both keyless local servers
    // (vLLM, llama.cpp server) and hosted gateways (OpenRouter,
    // Groq, …) that need a key. The settings UI shows the key field
    // for convenience but never blocks the user from testing
    // without one — the OpenAI-compat adapter omits the
    // Authorization header when apiKey is empty.
    expect(providerMissingFields("custom", baseConfig)).toEqual([
      "Base URL",
      "Model",
    ]);
    // Empty apiKey is not a missing field.
    expect(
      providerMissingFields("custom", {
        ...baseConfig,
        baseUrl: "http://localhost:8000/v1",
        model: "meta-llama/Llama-3-8B",
      }),
    ).toEqual([]);
    // A populated apiKey is also fine.
    expect(
      providerMissingFields("custom", {
        ...baseConfig,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-…",
        model: "openai/gpt-4o-mini",
      }),
    ).toEqual([]);
  });
});

describe("resolveEmbeddingModel", () => {
  it("uses the per-provider default when no override is set", () => {
    expect(resolveEmbeddingModel("openai", "")).toBe("text-embedding-3-small");
    expect(resolveEmbeddingModel("gemini", "")).toBe("gemini-embedding-001");
    expect(resolveEmbeddingModel("ollama", "")).toBe("nomic-embed-text");
    expect(resolveEmbeddingModel("lmstudio", "")).toBe("nomic-embed-text");
    expect(resolveEmbeddingModel("cortex_cloud", "")).toBe("nomic-embed-text");
  });

  it("returns an empty string when there is no default (custom / anthropic)", () => {
    expect(resolveEmbeddingModel("custom", "")).toBe("");
    expect(resolveEmbeddingModel("anthropic", "")).toBe("");
  });

  it("honors an explicit override (and trims it) for local / custom providers", () => {
    expect(resolveEmbeddingModel("ollama", "mxbai-embed-large")).toBe("mxbai-embed-large");
    expect(resolveEmbeddingModel("lmstudio", "  nomic-embed-text-v1.5  ")).toBe(
      "nomic-embed-text-v1.5",
    );
    expect(resolveEmbeddingModel("custom", "  text-embedding-3-large  ")).toBe(
      "text-embedding-3-large",
    );
  });

  it("ignores the global override for hosted providers and uses their default", () => {
    // Regression: `ai.embeddingModel` is a single global field. A value
    // the user set for Ollama must not leak into a hosted provider's
    // request — Gemini/OpenAI 404 on `models/nomic-embed-text:latest`.
    expect(resolveEmbeddingModel("gemini", "nomic-embed-text:latest")).toBe(
      "gemini-embedding-001",
    );
    expect(resolveEmbeddingModel("openai", "nomic-embed-text:latest")).toBe(
      "text-embedding-3-small",
    );
  });
});

describe("embeddingMissingFields", () => {
  it("blocks only Anthropic (no embedding endpoint)", () => {
    expect(embeddingMissingFields("anthropic")).toEqual([
      "Anthropic has no embedding endpoint",
    ]);
  });

  it("allows every other provider with no embedding model configured", () => {
    for (const p of ["openai", "gemini", "ollama", "lmstudio", "custom", "cortex_cloud"] as const) {
      expect(embeddingMissingFields(p, "")).toEqual([]);
    }
  });
});

describe("CORTEX_CLOUD_BASE_URL", () => {
  it("points at the cortex-proxy subdomain", () => {
    expect(CORTEX_CLOUD_BASE_URL).toMatch(/^https:\/\/cortex-proxy\.vercel\.app/);
  });
});
