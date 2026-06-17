import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
}));

import { App, TFile } from "obsidian";
import { createReviewTools } from "../reviews.js";
import type { ChronoteTest } from "../../../settingsTypes.js";

/**
 * Build a minimal fake App that satisfies `readReviewableNotes`:
 *   - vault.getMarkdownFiles() returns the given files,
 *   - metadataCache.getFileCache(f).frontmatter returns the matching fm.
 *
 * `readReviewableNotes` walks every markdown file, so we have to
 * hand it the files we want indexed. Anything we omit is invisible to
 * the tool — which is the point: tests can build small, focused
 * vaults without touching the rest of the plugin runtime.
 */
function fakeApp(files: Array<{ path: string; basename?: string; fm?: Record<string, unknown> }>): App {
  const tFiles = files.map((f) => {
    const tf = new TFile();
    (tf as unknown as { path: string }).path = f.path;
    (tf as unknown as { basename: string }).basename = f.basename ?? f.path.replace(/\.md$/, "");
    (tf as unknown as { extension: string }).extension = "md";
    return tf;
  });
  const fmByPath = new Map<string, Record<string, unknown> | undefined>();
  for (const f of files) fmByPath.set(f.path, f.fm);
  return {
    vault: {
      getMarkdownFiles: () => tFiles,
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const path = (file as unknown as { path: string }).path;
        const fm = fmByPath.get(path);
        return fm ? { frontmatter: fm } : null;
      },
    },
  } as unknown as App;
}

function getListReviewsTool(deps: {
  app: App;
  getTests: () => ChronoteTest[];
  now: Date;
}) {
  const tools = createReviewTools({ app: deps.app, getTests: deps.getTests, now: () => deps.now });
  const tool = tools.find((t) => t.name === "list_reviews");
  if (!tool) throw new Error("list_reviews tool not registered");
  return tool;
}

describe("list_reviews", () => {
  it("returns notes whose next_review is on the target date", async () => {
    const today = new Date(2026, 5, 16); // 2026-06-16 local
    const app = fakeApp([
      { path: "Calculus.md", fm: { next_review: "2026-06-16" } },
      { path: "History.md", fm: { next_review: "2026-06-20" } }, // future, not due
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    expect(out).toContain("Calculus.md");
    expect(out).toContain("(due today)");
    expect(out).not.toContain("History.md");
  });

  it("flags overdue notes and reports the day count", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "Calculus.md", fm: { next_review: "2026-06-14" } },
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    expect(out).toContain("Calculus.md");
    expect(out).toContain("(overdue by 2 days)");
  });

  it("skips notes linked to a test that is marked done", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "Calculus.md", fm: { next_review: "2026-06-16" } },
    ]);
    const tests: ChronoteTest[] = [
      {
        id: "t1",
        name: "Calculus final",
        date: "2026-06-10",
        filePaths: ["Calculus.md"],
        done: true,
      },
    ];
    const tool = getListReviewsTool({ app, getTests: () => tests, now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    expect(out).toBe("No reviews due on 2026-06-16.");
  });

  it("skips notes whose exam_date is in the past", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "OldExam.md", fm: { next_review: "2026-06-16", exam_date: "2026-05-01" } },
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    expect(out).toBe("No reviews due on 2026-06-16.");
  });

  it("returns the empty-state message when no notes are due", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([]); // vault is empty
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    expect(out).toBe("No reviews due on 2026-06-16.");
  });

  it("respects an explicit date argument", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "Calculus.md", fm: { next_review: "2026-06-20" } },
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({ date: "2026-06-20" }, {} as never)) as string;
    expect(out).toContain("Found 1 review(s) due on 2026-06-20");
    expect(out).toContain("Calculus.md");
  });

  it("accepts DD.MM.YYYY dates", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "Calculus.md", fm: { next_review: "2026-06-20" } },
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({ date: "20.06.2026" }, {} as never)) as string;
    expect(out).toContain("Found 1 review(s) due on 20.06.2026");
    expect(out).toContain("Calculus.md");
  });

  it("rejects unparseable date strings", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({ date: "not-a-date" }, {} as never)) as string;
    expect(out).toMatch(/Error: 'date' must be ISO 8601/);
  });

  it("orders results by overdue-ness (most overdue first)", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "SlightlyLate.md", fm: { next_review: "2026-06-15" } }, // 1 day overdue
      { path: "VeryLate.md", fm: { next_review: "2026-06-10" } }, // 6 days overdue
      { path: "DueToday.md", fm: { next_review: "2026-06-16" } }, // due today
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    const vIdx = out.indexOf("VeryLate.md");
    const sIdx = out.indexOf("SlightlyLate.md");
    const dIdx = out.indexOf("DueToday.md");
    expect(vIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(vIdx);
    expect(dIdx).toBeGreaterThan(sIdx);
  });

  it("includes confidence when present in frontmatter", async () => {
    const today = new Date(2026, 5, 16);
    const app = fakeApp([
      { path: "Calculus.md", fm: { next_review: "2026-06-16", confidence: 2 } },
    ]);
    const tool = getListReviewsTool({ app, getTests: () => [], now: today });
    const out = (await tool.execute({}, {} as never)) as string;
    expect(out).toContain("confidence: 2/5");
  });
});
