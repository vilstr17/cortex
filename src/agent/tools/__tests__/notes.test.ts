import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
}));

import { createNoteTools } from "../notes.js";
import type { NoteChunk } from "../../vectorIndex/chunker.js";
import type { SearchHit, VectorIndex } from "../../vectorIndex/index.js";

function chunk(file: string, text: string): NoteChunk {
  return { file, heading: "", text, startLine: 1, endLine: 5 } as NoteChunk;
}

/** A fake index that returns a fixed, descending-by-score hit list. */
function fakeIndexReturning(hits: SearchHit[]): VectorIndex {
  return {
    dim: 768,
    size: hits.length,
    add: vi.fn(),
    removeFile: vi.fn(),
    clear: vi.fn(),
    search: () => hits,
    snapshot: vi.fn(),
    load: vi.fn(),
  } as unknown as VectorIndex;
}

function getSearchTool(hits: SearchHit[]) {
  const knowledge = {
    embedder: {
      name: "api" as const,
      dim: 768,
      embed: async () => [new Float32Array(768)],
    },
    index: fakeIndexReturning(hits),
    isReady: () => true,
  };
  const tools = createNoteTools({ app: {} as never, knowledge });
  return tools.find((t) => t.name === "search_notes")!;
}

describe("search_notes relevance filtering", () => {
  it("drops chunks far below the top score (off-topic filler)", async () => {
    const hits: SearchHit[] = [
      { chunk: chunk("Capek.md", "Karel Capek, autor R.U.R., slovo robot"), score: 0.72 },
      { chunk: chunk("Capek.md", "Capek a jeho bratr Josef"), score: 0.63 },
      { chunk: chunk("Ekonomie.md", "Hayekovy hospodarske cykly"), score: 0.52 },
      { chunk: chunk("Ekonomie.md", "inflace a HDP"), score: 0.49 },
    ];
    const tool = getSearchTool(hits);
    const out = (await tool.execute({ query: "Karel Capek" }, {} as never)) as string;

    // Top cluster kept (top 0.72, cutoff = 0.72 - 0.15 = 0.57).
    expect(out).toContain("Capek.md");
    expect(out).toContain("R.U.R.");
    // Off-topic economics chunks (0.52, 0.49) dropped.
    expect(out).not.toContain("Ekonomie.md");
    expect(out).not.toContain("Hayek");
    expect(out).toContain("Found 2 matching chunk");
  });

  it("returns a 'nothing relevant' message when all hits are below the floor", async () => {
    const hits: SearchHit[] = [
      { chunk: chunk("A.md", "loosely related"), score: 0.31 },
      { chunk: chunk("B.md", "also weak"), score: 0.28 },
    ];
    const tool = getSearchTool(hits);
    const out = (await tool.execute({ query: "obscure topic" }, {} as never)) as string;
    expect(out).toMatch(/No sufficiently relevant notes/);
  });

  it("keeps the whole cluster when scores are uniformly high (broad query)", async () => {
    const hits: SearchHit[] = [
      { chunk: chunk("A.md", "alpha"), score: 0.71 },
      { chunk: chunk("B.md", "beta"), score: 0.68 },
      { chunk: chunk("C.md", "gamma"), score: 0.64 },
    ];
    const tool = getSearchTool(hits);
    const out = (await tool.execute({ query: "summary" }, {} as never)) as string;
    expect(out).toContain("Found 3 matching chunk");
  });
});

describe("search_notes dimension guard", () => {
  it("returns an actionable error when the query embedding dim does not match the index dim", async () => {
    const knowledge = {
      embedder: {
        name: "api" as const,
        dim: 3072,
        embed: async () => [new Float32Array(3072)],
      },
      index: fakeIndexReturning([]), // dim 768
      isReady: () => true,
    };
    const tools = createNoteTools({ app: {} as never, knowledge });
    const tool = tools.find((t) => t.name === "search_notes")!;
    const out = (await tool.execute({ query: "something" }, {} as never)) as string;

    expect(out).toMatch(/embedding dimension mismatch/);
    expect(out).toContain("3072");
    expect(out).toContain("768");
    expect(out).toMatch(/Reindex vault/i);
  });
});
