/**
 * Review tool: list_reviews.
 *
 * Surfaces the user's spaced-repetition review queue (the data behind
 * the dashboard's "Due Reviews" panel) to the LLM on demand. The model
 * calls this when the user asks "what should I review today?", "what
 * reviews are due this week?", or wants to plan revision around
 * upcoming exams.
 *
 * The tool is a thin wrapper over `computeDueReviews` /
 * `readReviewableNotes` in `src/services/reviewService.ts` — the same
 * pure computation the dashboard uses, so the agent's answer always
 * matches what the user sees in the UI. The factory takes the live
 * `App` and `getTests` closure so the tool sees vault edits and
 * dashboard edits without a re-mount, mirroring `createTestTools`.
 *
 * "Revision" itself is still not a stored entity — the model plans it
 * once it knows the reviews, the linked notes (via the `Notes:` hint
 * in each result), the calendar free slots, and the upcoming tests.
 */

import { App } from "obsidian";
import { Tool } from "../toolRegistry.js";
import { CortexTest } from "../../settingsTypes.js";
import { localISODate, parseLocalDate, startOfLocalDay, isSameLocalDay, daysUntil } from "../../utils/dateUtils.js";
import {
  computeDueReviews,
  readReviewableNotes,
} from "../../services/reviewService.js";

/**
 * Build the list_reviews tool. The factory takes the live app + test
 * list as closures so the tool sees any dashboard edits or vault
 * mutations without a re-mount, and an injectable `now` so the unit
 * tests are deterministic.
 */
export function createReviewTools(deps: {
  app: App;
  getTests: () => CortexTest[];
  now?: () => Date;
}): Tool[] {
  const getTests = deps.getTests;
  const now = deps.now ?? (() => new Date());

  return [
    {
      name: "list_reviews",
      description:
        "List notes that are due for spaced-repetition review on a specific date. " +
        "Returns the note file path, the scheduled next_review date, how many days " +
        "overdue it is (0 if due today), and the note's confidence (1–5, lower = " +
        "less sure). Use this whenever the user asks what to review, what notes are " +
        "due, or wants to plan revision. Notes linked to a finished exam are " +
        "automatically retired from the queue. Pair with list_tests (for upcoming " +
        "exams), search_notes / read_note (to pull revision material), and " +
        "list_events (to find free slots) to build a revision plan.",
      parameters: {
        type: "OBJECT",
        description: "List reviews due on a specific date",
        properties: {
          date: {
            type: "STRING",
            description:
              "The date to list due reviews for, in ISO 8601 format (YYYY-MM-DD) or " +
              "DD.MM.YYYY (e.g. '2026-06-20' or '20.06.2026'). If omitted, defaults to " +
              "today.",
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

        // Re-read the vault + tests every call so dashboard edits and
        // recently-changed frontmatter show up without a re-mount.
        // `readReviewableNotes` reads from the metadata cache (no disk
        // I/O), so this stays cheap even on large vaults.
        const allNotes = readReviewableNotes(deps.app);
        const donePaths = (() => {
          const set = new Set<string>();
          for (const t of getTests()) {
            if (!t.done) continue;
            for (const fp of t.filePaths) set.add(fp);
          }
          return set;
        })();

        const due = computeDueReviews(allNotes, donePaths, targetDate, now());

        if (due.length === 0) {
          return `No reviews due on ${dateStr}.`;
        }

        return formatReviews(due, dateStr, startOfLocalDay(now()));
      },
    },
  ];
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Render a list of due reviews as a citation-friendly string the model
 * can reason over. Order: most overdue first, then by basename as a
 * tiebreaker so identical-overdue results are deterministic. Confidence
 * is included so the model can prioritize low-confidence notes when
 * time is tight.
 */
function formatReviews(
  reviews: ReturnType<typeof computeDueReviews>,
  dateStr: string,
  nowMidnight: Date,
): string {
  const sorted = [...reviews].sort((a, b) => {
    if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
    return a.basename.localeCompare(b.basename);
  });

  const lines: string[] = [];
  lines.push(`Found ${sorted.length} review(s) due on ${dateStr}:`);
  lines.push("");

  sorted.forEach((r, i) => {
    const proximity =
      r.daysOverdue === 0
        ? "(due today)"
        : `(overdue by ${r.daysOverdue} day${r.daysOverdue === 1 ? "" : "s"})`;
    const confidence = r.confidence !== null ? `, confidence: ${r.confidence}/5` : "";
    const reviewDate = localISODate(r.nextReview);
    lines.push(
      `[${i + 1}] "${r.basename}" — scheduled: ${reviewDate} ${proximity}${confidence}`,
    );
    lines.push(`    Path: ${r.path}`);
  });
  return lines.join("\n");
}
