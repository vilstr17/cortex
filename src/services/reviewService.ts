/**
 * Review service: compute the spaced-repetition review queue.
 *
 * The dashboard's "Due Reviews" panel (`CortexDashboardView.getDueNotes`)
 * used to be the only consumer of this logic, which meant the agent
 * had no way to answer "what reviews are due today?". This module
 * extracts that computation so both the dashboard and the new
 * `list_reviews` agent tool share one source of truth.
 *
 * Split into two halves on purpose:
 *  - `computeDueReviews` is pure (no Obsidian) so it is trivially
 *    unit-testable and the agent tool can be driven with stub data.
 *  - `readReviewableNotes` / `donePathsFromTests` are the thin
 *    Obsidian-coupled adapters that feed real vault data in.
 */

import { App } from "obsidian";
import { CortexTest } from "../settingsTypes.js";
import { parseLocalDate, startOfLocalDay } from "../utils/dateUtils.js";

/** A note's review-relevant frontmatter, lifted off the TFile. */
export interface ReviewableNote {
  /** Vault-relative path, e.g. "Calculus - Limits.md". */
  path: string;
  /** File name without extension — what the user sees in the dashboard. */
  basename: string;
  /** `next_review` frontmatter, normalized to start-of-local-day. Null if absent/unparseable. */
  nextReview: Date | null;
  /** `exam_date` frontmatter, normalized. Null if absent/unparseable. */
  examDate: Date | null;
  /** `confidence` frontmatter clamped to 1–5. Null if absent/unparseable. */
  confidence: number | null;
}

/** A note that is due on or before `target` and not yet retired. */
export interface DueReview {
  path: string;
  basename: string;
  /** The note's `next_review` date (start of local day). */
  nextReview: Date;
  /** True when `nextReview` is strictly before the target day (overdue). */
  isOverdue: boolean;
  /** Whole days the review is past its scheduled day, relative to `target`. 0 if due today. */
  daysOverdue: number;
  confidence: number | null;
}

/**
 * Collect the file paths of every test marked done. Notes linked to a
 * done test are retired from the review queue — there's nothing left
 * to revise once the exam is over.
 */
export function donePathsFromTests(tests: CortexTest[]): Set<string> {
  const set = new Set<string>();
  for (const t of tests) {
    if (!t.done) continue;
    for (const fp of t.filePaths) set.add(fp);
  }
  return set;
}

/**
 * Pure due-review computation. Mirrors `getDueNotes` in the dashboard
 * field-for-field so the agent's answer matches what the user sees in
 * the UI:
 *
 *  - skip notes linked to a done test,
 *  - skip notes whose exam_date is already in the past,
 *  - a note is due when `next_review <= startOfLocalDay(target)`,
 *  - overdue when `nextReview < startOfLocalDay(target)`.
 *
 * `today` is passed in (rather than read from `new Date()`) so callers
 * — and tests — control "now" explicitly. The dashboard passes the
 * real clock; the agent tool passes its injectable `now()`.
 */
export function computeDueReviews(
  notes: ReviewableNote[],
  donePaths: Set<string>,
  target: Date,
  today: Date,
): DueReview[] {
  const targetDay = startOfLocalDay(target);
  const todayDay = startOfLocalDay(today);

  const out: DueReview[] = [];
  for (const n of notes) {
    if (donePaths.has(n.path)) continue;
    // A note whose exam already happened is retired, even if its
    // next_review frontmatter still points at a past date.
    if (n.examDate && n.examDate < todayDay) continue;
    if (!n.nextReview) continue;
    if (n.nextReview > targetDay) continue;

    const isOverdue = n.nextReview < targetDay;
    out.push({
      path: n.path,
      basename: n.basename,
      nextReview: n.nextReview,
      isOverdue,
      daysOverdue: isOverdue
        ? Math.max(1, Math.round((targetDay.getTime() - n.nextReview.getTime()) / (1000 * 60 * 60 * 24)))
        : 0,
      confidence: n.confidence,
    });
  }
  return out;
}

/**
 * Read every markdown file's review-relevant frontmatter out of the
 * Obsidian metadata cache. Cheap (no disk read) — the cache is already
 * warm for any note the user has seen.
 */
export function readReviewableNotes(app: App): ReviewableNote[] {
  const out: ReviewableNote[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    // No frontmatter at all → no next_review → can't be due. Skip
    // early to avoid minting a ReviewableNote we'll always filter out.
    if (!fm) continue;
    out.push({
      path: f.path,
      basename: f.basename,
      nextReview: parseFrontmatterDate(fm.next_review),
      examDate: parseFrontmatterDate(fm.exam_date),
      confidence: parseConfidence(fm.confidence),
    });
  }
  return out;
}

/**
 * Normalize a frontmatter date value to start-of-local-day. Accepts
 * the three shapes YAML round-trips dates as (Date, epoch number,
 * string). Identical to the dashboard's private helper — kept here so
 * the two paths can't drift.
 */
function parseFrontmatterDate(raw: unknown): Date | null {
  if (raw instanceof Date) return startOfLocalDay(raw);
  if (typeof raw === "number") return startOfLocalDay(new Date(raw));
  if (typeof raw === "string") return parseLocalDate(raw);
  return null;
}

/** Parse + clamp `confidence` to the 1–5 scale the dashboard uses. */
function parseConfidence(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.max(1, Math.min(5, v));
}
