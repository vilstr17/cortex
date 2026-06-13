import { describe, it, expect } from "vitest";
import { calculateNextReview } from "../srsLogic";

/**
 * Tests for the SM-2 inspired SRS algorithm.
 *
 * Pinning the score → interval mapping is critical: if a contributor
 * accidentally swaps a multiplier or hardcodes "1" somewhere, the
 * entire review cadence breaks silently. Every documented score
 * band has a dedicated assertion.
 */

describe("calculateNextReview", () => {
  it("resets to 1 day for a score of 1 (don't know at all)", () => {
    const r = calculateNextReview(30, 1);
    expect(r.nextInterval).toBe(1);
  });

  it("resets to 1 day for a score of 2 (barely knew it)", () => {
    const r = calculateNextReview(30, 2);
    expect(r.nextInterval).toBe(1);
  });

  it("holds the current interval for a score of 3", () => {
    expect(calculateNextReview(10, 3).nextInterval).toBe(10);
    expect(calculateNextReview(1, 3).nextInterval).toBe(1);
  });

  it("doubles the interval for a score of 4", () => {
    expect(calculateNextReview(5, 4).nextInterval).toBe(10);
    expect(calculateNextReview(7, 4).nextInterval).toBe(14);
  });

  it("triples the interval for a score of 5", () => {
    expect(calculateNextReview(5, 5).nextInterval).toBe(15);
    expect(calculateNextReview(10, 5).nextInterval).toBe(30);
  });

  it("starts at 1 day for new notes (currentInterval=0)", () => {
    expect(calculateNextReview(0, 4).nextInterval).toBe(2); // 1 * 2
    expect(calculateNextReview(0, 5).nextInterval).toBe(3); // 1 * 3
    expect(calculateNextReview(0, 3).nextInterval).toBe(1); // base 1
  });

  it("clamps to a 365-day hard maximum", () => {
    const r = calculateNextReview(200, 5);
    expect(r.nextInterval).toBe(365);
  });

  it("respects a user-supplied maxReviewIntervalDays cap", () => {
    const r = calculateNextReview(10, 5, undefined, 14);
    expect(r.nextInterval).toBe(14);
  });

  it("ignores non-finite user caps", () => {
    const r = calculateNextReview(10, 5, undefined, NaN);
    expect(r.nextInterval).toBe(30);
  });

  it("ignores a null user cap", () => {
    const r = calculateNextReview(10, 5, undefined, null);
    expect(r.nextInterval).toBe(30);
  });

  it("returns a YYYY-MM-DD nextReviewDate", () => {
    const r = calculateNextReview(0, 4);
    expect(r.nextReviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a 'sentinel' far-future date when the exam date has passed", () => {
    // Exam yesterday — review should be pushed out of the way.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const iso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    const r = calculateNextReview(5, 5, iso);
    expect(r.nextReviewDate).toBe("9999-12-31");
    expect(r.nextInterval).toBe(9999);
  });

  it("ignores a future exam date — the SRS cadence proceeds normally", () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const iso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    const r = calculateNextReview(5, 5, iso);
    expect(r.nextReviewDate).not.toBe("9999-12-31");
  });
});
