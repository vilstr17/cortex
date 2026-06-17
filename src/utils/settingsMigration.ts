/**
 * Settings migration.
 *
 * Obsidian stores plugin data in a single JSON blob (`data.json`) inside the
 * vault. When the plugin schema changes, the saved blob may contain legacy
 * keys that are no longer referenced in `ChronoteSettings`. If they hold any
 * sensitive value (OAuth client secret, refresh tokens for revoked apps,
 * device addresses, etc.) they sit on disk forever and become a privacy /
 * security liability the moment a user shares or syncs the vault.
 *
 * `migrateSettings()` runs on every `onload()` and returns a sanitized copy
 * containing ONLY the keys listed in `ChronoteSettings` plus the canonical
 * migration source-of-truth. It also normalizes values that the type
 * checker / runtime rely on (e.g. arrays, nulls, enums).
 *
 * This is intentionally additive and idempotent — old keys are dropped,
 * but a future migration can read them by looking at the raw input before
 * sanitization.
 */
import { App } from "obsidian";
import { ChronoteSettings, DEFAULT_SETTINGS } from "../settingsTypes.js";
import { DEFAULT_BASE_URL } from "../services/ai/catalog.js";

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
  // Legacy AI fields (moved under the `ai` subobject in settingsTypes.ts).
  // Values are copied into `ai` before these are stripped — see
  // `migrateSettings()` below.
  "geminiApiKey",
  "geminiModel",
  // Pre-simplification embedding stack. The five fields lived at
  // the top level of `ChronoteSettings` and are now unified under
  // `ai.embeddingModel` / `ai.embeddingDim` (or, for everything
  // else, removed entirely — embeddings now use the chat provider's
  // key / URL via `ai.apiKey` / `ai.baseUrl`). `embeddingModel` is
  // copied into `ai.embeddingModel` as a one-time seed; the others
  // are dropped.
  "embeddingProvider",
  "embeddingBaseUrl",
  "embeddingApiKey",
  "embeddingDim",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort correction of common typos in the embedding base URL.
 *
 * Background: users hand-type local endpoints (`http://localhost:11434/v1`,
 * `http://127.0.0.1:1234/v1`) into a single text field. The most
 * common mistake — observed in the wild — is dropping the colon so
 * `localhost:11434` becomes `localhost11434`. The resulting URL is
 * syntactically valid, so the embedding provider happily tries to
 * connect to a host that does not exist, and the user sees an opaque
 * network error.
 *
 * @deprecated Embeddings now use the active chat provider's `ai.baseUrl`,
 * so this function is no longer called by `migrateSettings()`. Kept for
 * one release in case any external consumer imports it. Safe to delete
 * once the public API is reviewed.
 */
export function correctEmbeddingBaseUrl(raw: string): string {
  if (typeof raw !== "string") return raw;
  const original = raw;
  let url = raw.trim();
  if (!url) return url;

  // Step 1: insert a missing colon between `localhost` / `127.0.0.1`
  // and the port number. Matches `localhost<digits>` or
  // `127.0.0.1<digits>` directly followed by `/` or end-of-string.
  //   `localhost11434/v1` → `localhost:11434/v1`
  //   `127.0.0.11234`    → `127.0.0.1:1234`
  url = url.replace(
    /\b((?:localhost|127\.0\.0\.1))(\d{2,5})(?=\/|$)/,
    (_match, host: string, port: string) => `${host}:${port}`,
  );

  // Step 2: prepend `http://` for bare local hostnames that still
  // have no scheme after the above fix. We only do this for
  // unambiguous local addresses — a cloud URL like `api.openai.com/v1`
  // should stay alone (the user probably means HTTPS, but a wrong
  // default is worse than a visible Notice from the runtime).
  if (!/^https?:\/\//i.test(url)) {
    if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?/i.test(url)) {
      url = `http://${url}`;
    }
  }

  if (url !== original) {
    return url;
  }

  return url;
}

/**
 * Drop keys not present on the current `ChronoteSettings` schema and known
 * legacy subtrees. The result is a strict subset of the input keys plus
 * any defaults that are missing.
 *
 * Returned shape: a full `ChronoteSettings` with all fields populated.
 */
export function migrateSettings(raw: unknown): ChronoteSettings {
  const safeRaw: Record<string, unknown> = isPlainObject(raw) ? raw : {};

  // First, copy through any keys that exist on the current schema.
  const migrated: Record<string, unknown> = {};
  for (const key of Object.keys(safeRaw)) {
    if (key in DEFAULT_SETTINGS) {
      migrated[key] = safeRaw[key];
    }
  }

  // Migrate legacy top-level `geminiApiKey` / `geminiModel` into the new
  // `ai` subobject. We do this BEFORE the schema key-strip, so the
  // legacy values are still available at this point. Only copy if the
  // user has not already populated the new `ai` subobject (i.e. the
  // saved blob pre-dates the multi-provider refactor).
  if (
    typeof safeRaw.geminiApiKey === "string" ||
    typeof safeRaw.geminiModel === "string"
  ) {
    const aiRaw = isPlainObject(migrated.ai)
      ? (migrated.ai as Record<string, unknown>)
      : {};
    migrated.ai = {
      ...(DEFAULT_SETTINGS.ai as unknown as Record<string, unknown>),
      ...aiRaw,
      geminiApiKey:
        typeof safeRaw.geminiApiKey === "string"
          ? safeRaw.geminiApiKey
          : (aiRaw.geminiApiKey as string | undefined) ??
            (DEFAULT_SETTINGS.ai.geminiApiKey as string),
      geminiModel:
        typeof safeRaw.geminiModel === "string"
          ? safeRaw.geminiModel
          : (aiRaw.geminiModel as string | undefined) ??
            (DEFAULT_SETTINGS.ai.geminiModel as string),
    };
  }

  // One-time seed: pre-simplification users had a top-level
  // `embeddingModel: "nomic-embed-text"` (or similar) saved. Copy it
  // into `ai.embeddingModel` so the first reindex uses the right
  // model without forcing a settings-tab visit. Idempotent: a user
  // who already set `ai.embeddingModel` is not overwritten.
  if (
    typeof safeRaw.embeddingModel === "string" &&
    safeRaw.embeddingModel.length > 0
  ) {
    const aiRaw = isPlainObject(migrated.ai)
      ? (migrated.ai as Record<string, unknown>)
      : {};
    const existing = aiRaw.embeddingModel;
    if (typeof existing !== "string" || existing.length === 0) {
      migrated.ai = { ...aiRaw, embeddingModel: safeRaw.embeddingModel };
    } else {
      // Preserve the existing ai block (we may have just rebuilt it
      // for the gemini migration above).
      migrated.ai = { ...aiRaw };
    }
  }

  // Apply defaults for any field the user has not yet populated.
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in migrated)) {
      migrated[key] = defaultValue;
    }
  }

  // Apply defaults for any subkey the user has not yet populated
  // inside `ai`. Adding a new field to `AIProviderConfig` (e.g.
  // `responseStyle`) is otherwise a no-op for older vaults — the
  // top-level defaults loop only sees top-level keys, and the
  // per-subkey normalization blocks below only rebuild `ai` for the
  // specific subkey they're handling.
  if (isPlainObject(migrated.ai)) {
    const aiRaw = migrated.ai as Record<string, unknown>;
    const aiDefaults = DEFAULT_SETTINGS.ai as unknown as Record<string, unknown>;
    for (const [key, defaultValue] of Object.entries(aiDefaults)) {
      if (!(key in aiRaw)) {
        aiRaw[key] = defaultValue;
      }
    }
    migrated.ai = aiRaw;
  }

  // Normalize array fields.
  if (!Array.isArray(migrated.tests)) {
    migrated.tests = [];
  }

  // Defensively normalize ai.baseUrls (per-provider URL map for the
  // local / custom providers). If the field exists but is malformed
  // (not a plain object, contains non-string entries), strip the bad
  // entries rather than dropping the whole map. Then seed the active
  // provider's slot from the legacy ai.baseUrl (so a vault saved
  // before per-provider URLs existed still has the right value when
  // the user switches back) and pre-fill the documented defaults for
  // ollama / lmstudio / chronote_cloud.
  //
  // Build a fresh `ai` object so we don't mutate the caller's
  // `migrated.ai` (which is the same reference as `raw.ai` from the
  // copy-through step). The "preserves every field" test passes
  // `DEFAULT_SETTINGS` itself into `migrateSettings` and any in-place
  // edit here would leak into the module-level `DEFAULT_SETTINGS`
  // constant and break subsequent tests.
  if (isPlainObject(migrated.ai)) {
    const aiRaw = migrated.ai as Record<string, unknown>;
    const existing = isPlainObject(aiRaw.baseUrls)
      ? (aiRaw.baseUrls as Record<string, unknown>)
      : {};
    const map: Record<string, string> = {};
    for (const [provider, value] of Object.entries(existing)) {
      if (typeof value === "string" && value.length > 0) {
        map[provider] = value;
      }
    }
    // Seed the active provider from the legacy ai.baseUrl only if the
    // slot is empty — never clobber a value the user had already
    // saved into the map.
    if (
      typeof aiRaw.provider === "string" &&
      typeof aiRaw.baseUrl === "string" &&
      aiRaw.baseUrl.length > 0 &&
      !map[aiRaw.provider]
    ) {
      map[aiRaw.provider] = aiRaw.baseUrl;
    }
    // Pre-fill documented defaults for any local provider that
    // doesn't already have a value, so the very first visit to
    // a fresh install shows the right URL right away.
    for (const [provider, def] of Object.entries(DEFAULT_BASE_URL)) {
      if (!map[provider] && def) {
        map[provider] = def;
      }
    }
    // Keep `ai.baseUrl` in sync with the active provider's slot.
    // The settings tab also writes this on every switch, but doing
    // it here means the persisted blob is consistent on the very
    // first save after migration.
    const newBaseUrl =
      typeof aiRaw.provider === "string" && map[aiRaw.provider]
        ? map[aiRaw.provider]
        : aiRaw.baseUrl;
    migrated.ai = { ...aiRaw, baseUrls: map, baseUrl: newBaseUrl };
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

  return migrated as unknown as ChronoteSettings;
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

/**
 * Read just the `dim` field from the on-disk `CTX1` knowledge index
 * header (no chunk data). Returns `null` if the file is missing,
 * unreadable, malformed, or its header doesn't match the magic +
 * version bytes.
 *
 * Used at migration time so an existing pre-simplification index
 * (whose dim may not be 384) is not dropped by the dim-mismatch
 * check in `KnowledgeBase.loadFromDisk`. We don't decode the
 * matrix — only the 4-byte dim at offset 5. The function is
 * safe to call multiple times and never throws.
 *
 * CTX1 format (see `src/agent/vectorIndex/persistence.ts:39-90`):
 *   offset 0  size 4   magic "CTX1" (0x43 0x54 0x58 0x31)
 *   offset 4  size 1   version (0x01)
 *   offset 5  size 4   dim (uint32 little-endian)
 *   …
 */
export async function readChronoteIndexDim(
  app: App,
  pluginDataDir: string,
): Promise<number | null> {
  const path = `${pluginDataDir}/knowledge-index.bin`;
  try {
    const buf = new Uint8Array(await app.vault.adapter.readBinary(path));
    if (buf.byteLength < 9) return null;
    // Magic "CTX1"
    if (
      buf[0] !== 0x43 ||
      buf[1] !== 0x54 ||
      buf[2] !== 0x58 ||
      buf[3] !== 0x31
    ) {
      return null;
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getUint32(5, true);
  } catch {
    return null;
  }
}

/**
 * If the settings blob doesn't already carry an `ai.embeddingDim`,
 * and the on-disk `knowledge-index.bin` header decodes cleanly, seed
 * `ai.embeddingDim` from the file. This is the one shot a
 * pre-simplification user with a non-384-dim index has to keep
 * their persisted chunks — without it, `loadFromDisk` would see a
 * dim mismatch on the next start and silently drop the index.
 *
 * Idempotent: if `ai.embeddingDim` is already set (e.g. from a
 * subsequent migration), we leave it alone.
 */
export async function seedEmbeddingDimFromDisk(
  settings: ChronoteSettings,
  app: App,
  pluginDataDir: string,
): Promise<ChronoteSettings> {
  if (settings.ai.embeddingDim != null) return settings;
  const dim = await readChronoteIndexDim(app, pluginDataDir);
  if (dim == null) return settings;
  return {
    ...settings,
    ai: { ...settings.ai, embeddingDim: dim },
  };
}
