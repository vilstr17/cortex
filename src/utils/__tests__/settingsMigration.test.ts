import { describe, it, expect } from "vitest";
import {
  migrateSettings,
  detectObsoleteKeys,
  correctEmbeddingBaseUrl,
} from "../settingsMigration.js";
import { DEFAULT_SETTINGS } from "../../settingsTypes.js";

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
    expect(out.ai.geminiApiKey).toBe("");
    expect(out.timeZone).toBe(DEFAULT_SETTINGS.timeZone);
  });

  it("fills the response-style default for an older vault", () => {
    // Vaults saved before the response-style field existed have no
    // `ai.responseStyle` key. Migration must fill it from
    // DEFAULT_SETTINGS so the chat layer never sees an undefined value
    // (the chat layer's defensive `getResponseStyle()` would fall back
    // to "concise" anyway, but filling the default here means the
    // settings tab shows the right value on first visit).
    //
    // We construct a raw `ai` object WITHOUT a responseStyle key —
    // mirroring the shape an older save would have. The default-fill
    // step in migrateSettings runs over the result, and the default
    // (currently "concise") is what the user sees.
    const aiWithoutStyle = { ...DEFAULT_SETTINGS.ai };
    delete (aiWithoutStyle as Record<string, unknown>).responseStyle;
    const raw = {
      ...DEFAULT_SETTINGS,
      ai: aiWithoutStyle,
    };
    const out = migrateSettings(raw);
    expect(out.ai.responseStyle).toBe("concise");
  });

  it("preserves a user-set response-style value", () => {
    // The user picked "formal" in the settings tab. Round-tripping
    // the saved blob through migrateSettings must keep the value —
    // the copy-through step in migrateSettings must not silently
    // overwrite it with the default.
    const raw = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        responseStyle: "formal",
      },
    };
    const out = migrateSettings(raw);
    expect(out.ai.responseStyle).toBe("formal");
  });

  it("seeds ai.baseUrls from the legacy ai.baseUrl and DEFAULT_BASE_URL on upgrade", () => {
    // A vault saved before the per-provider baseUrls map was added
    // has a single shared ai.baseUrl. Migration must:
    //   1. copy that value into baseUrls[ai.provider] (so the
    //      round-trip across provider switches keeps the user's URL).
    //   2. pre-fill documented defaults for the other local providers
    //      so a fresh visit to e.g. LM Studio shows the right URL
    //      immediately.
    const raw = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "ollama" as const,
        baseUrl: "http://my-ollama:11434/v1",
      },
    };
    const out = migrateSettings(raw);
    expect(out.ai.baseUrls.ollama).toBe("http://my-ollama:11434/v1");
    expect(out.ai.baseUrls.lmstudio).toBe("http://127.0.0.1:1234/v1");
    // cortex_cloud always has a fixed base URL; included for
    // completeness so the map is fully populated after migration.
    expect(out.ai.baseUrls.cortex_cloud).toMatch(/^https:\/\/cortex-proxy/);
    // Custom has no documented default — slot stays empty so the
    // settings tab shows an empty field the first time the user
    // visits it.
    expect(out.ai.baseUrls.custom).toBeUndefined();
    // ai.baseUrl is kept in sync with the active provider's slot so
    // the runtime (adapters, embedding factory) keeps reading the
    // same value.
    expect(out.ai.baseUrl).toBe("http://my-ollama:11434/v1");
  });

  it("preserves a user-set baseUrls value over the legacy ai.baseUrl seed", () => {
    // If the user already has a per-provider URL saved (e.g. they
    // switched providers in a prior version of the plugin and the
    // settings tab wrote into the map), the migration must NOT
    // clobber that value with the legacy ai.baseUrl.
    const raw = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "ollama" as const,
        baseUrl: "http://stale-ollama:11434/v1",
        baseUrls: { ollama: "http://fresh-ollama:11434/v1" },
      },
    };
    const out = migrateSettings(raw);
    expect(out.ai.baseUrls.ollama).toBe("http://fresh-ollama:11434/v1");
  });

  it("drops non-string entries from ai.baseUrls", () => {
    // Defensive: if a corrupted vault saved numbers, booleans, or
    // nulls into the map, drop them. The settings tab assumes every
    // slot is a string and would render a broken placeholder
    // otherwise. After the drops, the seeding loop back-fills the
    // missing documented defaults.
    const raw = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        baseUrls: {
          ollama: "http://x:11434/v1", // keep
          lmstudio: 1234, // drop → back-filled from DEFAULT_BASE_URL
          custom: null, // drop → no documented default, stays undefined
          cortex_cloud: "", // drop (empty string) → back-filled
          gemini: "valid-but-not-a-local-provider", // keep — schema doesn't restrict
        },
      },
    };
    const out = migrateSettings(raw);
    expect(out.ai.baseUrls.ollama).toBe("http://x:11434/v1");
    // lmstudio's malformed entry is dropped, then the seeding loop
    // re-populates the slot with DEFAULT_BASE_URL.
    expect(out.ai.baseUrls.lmstudio).toBe("http://127.0.0.1:1234/v1");
    // Custom has no documented default; the slot stays unset so the
    // settings tab shows an empty field the first time the user visits.
    expect(out.ai.baseUrls.custom).toBeUndefined();
    expect(out.ai.baseUrls.cortex_cloud).toMatch(/^https:\/\/cortex-proxy/);
  });

  it("resets a non-object ai.baseUrls to a clean seeded map", () => {
    // Defensive: if the field is somehow a string / number / array
    // (e.g. hand-edited data.json), the migration resets it to an
    // object seeded from defaults.
    const raw = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "ollama" as const,
        baseUrls: "not-an-object" as unknown as Record<string, string>,
      },
    };
    const out = migrateSettings(raw);
    expect(typeof out.ai.baseUrls).toBe("object");
    // The seeding loop writes DEFAULT_BASE_URL entries, so ollama
    // and lmstudio must both be present after migration.
    expect(out.ai.baseUrls.ollama).toBe("http://localhost:11434/v1");
    expect(out.ai.baseUrls.lmstudio).toBe("http://127.0.0.1:1234/v1");
  });

  it("migrates legacy top-level geminiApiKey into ai.geminiApiKey", () => {
    const raw = {
      geminiApiKey: "AIza-LEGACY-KEY",
      geminiModel: "gemini-2.5-pro",
    };
    const out = migrateSettings(raw);
    expect(out.ai.geminiApiKey).toBe("AIza-LEGACY-KEY");
    expect(out.ai.geminiModel).toBe("gemini-2.5-pro");
    // Legacy top-level keys must be stripped from the result
    expect((out as unknown as Record<string, unknown>).geminiApiKey).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).geminiModel).toBeUndefined();
  });

  it("round-trips a legacy 'gemini' embedding provider choice", () => {
    // Pre-rewrite vaults stored `embeddingProvider: "gemini"`. The
    // rewrite added "api" to the union and surfaces only "local"
    // and "api" in the UI, but the literal is still accepted and
    // routed correctly by the factory. Migration must not clobber
    // the stored value — silent provider switches would break
    // working indexes.
    //
    // After the embedding-simplification rewrite, the top-level
    // `embeddingProvider` key is in OBSOLETE_TOP_LEVEL_KEYS and is
    // dropped. The model id is still seeded into `ai.embeddingModel`
    // so the user doesn't have to re-type it.
    const raw = {
      ...DEFAULT_SETTINGS,
      embeddingProvider: "gemini",
      embeddingModel: "text-embedding-004",
    };
    const out = migrateSettings(raw);
    expect((out as unknown as Record<string, unknown>).embeddingProvider).toBeUndefined();
    expect(out.ai.embeddingModel).toBe("text-embedding-004");
  });

  it("drops the legacy embeddingBaseUrl / embeddingApiKey / embeddingDim", () => {
    // These three keys are no longer in the schema. They must be
    // stripped from the persisted blob to keep data.json clean
    // (and to remove any old API keys that are no longer
    // referenced). The on-disk `knowledge-index.bin` is left alone
    // — the migration reads its CTX1 header separately.
    const raw = {
      ...DEFAULT_SETTINGS,
      embeddingBaseUrl: "http://localhost:11434/v1",
      embeddingApiKey: "sk-LEAKED",
      embeddingDim: 768,
    };
    const out = migrateSettings(raw) as unknown as Record<string, unknown>;
    expect(out.embeddingBaseUrl).toBeUndefined();
    expect(out.embeddingApiKey).toBeUndefined();
    expect(out.embeddingDim).toBeUndefined();
  });

  it("seeds ai.embeddingModel from the legacy top-level embeddingModel", () => {
    // A pre-simplification user with `embeddingModel: "nomic-embed-text"`
    // must not have to re-type it. Migration copies the value into
    // `ai.embeddingModel` if the latter is missing or empty.
    const raw = {
      ...DEFAULT_SETTINGS,
      embeddingModel: "nomic-embed-text",
    };
    const out = migrateSettings(raw);
    expect(out.ai.embeddingModel).toBe("nomic-embed-text");
  });

  it("does not overwrite an existing ai.embeddingModel on upgrade", () => {
    // Idempotent: a user who already set ai.embeddingModel must
    // not have it replaced by a stale legacy top-level value.
    const raw = {
      ...DEFAULT_SETTINGS,
      embeddingModel: "nomic-embed-text",
      ai: { ...DEFAULT_SETTINGS.ai, embeddingModel: "text-embedding-3-small" },
    };
    const out = migrateSettings(raw);
    expect(out.ai.embeddingModel).toBe("text-embedding-3-small");
  });

  it("preserves user-set ai values when migrating legacy fields", () => {
    // Hypothetical: user has a fresh `ai` subobject AND legacy top-level
    // fields. The new values must win.
    const raw = {
      geminiApiKey: "AIza-LEGACY",
      geminiModel: "gemini-2.5-pro",
      ai: {
        provider: "openai",
        geminiApiKey: "",
        geminiModel: "gemini-2.5-flash",
        apiKey: "sk-NEW",
        model: "gpt-4o-mini",
        baseUrl: "",
        enableCalendarTools: true,
      },
    };
    const out = migrateSettings(raw);
    expect(out.ai.provider).toBe("openai");
    expect(out.ai.apiKey).toBe("sk-NEW");
    expect(out.ai.model).toBe("gpt-4o-mini");
    // Legacy fields still get copied in for Gemini fallback
    expect(out.ai.geminiApiKey).toBe("AIza-LEGACY");
    expect(out.ai.geminiModel).toBe("gemini-2.5-pro");
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

  it("normalizes a non-array tests field to an empty array", () => {
    const out = migrateSettings({ tests: "not-an-array" });
    expect(out.tests).toEqual([]);
  });

  it("defaults chatHistory to an empty array for older vaults", () => {
    const raw = { ...DEFAULT_SETTINGS };
    delete (raw as Record<string, unknown>).chatHistory;
    const out = migrateSettings(raw);
    expect(out.chatHistory).toEqual([]);
  });

  it("tolerates null input", () => {
    const out = migrateSettings(null);
    expect(out.tests).toEqual([]);
    expect(out.ai.geminiApiKey).toBe("");
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
      geminiApiKey: "x",
      geminiModel: "x",
    };
    expect(detectObsoleteKeys(raw).sort()).toEqual(
      [
        "bleMacAddress",
        "geminiApiKey",
        "geminiModel",
        "googleClientId",
        "googleClientSecret",
        "mealTimes",
      ].sort(),
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

describe("correctEmbeddingBaseUrl", () => {
  // Kept for one release as a public re-export in case external
  // consumers import it. The function is no longer called by
  // migrateSettings (embeddings use the active chat provider's
  // ai.baseUrl now) — these tests stay so the helper doesn't
  // regress during the deprecation window.
  it("inserts a missing colon after localhost", () => {
    expect(correctEmbeddingBaseUrl("http://localhost11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("inserts a missing colon after 127.0.0.1", () => {
    expect(correctEmbeddingBaseUrl("http://127.0.0.11234")).toBe(
      "http://127.0.0.1:1234",
    );
  });

  it("prepends http:// to a bare local hostname", () => {
    expect(correctEmbeddingBaseUrl("localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("leaves a cloud URL with a scheme untouched", () => {
    expect(correctEmbeddingBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("tolerates non-string input without throwing", () => {
    expect(correctEmbeddingBaseUrl(undefined as unknown as string)).toBe(
      undefined,
    );
    expect(correctEmbeddingBaseUrl(null as unknown as string)).toBe(null);
  });
});

// Removed: the "embedding base URL typo correction" describe block.
// Migration no longer calls correctEmbeddingBaseUrl — the top-level
// `embeddingBaseUrl` field was deleted in the simplification, and the
// typo fix is now served by the active chat provider's URL field.

