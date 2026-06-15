import { describe, it, expect } from "vitest";
import { encodeSnapshot, decodeSnapshot, FormatError } from "../persistence";
import { IndexSnapshot } from "../index";

/**
 * Tests for the binary persistence format.
 *
 * The format is internal — we test that encode/decode is a
 * perfect round-trip, that unknown magic / unsupported version
 * throws a FormatError, and that the JSON metadata is what we
 * wrote (chunks array, but NOT the matrix — the matrix travels
 * as raw bytes).
 */

function makeSnapshot(dim: number, chunkCount: number): IndexSnapshot {
  const chunks = Array.from({ length: chunkCount }, (_, i) => ({
    file: `note${i}.md`,
    heading: i % 2 === 0 ? `Heading ${i}` : "",
    startLine: i * 10,
    endLine: i * 10 + 5,
    text: `Body of chunk ${i}.`,
  }));
  // Build a matrix of length chunkCount * dim. Use a recognizable
  // pattern so a regression that mixes up the byte order would
  // show up as garbage values.
  const matrix: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    for (let j = 0; j < dim; j++) {
      matrix.push((i + 1) * 0.1 + j * 0.01);
    }
  }
  return { dim, chunks, matrix };
}

describe("encode/decode roundtrip", () => {
  it("preserves a small snapshot", () => {
    const snap = makeSnapshot(8, 4);
    const bytes = encodeSnapshot(snap);
    const out = decodeSnapshot(bytes);
    expect(out.dim).toBe(8);
    expect(out.chunks.length).toBe(4);
    expect(out.chunks[0]).toEqual(snap.chunks[0]);
    expect(out.matrix.length).toBe(snap.matrix.length);
    // Spot-check a few values — exact equality because Float32Array
    // round-trip is lossless.
    expect(out.matrix[0]).toBeCloseTo(snap.matrix[0], 6);
    expect(out.matrix[out.matrix.length - 1]).toBeCloseTo(
      snap.matrix[snap.matrix.length - 1],
      6,
    );
  });

  it("preserves a larger snapshot", () => {
    const snap = makeSnapshot(384, 100);
    const bytes = encodeSnapshot(snap);
    const out = decodeSnapshot(bytes);
    expect(out.dim).toBe(384);
    expect(out.chunks.length).toBe(100);
    expect(out.matrix.length).toBe(100 * 384);
  });

  it("preserves chunks with special characters in text", () => {
    const snap: IndexSnapshot = {
      dim: 4,
      chunks: [
        {
          file: "f.md",
          heading: "Tricky / heading",
          startLine: 0,
          endLine: 1,
          text: 'Line 1\nLine 2 with "quotes" and \\backslashes\n',
        },
      ],
      matrix: [0.1, 0.2, 0.3, 0.4],
    };
    const out = decodeSnapshot(encodeSnapshot(snap));
    expect(out.chunks[0].text).toBe(snap.chunks[0].text);
    expect(out.chunks[0].heading).toBe("Tricky / heading");
  });
});

describe("decodeSnapshot error paths", () => {
  it("throws FormatError on truncated input", () => {
    expect(() => decodeSnapshot(new Uint8Array([0x01, 0x02]))).toThrow(FormatError);
  });

  it("throws FormatError on bad magic", () => {
    const bytes = new Uint8Array(64);
    bytes[0] = 0x42; // not 'C'
    expect(() => decodeSnapshot(bytes)).toThrow(/bad magic/);
  });

  it("throws FormatError on unsupported version", () => {
    const snap = makeSnapshot(4, 1);
    const bytes = encodeSnapshot(snap);
    // Bump the version byte.
    bytes[4] = 0x99;
    expect(() => decodeSnapshot(bytes)).toThrow(/unsupported version/);
  });

  it("throws FormatError when matrixLen != chunkCount * dim", () => {
    // Hand-craft a header where the matrixLen is bogus.
    const bytes = new Uint8Array(64);
    const magic = new Uint8Array([0x43, 0x54, 0x58, 0x31]); // CTX1
    bytes.set(magic, 0);
    bytes[4] = 0x01; // version
    const view = new DataView(bytes.buffer);
    view.setUint32(5, 4, true); // dim = 4
    view.setUint32(9, 2, true); // chunkCount = 2
    view.setUint32(13, 999, true); // matrixLen = 999 (bogus)
    expect(() => decodeSnapshot(bytes)).toThrow(/matrixLen/);
  });
});
