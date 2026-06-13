/**
 * Settings migration.
 *
 * Obsidian stores plugin data in a single JSON blob (`data.json`) inside the
 * vault. When the plugin schema changes, the saved blob may contain legacy
 * keys that are no longer referenced in `CortexSettings`. If they hold any
 * sensitive value (OAuth client secret, refresh tokens for revoked apps,
 * device addresses, etc.) they sit on disk forever and become a privacy /
 * security liability the moment a user shares or syncs the vault.
 *
 * `migrateSettings()` runs on every `onload()` and returns a sanitized copy
 * containing ONLY the keys listed in `CortexSettings` plus the canonical
 * migration source-of-truth. It also normalizes values that the type
 * checker / runtime rely on (e.g. arrays, nulls, enums).
 *
 * This is intentionally additive and idempotent — old keys are dropped,
 * but a future migration can read them by looking at the raw input before
 * sanitization.
 */
import { CortexSettings, DEFAULT_SETTINGS } from "../settingsTypes";

/**
 * Set of legacy / orphaned top-level keys that must NEVER appear in the
 * persisted settings blob. Anything in this set is dropped during migration
 * and the change is persisted on the next save cycle.
 *
 * Keep this list explicit — every entry is a known regression we've
 * already shipped and don't want sneaking back into data.json.
 */
const OBSOLETE_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  // Legacy OAuth (the proxy now owns its own client credentials)
  "googleClientId",
  "googleClientSecret",
  // Legacy BLE schema (replaced by bleCalibrationData / bleDeviceName)
  "blePresets",
  "bleActivePresetId",
  "bleMacAddress",
  // Legacy review-load settings
  "dailyLimitEnabled",
  "mealTimes",
  // Legacy nested settings subobject (firebase + dashboard path)
  "settings",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop keys not present on the current `CortexSettings` schema and known
 * legacy subtrees. The result is a strict subset of the input keys plus
 * any defaults that are missing.
 *
 * Returned shape: a full `CortexSettings` with all fields populated.
 */
export function migrateSettings(raw: unknown): CortexSettings {
  const safeRaw: Record<string, unknown> = isPlainObject(raw) ? raw : {};

  // First, copy through any keys that exist on the current schema.
  const migrated: Record<string, unknown> = {};
  for (const key of Object.keys(safeRaw)) {
    if (key in DEFAULT_SETTINGS) {
      migrated[key] = safeRaw[key];
    }
  }

  // Apply defaults for any field the user has not yet populated.
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in migrated)) {
      migrated[key] = defaultValue;
    }
  }

  // Normalize array fields.
  if (!Array.isArray(migrated.tests)) {
    migrated.tests = [];
  }

  // Clamp numeric bounds that have semantic meaning (defensive — the UI
  // already clamps, but stale data may have been saved before limits
  // existed).
  if (typeof migrated.dailyLimitMax === "number" && Number.isFinite(migrated.dailyLimitMax)) {
    migrated.dailyLimitMax = Math.max(1, Math.min(20, Math.floor(migrated.dailyLimitMax)));
  } else if (migrated.dailyLimitMax !== null) {
    migrated.dailyLimitMax = null;
  }
  if (typeof migrated.maxReviewIntervalDays === "number" && Number.isFinite(migrated.maxReviewIntervalDays)) {
    migrated.maxReviewIntervalDays = Math.max(1, Math.min(365, Math.floor(migrated.maxReviewIntervalDays)));
  } else if (migrated.maxReviewIntervalDays !== null) {
    migrated.maxReviewIntervalDays = null;
  }
  for (const slider of ["faceSampleIntervalSec", "faceBlinkThreshold", "facePitchThreshold", "faceGracePeriodSec"] as const) {
    if (typeof migrated[slider] !== "number" || !Number.isFinite(migrated[slider] as number)) {
      (migrated as Record<string, unknown>)[slider] = DEFAULT_SETTINGS[slider];
    }
  }

  return migrated as unknown as CortexSettings;
}

/**
 * Returns the set of obsolete top-level keys that were present in `raw`.
 * Useful for logging and tests — the migration itself silently strips
 * them; callers that want telemetry can compare lists.
 */
export function detectObsoleteKeys(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  return Object.keys(raw).filter((k) => OBSOLETE_TOP_LEVEL_KEYS.has(k));
}

export const OBSOLETE_KEYS_FOR_TESTS = OBSOLETE_TOP_LEVEL_KEYS;
