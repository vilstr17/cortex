/**
 * Tests for the SaveTarget-based API of the flashcard save service.
 *
 * `saveProposalsToTarget` accepts a `SaveTarget` (default / folder /
 * existing). This suite covers the three branches end-to-end against
 * an in-memory vault fake. The legacy `saveProposalsToNote` API is
 * tested in `flashcardSaveService.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  saveProposalsToTarget,
  SaveTarget,
  SaveResult,
} from "../flashcardSaveService";
import { FlashcardProposal } from "../../agent/tools/flashcards";

// ── Minimal Obsidian mocks ─────────────────────────────────────────

const noticeMock = vi.fn();
vi.mock("obsidian", () => {
  class TFile {
    constructor(public path: string) {}
  }
  class Notice {
    constructor(...args: unknown[]) {
      noticeMock(...args);
    }
  }
  return { App: class {}, TFile, Notice };
});

// ── In-memory vault adapter ────────────────────────────────────────

interface FakeAdapter {
  files: Map<string, string>;
  createdFolders: string[];
  exists(path: string): Promise<boolean>;
}

function makeFakeAdapter(): FakeAdapter {
  const files = new Map<string, string>();
  const createdFolders: string[] = [];
  return {
    files,
    createdFolders,
    async exists(path: string) {
      if (createdFolders.includes(path)) return true;
      for (const k of files.keys()) {
        if (k.startsWith(path + "/") || k === path) return true;
      }
      return false;
    },
  };
}

interface FakeVault {
  adapter: FakeAdapter;
  existingFiles: Map<string, { content: string }>;
  created: Array<{ path: string; content: string }>;
  processed: Array<{ path: string; before: string; after: string }>;
  createdFolders: string[];
  getAbstractFileByPath(path: string): unknown;
  create(path: string, content: string): Promise<unknown>;
  process(file: unknown, mutator: (current: string) => string): Promise<void>;
  createFolder(path: string): Promise<void>;
}

function makeFakeVault(adapter: FakeAdapter): FakeVault {
  const created: Array<{ path: string; content: string }> = [];
  const processed: Array<{ path: string; before: string; after: string }> = [];
  const existingFiles = new Map<string, { content: string }>();
  const createdFolders: string[] = [];
  return {
    adapter,
    existingFiles,
    created,
    processed,
    createdFolders,
    getAbstractFileByPath(path: string) {
      if (existingFiles.has(path)) return new TFile(path);
      return null;
    },
    create(path: string, content: string) {
      created.push({ path, content });
      existingFiles.set(path, { content });
      return Promise.resolve(new TFile(path));
    },
    process(file: unknown, mutator: (current: string) => string) {
      const path = (file as { path: string }).path;
      const before = existingFiles.get(path)?.content ?? "";
      const after = mutator(before);
      existingFiles.set(path, { content: after });
      processed.push({ path, before, after });
      return Promise.resolve();
    },
    createFolder(path: string) {
      if (!createdFolders.includes(path)) createdFolders.push(path);
      return Promise.resolve();
    },
  };
}

function makeApp(vault: FakeVault) {
  return { vault } as unknown as import("obsidian").App;
}

// ── Fixtures ───────────────────────────────────────────────────────

import { TFile as MockTFile, type TFile as TFileType } from "obsidian";
// The mock `obsidian` module's TFile takes a `path` argument,
// but the real one doesn't. Cast through `unknown` so the mock
// is constructible in tests but the type-system sees a regular
// `TFile` instance. `TFileType` is the real (unmocked) class
// shape, used as the type in `as unknown as TFileType` casts.
const TFile: new (path: string) => unknown = MockTFile as unknown as new (path: string) => unknown;

function makeProposal(overrides: Partial<FlashcardProposal> = {}): FlashcardProposal {
  return {
    proposalId: "p1",
    question: "What is 2+2?",
    answer: "4",
    sourceNote: "Math.md",
    testName: "Math Final",
    proposedAt: Date.UTC(2026, 5, 14, 10, 30, 0),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("saveProposalsToTarget", () => {
  beforeEach(() => {
    noticeMock.mockClear();
  });

  it("returns null for an empty proposal list (no I/O)", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);
    const result = await saveProposalsToTarget(app, [], "Math Final", {
      kind: "default",
      folder: "",
    });
    expect(result).toBeNull();
    expect(vault.created).toHaveLength(0);
    expect(vault.processed).toHaveLength(0);
  });

  it("dispatches `default` to the same code path as the string API", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);

    const target: SaveTarget = { kind: "default", folder: "" };
    const result = await saveProposalsToTarget(
      app,
      [makeProposal()],
      "Math Final",
      target,
    );

    expect(result).not.toBeNull();
    expect(vault.created).toHaveLength(1);
    expect(vault.created[0].path).toBe("Flashcards - Math Final.md");
    expect(result?.cardsAppended).toBe(1);
  });

  it("writes to the supplied folder when kind is `folder`", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);

    const result = await saveProposalsToTarget(
      app,
      [makeProposal()],
      "Bio Quiz",
      { kind: "folder", folder: "decks/bio" },
    );

    expect(result).not.toBeNull();
    expect(vault.createdFolders).toContain("decks/bio");
    expect(vault.created[0].path).toBe("decks/bio/Flashcards - Bio Quiz.md");
  });

  it("creates a new file when `folder` target points at a new folder", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);

    const result = await saveProposalsToTarget(
      app,
      [makeProposal({ question: "Q?", answer: "A!" })],
      "Chem",
      { kind: "folder", folder: "study/chem" },
    );

    expect(result).not.toBeNull();
    expect(vault.created).toHaveLength(1);
    expect(vault.created[0].content).toContain("## Q: Q?");
    expect(vault.created[0].content).toContain("> A!");
  });

  it("appends to the supplied file when kind is `existing`", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);

    // Pre-populate an existing flashcard note.
    const existingPath = "Flashcards - Math Final.md";
    const beforeContent =
      "---\nflashcards: true\ntest: \"Math Final\"\n---\n\n# Flashcards — Math Final\n\n## Q: prior\n\n> answer\n";
    vault.existingFiles.set(existingPath, { content: beforeContent });
    const existingFile = new TFile(existingPath) as unknown as TFileType;

    const result = await saveProposalsToTarget(
      app,
      [makeProposal({ proposalId: "new1", question: "Q-new", answer: "A-new" })],
      "Math Final",
      { kind: "existing", file: existingFile },
    );

    // No new file is created; the existing one is processed.
    expect(vault.created).toHaveLength(0);
    expect(vault.processed).toHaveLength(1);
    expect(vault.processed[0].path).toBe(existingPath);

    const after = vault.processed[0].after;
    expect(after).toContain("## Q: prior"); // old content preserved
    expect(after).toContain("## Q: Q-new");
    expect(after).toMatch(/## Saved \d{4}-\d{2}-\d{2} \(1 card\)/);
    expect(result).not.toBeNull();
    expect(result?.file).toBe(existingFile);
    expect(result?.cardsAppended).toBe(1);
  });

  it("does not create a folder when saving into an existing file", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);

    const existingPath = "Flashcards - Math Final.md";
    vault.existingFiles.set(existingPath, {
      content: "## Q: prior\n\n> answer\n",
    });
    const existingFile = new TFile(existingPath) as unknown as TFileType;

    await saveProposalsToTarget(
      app,
      [makeProposal()],
      "Math Final",
      { kind: "existing", file: existingFile },
    );

    // The `existing` branch must not touch folder creation, even
    // if the file is in a folder that doesn't exist in the adapter
    // map. We assert by checking no `createFolder` call happened.
    expect(vault.createdFolders).toHaveLength(0);
  });

  it("does not write the test name into the file name for the `existing` target", async () => {
    const vault = makeFakeVault(makeFakeAdapter());
    const app = makeApp(vault);

    const existingPath = "Math - cards.md";
    vault.existingFiles.set(existingPath, {
      content: "## Q: prior\n\n> answer\n",
    });
    const existingFile = new TFile(existingPath) as unknown as TFileType;

    const result = await saveProposalsToTarget(
      app,
      [makeProposal()],
      "TOTALLY DIFFERENT NAME",
      { kind: "existing", file: existingFile },
    );

    expect(result?.file).toBe(existingFile);
    // The file path is the existing file's path, NOT derived
    // from the test name.
    expect(vault.processed[0].path).toBe(existingPath);
  });

  it("returns a SaveResult with a TFile for all three kinds", async () => {
    const folder = makeFakeVault(makeFakeAdapter());
    const existing = makeFakeVault(makeFakeAdapter());
    const defaultVault = makeFakeVault(makeFakeAdapter());

    const existingFile = new TFile("x.md") as unknown as TFileType;
    existing.existingFiles.set("x.md", { content: "## Q: a\n\n> b\n" });

    const r1 = await saveProposalsToTarget(makeApp(folder), [makeProposal()], "T", {
      kind: "folder",
      folder: "f",
    });
    const r2 = await saveProposalsToTarget(makeApp(existing), [makeProposal()], "T", {
      kind: "existing",
      file: existingFile,
    });
    const r3 = await saveProposalsToTarget(makeApp(defaultVault), [makeProposal()], "T", {
      kind: "default",
      folder: "",
    });

    for (const r of [r1, r2, r3]) {
      expect(r).not.toBeNull();
      expect((r as SaveResult).file).toBeInstanceOf(MockTFile);
      expect((r as SaveResult).cardsAppended).toBe(1);
    }
  });
});
