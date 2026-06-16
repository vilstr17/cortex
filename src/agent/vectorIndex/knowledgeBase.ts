/**
 * Knowledge base — the live in-memory + on-disk vector index over
 * the user's vault, with progress callbacks for the chat UI.
 *
 * Wiring:
 *  - `InMemoryCosineIndex` (the `VectorIndex`) for search.
 *  - `EmbeddingProvider` (routed through the active LLM adapter) for embedding.
 *  - `chunkMarkdown` for splitting notes.
 *  - `encodeSnapshot` / `decodeSnapshot` for persistence.
 *
 * Lifecycle:
 *  - `new KnowledgeBase({...})` constructs an empty index.
 *  - `loadFromDisk()` reads the persisted `index.bin` if it exists.
 *  - `reindexVault()` walks every markdown file, embeds, indexes,
 *    and saves the result. Long-running; run in the background.
 *  - `updateFile(path)` re-chunks one file (used on metadata-cache
 *    change events).
 *
 * The class is owned by `main.ts` and shared with the chat modal
 * and any other code that needs to search the vault.
 *
 * State-change events: `KnowledgeBase` extends `EventTarget` and
 * dispatches a `"change"` event whenever the index state mutates
 * (reindex finishes, a single file is updated, the embedder is
 * recreated on settings change). The dashboard subscribes to keep
 * its Vault Index status line live.
 */

import { App, Notice, TFile } from "obsidian";
import { chunkMarkdown, NoteChunk } from "./chunker.js";
import { InMemoryCosineIndex, VectorIndex } from "./index.js";
import {
  createEmbeddingProvider,
  DEFAULT_EMBEDDING_DIM,
  EMBED_BATCH_SIZE,
  EmbeddingProvider,
} from "./embeddings.js";
import { decodeSnapshot, encodeSnapshot } from "./persistence.js";
import { CortexSettings } from "../../settingsTypes.js";

const INDEX_FILENAME = "knowledge-index.bin";
const PROBE_TEXT = "cortex probe"; // single-word short text for the dim probe call

export interface ReindexProgress {
  /** Number of files processed so far. */
  done: number;
  /** Total files scheduled to process. */
  total: number;
  /** Number of chunks indexed so far. */
  chunks: number;
  /** Current file being processed, for the "Indexing X…" line. */
  currentFile: string;
}

export class KnowledgeBase extends EventTarget {
  readonly app: App;
  /** Mutable reference so the chat modal sees updates from main.ts. */
  settings: CortexSettings;
  /** Save hook from main.ts — wraps `app.saveData`-style persistence. */
  private saveSettings: () => Promise<void>;
  /** Plugin data directory, e.g. ".obsidian/plugins/cortex". */
  private pluginDataDir: string;

  /** The live vector index. Replaced when the embedding dim changes. */
  index: VectorIndex;
  /** The active embedding provider. Recreated if the user changes the setting. */
  embedder: EmbeddingProvider;

  /** Status flags for the chat UI. */
  private _ready: boolean = false;
  private _lastIndexedAt: number = 0;
  private _chunkCount: number = 0;
  /** Active reindex handle, if any. */
  private _reindexInFlight: Promise<void> | null = null;

  constructor(deps: {
    app: App;
    settings: CortexSettings;
    saveSettings: () => Promise<void>;
    pluginDataDir: string;
  }) {
    super();
    this.app = deps.app;
    this.settings = deps.settings;
    this.saveSettings = deps.saveSettings;
    this.pluginDataDir = deps.pluginDataDir;

    // Single source of truth for installing an embedder. The
    // constructor and the public `recreateEmbedder()` method both
    // call this so the dim-change / clear-index path lives in one
    // place.
    this.installEmbedder(createEmbeddingProvider(this.settings));

    this.index = new InMemoryCosineIndex(this.embedder.dim);
  }

  /**
   * Install (or replace) the active embedder and resize the index to
   * match. If the new provider reports a different `dim` than the
   * current index, the on-disk index will be discarded on the next
   * `loadFromDisk` because of the dim-mismatch check there, so we
   * proactively clear the in-memory state and reset the status flags
   * so the UI surfaces a clean "run Reindex" hint immediately rather
   * than waiting for the next save to overwrite the persisted file.
   */
  private installEmbedder(provider: EmbeddingProvider | null): void {
    if (provider) {
      const dimChanged = this.embedder && this.embedder.dim !== provider.dim;
      this.embedder = provider;
      if (dimChanged) {
        this.index = new InMemoryCosineIndex(provider.dim);
        this._chunkCount = 0;
        this._ready = false;
        this._lastIndexedAt = 0;
      }
      return;
    }
    // Stub satisfies the EmbeddingProvider interface; the name
    // field is "api" because that's the only path we ship now
    // that the @xenova/transformers local provider is gone.
    this.embedder = {
      name: "api",
      dim: DEFAULT_EMBEDDING_DIM,
      async embed() {
        throw new Error(
          "Cortex: no embedding provider configured. " +
            "Set a base URL (+ API key, if required) in " +
            "Settings → Cortex → Indexing. [code=E100]",
        );
      },
    };
  }

  /**
   * Rebuild the live embedder from the current `this.settings`.
   * Used by the settings tab after the user edits the embedding
   * model / base URL / key — so the change takes effect without
   * restarting Obsidian.
   *
   * The in-memory index is kept as-is when the dim is unchanged
   * (existing vectors are still valid — the user only swapped the
   * auth/URL, not the embedding model). When the dim changes we
   * drop and re-create the index because the on-disk `CTX1` file
   * encodes dim and would be rejected on next `loadFromDisk`; the
   * user has to reindex anyway, so we surface that immediately.
   */
  recreateEmbedder(): { dimChanged: boolean; ready: boolean } {
    const previousDim = this.embedder.dim;
    this.installEmbedder(createEmbeddingProvider(this.settings));
    const dimChanged = this.embedder.dim !== previousDim;
    if (dimChanged) {
      this.index = new InMemoryCosineIndex(this.embedder.dim);
      this._chunkCount = 0;
      this._ready = false;
      this._lastIndexedAt = 0;
    }
    this.dispatchEvent(new Event("change"));
    return { dimChanged, ready: this._ready };
  }

  isReady(): boolean {
    return this._ready && this.index.size > 0;
  }

  get chunkCount(): number {
    return this._chunkCount;
  }

  get lastIndexedAt(): number {
    return this._lastIndexedAt;
  }

  isReindexInFlight(): boolean {
    return this._reindexInFlight !== null;
  }

  /**
   * Read the persisted index from disk. Returns true on success,
   * false if the file is missing or unreadable. A failure here is
   * not fatal — the next reindex will overwrite the file.
   */
  async loadFromDisk(): Promise<boolean> {
    const path = `${this.pluginDataDir}/${INDEX_FILENAME}`;
    let buf: ArrayBuffer | null = null;
    try {
      buf = await this.app.vault.adapter.readBinary(path);
    } catch {
      return false;
    }
    if (!buf) return false;
    try {
      const bytes = new Uint8Array(buf);
      const snapshot = decodeSnapshot(bytes);
      if (snapshot.dim !== this.embedder.dim) {
        // Dimension mismatch means the user switched providers
        // between sessions. Treat the on-disk index as stale.
        console.warn(
          `Cortex: persisted index dim ${snapshot.dim} != current provider dim ${this.embedder.dim} — discarding.`,
        );
        return false;
      }
      this.index.load(snapshot);
      this._chunkCount = snapshot.chunks.length;
      this._ready = true;
      this._lastIndexedAt = Date.now();
      this.dispatchEvent(new Event("change"));
      return true;
    } catch (err) {
      console.warn("Cortex: failed to load persisted index:", err);
      return false;
    }
  }

  /**
   * Reindex the entire vault. Walks every markdown file, chunks,
   * embeds, and writes the index back to disk. Long-running for
   * large vaults — call from a background context.
   *
   * Re-entrant safe: if a reindex is already running, the new call
   * just awaits the existing promise.
   *
   * Flow (probe-then-batch):
   *   1. Probe the embedder with a single short text to discover
   *      the live dim. If the constructed index's dim doesn't
   *      match, rebuild it before any add().
   *   2. Chunk every file in the vault.
   *   3. Call `embedder.embed(allTexts)` once for the entire vault
   *      (a typical 100-file vault is ~500 chunks; well under any
   *      reasonable limit). If a single batched call fails, fall
   *      back to a per-file loop so a single bad file doesn't
   *      nuke the whole reindex.
   *   4. `index.add(allChunks, allEmbeddings)`. Persist.
   */
  async reindexVault(
    onProgress?: (p: ReindexProgress) => void,
  ): Promise<void> {
    if (this._reindexInFlight) return this._reindexInFlight;
    this._reindexInFlight = this._doReindex(onProgress).finally(() => {
      this._reindexInFlight = null;
    });
    return this._reindexInFlight;
  }

  private async _doReindex(
    onProgress?: (p: ReindexProgress) => void,
  ): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const total = files.length;

    // Rebuild the embedder from current settings. The provider
    // adapters capture their base URL / key / model at construction,
    // so a reindex after the user edits provider settings would
    // otherwise hit a stale endpoint (or the wrong adapter class
    // entirely). Recreating here makes every reindex reflect the
    // live config.
    this.embedder = createEmbeddingProvider(this.settings);

    // Reset state up front so the dashboard's "not indexed" copy
    // shows immediately on click.
    this.index.clear();
    this._chunkCount = 0;
    this._ready = false;
    this.dispatchEvent(new Event("change"));

    // Step 1 — probe the live dim.
    let liveDim: number;
    try {
      const probeVecs = await this.embedder.embed([PROBE_TEXT]);
      if (probeVecs.length === 0 || !probeVecs[0] || probeVecs[0].length === 0) {
        throw new Error("Cortex: embedder returned an empty vector during dim probe.");
      }
      liveDim = probeVecs[0].length;
    } catch (err) {
      // The probe call throws on every kind of failure the user
      // might see later — bad base URL, model not loaded, missing
      // key, etc. Re-throw so runIndex() can surface the original
      // error message verbatim.
      this.dispatchEvent(new Event("change"));
      throw err;
    }
    if (this.index.dim !== liveDim) {
      this.index = new InMemoryCosineIndex(liveDim);
    }

    // Step 2 — chunk every file.
    type FileChunks = { file: TFile; chunks: NoteChunk[]; texts: string[] };
    const perFile: FileChunks[] = [];
    for (const file of files) {
      const markdown = await this.app.vault.cachedRead(file);
      const chunks = chunkMarkdown(file.path, markdown);
      if (chunks.length === 0) continue;
      const texts = chunks.map(
        (c) => `${c.heading ? c.heading + "\n\n" : ""}${c.text}`,
      );
      perFile.push({ file, chunks, texts });
    }

    // Step 3 — embed in one batch.
    const allChunks: NoteChunk[] = [];
    const allTexts: string[] = [];
    for (const { chunks, texts } of perFile) {
      for (let i = 0; i < chunks.length; i++) {
        allChunks.push(chunks[i]);
        allTexts.push(texts[i]);
      }
    }

    // Step 3 + 4 — embed in visible batches and index incrementally.
    // The previous single whole-vault embed reported nothing until it
    // finished, so a multi-thousand-chunk vault looked frozen for
    // minutes. Batching here moves the progress bar, logs each step
    // to the console, and means a mid-run failure keeps what's been
    // indexed so far instead of losing everything.
    const totalChunks = allChunks.length;
    let embedded = 0;
    try {
      for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
        const chunkSlice = allChunks.slice(i, i + EMBED_BATCH_SIZE);
        const textSlice = allTexts.slice(i, i + EMBED_BATCH_SIZE);
        const vecs = await this.embedder.embed(textSlice);
        // Defensive: resize if the live model's dim differs from the probe.
        if (vecs[0] && vecs[0].length !== this.index.dim) {
          this.index = new InMemoryCosineIndex(vecs[0].length);
        }
        this.index.add(chunkSlice, vecs);
        embedded += chunkSlice.length;
        this._chunkCount = this.index.size;
        console.log(`[Cortex] indexing ${embedded}/${totalChunks} chunks`);
        if (onProgress) {
          onProgress({
            done: Math.round((embedded / totalChunks) * total),
            total,
            chunks: this._chunkCount,
            currentFile: "",
          });
        }
        this.dispatchEvent(new Event("change"));
      }
    } catch (err) {
      // Fall back to per-file so a single bad file doesn't kill the
      // whole reindex. Surface a single Notice naming the first
      // failure so the user knows what to fix.
      const message = err instanceof Error ? err.message : String(err);
      console.warn("Cortex: batched embed failed, falling back to per-file:", err);
      new Notice(
        `Cortex: bulk embed failed (${message}). Falling back to per-file indexing.`,
      );
      await this._reindexPerFileFallback(perFile, onProgress, total);
      return;
    }

    // Persist the finished index.
    this._chunkCount = this.index.size;
    this._ready = true;
    this._lastIndexedAt = Date.now();
    await this.syncEmbeddingDim(this.index.dim);
    await this.persistToDisk();
    console.log(`[Cortex] indexing complete: ${this._chunkCount} chunks`);

    if (onProgress) {
      onProgress({
        done: total,
        total,
        chunks: this._chunkCount,
        currentFile: "",
      });
    }
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Slow per-file fallback. Used only when the batched embed call
   * throws (e.g. a single malformed chunk). Each file is its own
   * try/catch so a single bad file doesn't drop the whole reindex.
   */
  private async _reindexPerFileFallback(
    perFile: Array<{ file: TFile; chunks: NoteChunk[]; texts: string[] }>,
    onProgress: ((p: ReindexProgress) => void) | undefined,
    total: number,
  ): Promise<void> {
    let done = 0;
    let chunks = 0;
    let firstError: string | null = null;
    for (const { file, chunks: fileChunks, texts } of perFile) {
      done++;
      try {
        const vecs = await this.embedder.embed(texts);
        // Resize the index if the live model reports a different
        // dim on this call vs. the previous one (rare, but happens
        // when the user swaps model mid-reindex).
        if (vecs[0] && vecs[0].length !== this.index.dim) {
          this.index = new InMemoryCosineIndex(vecs[0].length);
        }
        this.index.add(fileChunks, vecs);
        chunks = this.index.size;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Cortex: failed to embed ${file.path}:`, err);
        if (firstError === null) {
          firstError = `${file.path}: ${message}`;
          new Notice(`Cortex: failed to embed ${file.path}: ${message}`);
        }
      }
      if (onProgress) {
        onProgress({ done, total, chunks, currentFile: file.path });
      }
    }
    this._chunkCount = this.index.size;
    // Don't report success when nothing actually indexed — otherwise
    // the dashboard shows a healthy index while every embed failed and
    // chat silently falls back to hallucination. Re-throw so runIndex
    // surfaces the real reason.
    if (this.index.size === 0 && firstError !== null) {
      this._ready = false;
      this.dispatchEvent(new Event("change"));
      throw new Error(firstError);
    }
    this._ready = true;
    this._lastIndexedAt = Date.now();
    await this.syncEmbeddingDim(this.index.dim);
    await this.persistToDisk();
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Persist the live embedding dim discovered at index time so the
   * freshly built index survives a restart.
   *
   * The embedder's *reported* dim comes from `ai.embeddingDim` in
   * settings (or the 384 default). When that's stale — e.g. the user
   * switched to a 768-dim model like `nomic-embed-text` while the
   * setting still reads 384 — the dim-mismatch check in
   * `loadFromDisk` would discard the persisted index on the next
   * startup, forcing a reindex every session. Writing the probed dim
   * back keeps the on-disk index loadable.
   *
   * Also recreates the embedder so its `.dim` matches the index for
   * the rest of this session, so a later `recreateEmbedder()` doesn't
   * see a phantom dim change and clear the index. No-op when the
   * setting already matches.
   */
  private async syncEmbeddingDim(liveDim: number): Promise<void> {
    if (this.settings.ai.embeddingDim === liveDim) return;
    this.settings.ai.embeddingDim = liveDim;
    this.embedder = createEmbeddingProvider(this.settings);
    try {
      await this.saveSettings();
    } catch (err) {
      console.warn("Cortex: failed to persist embedding dim:", err);
    }
  }

  /**
   * Re-chunk and re-embed a single file. Removes the old version
   * first so the file isn't double-counted.
   */
  async updateFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      // File was deleted — drop any chunks we had for it.
      this.index.removeFile(path);
      this._chunkCount = this.index.size;
      await this.persistToDisk();
      this.dispatchEvent(new Event("change"));
      return;
    }
    if (!this._ready) return; // ignore changes before the first reindex
    this.index.removeFile(path);
    const markdown = await this.app.vault.cachedRead(file);
    const chunks = chunkMarkdown(file.path, markdown);
    if (chunks.length === 0) {
      this._chunkCount = this.index.size;
      await this.persistToDisk();
      this.dispatchEvent(new Event("change"));
      return;
    }
    const texts = chunks.map(
      (c) => `${c.heading ? c.heading + "\n\n" : ""}${c.text}`,
    );
    try {
      const embeddings = await this.embedder.embed(texts);
      if (embeddings[0] && embeddings[0].length !== this.index.dim) {
        this.index = new InMemoryCosineIndex(embeddings[0].length);
      }
      this.index.add(chunks, embeddings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Cortex: failed to embed ${file.path}:`, err);
      new Notice(`Cortex: failed to embed ${file.path}: ${message}`);
    }
    this._chunkCount = this.index.size;
    this._lastIndexedAt = Date.now();
    await this.syncEmbeddingDim(this.index.dim);
    await this.persistToDisk();
    this.dispatchEvent(new Event("change"));
  }

  /** Persist the current index to disk. */
  private async persistToDisk(): Promise<void> {
    const path = `${this.pluginDataDir}/${INDEX_FILENAME}`;
    const snapshot = this.index.snapshot();
    const bytes = encodeSnapshot(snapshot);
    try {
      await this.app.vault.adapter.writeBinary(path, bytes.buffer);
    } catch (err) {
      console.error("Cortex: failed to persist index:", err);
    }
  }
}

/** Re-export the chunk type for convenience. */
export type { NoteChunk };
