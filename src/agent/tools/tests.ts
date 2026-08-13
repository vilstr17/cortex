/**
 * Test tool: list_tests.
 *
 * Surfaces the user's `ChronoteTest[]` (the data behind the dashboard's
 * "Upcoming Tests" panel) to the LLM on demand. The model calls this
 * when the user asks "what's my next exam?", "plan my revision for
 * the calculus test", or "what tests do I have on the 20th?".
 *
 * The tool reads from the live `plugin.settings.tests` array via a
 * closure — no plugin reference, no vault access. That mirrors the
 * other tool factories (notes, reviews): the agent layer only knows
 * about the data it needs, and tests can inject a stub `getTests`
 * without standing up an Obsidian runtime.
 *
 * "Revision" itself is not a stored entity — it is what the model
 * plans once it knows the test and the linked notes. So we only
 * expose the test list here; the model chains `list_tests` →
 * `list_reviews` → `search_notes` / `read_note` to build a revision
 * plan.
 */

import { Tool } from "../toolRegistry.js";
import { ChronoteTest } from "../../settingsTypes.js";
import { localISODate, parseLocalDate, daysUntil, startOfLocalDay } from "../../utils/dateUtils.js";

/**
 * Build the list_tests tool. The factory takes the live test list as
 * a closure so the tool sees any dashboard edits without a re-mount,
 * and an injectable `now` so the unit tests are deterministic.
 */
export function createTestTools(deps: {
  getTests: () => ChronoteTest[];
  now?: () => Date;
}): Tool[] {
  const getTests = deps.getTests;
  const now = deps.now ?? (() => new Date());

  return [
    {
      name: "list_tests",
      description:
        "List upcoming tests (exams) on a specific date and the notes linked to each. " +
        "Use this whenever the user asks about an exam, a test, what to revise, or wants to " +
        "plan revision around a deadline. Each result includes the test name, the exam date, " +
        "the number of days from today, and the list of note file paths associated with the test. " +
        "Combine with list_events (to find free slots) and search_notes / read_note (to pull " +
        "revision material). The test list is the only place to discover upcoming exams — the " +
        "system prompt deliberately does not include them.",
      parameters: {
        type: "OBJECT",
        description: "List tests on a specific date",
        properties: {
          date: {
            type: "STRING",
            description:
              "The date to list tests for, in ISO 8601 format (YYYY-MM-DD) or DD.MM.YYYY " +
              "(e.g. '2026-06-20' or '20.06.2026'). If omitted, defaults to today.",
          },
          include_done: {
            type: "BOOLEAN",
            description:
              "If true, include tests already marked as done. Default false — done tests " +
              "are noise for revision planning. Set true when the user asks 'what tests " +
              "have I finished?' or wants a historical view.",
          },
        },
        required: [],
      },
      async execute(args) {
        const rawDate = typeof args.date === "string" ? args.date : "";
        const dateStr = rawDate || localISODate(now());
        const targetDate = parseLocalDate(dateStr);
        if (!targetDate) {
          return "Error: 'date' must be ISO 8601 (YYYY-MM-DD) or DD.MM.YYYY.";
        }
        const includeDone = args.include_done === true;
        const todayMidnight = startOfLocalDay(now());

        const all = getTests();
        const matching: ChronoteTest[] = [];
        for (const t of all) {
          if (!includeDone && t.done) continue;
          const td = parseLocalDate(t.date);
          if (!td) {
            // Defensive: TestService writes ISO dates, but a hand-edited
            // data.json could break the parse. Skip with a warning rather
            // than throwing — the rest of the list is still useful.
            console.warn(`Chronote: skipping test "${t.name}" with unparseable date "${t.date}"`);
            continue;
          }

          if (isSameLocalDay(td, targetDate)) {
            matching.push(t);
          }
        }

        // Stable order: soonest first, then alphabetical by name as a
        // tiebreaker so identical-date results are deterministic.
        matching.sort((a, b) => {
          const da = parseLocalDate(a.date)!.getTime();
          const db = parseLocalDate(b.date)!.getTime();
          if (da !== db) return da - db;
          return a.name.localeCompare(b.name);
        });

        if (matching.length === 0) {
          // Be a good citizen: if the only reason we returned nothing is
          // that every test on the day is done, tell the model so it
          // doesn't have to guess at the include_done flag.
          const anyOnDayButDone = all.some((t) => {
            const td = parseLocalDate(t.date);
            return td && isSameLocalDay(td, targetDate) && t.done;
          });
          if (anyOnDayButDone && !includeDone) {
            return `All tests on ${dateStr} are marked done. Pass include_done: true to see them.`;
          }
          return `No tests found on ${dateStr}.`;
        }

        return formatTests(matching, dateStr, todayMidnight);
      },
    },
  ];
}

// ── Helpers ────────────────────────────────────────────────────────

/** True iff `a` and `b` fall on the same local calendar day. */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Render a list of tests as a citation-friendly string the model can
 * reason over. The phrasing matches the dashboard's "(past)" /
 * "(today)" / "(in N days)" convention so the model's prose aligns
 * with what the user sees in the UI.
 */
function formatTests(tests: ChronoteTest[], dateStr: string, nowMidnight: Date): string {
  const lines: string[] = [];
  lines.push(`Found ${tests.length} test(s) on ${dateStr}:`);
  lines.push("");
  tests.forEach((t, i) => {
    const td = parseLocalDate(t.date)!;
    const days = daysUntil(nowMidnight, td);
    const proximity =
      days === 0
        ? "(today)"
        : days > 0
          ? `(in ${days} day${days === 1 ? "" : "s"})`
          : `(past, ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago)`;
    lines.push(`[${i + 1}] "${t.name}" — ${t.date} ${proximity} — done: ${t.done ? "true" : "false"}`);
    if (t.filePaths.length > 0) {
      lines.push(`    Notes: ${t.filePaths.join(", ")}`);
    } else {
      lines.push(`    Notes: (no notes linked yet)`);
    }
  });
  return lines.join("\n");
}
