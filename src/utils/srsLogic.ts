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
 * @returns Object with nextInterval (days) and nextReviewDate (YYYY-MM-DD)
 */
export function calculateNextReview(
  currentInterval: number,
  quality: number,
  examDateStr?: string,
): NextReviewResult {
  const baseInterval = currentInterval <= 0 ? 1 : currentInterval;
  let nextInterval: number;

  if (quality <= 2) {
    // Forgot or barely remembered — reset
    nextInterval = 1;
  } else if (quality === 3) {
    // Partial recall — hold steady
    nextInterval = baseInterval;
  } else if (quality === 4) {
    // Good recall — double the interval
    nextInterval = Math.round(baseInterval * 2.0);
  } else {
    // Perfect recall — triple the interval
    nextInterval = Math.round(baseInterval * 3.0);
  }

  // Clamp to a reasonable range
  nextInterval = Math.max(1, Math.min(nextInterval, 365));

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  const nextReviewDateObj = new Date(today);
  nextReviewDateObj.setDate(nextReviewDateObj.getDate() + nextInterval);
  let nextReviewDate = nextReviewDateObj.toISOString().split("T")[0];

  // ── Exam date constraint ─────────────────────────────────────────
  if (examDateStr) {
    const examDate = new Date(examDateStr);
    const examDateOnly = examDate.toISOString().split("T")[0];

    const timeUntilExam = examDate.getTime() - today.getTime();
    const daysUntilExam = Math.ceil(timeUntilExam / (1000 * 60 * 60 * 24));

    if (daysUntilExam <= 0) {
      // Exam is today or already passed — review today
      nextInterval = 0;
      nextReviewDate = todayStr;
    } else if (daysUntilExam === 1) {
      // Exam tomorrow — review today
      nextInterval = 0;
      nextReviewDate = todayStr;
    } else {
      // SR interval MUST NOT exceed 50% of the remaining time to the exam
      const maxInterval = Math.max(1, Math.floor(daysUntilExam / 2));
      if (nextInterval > maxInterval) {
        nextInterval = maxInterval;
        const compressedDate = new Date(today);
        compressedDate.setDate(compressedDate.getDate() + nextInterval);
        nextReviewDate = compressedDate.toISOString().split("T")[0];
      }
    }
  }

  return {
    nextInterval,
    nextReviewDate,
  };
}
