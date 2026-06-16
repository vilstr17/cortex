import { describe, it, expect, vi } from "vitest";
import { createTestTools } from "../tools/tests.js";
import { CortexTest } from "../../settingsTypes.js";

/**
 * Tests for the list_tests tool.
 *
 * The factory takes the live test list and `now` as closures, so we
 * can drive every test with pure data — no Obsidian mocks, no
 * date-of-day brittleness. The fixed `now()` is the same calendar
 * day as the default `date` argument, so the default-today path is
 * just a copy of the explicit-date path with `date` omitted.
 */

function makeTest(over: Partial<CortexTest> & Pick<CortexTest, "id" | "name" | "date">): CortexTest {
  return {
    filePaths: [],
    done: false,
    ...over,
  };
}

const NOW = new Date(2026, 5, 14, 10, 0, 0); // 2026-06-14 local
const NOW_ISO = "2026-06-14";

function build(rows: CortexTest[]) {
  return createTestTools({
    getTests: () => rows,
    now: () => NOW,
  });
}

describe("list_tests", () => {
  it("returns an empty-result message when there are no tests", async () => {
    const tools = build([]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(out).toBe(`No tests found on ${NOW_ISO}.`);
  });

  it("returns only tests on the requested day, sorted ascending", async () => {
    const tools = build([
      makeTest({ id: "1", name: "History", date: "2026-06-20" }),
      makeTest({ id: "2", name: "Math", date: "2026-06-14" }),
      makeTest({ id: "3", name: "Biology", date: "2026-06-25" }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(out).toContain("Found 1 test(s) on 2026-06-14:");
    expect(out).toContain(`[1] "Math" — 2026-06-14 (today)`);
    expect(out).not.toContain("History");
    expect(out).not.toContain("Biology");
  });

  it("treats two tests on the same day as a single window", async () => {
    const tools = build([
      makeTest({ id: "1", name: "Calc", date: "2026-06-20" }),
      makeTest({ id: "2", name: "Stats", date: "2026-06-20" }),
    ]);
    const out = await tools[0].execute({ date: "2026-06-20" }, { plugin: null });
    expect(out).toContain("Found 2 test(s) on 2026-06-20:");
    // Tiebreaker: alphabetical
    expect(out.indexOf("Calc")).toBeLessThan(out.indexOf("Stats"));
  });

  it("excludes done: true tests by default", async () => {
    const tools = build([
      makeTest({ id: "1", name: "Passed", date: "2026-06-14", done: true }),
      makeTest({ id: "2", name: "Active", date: "2026-06-14" }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(out).toContain("Found 1 test(s)");
    expect(out).toContain(`"Active"`);
    expect(out).not.toContain("Passed");
  });

  it("includes done tests when include_done: true", async () => {
    const tools = build([
      makeTest({ id: "1", name: "Passed", date: "2026-06-14", done: true }),
    ]);
    const out = await tools[0].execute(
      { date: NOW_ISO, include_done: true },
      { plugin: null },
    );
    expect(out).toContain(`"Passed"`);
    expect(out).toContain("done: true");
  });

  it("hints at include_done when every test on the day is done", async () => {
    const tools = build([
      makeTest({ id: "1", name: "Passed", date: "2026-06-14", done: true }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(out).toBe(
      `All tests on ${NOW_ISO} are marked done. Pass include_done: true to see them.`,
    );
  });

  it("defaults date to today when omitted", async () => {
    const tools = build([
      makeTest({ id: "1", name: "Today", date: NOW_ISO }),
      makeTest({ id: "2", name: "Tomorrow", date: "2026-06-15" }),
    ]);
    const out = await tools[0].execute({}, { plugin: null });
    expect(out).toContain(`"Today"`);
    expect(out).not.toContain(`"Tomorrow"`);
    expect(out).toContain(`Found 1 test(s) on ${NOW_ISO}:`);
  });

  it("returns an error string on an unparseable date argument", async () => {
    const tools = build([]);
    const out = await tools[0].execute({ date: "not-a-date" }, { plugin: null });
    expect(out).toMatch(/^Error: 'date' must be/);
  });

  it("skips tests with malformed dates with a warning, returns the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tools = build([
      makeTest({ id: "1", name: "Bad", date: "garbage" }),
      makeTest({ id: "2", name: "Good", date: NOW_ISO }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(warn).toHaveBeenCalled();
    expect(out).toContain(`"Good"`);
    expect(out).not.toContain(`"Bad"`);
    warn.mockRestore();
  });

  it("lists filePaths under each test in source order", async () => {
    const tools = build([
      makeTest({
        id: "1",
        name: "Math",
        date: NOW_ISO,
        filePaths: ["Calculus - Limits.md", "Integration.md", "Vectors.md"],
      }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    const idxL = out.indexOf("Calculus - Limits.md");
    const idxI = out.indexOf("Integration.md");
    const idxV = out.indexOf("Vectors.md");
    expect(idxL).toBeGreaterThan(-1);
    expect(idxL).toBeLessThan(idxI);
    expect(idxI).toBeLessThan(idxV);
  });

  it("shows '(no notes linked yet)' when filePaths is empty", async () => {
    const tools = build([
      makeTest({ id: "1", name: "Math", date: NOW_ISO, filePaths: [] }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(out).toContain("Notes: (no notes linked yet)");
  });

  it("renders proximity as (today), (in N days), or (past, N days ago)", async () => {
    const tools = build([
      makeTest({ id: "1", name: "T", date: NOW_ISO }),
      makeTest({ id: "2", name: "P1", date: "2026-06-15" }),
      makeTest({ id: "3", name: "P6", date: "2026-06-20" }),
      makeTest({ id: "4", name: "PAST", date: "2026-06-10" }),
    ]);
    const out = await tools[0].execute({ date: NOW_ISO }, { plugin: null });
    expect(out).toContain(`"T" — ${NOW_ISO} (today)`);
    // The other three are on different days, so to see their proximity we
    // need to ask for those days. Quick sanity check on each:
    const out1 = await tools[0].execute({ date: "2026-06-15" }, { plugin: null });
    expect(out1).toContain("(in 1 day)");
    const out6 = await tools[0].execute({ date: "2026-06-20" }, { plugin: null });
    expect(out6).toContain("(in 6 days)");
    const outPast = await tools[0].execute({ date: "2026-06-10" }, { plugin: null });
    expect(outPast).toContain("(past, 4 days ago)");
  });

  it("accepts DD.MM.YYYY as a date string (parseLocalDate handles it)", async () => {
    const tools = build([makeTest({ id: "1", name: "Math", date: "2026-06-14" })]);
    const out = await tools[0].execute({ date: "14.06.2026" }, { plugin: null });
    expect(out).toContain(`"Math"`);
    expect(out).toContain("Found 1 test(s) on 14.06.2026:");
  });
});
