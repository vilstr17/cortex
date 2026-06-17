import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the `runIndex` helper — the single entry point that
 * the dashboard button, the command palette, and the settings-tab
 * button all funnel through. It owns the chat + embedding
 * validation, the in-flight guard, the progress Notice, and the
 * success / failure Notice.
 */

const NoticeMock = vi.fn();

vi.mock("obsidian", () => ({
  Notice: class {
    constructor(...args: unknown[]) {
      NoticeMock(...args);
    }
    setMessage = vi.fn();
    hide = vi.fn();
  },
}));

const providerMissingFieldsMock = vi.fn();
const embeddingMissingFieldsMock = vi.fn();

vi.mock("../ai/catalog", () => ({
  providerMissingFields: (...args: unknown[]) => providerMissingFieldsMock(...args),
  embeddingMissingFields: (...args: unknown[]) => embeddingMissingFieldsMock(...args),
}));

import { runIndex } from "../indexRunner.js";
import { DEFAULT_SETTINGS, ChronoteSettings } from "../../settingsTypes.js";

function settingsFor(overrides: Partial<ChronoteSettings["ai"]> = {}): ChronoteSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, ...overrides },
  };
}

function makePlugin(ai: ChronoteSettings["ai"]) {
  const kb = {
    isReindexInFlight: vi.fn(() => false),
    // Cast through `unknown` so we can pass a callback shape when
    // overriding per-test without a union of all possible signatures.
    reindexVault: vi.fn(async (_cb?: (p: unknown) => void) => {
      void _cb;
    }),
    chunkCount: 0,
  };
  return {
    settings: { ...DEFAULT_SETTINGS, ai },
    getKnowledgeBase: () => kb,
    kb,
  };
}

beforeEach(() => {
  NoticeMock.mockReset();
  providerMissingFieldsMock.mockReset();
  embeddingMissingFieldsMock.mockReset();
  // Default: chat and embedding are both configured, no missing
  // fields. Tests that need a different shape override with
  // `mockReturnValueOnce`.
  providerMissingFieldsMock.mockReturnValue([]);
  embeddingMissingFieldsMock.mockReturnValue([]);
});

describe("runIndex", () => {
  it("surfaces a clear Notice + state error when the chat provider is unconfigured", async () => {
    providerMissingFieldsMock.mockReturnValueOnce(["API key"]);
    const onStateChange = vi.fn();
    const plugin = makePlugin(settingsFor().ai);

    await runIndex(plugin as unknown as Parameters<typeof runIndex>[0], { onStateChange });

    expect(NoticeMock).toHaveBeenCalledTimes(1);
    expect(NoticeMock.mock.calls[0][0]).toMatch(/Missing: API key/);
    expect(onStateChange).toHaveBeenCalledWith("error", "not configured");
    expect(plugin.kb.reindexVault).not.toHaveBeenCalled();
  });

  it("surfaces a clear Notice when the embed path is unconfigured (Anthropic)", async () => {
    embeddingMissingFieldsMock.mockReturnValueOnce([
      "Anthropic has no embedding endpoint",
    ]);
    const onStateChange = vi.fn();
    const plugin = makePlugin(settingsFor({ provider: "anthropic" }).ai);

    await runIndex(plugin as unknown as Parameters<typeof runIndex>[0], { onStateChange });

    expect(NoticeMock).toHaveBeenCalledTimes(1);
    expect(NoticeMock.mock.calls[0][0]).toMatch(/Anthropic has no embedding endpoint/);
    expect(onStateChange).toHaveBeenCalledWith("error", "embedding not configured");
    expect(plugin.kb.reindexVault).not.toHaveBeenCalled();
  });

  it("short-circuits silently when a reindex is already in flight", async () => {
    const onStateChange = vi.fn();
    const plugin = makePlugin(settingsFor().ai);
    plugin.kb.isReindexInFlight.mockReturnValueOnce(true);

    await runIndex(plugin as unknown as Parameters<typeof runIndex>[0], { onStateChange });

    expect(NoticeMock).toHaveBeenCalledWith("Chronote: a reindex is already running.");
    expect(plugin.kb.reindexVault).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("runs the reindex and reports success on completion", async () => {
    const onStateChange = vi.fn();
    const onProgress = vi.fn();
    const plugin = makePlugin(settingsFor().ai);
    plugin.kb.reindexVault.mockImplementationOnce(async (cb: (p: unknown) => void) => {
      cb({ done: 1, total: 1, chunks: 5, currentFile: "x.md" });
    });
    plugin.kb.chunkCount = 5;

    await runIndex(plugin as unknown as Parameters<typeof runIndex>[0], {
      onStateChange,
      onProgress,
    });

    expect(plugin.kb.reindexVault).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("running");
    expect(onStateChange).toHaveBeenCalledWith("done");
    expect(onProgress).toHaveBeenCalledWith("Indexing… 1/1 (5 chunks)");
    expect(NoticeMock.mock.calls.some((c) => /indexed 5 chunk/.test(String(c[0])))).toBe(true);
  });

  it("surfaces a Notice with the upstream error message on failure", async () => {
    const onStateChange = vi.fn();
    const plugin = makePlugin(settingsFor().ai);
    plugin.kb.reindexVault.mockRejectedValueOnce(
      new Error("Ollama connection refused"),
    );

    await runIndex(plugin as unknown as Parameters<typeof runIndex>[0], { onStateChange });

    expect(onStateChange).toHaveBeenCalledWith("error", "Ollama connection refused");
    expect(NoticeMock.mock.calls.some((c) =>
      /indexing failed — Ollama connection refused/.test(String(c[0])),
    )).toBe(true);
  });
});
