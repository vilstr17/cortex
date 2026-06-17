/**
 * Persistence for the Chronote AI knowledge index.
 *
 * Binary format (little-endian):
 *
 *   [magic: 4 bytes = "CTX1"]
 *   [version: 1 byte = 0x01]
 *   [dim: 4 bytes uint32]
 *   [chunkCount: 4 bytes uint32]
 *   [matrixLen: 4 bytes uint32]  (chunkCount * dim, count of float32s)
 *   [matrixBytes: matrixLen * 4 bytes, raw little-endian f32]
 *   [jsonByteLen: 4 bytes uint32]
 *   [jsonBytes:    jsonByteLen bytes, UTF-8]
 *
 * The JSON payload is the `IndexSnapshot` minus the matrix (we
 * already wrote the matrix as raw bytes — encoding it as a
 * number[] would triple the file size for no benefit). The chunk
 * metadata is what we read back to render citations in the chat UI.
 *
 * Format version policy: bump the version byte if you change the
 * layout. Old files are detected by either an unknown magic or a
 * mismatched version, and treated as "no index" — the caller
 * triggers a rebuild rather than crashing.
 */

import type { IndexSnapshot } from "./index.js";

const MAGIC = new Uint8Array([0x43, 0x54, 0x58, 0x31]); // "CTX1"
const VERSION = 0x01;

export interface PersistedIndex {
  dim: number;
  chunkCount: number;
  /** Bytes of the on-disk file. Useful for diagnostics. */
  byteLength: number;
}

/** Encode a snapshot to a Uint8Array ready to write to disk. */
export function encodeSnapshot(snapshot: IndexSnapshot): Uint8Array {
  if (snapshot.dim <= 0) {
    throw new Error("encodeSnapshot: dim must be positive");
  }
  const chunkCount = snapshot.chunks.length;
  const matrixLen = chunkCount * snapshot.dim;
  const matrixF32 = new Float32Array(matrixLen);
  // Snapshot stores matrix as number[]; copy into the typed array.
  // We assume the snapshot's matrix length matches chunkCount * dim
  // — the index enforces that on add(), so this is just defensive.
  for (let i = 0; i < matrixLen; i++) {
    matrixF32[i] = snapshot.matrix[i] ?? 0;
  }
  const jsonBlob = new TextEncoder().encode(
    JSON.stringify({ chunks: snapshot.chunks }),
  );

  const total =
    MAGIC.length +
    1 + // version
    4 + // dim
    4 + // chunkCount
    4 + // matrixLen
    matrixF32.byteLength +
    4 + // jsonByteLen
    jsonBlob.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;

  out.set(MAGIC, p);
  p += MAGIC.length;
  view.setUint8(p, VERSION);
  p += 1;
  view.setUint32(p, snapshot.dim, true);
  p += 4;
  view.setUint32(p, chunkCount, true);
  p += 4;
  view.setUint32(p, matrixLen, true);
  p += 4;
  out.set(new Uint8Array(matrixF32.buffer), p);
  p += matrixF32.byteLength;
  view.setUint32(p, jsonBlob.byteLength, true);
  p += 4;
  out.set(jsonBlob, p);
  p += jsonBlob.byteLength;

  return out;
}

/** Decode a previously-encoded snapshot. Throws on format mismatch. */
export function decodeSnapshot(bytes: Uint8Array): IndexSnapshot {
  if (bytes.length < MAGIC.length + 1) {
    throw new FormatError("file too short");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new FormatError("bad magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = MAGIC.length;
  const version = view.getUint8(p);
  p += 1;
  if (version !== VERSION) throw new FormatError(`unsupported version ${version}`);

  const dim = view.getUint32(p, true);
  p += 4;
  const chunkCount = view.getUint32(p, true);
  p += 4;
  const matrixLen = view.getUint32(p, true);
  p += 4;
  if (matrixLen !== chunkCount * dim) {
    throw new FormatError(
      `matrixLen ${matrixLen} != chunkCount ${chunkCount} * dim ${dim}`,
    );
  }
  const matrixBytes = matrixLen * 4;
  if (p + matrixBytes > bytes.length) {
    throw new FormatError("truncated matrix");
  }
  // Copy the matrix into a fresh, aligned Float32Array. We can't
  // take a zero-copy view onto bytes.buffer because the header
  // size (4 magic + 1 version + 4 dim + 4 chunkCount + 4
  // matrixLen = 17 bytes) isn't a multiple of 4, and Float32Array
  // requires 4-byte alignment. A 50k×384 copy is ~80 MB and takes
  // ~10ms — well within the load-time budget. If this ever shows
  // up in a profile, padding the header to 20 bytes is the
  // alternative.
  const matrixF32 = new Float32Array(matrixLen);
  for (let i = 0; i < matrixLen; i++) {
    matrixF32[i] = view.getFloat32(p + i * 4, true);
  }
  p += matrixBytes;
  const jsonByteLen = view.getUint32(p, true);
  p += 4;
  if (p + jsonByteLen > bytes.length) {
    throw new FormatError("truncated json");
  }
  const jsonText = new TextDecoder().decode(
    bytes.subarray(p, p + jsonByteLen),
  );
  const parsed = JSON.parse(jsonText) as { chunks: IndexSnapshot["chunks"] };
  if (!Array.isArray(parsed.chunks) || parsed.chunks.length !== chunkCount) {
    throw new FormatError("chunk count mismatch between header and json");
  }

  return {
    dim,
    chunks: parsed.chunks,
    // Re-materialize the matrix as a plain number[] to satisfy
    // IndexSnapshot's shape. This is the slow part of loading
    // (~80 MB → 20M JS numbers, ~250ms for 50k×384); we accept it
    // because the caller will feed the matrix back into the
    // InMemoryCosineIndex which is going to copy it into a
    // Float32Array anyway. If load time becomes a problem, we
    // can add a zero-copy path that takes the raw bytes directly.
    matrix: Array.from(matrixF32),
  };
}

/** Thrown by decodeSnapshot when the on-disk file is unreadable. */
export class FormatError extends Error {
  constructor(message: string) {
    super(`Chronote index file: ${message}`);
    this.name = "FormatError";
  }
}
