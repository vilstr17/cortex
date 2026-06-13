import { localISODate, addDays, parseLocalDate, startOfLocalDay } from "./dateUtils";

export interface NextReviewResult {
  nextInterval: number;
  nextReviewDate: string;
}

/**
 * Calculate the next review interval and date based on a 1–5 quality score.
 *
 * Score semantics (SM-2 inspired):
 *   1 — "Don't know it at all"  → reset interval to 1 day
 *   2 — "Barely knew it"        → reset interval to 1 day
 *   3 — "Partially know it"     → keep current interval (or 1 if new)
 *   4 — "Know it well"          → multiply interval by 2.0
 *   5 — "Know it perfectly"     → multiply interval by 3.0
 *
 * @param currentInterval - The current interval in days (0 means new/never reviewed)
 * @param quality - Quality score from 1–5
 * @param examDateStr - Optional exam date in YYYY-MM-DD format
 * @param maxIntervalDays - Optional user-defined max interval in days (null/undefined = no custom cap)
 * @returns Object with nextInterval (days) and nextReviewDate (YYYY-MM-DD)
 */
export function calculateNextReview(
  currentInterval: number,
  quality: number,
  examDateStr?: string,
  maxIntervalDays?: number | null,
): NextReviewResult {
  const baseInterval = currentInterval <= 0 ? 1 : currentInterval;
  let nextInterval: number;

  if (quality <= 2) {
    nextInterval = 1;
  } else if (quality === 3) {
    nextInterval = baseInterval;
  } else if (quality === 4) {
    nextInterval = Math.round(baseInterval * 2.0);
  } else {
    nextInterval = Math.round(baseInterval * 3.0);
  }

  nextInterval = Math.max(1, Math.min(nextInterval, 365));

  if (typeof maxIntervalDays === "number" && Number.isFinite(maxIntervalDays)) {
    const sanitizedUserMax = Math.max(1, Math.floor(maxIntervalDays));
    nextInterval = Math.min(nextInterval, sanitizedUserMax);
  }

  const today = new Date();
  const todayMidnight = startOfLocalDay(today);

  let nextReviewDate = localISODate(addDays(today, nextInterval));

  if (examDateStr) {
    const examDate = parseLocalDate(examDateStr);
    if (examDate) {
      const timeUntilExam = examDate.getTime() - todayMidnight.getTime();
      const daysUntilExam = Math.ceil(timeUntilExam / (1000 * 60 * 60 * 24));

      if (daysUntilExam <= 0) {
        nextInterval = 9999;
        nextReviewDate = "9999-12-31";
      }
    }
  }

  return {
    nextInterval,
    nextReviewDate,
  };
}
