import { describe, expect, it } from "vitest";
import {
  EMPTY_DAY,
  FocusStatsRecorder,
  dayKey,
  dayStartMs,
  focusRatio,
  getDay,
  hourlyDistracted,
  lastNDays,
} from "../focusStats.js";

// Fixed "now" so day-boundary tests are deterministic.
const NOW = new Date(2026, 7, 13, 12, 0, 0).getTime(); // 2026-08-13 12:00 local

describe("dayKey / dayStartMs", () => {
  it("formats a local date key", () => {
    expect(dayKey(new Date(2026, 7, 3, 23, 59).getTime())).toBe("2026-08-03");
  });

  it("round-trips through dayStartMs", () => {
    const key = "2026-08-13";
    expect(dayKey(dayStartMs(key))).toBe(key);
  });
});

describe("FocusStatsRecorder", () => {
  it("accumulates focus and distracted durations per day", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    const t0 = NOW;
    r.recordState("LOCKED_IN", t0);
    r.recordState("DISTRACTED", t0 + 60000); // 60s focused
    r.recordState("LOCKED_IN", t0 + 90000); // 30s distracted
    r.stop(t0 + 120000); // 30s focused

    const day = getDay(data, "2026-08-13");
    expect(day.focusMs).toBe(90000);
    expect(day.distractedMs).toBe(30000);
    expect(day.distractedCount).toBe(1);
    expect(day.episodes).toEqual([{ start: t0 + 60000, end: t0 + 90000 }]);
  });

  it("ignores duplicate consecutive states", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    r.recordState("DISTRACTED", NOW);
    r.recordState("DISTRACTED", NOW + 1000);
    r.recordState("LOCKED_IN", NOW + 5000);
    expect(getDay(data, "2026-08-13").distractedCount).toBe(1);
    expect(getDay(data, "2026-08-13").distractedMs).toBe(5000);
  });

  it("closes an open episode on stop()", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    r.recordState("DISTRACTED", NOW);
    r.stop(NOW + 10000);
    const day = getDay(data, "2026-08-13");
    expect(day.distractedCount).toBe(1);
    expect(day.episodes[0].end).toBe(NOW + 10000);
  });

  it("splits durations across midnight into the right days", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    const beforeMidnight = new Date(2026, 7, 13, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 7, 14, 0, 0, 30).getTime();
    r.recordState("LOCKED_IN", beforeMidnight);
    r.stop(afterMidnight);

    // 30s before midnight → 08-13, 30s after → 08-14
    expect(getDay(data, "2026-08-13").focusMs).toBe(30000);
    expect(getDay(data, "2026-08-14").focusMs).toBe(30000);
  });

  it("prune() drops old days", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    r.recordState("LOCKED_IN", dayStartMs("2026-07-01"));
    r.stop(dayStartMs("2026-07-01") + 1000);
    expect(Object.keys(data.days)).toContain("2026-07-01");
    r.prune(30);
    expect(Object.keys(data.days)).not.toContain("2026-07-01");
  });
});

describe("lastNDays", () => {
  it("returns n days ending today, oldest first, with empty days", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    r.recordState("DISTRACTED", NOW);
    r.stop(NOW + 1000);
    const days = lastNDays(data, 3);
    expect(days).toHaveLength(3);
    expect(days[2].key).toBe("2026-08-13");
    expect(days[2].distractedCount).toBe(1);
    expect(days[0].distractedCount).toBe(0);
  });
});

describe("hourlyDistracted", () => {
  it("attributes episode time to the correct hours", () => {
    const data = { days: {} };
    const r = new FocusStatsRecorder(data);
    const t0 = new Date(2026, 7, 13, 9, 30, 0).getTime();
    r.recordState("DISTRACTED", t0);
    r.stop(t0 + 3600000); // 1h episode starting 09:30
    const hours = hourlyDistracted(data, "2026-08-13");
    expect(hours[9]).toBe(1800000); // 09:30–10:00
    expect(hours[10]).toBe(1800000); // 10:00–10:30
    expect(hours[8]).toBe(0);
  });
});

describe("focusRatio", () => {
  it("computes the focus share", () => {
    expect(focusRatio({ ...EMPTY_DAY, focusMs: 30000, distractedMs: 10000 })).toBeCloseTo(0.75);
  });

  it("returns 0 when nothing was recorded", () => {
    expect(focusRatio(EMPTY_DAY)).toBe(0);
  });
});
