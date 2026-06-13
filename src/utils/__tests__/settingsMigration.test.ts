import { describe, it, expect } from "vitest";
import { migrateSettings, detectObsoleteKeys } from "../settingsMigration";
import { DEFAULT_SETTINGS } from "../../settingsTypes";

/**
 * Settings migration regression tests.
 *
 * The plugin is shipped against an evolving schema. Every previous
 * version's settings blob may live on a user's disk for years, and
 * some of those blobs contain secrets (OAuth client secrets, device
 * MAC addresses, firebase IDs) that must NEVER be persisted in the
 * post-migration blob.
 *
 * These tests pin the contract: known-bad keys are dropped, defaults
 * are filled in, numeric fields are clamped, and the result is a
 * complete `CortexSettings` shape regardless of input state.
 */

describe("migrateSettings", () => {
  it("strips a known legacy OAuth client secret", () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      googleClientSecret: "GOCSPX-LEAKED",
      googleClientId: "old.apps.googleusercontent.com",
    };
    const out = migrateSettings(raw);
    expect((out as unknown as Record<string, unknown>).googleClientSecret).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).googleClientId).toBeUndefined();
  });

  it("strips legacy BLE schema keys", () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      blePresets: [{ id: "1" }],
      bleActivePresetId: "1",
      bleMacAddress: "EDD5FBAF-D47C-0535-D0C5-E58B4DE9EC52",
    };
    const out = migrateSettings(raw);
    expect((out as unknown as Record<string, unknown>).blePresets).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).bleActivePresetId).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).bleMacAddress).toBeUndefined();
  });

  it("strips legacy review-load keys", () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      dailyLimitEnabled: true,
      mealTimes: "Lunch 12:00-13:00",
    };
    const out = migrateSettings(raw);
    expect((out as unknown as Record<string, unknown>).dailyLimitEnabled).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).mealTimes).toBeUndefined();
  });

  it("strips the legacy nested settings subobject", () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      settings: {
        dashboardPath: "cortex dashboard.md",
        firebaseUserId: "abc123",
        firebaseProjectId: "demo",
      },
    };
    const out = migrateSettings(raw);
    expect((out as unknown as Record<string, unknown>).settings).toBeUndefined();
  });

  it("preserves every field on the current schema", () => {
    const out = migrateSettings(DEFAULT_SETTINGS);
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      expect(out).toHaveProperty(k);
    }
  });

  it("applies defaults for missing fields", () => {
    const out = migrateSettings({});
    expect(out.geminiApiKey).toBe("");
    expect(out.timeZone).toBe(DEFAULT_SETTINGS.timeZone);
    expect(out.faceEnabled).toBe(false);
  });

  it("clamps dailyLimitMax to [1, 20]", () => {
    expect(migrateSettings({ dailyLimitMax: 50 }).dailyLimitMax).toBe(20);
    expect(migrateSettings({ dailyLimitMax: 0 }).dailyLimitMax).toBe(1);
    expect(migrateSettings({ dailyLimitMax: -5 }).dailyLimitMax).toBe(1);
  });

  it("clamps maxReviewIntervalDays to [1, 365]", () => {
    expect(migrateSettings({ maxReviewIntervalDays: 1000 }).maxReviewIntervalDays).toBe(365);
    expect(migrateSettings({ maxReviewIntervalDays: 0 }).maxReviewIntervalDays).toBe(1);
  });

  it("resets invalid numerics to null where null is allowed", () => {
    const out = migrateSettings({ dailyLimitMax: "oops" });
    expect(out.dailyLimitMax).toBeNull();
  });

  it("falls back to defaults if a slider value is missing", () => {
    const out = migrateSettings({});
    expect(out.faceSampleIntervalSec).toBe(DEFAULT_SETTINGS.faceSampleIntervalSec);
    expect(out.faceBlinkThreshold).toBe(DEFAULT_SETTINGS.faceBlinkThreshold);
    expect(out.facePitchThreshold).toBe(DEFAULT_SETTINGS.facePitchThreshold);
    expect(out.faceGracePeriodSec).toBe(DEFAULT_SETTINGS.faceGracePeriodSec);
  });

  it("falls back to defaults for non-finite slider values", () => {
    const out = migrateSettings({ faceSampleIntervalSec: NaN, faceBlinkThreshold: Infinity });
    expect(out.faceSampleIntervalSec).toBe(DEFAULT_SETTINGS.faceSampleIntervalSec);
    expect(out.faceBlinkThreshold).toBe(DEFAULT_SETTINGS.faceBlinkThreshold);
  });

  it("normalizes a non-array tests field to an empty array", () => {
    const out = migrateSettings({ tests: "not-an-array" });
    expect(out.tests).toEqual([]);
  });

  it("tolerates null input", () => {
    const out = migrateSettings(null);
    expect(out.tests).toEqual([]);
    expect(out.geminiApiKey).toBe("");
  });

  it("tolerates non-object input (string, number, array)", () => {
    expect(migrateSettings("nope").tests).toEqual([]);
    expect(migrateSettings(42).tests).toEqual([]);
    expect(migrateSettings([1, 2, 3]).tests).toEqual([]);
  });
});

describe("detectObsoleteKeys", () => {
  it("returns all known-obsolete top-level keys present in input", () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      googleClientSecret: "x",
      googleClientId: "x",
      bleMacAddress: "x",
      mealTimes: "x",
    };
    expect(detectObsoleteKeys(raw).sort()).toEqual(
      ["bleMacAddress", "googleClientId", "googleClientSecret", "mealTimes"].sort(),
    );
  });

  it("returns an empty list for clean data", () => {
    expect(detectObsoleteKeys(DEFAULT_SETTINGS)).toEqual([]);
  });

  it("tolerates non-object input", () => {
    expect(detectObsoleteKeys(null)).toEqual([]);
    expect(detectObsoleteKeys("nope")).toEqual([]);
  });
});
