import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the embedding provider factory. The factory is a thin
 * façade over the unified LLM adapter layer (`createAdapter`), so
 * the only thing worth testing is the wiring: it picks up the
 * adapter's `embed()` method, wraps the response in Float32Array,
 * and returns a stub when the active provider has no `embed`.
 *
 * The wire-level behavior of `embed()` itself is tested on each
 * adapter in `src/services/ai/__tests__/`.
 */

const embedMock = vi.fn();

vi.mock("../../../services/ai", () => ({
  createAdapter: () => ({
    provider: "openai",
    chat: vi.fn(),
    embed: (...args: unknown[]) => embedMock(...args),
  }),
}));

vi.mock("obsidian", () => ({
  Notice: class {},
}));

import {
  createEmbeddingProvider,
  DEFAULT_EMBEDDING_DIM,
  EMBED_BATCH_SIZE,
} from "../embeddings";
import { DEFAULT_SETTINGS, CortexSettings } from "../../../settingsTypes";

function settingsFor(extras: Partial<CortexSettings> = {}): CortexSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...extras,
  };
}

beforeEach(() => {
  embedMock.mockReset();
});

describe("createEmbeddingProvider — adapter-driven", () => {
  it("returns a Float32Array-wrapping provider when the adapter exposes embed()", async () => {
    embedMock.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    const p = createEmbeddingProvider(settingsFor());
    expect(p.name).toBe("api");
    const out = await p.embed(["hello"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(3);
    expect(out[0][0]).toBeCloseTo(0.1, 5);
  });

  it("defaults the dim to DEFAULT_EMBEDDING_DIM when no override is set", () => {
    const p = createEmbeddingProvider(settingsFor());
    expect(p.dim).toBe(DEFAULT_EMBEDDING_DIM);
  });

  it("honors the internal dim override seeded by migration", () => {
    const p = createEmbeddingProvider(
      settingsFor({
        ai: { ...DEFAULT_SETTINGS.ai, embeddingDim: 768 },
      }),
    );
    expect(p.dim).toBe(768);
  });

  it("passes the texts through to the adapter's embed() in order", async () => {
    embedMock.mockResolvedValueOnce([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    const p = createEmbeddingProvider(settingsFor());
    await p.embed(["a", "b"]);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0][0]).toEqual(["a", "b"]);
  });

  it("splits large inputs into EMBED_BATCH_SIZE batches, preserving order", async () => {
    // Adapter echoes one 1-dim vector per input, encoding the numeric
    // input so we can assert ordering across batch boundaries.
    embedMock.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map((t) => [Number(t)])),
    );
    const p = createEmbeddingProvider(settingsFor());
    const n = EMBED_BATCH_SIZE * 2 + 5;
    const inputs = Array.from({ length: n }, (_, i) => String(i));
    const out = await p.embed(inputs);

    expect(out).toHaveLength(n);
    expect(embedMock).toHaveBeenCalledTimes(3); // 64 + 64 + 5
    expect(embedMock.mock.calls[0][0]).toHaveLength(EMBED_BATCH_SIZE);
    expect(embedMock.mock.calls[2][0]).toHaveLength(5);
    // Order preserved end-to-end across batches.
    expect(out[0][0]).toBe(0);
    expect(out[n - 1][0]).toBe(n - 1);
  });
});

describe("createEmbeddingProvider — no-embed stub", () => {
  it("returns a throwing stub when the adapter has no embed()", async () => {
    vi.resetModules();
    vi.doMock("../../../services/ai", () => ({
      createAdapter: () => ({
        provider: "anthropic",
        chat: vi.fn(),
        // intentionally no `embed`
      }),
    }));
    const { createEmbeddingProvider: fresh } = await import("../embeddings");
    const p = fresh(settingsFor());
    expect(p.name).toBe("anthropic");
    await expect(p.embed(["a"])).rejects.toThrow(
      /does not support embeddings/,
    );
  });
});
