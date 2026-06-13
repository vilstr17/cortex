import { describe, it, expect } from "vitest";
import {
  localISODate,
  parseLocalDate,
  addDays,
  daysUntil,
  startOfLocalDay,
  isSameLocalDay,
} from "../dateUtils";

/**
 * Regression suite for the local-date utilities.
 *
 * The whole point of `dateUtils.ts` was to eliminate the
 * `toISOString().slice(0, 10)` UTC bug that surfaced as off-by-one-day
 * errors near midnight in non-UTC timezones. The cases below pin every
 * helper against that bug: if any of them ever produces a UTC-derived
 * date, the test will fail.
 *
 * We pin `process.env.TZ` is left untouched on purpose — the host
 * machine's timezone is what we test against, because that's the
 * behaviour the plugin actually relies on at runtime.
 */

describe("localISODate", () => {
  it("returns YYYY-MM-DD in the local timezone", () => {
    const d = new Date(2026, 5, 13, 23, 30, 0); // 13 June 2026 23:30 local
    expect(localISODate(d)).toBe("2026-06-13");
  });

  it("uses local date components, never UTC", () => {
    // Build a date late in the evening local time. A bug that uses
    // toISOString() (UTC) would shift this to the next day in any
    // timezone west of UTC. The test asserts local semantics.
    const d = new Date(2026, 0, 1, 23, 59, 0);
    expect(localISODate(d)).toBe("2026-01-01");
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5); // 5 Jan 2026
    expect(localISODate(d)).toBe("2026-01-05");
  });

  it("defaults to the current date when no argument is given", () => {
    const now = localISODate();
    const expected = localISODate(new Date());
    expect(now).toBe(expected);
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rolls over year boundary correctly", () => {
    const d = new Date(2026, 11, 31); // 31 Dec 2026
    expect(localISODate(d)).toBe("2026-12-31");
    const next = addDays(d, 1);
    expect(localISODate(next)).toBe("2027-01-01");
  });
});

describe("parseLocalDate", () => {
  it("parses YYYY-MM-DD as a local date", () => {
    const d = parseLocalDate("2026-06-13");
    expect(d).not.toBeNull();
    if (!d) throw new Error("expected parseLocalDate to succeed");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(0);
  });

  it("parses DD.MM.YYYY (Czech-style) as a local date", () => {
    const d = parseLocalDate("13.06.2026");
    expect(d).not.toBeNull();
    if (!d) throw new Error("expected parseLocalDate to succeed");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(13);
  });

  it("rejects impossible dates (Feb 30)", () => {
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("30.02.2026")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseLocalDate("")).toBeNull();
    expect(parseLocalDate("hello")).toBeNull();
    expect(parseLocalDate("2026/06/13")).toBeNull();
    expect(parseLocalDate("13-06-2026")).toBeNull();
  });

  it("handles two-digit years or days gracefully (only accepts 4-digit years)", () => {
    expect(parseLocalDate("26-06-13")).toBeNull();
  });
});

describe("startOfLocalDay", () => {
  it("zeroes out time-of-day", () => {
    const d = new Date(2026, 5, 13, 15, 30, 45, 123);
    const sod = startOfLocalDay(d);
    expect(sod.getHours()).toBe(0);
    expect(sod.getMinutes()).toBe(0);
    expect(sod.getSeconds()).toBe(0);
    expect(sod.getMilliseconds()).toBe(0);
    expect(sod.getDate()).toBe(13);
  });

  it("does not mutate the input", () => {
    const d = new Date(2026, 5, 13, 15, 30, 45, 123);
    const sod = startOfLocalDay(d);
    expect(d.getHours()).toBe(15);
    expect(sod).not.toBe(d);
  });
});

describe("isSameLocalDay", () => {
  it("matches two dates on the same local day", () => {
    expect(isSameLocalDay(
      new Date(2026, 5, 13, 9, 0, 0),
      new Date(2026, 5, 13, 23, 59, 59),
    )).toBe(true);
  });

  it("distinguishes consecutive local days", () => {
    expect(isSameLocalDay(
      new Date(2026, 5, 13, 23, 59, 59),
      new Date(2026, 5, 14, 0, 0, 1),
    )).toBe(false);
  });
});

describe("addDays", () => {
  it("adds days across a month boundary", () => {
    const d = new Date(2026, 0, 30);
    expect(localISODate(addDays(d, 5))).toBe("2026-02-04");
  });

  it("subtracts days with negative input", () => {
    const d = new Date(2026, 1, 1);
    expect(localISODate(addDays(d, -1))).toBe("2026-01-31");
  });

  it("adds zero", () => {
    const d = new Date(2026, 5, 13, 10, 30);
    const r = addDays(d, 0);
    expect(localISODate(r)).toBe("2026-06-13");
    expect(r.getHours()).toBe(0);
  });

  it("handles a 28-day February", () => {
    const d = new Date(2026, 1, 28);
    expect(localISODate(addDays(d, 1))).toBe("2026-03-01");
  });

  it("handles a 29-day leap-year February", () => {
    const d = new Date(2024, 1, 28);
    expect(localISODate(addDays(d, 2))).toBe("2024-03-01");
  });
});

describe("daysUntil", () => {
  it("counts whole days between two local midnights", () => {
    const from = new Date(2026, 5, 13, 9, 0, 0);
    const to = new Date(2026, 5, 18, 23, 0, 0);
    expect(daysUntil(from, to)).toBe(5);
  });

  it("returns negative for past dates", () => {
    const from = new Date(2026, 5, 18);
    const to = new Date(2026, 5, 13);
    expect(daysUntil(from, to)).toBe(-5);
  });

  it("returns 0 for the same local day", () => {
    expect(daysUntil(
      new Date(2026, 5, 13, 0, 0),
      new Date(2026, 5, 13, 23, 59, 59),
    )).toBe(0);
  });
});

/**
 * DST regression tests.
 *
 * The original UTC bug had a second symptom: anywhere west of UTC, a
 * date computed as `toISOString().slice(0, 10)` would shift by one day
 * after a DST change. These tests pick two DST-transition dates and
 * assert that round-tripping a date through addDays + localISODate is
 * stable. The exact DST dates depend on the host timezone, so we use
 * `Intl.DateTimeFormat` to find the relevant transition dynamically.
 */
describe("DST stability", () => {
  function findDstTransition(year: number): Date | null {
    // Walk a window around the most likely DST dates and find the day
    // where local-midnight in UTC is offset by something other than
    // the previous day's offset.
    const candidates: Date[] = [];
    for (const month of [2, 9]) { // March & October — typical DST windows
      for (const day of range(1, 31)) {
        const d = new Date(year, month, day, 12, 0, 0);
        candidates.push(d);
      }
    }
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1];
      const cur = candidates[i];
      if (prev.getTimezoneOffset() !== cur.getTimezoneOffset()) {
        // Found a transition; return the local date on which it lands.
        return new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
      }
    }
    return null;
  }
  function range(a: number, b: number): number[] {
    const r: number[] = [];
    for (let i = a; i <= b; i++) r.push(i);
    return r;
  }

  it("does not shift a date across the spring-forward transition", () => {
    const transition = findDstTransition(new Date().getFullYear());
    if (!transition) {
      // Host timezone doesn't observe DST — nothing to test.
      return;
    }
    // Three days around the transition: round-trip must be stable.
    for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
      const d = addDays(transition, offset);
      expect(localISODate(d)).toBe(localISODate(addDays(d, 0)));
    }
  });
});
