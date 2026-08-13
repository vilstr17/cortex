/**
 * Focus statistics — pure, dependency-free aggregation of face-detection
 * state transitions into per-day distraction stats.
 *
 * The recorder is fed every state change from DetectionManager
 * (LOCKED_IN / DISTRACTED / UNKNOWN). It closes the previous state's
 * duration on each transition and on `stop()`, so durations are exact
 * even when detection is toggled off mid-state. Everything is derived
 * from a single `days` map keyed by local YYYY-MM-DD, which keeps the
 * persisted shape small and the dashboard queries trivial.
 *
 * All functions here are pure / deterministic so they can be unit-tested
 * in Node without Obsidian.
 */

export type FocusState = "LOCKED_IN" | "DISTRACTED" | "UNKNOWN";

/** One completed distraction episode (DISTRACTED → back to focus). */
export interface DistractionEpisode {
  /** Epoch ms when the DISTRACTED state began. */
  start: number;
  /** Epoch ms when it ended (LOCKED_IN / UNKNOWN / detection stopped). */
  end: number;
}

export interface DayFocusStats {
  /** Milliseconds spent in LOCKED_IN that day. */
  focusMs: number;
  /** Milliseconds spent in DISTRACTED that day. */
  distractedMs: number;
  /** Number of completed distraction episodes that day. */
  distractedCount: number;
  /** Completed episodes, oldest first (bounded by `prune`). */
  episodes: DistractionEpisode[];
}

export interface FocusStatsData {
  /** Per-day stats keyed by local date `YYYY-MM-DD`. */
  days: Record<string, DayFocusStats>;
}

export const EMPTY_DAY: DayFocusStats = {
  focusMs: 0,
  distractedMs: 0,
  distractedCount: 0,
  episodes: [],
};

/**
 * Fresh empty day. `{ ...EMPTY_DAY }` is NOT safe — it shares the
 * `episodes` array reference, so a push on one day would leak into every
 * other day (and into EMPTY_DAY itself).
 */
function emptyDay(): DayFocusStats {
  return { ...EMPTY_DAY, episodes: [] };
}

/** Local-time date key for an epoch-ms timestamp. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Epoch ms of local midnight for a date key. */
export function dayStartMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * Incremental recorder. Feed it every state change; it accumulates
 * durations into `data.days`. Call `stop()` when detection shuts down so
 * the in-flight state is closed out.
 */
export class FocusStatsRecorder {
  private data: FocusStatsData;
  private currentState: FocusState | null = null;
  private stateSince = 0;
  private episodeStart: number | null = null;

  constructor(data: FocusStatsData) {
    this.data = data;
  }

  /** Record a state transition at epoch-ms `ts`. */
  recordState(state: FocusState, ts: number): void {
    if (state === this.currentState) return;
    if (this.currentState !== null) {
      this.closeState(ts);
    }
    this.currentState = state;
    this.stateSince = ts;
    if (state === "DISTRACTED") {
      this.episodeStart = ts;
    }
  }

  /** Close the in-flight state (detection stopped / plugin unload). */
  stop(ts: number): void {
    if (this.currentState !== null) {
      this.closeState(ts);
    }
    this.currentState = null;
    this.episodeStart = null;
  }

  getData(): FocusStatsData {
    return this.data;
  }

  /**
   * Drop day records older than `maxDays` (keeps the persisted blob
   * bounded). Call after saving.
   */
  prune(maxDays: number): void {
    const cutoff = dayKey(Date.now() - maxDays * 86400000);
    for (const key of Object.keys(this.data.days)) {
      if (key < cutoff) delete this.data.days[key];
    }
  }

  private closeState(ts: number): void {
    const dur = ts - this.stateSince;
    if (dur <= 0) return;
    // Split the duration across local-midnight boundaries so a state that
    // spans midnight lands in both days. A DISTRACTED episode is recorded
    // on every day it overlaps (with its full timestamps — read-side
    // helpers clamp to the day), so per-day ms, counts and the hourly
    // chart stay consistent.
    let cursor = this.stateSince;
    while (cursor < ts) {
      const key = dayKey(cursor);
      const segEnd = Math.min(ts, dayStartMs(key) + 86400000);
      const segDur = segEnd - cursor;
      if (segDur > 0) {
        const day: DayFocusStats = this.data.days[key] ?? emptyDay();
        if (this.currentState === "LOCKED_IN") {
          day.focusMs += segDur;
        } else if (this.currentState === "DISTRACTED") {
          day.distractedMs += segDur;
          if (this.episodeStart !== null) {
            day.distractedCount += 1;
            day.episodes.push({ start: this.episodeStart, end: ts });
          }
        }
        this.data.days[key] = day;
      }
      cursor = segEnd;
    }
    if (this.currentState === "DISTRACTED") {
      this.episodeStart = null;
    }
  }
}

// ── Read-side aggregation (pure) ──────────────────────────────────

export interface DaySummary {
  key: string;
  focusMs: number;
  distractedMs: number;
  distractedCount: number;
}

/** Stats for one day, or an empty day when nothing was recorded. */
export function getDay(data: FocusStatsData, key: string): DayFocusStats {
  return data.days[key] ?? emptyDay();
}

/**
 * Summaries for the last `n` days ending today (local time), oldest
 * first. Missing days are included as empty so charts can render a
 * continuous axis.
 */
export function lastNDays(data: FocusStatsData, n: number): DaySummary[] {
  const out: DaySummary[] = [];
  const today = dayKey(Date.now());
  for (let i = n - 1; i >= 0; i--) {
    const key = dayKey(dayStartMs(today) - i * 86400000);
    const day = getDay(data, key);
    out.push({
      key,
      focusMs: day.focusMs,
      distractedMs: day.distractedMs,
      distractedCount: day.distractedCount,
    });
  }
  return out;
}

/**
 * Distracted milliseconds per hour of the day (0–23) for a given date
 * key, computed by overlapping each episode with each hour. Used for the
 * "when do you get distracted most" chart.
 */
export function hourlyDistracted(data: FocusStatsData, key: string): number[] {
  const hours = new Array<number>(24).fill(0);
  const day = getDay(data, key);
  const dayStart = dayStartMs(key);
  const dayEnd = dayStart + 86400000;
  for (const ep of day.episodes) {
    const start = Math.max(ep.start, dayStart);
    const end = Math.min(ep.end, dayEnd);
    if (end <= start) continue;
    for (let h = 0; h < 24; h++) {
      const hStart = dayStart + h * 3600000;
      const hEnd = hStart + 3600000;
      const overlap = Math.min(end, hEnd) - Math.max(start, hStart);
      if (overlap > 0) hours[h] += overlap;
    }
  }
  return hours;
}

/** Focus ratio 0–1 for a day (focus / (focus + distracted)); 0 when idle. */
export function focusRatio(day: DayFocusStats): number {
  const total = day.focusMs + day.distractedMs;
  if (total <= 0) return 0;
  return day.focusMs / total;
}
