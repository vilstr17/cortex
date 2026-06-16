/**
 * Embedding provider for the Cortex AI knowledge index.
 *
 * The actual wire transport lives on the LLM adapters under
 * `src/services/ai/`. This file is a thin façade: it picks the right
 * adapter via `createAdapter(settings)` and wraps its `embed()` method
 * so callers get back `Float32Array[]` (the shape the in-memory cosine
 * index expects).
 *
 * Providers that have no embeddings API (Anthropic, today) still
 * define `embed()` — it throws a clear, actionable error. Indexing for
 * those providers is blocked upstream by `embeddingMissingFields()`
 * before the reindex loop runs, so the throw is only a last-resort
 * guard. The `!adapter.embed` stub below is a defensive fallback for a
 * hypothetical future adapter that omits `embed()` entirely.
 *
 * Why this indirection:
 *   - One configuration surface: the user picks the LLM provider once
 *     and embeddings follow the same key / base URL / auth. No more
 *     parallel `embeddingBaseUrl` / `embeddingApiKey` / `embeddingModel`
 *     fields to keep in sync.
 *   - One place to handle per-transport quirks (Ollama's no-auth rule,
 *     Gemini's header-vs-query auth, dim autodetection).
 *   - `EmbeddingProvider` is a small, stable interface consumed by
 *     `KnowledgeBase` and the `search_notes` tool — neither has to
 *     know which LLM provider is active.
 *
 * History:
 *   - The previous `LocalEmbeddingProvider` (in-process
 *     `@xenova/transformers`) was removed: Obsidian's plugin runtime
 *     has no module resolver, so the externalised `import()` always
 *     threw `TypeError: Failed to resolve module specifier` and every
 *     reindex produced 0 chunks. Users who want a local embedding
 *     model can now point the OpenAI-compatible adapter at Ollama or
 *     LM Studio via the existing `ai.baseUrl` field.
 */

import type { CortexSettings } from "../../settingsTypes.js";
import { createAdapter } from "../../services/ai/index.js";

/** Default embedding dimension. Used as a fallback for index construction only;
 *  the live dim is autodetected from the first embed response. */
export const DEFAULT_EMBEDDING_DIM = 384;

/**
 * Max number of texts sent to the provider in a single embed request.
 *
 * The whole-vault reindex used to pass *every* chunk in one call. That
 * overflows real provider limits:
 *   - Ollama's `/v1/embeddings` 400s on large batches (its tokenizer
 *     subprocess EOFs somewhere past ~500 inputs:
 *     `Post ".../tokenize": EOF`).
 *   - Gemini's `:batchEmbedContents` caps a batch at 100 requests.
 *
 * 64 is comfortably under both and keeps each HTTP request small and
 * reliable; a few hundred sequential requests for a large vault is
 * still fast against a local model. The reindex passes the full chunk
 * list and this wrapper slices it transparently.
 */
export const EMBED_BATCH_SIZE = 64;

/** Debug tag for the embedder. Not user-visible. */
export type EmbeddingProviderName = "api" | "anthropic";

/** Single source of embeddings. Returned vectors are Float32Array of length `dim`. */
export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;
  readonly dim: number;
  /**
   * Embed a batch of texts. Implementations should batch internally
   * to amortize HTTP / model overhead.
   * Throws on unrecoverable errors (network down, auth failure, model
   * load failure). Callers should catch and surface a Notice.
   */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Build the embedder from settings. Routes through the unified LLM
 * adapter layer. Every adapter defines `embed()` (Anthropic's throws,
 * since it has no embeddings API); the `!adapter.embed` stub here is a
 * defensive fallback for a future adapter that omits it. Either way the
 * `KnowledgeBase` failure mode stays "throw on first use", which
 * surfaces as a clear notice in the dashboard / settings / chat layers
 * via `runIndex()`.
 */
export function createEmbeddingProvider(
  settings: CortexSettings,
): EmbeddingProvider {
  const adapter = createAdapter(settings);
  if (!adapter.embed) {
    return {
      name: "anthropic",
      dim: DEFAULT_EMBEDDING_DIM,
      async embed() {
        throw new Error(
          "Cortex: the active AI provider does not support embeddings. " +
            "Switch to OpenAI, Gemini, or a Custom OpenAI-compatible endpoint.",
        );
      },
    };
  }
  // Honor an internal dim override seeded by migration from the
  // on-disk CTX1 file, so existing pre-simplification indexes with
  // a non-384 dim (e.g. nomic-embed-text 768-dim) don't get dropped
  // by the dim-mismatch check in `KnowledgeBase.loadFromDisk`.
  const dimOverride = settings.ai.embeddingDim ?? null;
  return {
    name: "api",
    dim: dimOverride ?? DEFAULT_EMBEDDING_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      // Slice into provider-safe batches (see EMBED_BATCH_SIZE).
      // Sequential so we don't hammer a local model with N concurrent
      // requests; order is preserved so the caller's chunk/vector
      // alignment holds.
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const rows = await adapter.embed!(batch);
        for (const r of rows) out.push(new Float32Array(r));
      }
      return out;
    },
  };
}
