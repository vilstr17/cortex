import { describe, it, expect, vi } from "vitest";
import {
  saveProposalsToNote,
  sanitizeForFilename,
} from "../flashcardSaveService.js";
import { FlashcardProposal } from "../../agent/tools/flashcards.js";

/**
 * Tests for the flashcard save service.
 *
 * The service writes markdown to the vault. We mock the parts of
 * `obsidian` we touch (App, TFile, Notice) and provide a tiny
 * in-memory adapter so we can assert on the file contents without
 * touching disk.
 */

// ── Minimal Obsidian mocks ─────────────────────────────────────────

const noticeMock = vi.fn();
vi.mock("obsidian", () => {
  // The service uses `TFile` only as a `instanceof` check. We
  // expose a class whose instances are recognizable.
  class TFile {
    constructor(public path: string) {}
  }
  // The service calls `new Notice(...)`. `Notice` must be a regular
  // function (or class) — arrow functions throw "X is not a
  // constructor" when used with `new`. We use a class so it's
  // constructible in both call styles.
  class Notice {
    constructor(...args: unknown[]) {
      noticeMock(...args);
    }
  }
  return {
    App: class {},
    TFile,
    Notice,
  };
});

// ── In-memory vault adapter ────────────────────────────────────────

interface FakeAdapter {
  files: Map<string, string>;
  createdFolders: string[];
  exists(path: string): Promise<boolean>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}function makeFakeAdapter(): FakeAdapter {
  const files = new Map<string, string>();
  const createdFolders: string[] = [];
  return {
    files,
    createdFolders,
    async exists(path: string) {
      // A folder "exists" if any file path starts with it OR it's
      // a folder we created.
      if (createdFolders.includes(path)) return true;
      for (const k of files.keys()) {
        if (k.startsWith(path + "/") || k === path) return true;
      }
      return false;
    },
    async writeBinary(_path, _data) {
      /* unused in this service — present so the type compiles */
    },
  };
}

interface FakeVault {
  adapter: FakeAdapter;
  existingFiles: Map<string, { content: string }>;
  created: Array<{ path: string; content: string }>;
  processed: Array<{ path: string; before: string; after: string }>;
  /** Mirrors `Vault.createFolder` so the save service can ensure a
   * folder exists. The real Obsidian API throws if the folder
   * already exists; this fake is idempotent. */
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
      if (existingFiles.has(path)) {
        return new TFile(path);
      }
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
      // Idempotent — the real Obsidian API throws if the folder
      // exists, but the service only calls this when `exists()`
      // returned false, so a no-op duplicate is fine.
      if (!createdFolders.includes(path)) createdFolders.push(path);
      return Promise.resolve();
    },
  };
}

function makeApp(vault: FakeVault) {
  // The service only uses `app.vault.adapter`, `app.vault.getAbstractFileByPath`,
  // `app.vault.create`, `app.vault.process`, `app.vault.createFolder`.
  // Construct a minimal `App`-shaped object and cast — the
  // service's real call sites use a real `App` whose vault has
  // the same surface.
  return { vault } as unknown as import("obsidian").App;
}

// ── Test fixtures ──────────────────────────────────────────────────

// We import the mocked `TFile` so its constructor signature
// matches the one our fake-vault helpers use to create instances.
// The real `obsidian.TFile` takes no constructor args; the mock
// takes a `path`. We need the mock so `instanceof TFile` in the
// service recognizes the instances we hand it.
import { TFile as MockTFile } from "obsidian";
// Local alias so the rest of the test file is concise. The type
// is just `any`-shaped because the mock constructor is a class
// expression; we don't actually inspect the instance — we just
// pass it through.
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

describe("sanitizeForFilename", () => {
  it("strips path-illegal characters", () => {
    expect(sanitizeForFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("collapses whitespace and dashes", () => {
    expect(sanitizeForFilename("  math   --  final  ")).toBe("math - final");
  });

  it("falls back to 'Untitled' for empty input", () => {
    expect(sanitizeForFilename("")).toBe("Untitled");
    expect(sanitizeForFilename("///")).toBe("Untitled");
  });

  it("preserves accented characters and em-dashes", () => {
    // The sanitizer only replaces path-illegal characters
    // (`/\\:*?"<>|`) and collapses whitespace + dashes. Unicode
    // punctuation like `—` and diacritics like `š` are left
    // alone — they're perfectly valid in filenames.
    expect(sanitizeForFilename("Matematika — zkouška")).toBe("Matematika — zkouška");
  });
});

describe("saveProposalsToNote", () => {
  it("returns null for an empty proposal list (no I/O)", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);
    const result = await saveProposalsToNote(app, [], "Math Final", "");
    expect(result).toBeNull();
    expect(vault.created).toHaveLength(0);
    expect(vault.processed).toHaveLength(0);
  });

  it("creates a new file with frontmatter when the target doesn't exist", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    const proposals = [makeProposal({ question: "Q1", answer: "A1" })];
    const result = await saveProposalsToNote(app, proposals, "Math Final", "");

    expect(result).not.toBeNull();
    expect(vault.created).toHaveLength(1);
    const created = vault.created[0];
    expect(created.path).toBe("Flashcards - Math Final.md");
    expect(created.content).toContain("flashcards: true");
    expect(created.content).toContain("test: \"Math Final\"");
    expect(created.content).toContain("## Q: Q1");
    expect(created.content).toContain("> A1");
    expect(created.content).toContain("[[Math]]"); // sourceNote with .md stripped
  });

  it("appends a dated section when the file already exists", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    // Pre-populate the file.
    const path = "Flashcards - Math Final.md";
    vault.existingFiles.set(path, {
      content:
        "---\nflashcards: true\ntest: \"Math Final\"\n---\n\n# Flashcards — Math Final\n\n## Q: prior\n\n> answer\n",
    });

    const proposals = [makeProposal({ proposalId: "new1", question: "Q-new", answer: "A-new" })];
    await saveProposalsToNote(app, proposals, "Math Final", "");

    expect(vault.created).toHaveLength(0);
    expect(vault.processed).toHaveLength(1);
    const after = vault.processed[0].after;
    expect(after).toContain("## Q: prior"); // old content preserved
    expect(after).toContain("## Q: Q-new");
    expect(after).toMatch(/## Saved \d{4}-\d{2}-\d{2} \(1 card\)/);
  });

  it("creates the configured folder if missing", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    const proposals = [makeProposal({ question: "Q1", answer: "A1" })];
    await saveProposalsToNote(app, proposals, "Bio Quiz", "study");

    // Folder should have been created.
    expect(vault.createdFolders).toContain("study");
    // File should live in the folder.
    expect(vault.created[0].path).toBe("study/Flashcards - Bio Quiz.md");
  });

  it("does not create the folder if it already exists", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    // Pre-populate the adapter's file map so its `exists("study")`
    // returns true (the service calls `app.vault.adapter.exists`,
    // not `getAbstractFileByPath`).
    adapter.files.set("study/anything.md", "x");

    const proposals = [makeProposal({ question: "Q1", answer: "A1" })];
    await saveProposalsToNote(app, proposals, "Bio Quiz", "study");

    expect(vault.createdFolders).toEqual([]);
  });

  it("strips trailing slash from folder path", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    const proposals = [makeProposal({ question: "Q1", answer: "A1" })];
    await saveProposalsToNote(app, proposals, "Bio Quiz", "study/");

    expect(vault.created[0].path).toBe("study/Flashcards - Bio Quiz.md");
  });

  it("sanitizes the test name into a safe filename", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    const proposals = [makeProposal({ question: "Q1", answer: "A1" })];
    await saveProposalsToNote(app, proposals, 'A/B: C "D" Test', "");

    // Slashes, colons, and quotes get replaced with dashes.
    expect(vault.created[0].path).toBe("Flashcards - A-B- C -D- Test.md");
  });

  it("groups multiple cards in one file when saved together", async () => {
    const adapter = makeFakeAdapter();
    const vault = makeFakeVault(adapter);
    const app = makeApp(vault);

    const proposals = [
      makeProposal({ proposalId: "p1", question: "Q1", answer: "A1" }),
      makeProposal({ proposalId: "p2", question: "Q2", answer: "A2" }),
      makeProposal({ proposalId: "p3", question: "Q3", answer: "A3" }),
    ];
    await saveProposalsToNote(app, proposals, "Math Final", "");

    const content = vault.created[0].content;
    expect(content).toContain("## Q: Q1");
    expect(content).toContain("## Q: Q2");
    expect(content).toContain("## Q: Q3");
  });
});
