/**
 * In-memory vector index for the Chronote AI knowledge index.
 *
 * Storage: a single Float32Array of size (chunkCount × dim), plus
 * a parallel array of chunk metadata (file, heading, text). The
 * matrix is row-major: `vectors[i*dim + j]` is dimension j of
 * chunk i.
 *
 * Search: naive cosine similarity. For personal-vault scale (up
 * to ~50k chunks × 384 dims) this is well under 50ms on a modern
 * laptop. If/when the vault grows, swap in a real ANN index
 * (hnswlib-wasm, voyager) behind the same `VectorIndex`
 * interface — the rest of the agent doesn't care.
 *
 * Concurrency: the index is mutated in-place. We don't lock during
 * `search()` because the caller's intent is read-only and the
 * worst case is a one-off stale result during a reindex. If that
 * becomes a problem, a copy-on-write snapshot is a clean upgrade.
 */

import { NoteChunk } from "./chunker.js";

export interface SearchHit {
  chunk: NoteChunk;
  /** Cosine similarity in [-1, 1]. Higher is more similar. */
  score: number;
}

export interface VectorIndex {
  readonly dim: number;
  /** Number of chunks currently in the index. */
  readonly size: number;
  /** Add chunks and their embeddings to the index. */
  add(chunks: NoteChunk[], embeddings: Float32Array[]): void;
  /** Remove all chunks whose `file` matches the given path. */
  removeFile(path: string): void;
  /** Reset the index to empty. */
  clear(): void;
  /**
   * Search the index for the top-k chunks most similar to `queryVec`.
   * Returns hits sorted by descending score.
   */
  search(queryVec: Float32Array, k: number): SearchHit[];
  /** Snapshot the internal state for persistence. */
  snapshot(): IndexSnapshot;
  /** Load state from a snapshot (replaces current contents). */
  load(snapshot: IndexSnapshot): void;
}

/**
 * Serializable snapshot of the index. The matrix is exposed as a
 * plain `number[]` (one contiguous array) so it survives JSON
 * serialization if needed; the persistence layer can also store it
 * as a raw `Float32Array` buffer.
 */
export interface IndexSnapshot {
  dim: number;
  /** Row-major matrix as plain numbers. Use snapshotMatrix() to read. */
  matrix: number[];
  chunks: NoteChunk[];
}

export class InMemoryCosineIndex implements VectorIndex {
  readonly dim: number;
  private _size: number = 0;
  private matrix: Float32Array;
  private chunks: NoteChunk[] = [];

  constructor(dim: number, initialCapacity: number = 1024) {
    this.dim = dim;
    this.matrix = new Float32Array(initialCapacity * dim);
  }

  get size(): number {
    return this._size;
  }

  add(chunks: NoteChunk[], embeddings: Float32Array[]): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `VectorIndex.add: chunk count (${chunks.length}) != embedding count (${embeddings.length})`,
      );
    }
    this.ensureCapacity(this._size + chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      const vec = embeddings[i];
      if (vec.length !== this.dim) {
        throw new Error(
          `VectorIndex.add: embedding dim ${vec.length} != index dim ${this.dim}`,
        );
      }
      // Pre-normalize so search() is a single dot product.
      const normalized = normalize(vec);
      const rowStart = this._size * this.dim;
      this.matrix.set(normalized, rowStart);
      this.chunks.push(chunks[i]);
      this._size++;
    }
  }

  removeFile(path: string): void {
    // Walk chunks backwards so we can splice in place without an
    // intermediate copy. We rebuild the matrix block-by-block
    // because Float32Array has no per-row delete.
    const keptChunks: NoteChunk[] = [];
    const keptRows: number[] = [];
    for (let i = 0; i < this._size; i++) {
      if (this.chunks[i].file !== path) {
        keptChunks.push(this.chunks[i]);
        keptRows.push(i);
      }
    }
    if (keptRows.length === this._size) return;
    const newMatrix = new Float32Array(keptRows.length * this.dim);
    for (let i = 0; i < keptRows.length; i++) {
      const srcStart = keptRows[i] * this.dim;
      const dstStart = i * this.dim;
      newMatrix.set(this.matrix.subarray(srcStart, srcStart + this.dim), dstStart);
    }
    this.matrix = newMatrix;
    this.chunks = keptChunks;
    this._size = keptChunks.length;
  }

  clear(): void {
    this._size = 0;
    this.chunks = [];
    // We don't free the Float32Array — its capacity is still useful
    // for the next add. clear() just resets the logical size.
  }

  search(queryVec: Float32Array, k: number): SearchHit[] {
    if (this._size === 0 || k <= 0) return [];
    if (queryVec.length !== this.dim) {
      throw new Error(
        `VectorIndex.search: query dim ${queryVec.length} != index dim ${this.dim}`,
      );
    }
    const q = normalize(queryVec);
    // Top-k via a tiny linear scan. For ~50k × 384 dims the inner
    // loop is ~20M multiply-adds, well under a frame budget.
    // If the vault grows, replace this with a heap or a real ANN.
    const heap = new TopK(k);
    for (let i = 0; i < this._size; i++) {
      const rowStart = i * this.dim;
      let dot = 0;
      for (let j = 0; j < this.dim; j++) {
        dot += this.matrix[rowStart + j] * q[j];
      }
      heap.push(dot, i);
    }
    const top = heap.drainDescending();
    return top.map((entry) => ({
      chunk: this.chunks[entry.idx],
      score: entry.score,
    }));
  }

  snapshot(): IndexSnapshot {
    return {
      dim: this.dim,
      // Convert to a plain number[] so JSON.stringify works for
      // debugging; the binary persistence path takes a different
      // route (see persistence.ts).
      matrix: Array.from(this.matrix.subarray(0, this._size * this.dim)),
      chunks: this.chunks.slice(),
    };
  }

  load(snapshot: IndexSnapshot): void {
    if (snapshot.dim !== this.dim) {
      throw new Error(
        `VectorIndex.load: snapshot dim ${snapshot.dim} != index dim ${this.dim}`,
      );
    }
    this.matrix = new Float32Array(snapshot.matrix);
    this.chunks = snapshot.chunks.slice();
    this._size = snapshot.chunks.length;
  }

  private ensureCapacity(needed: number): void {
    if (needed * this.dim <= this.matrix.length) return;
    let newCap = Math.max(this.matrix.length, 1) * 2;
    while (newCap < needed * this.dim) newCap *= 2;
    const next = new Float32Array(newCap);
    next.set(this.matrix);
    this.matrix = next;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * L2-normalize a vector in place and return it. If the input is
 * the zero vector (norm = 0) we return it as-is; downstream cosine
 * will then produce 0, which is a reasonable "no signal" answer.
 */
function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Tiny bounded top-k. We use a sorted array rather than a heap
 * because k is small (default 8) and the cost of `splice` is
 * negligible. The class is intentionally private to this module.
 */
class TopK {
  private entries: Array<{ score: number; idx: number }> = [];
  constructor(private readonly k: number) {}

  push(score: number, idx: number): void {
    // Keep the array in DESCENDING order by score. The head is
    // always the best (highest score); if the new score beats the
    // tail, we have to evict the tail to keep the array bounded
    // at k. Insertion-sort position: walk down from the head
    // while the entry at position i is *less than* the new score
    // (so the new entry belongs above it).
    if (this.entries.length < this.k) {
      let i = 0;
      while (i < this.entries.length && this.entries[i].score > score) i++;
      this.entries.splice(i, 0, { score, idx });
    } else if (score > this.entries[this.entries.length - 1].score) {
      // New score beats the worst. Find where it goes in the
      // descending array, then drop the tail.
      let i = 0;
      while (i < this.entries.length && this.entries[i].score > score) i++;
      this.entries.splice(i, 0, { score, idx });
      this.entries.pop();
    }
  }

  /**
   * Drain in descending-score order. The array is already
   * descending, so this is a copy rather than a reverse — we
   * don't want to mutate internal state in case the caller wants
   * to inspect it.
   */
  drainDescending(): Array<{ score: number; idx: number }> {
    return this.entries.slice();
  }
}
