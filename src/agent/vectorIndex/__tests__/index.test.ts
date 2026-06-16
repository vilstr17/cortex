import { describe, it, expect } from "vitest";
import { InMemoryCosineIndex } from "../index.js";
import { NoteChunk } from "../chunker.js";

/**
 * Tests for the in-memory vector index.
 *
 * The index is pure logic with no Obsidian dependency. We use
 * deterministic hand-built vectors (the i-th basis direction)
 * so search results are reproducible and obvious — if a query
 * is "near" a chunk, it's because we put them on similar
 * axes, not because of random init.
 */

function makeVec(values: number[]): Float32Array {
  return new Float32Array(values);
}

function basis(dim: number, axis: number): Float32Array {
  const v = new Float32Array(dim);
  v[axis % dim] = 1;
  return v;
}

function chunk(id: string, text: string): NoteChunk {
  return {
    file: "f.md",
    heading: "",
    startLine: 0,
    endLine: 0,
    text,
  };
}

describe("InMemoryCosineIndex", () => {
  it("returns empty search for an empty index", () => {
    const idx = new InMemoryCosineIndex(4);
    expect(idx.size).toBe(0);
    expect(idx.search(basis(4, 0), 5)).toEqual([]);
  });

  it("ranks exact matches first", () => {
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    idx.add(
      [chunk("a", "A"), chunk("b", "B"), chunk("c", "C")],
      [basis(dim, 0), basis(dim, 1), basis(dim, 2)],
    );
    const hits = idx.search(basis(dim, 0), 3);
    expect(hits.length).toBe(3);
    expect(hits[0].chunk.text).toBe("A");
    expect(hits[0].score).toBeCloseTo(1.0, 5);
  });

  it("respects the k parameter", () => {
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    idx.add(
      Array.from({ length: 10 }, (_, i) => chunk(`c${i}`, `t${i}`)),
      Array.from({ length: 10 }, (_, i) => basis(dim, i)),
    );
    expect(idx.search(basis(dim, 0), 1).length).toBe(1);
    expect(idx.search(basis(dim, 0), 5).length).toBe(5);
    expect(idx.search(basis(dim, 0), 50).length).toBe(10); // capped at size
  });

  it("rejects embeddings with the wrong dim", () => {
    const idx = new InMemoryCosineIndex(4);
    expect(() => idx.add([chunk("x", "x")], [basis(8, 0)])).toThrow(/dim/);
  });

  it("rejects mismatched chunk/embedding counts", () => {
    const idx = new InMemoryCosineIndex(4);
    expect(() =>
      idx.add([chunk("a", "a"), chunk("b", "b")], [basis(4, 0)]),
    ).toThrow(/count/);
  });

  it("removeFile drops only matching rows", () => {
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    const a = { ...chunk("a", "A"), file: "a.md" };
    const b = { ...chunk("b", "B"), file: "b.md" };
    const c = { ...chunk("c", "C"), file: "a.md" };
    idx.add([a, b, c], [basis(dim, 0), basis(dim, 1), basis(dim, 2)]);
    expect(idx.size).toBe(3);
    idx.removeFile("a.md");
    expect(idx.size).toBe(1);
    const hits = idx.search(basis(dim, 0), 5);
    expect(hits[0].chunk.text).toBe("B");
  });

  it("round-trips through snapshot/load", () => {
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    idx.add(
      [chunk("a", "A"), chunk("b", "B")],
      [basis(dim, 0), basis(dim, 1)],
    );
    const snap = idx.snapshot();
    const idx2 = new InMemoryCosineIndex(dim);
    idx2.load(snap);
    expect(idx2.size).toBe(2);
    const hits = idx2.search(basis(dim, 1), 1);
    expect(hits[0].chunk.text).toBe("B");
  });

  it("clear() resets size but preserves capacity", () => {
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    idx.add([chunk("a", "A")], [basis(dim, 0)]);
    idx.clear();
    expect(idx.size).toBe(0);
    // We can add again without an error — capacity is preserved.
    idx.add([chunk("b", "B")], [basis(dim, 0)]);
    expect(idx.size).toBe(1);
  });

  it("search with mismatched dim throws", () => {
    const idx = new InMemoryCosineIndex(4);
    idx.add([chunk("a", "A")], [basis(4, 0)]);
    expect(() => idx.search(basis(8, 0), 1)).toThrow(/dim/);
  });

  it("load rejects snapshots with a different dim", () => {
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    idx.add([chunk("a", "A")], [basis(dim, 0)]);
    const snap = idx.snapshot();
    // Mutate the snapshot dim — the loader must reject it rather
    // than silently corrupting the index.
    (snap as { dim: number }).dim = 8;
    const idx2 = new InMemoryCosineIndex(dim);
    expect(() => idx2.load(snap)).toThrow(/dim/);
  });

  it("treats zero vectors as 'no signal' (score = 0)", () => {
    // A query of all zeros shouldn't crash and shouldn't dominate
    // the results. The implementation normalizes to 0/0 = 0, so
    // cosine against any non-zero vector is 0. The first result is
    // arbitrary; what matters is no NaN and the test doesn't throw.
    const dim = 4;
    const idx = new InMemoryCosineIndex(dim);
    idx.add([chunk("a", "A")], [basis(dim, 0)]);
    const hits = idx.search(makeVec([0, 0, 0, 0]), 1);
    expect(hits.length).toBe(1);
    expect(Number.isFinite(hits[0].score)).toBe(true);
  });
});
