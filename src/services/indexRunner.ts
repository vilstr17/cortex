/**
 * Single entry point for "index the vault".
 *
 * Three call sites (the dashboard button, the `reindex-knowledge-base`
 * command palette entry, and the settings-tab button) all funnel
 * through this helper. It owns:
 *
 *   - chat-side validation (delegates to `providerMissingFields`)
 *   - embedding-side validation (delegates to `embeddingMissingFields`)
 *   - the re-entry guard (via `kb.isReindexInFlight()`)
 *   - a sticky progress Notice that updates as the reindex ticks
 *   - the success / failure Notice the user actually sees
 *   - state-change + progress callbacks so the caller UI can
 *     re-render its status line / button label
 *
 * Errors thrown by `kb.reindexVault` propagate up to the user as a
 * single Notice naming the actual upstream reason (Ollama not
 * running, model not pulled, Anthropic's "no embedding endpoint",
 * etc.). We never wrap the original message in a generic shell —
 * the user needs the verbatim text to fix the configuration.
 */
import { Notice } from "obsidian";
import type ChronotePlugin from "../main.js";
import { providerMissingFields, embeddingMissingFields } from "./ai/catalog.js";

export interface RunIndexOptions {
  /** Re-render the caller's UI on progress (button label / status line). */
  onProgress?: (label: string) => void;
  /** Re-render the caller's UI on lifecycle transitions. */
  onStateChange?: (
    state: "running" | "done" | "error",
    info?: string,
  ) => void;
}

export async function runIndex(
  plugin: ChronotePlugin,
  opts: RunIndexOptions = {},
): Promise<void> {
  const ai = plugin.settings.ai;

  // 1. The chat provider must be configured.
  const missing = providerMissingFields(ai.provider, {
    geminiApiKey: ai.geminiApiKey,
    geminiModel: ai.geminiModel,
    apiKey: ai.apiKey,
    model: ai.model,
    baseUrl: ai.baseUrl,
  });
  if (missing.length > 0) {
    new Notice(
      `Chronote: AI provider is not configured. Missing: ${missing.join(", ")}. Open Settings → Chronote.`,
    );
    opts.onStateChange?.("error", "not configured");
    return;
  }

  // 2. The embedding path has its own gating (Anthropic, missing
  //    model id, etc.). Run this *before* the in-flight guard so a
  //    user clicking during an existing run still sees the
  //    actionable message.
  const embMissing = embeddingMissingFields(ai.provider, ai.embeddingModel);
  if (embMissing.length > 0) {
    new Notice(
      `Chronote: cannot index. ${embMissing.join(", ")}. Open Settings → Chronote.`,
    );
    opts.onStateChange?.("error", "embedding not configured");
    return;
  }

  const kb = plugin.getKnowledgeBase();
  if (kb.isReindexInFlight()) {
    new Notice("Chronote: a reindex is already running.");
    return;
  }

  opts.onStateChange?.("running");
  const progressNotice = new Notice("Chronote: indexing… 0/?", 0);
  try {
    await kb.reindexVault((p) => {
      const label = `Indexing… ${p.done}/${p.total} (${p.chunks} chunks)`;
      // Obsidian replaces Notice text in place via setMessage — no
      // visible flicker.
      progressNotice.setMessage(`Chronote: ${label}`);
      opts.onProgress?.(label);
    });
    progressNotice.hide();
    new Notice(`Chronote: indexed ${kb.chunkCount} chunk(s).`);
    opts.onStateChange?.("done");
  } catch (err) {
    progressNotice.hide();
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`Chronote: indexing failed — ${msg}`);
    opts.onStateChange?.("error", msg);
  }
}
