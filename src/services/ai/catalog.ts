/**
 * Curated model dropdowns for the AI provider settings UI.
 *
 * Each entry is `{ id, label }` where `id` is the exact model string
 * the provider expects and `label` is what the user sees.
 *
 * Keep this in sync with the active models on each provider's docs:
 *   - Gemini:     https://ai.google.dev/gemini-api/docs/models
 *   - OpenAI:     https://platform.openai.com/docs/models
 *   - Anthropic:  https://platform.claude.com/docs/en/about-claude/models/overview
 *
 * For local / custom providers (Ollama, LM Studio, Custom) the
 * settings UI uses free-text input — these lists are *suggestions*
 * shown as datalist hints only, not a hard dropdown.
 */
import type { AIProvider, ResponseStyle } from "../../settingsTypes";

export interface ModelOption {
  id: string;
  label: string;
  /** True if the model will be removed soon. Settings UI shows a badge. */
  deprecated?: boolean;
}

export const PROVIDER_CATALOG: Record<AIProvider, ModelOption[]> = {
  cortex_cloud: [
    // The user does NOT pick a model for Cortex Cloud — the proxy
    // chooses the best price/perf model on Ollama Cloud and routes
    // accordingly. The empty list is intentional; the settings UI
    // shows no model dropdown for this provider.
  ],
  gemini: [
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash", label: "Gemini 3 Flash (preview)" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
  ],
  openai: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-pro", label: "GPT-5.4 Pro" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano" },
  ],
  anthropic: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  ollama: [
    { id: "llama3.3", label: "llama3.3" },
    { id: "qwen3", label: "qwen3" },
    { id: "qwen2.5", label: "qwen2.5" },
    { id: "gemma3", label: "gemma3" },
    { id: "mistral", label: "mistral" },
    { id: "codellama", label: "codellama" },
    { id: "phi-4", label: "phi-4" },
    { id: "deepseek-r1", label: "deepseek-r1" },
  ],
  lmstudio: [
    // LM Studio models are user-defined — we don't ship a curated list
    // because we can't know which GGUF the user has loaded. The UI
    // uses a free-text input with a "Load models" button that hits
    // GET /v1/models.
  ],
  custom: [
    // Custom is also free-text. The catalog stays empty; the settings
    // UI shows an empty datalist and accepts any string.
  ],
};

/** Human-readable provider names used in the settings UI. */
export const PROVIDER_LABELS: Record<AIProvider, string> = {
  cortex_cloud: "Cortex Cloud",
  gemini: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  custom: "Custom (OpenAI-compatible)",
};

/** Fixed base URL for the managed Cortex Cloud proxy. */
export const CORTEX_CLOUD_BASE_URL = "https://cortex-proxy.vercel.app/v1";

/** Sensible default base URL for OpenAI-compat local providers. */
export const DEFAULT_BASE_URL: Partial<Record<AIProvider, string>> = {
  ollama: "http://localhost:11434/v1",
  // LM Studio's own docs point at 127.0.0.1 (localhost doesn't resolve on
  // some hosts). The fetcher normalizes missing /v1 suffixes.
  lmstudio: "http://127.0.0.1:1234/v1",
  cortex_cloud: CORTEX_CLOUD_BASE_URL,
};

/** Per-provider placeholder for the model field when nothing is configured. */
export const MODEL_PLACEHOLDER: Record<AIProvider, string> = {
  cortex_cloud: "(model picked by Cortex Cloud)",
  gemini: "e.g., gemini-3.5-flash",
  openai: "e.g., gpt-5.4-mini",
  anthropic: "e.g., claude-sonnet-4-6",
  ollama: "e.g., llama3.3",
  lmstudio: "model identifier from LM Studio",
  custom: "e.g., openai/gpt-4o-mini",
};

/** Per-provider placeholder for the base URL field (only used for local / custom). */
export const BASE_URL_PLACEHOLDER: Partial<Record<AIProvider, string>> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  custom: "https://openrouter.ai/api/v1",
};

/**
 * Default embedding model per provider. Cortex derives the embedding
 * model from the active provider — there is no embedding-model field
 * in the settings UI anymore. (`ai.embeddingModel` survives as an
 * optional override that power users can set by editing data.json.)
 *
 * Omitted on purpose:
 *   - `anthropic` — no embedding endpoint at all.
 *   - `custom` — an arbitrary OpenAI-compatible server has no knowable
 *     default, so we send the request model-less and let it pick.
 */
export const DEFAULT_EMBEDDING_MODEL: Partial<Record<AIProvider, string>> = {
  // `text-embedding-004` was retired on the Gemini Developer API
  // (v1beta returns 404 NOT_FOUND for it). `gemini-embedding-001` is
  // the current stable text-embedding model and supports the
  // `:batchEmbedContents` endpoint this adapter calls.
  gemini: "gemini-embedding-001",
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  lmstudio: "nomic-embed-text",
  cortex_cloud: "nomic-embed-text",
};

/**
 * Providers whose embedding model the user genuinely hand-picks (local
 * servers and OpenAI-compatible custom endpoints). For these, the
 * `ai.embeddingModel` override is honored.
 *
 * Hosted providers (gemini, openai) are deliberately excluded: each
 * exposes a single canonical embedding family whose id uses
 * provider-specific syntax. `ai.embeddingModel` is a *global* field, so
 * a value the user set for one provider (e.g. Ollama's
 * `nomic-embed-text:latest`) would otherwise leak into a hosted
 * provider's request and 404 (`models/nomic-embed-text:latest is not
 * found for API version v1beta`). Hosted providers always use their
 * per-provider default instead.
 */
const EMBEDDING_OVERRIDE_PROVIDERS: ReadonlySet<AIProvider> = new Set([
  "ollama",
  "lmstudio",
  "custom",
]);

/**
 * Resolve the embedding model id for a provider. For local / custom
 * providers an explicit `ai.embeddingModel` override (kept for power
 * users) wins; otherwise the per-provider default. Hosted providers
 * ignore the global override and always use their default. Returns `""`
 * when neither exists (custom / anthropic) so the adapter can omit the
 * model field from the request.
 */
export function resolveEmbeddingModel(
  provider: AIProvider,
  embeddingModel: string,
): string {
  const explicit = (embeddingModel ?? "").trim();
  if (explicit && EMBEDDING_OVERRIDE_PROVIDERS.has(provider)) return explicit;
  return DEFAULT_EMBEDDING_MODEL[provider] ?? "";
}

/**
 * Returns the set of fields the user must fill in for the provider to
 * be considered "configured". Used by the chat modal to decide whether
 * to surface the "set up AI" error before sending a request.
 */
export function providerMissingFields(
  provider: AIProvider,
  config: {
    cortexAccountId: string;
    geminiApiKey: string;
    geminiModel: string;
    apiKey: string;
    model: string;
    baseUrl: string;
  },
): string[] {
  switch (provider) {
    case "cortex_cloud":
      return config.cortexAccountId ? [] : ["Cortex account id"];
    case "gemini":
      return [
        ...(config.geminiApiKey ? [] : ["Gemini API key"]),
        ...(config.geminiModel ? [] : ["Gemini model"]),
      ];
    case "openai":
      return [
        ...(config.apiKey ? [] : ["OpenAI API key"]),
        ...(config.model ? [] : ["OpenAI model"]),
      ];
    case "anthropic":
      return [
        ...(config.apiKey ? [] : ["Anthropic API key"]),
        ...(config.model ? [] : ["Anthropic model"]),
      ];
    case "ollama":
    case "lmstudio":
      return [
        ...(config.baseUrl ? [] : ["Base URL"]),
        ...(config.model ? [] : ["Model"]),
      ];
    case "custom":
      // apiKey is always optional for Custom: built-in presets
      // include keyless local servers (vLLM, llama.cpp server), and
      // the user is free to leave the field blank. The OpenAI-compat
      // adapter omits the Authorization header when apiKey is empty,
      // so an unset key is wired through correctly.
      return [
        ...(config.baseUrl ? [] : ["Base URL"]),
        ...(config.model ? [] : ["Model"]),
      ];
  }
}

/**
 * Returns the set of fields the user must fill in *for embedding* —
 * a subset of the chat-side gating. Used by `runIndex()` to surface a
 * clear "Anthropic has no embedding endpoint" notice *before* the
 * reindex loop starts (so the user sees the actionable message rather
 * than an upstream "model not found" 404 deep inside the loop).
 *
 * The embedding model itself is no longer a required field: every
 * provider except Anthropic has a sensible default (see
 * `DEFAULT_EMBEDDING_MODEL`), and `custom` is allowed to send the
 * request model-less. So the only hard blocker here is Anthropic,
 * which has no embedding endpoint at all.
 *
 * The second parameter is retained for call-site/signature stability
 * (and a potential future per-provider check); it is currently unused.
 */
export function embeddingMissingFields(
  provider: AIProvider,
  _embeddingModel?: string,
): string[] {
  if (provider === "anthropic") {
    return ["Anthropic has no embedding endpoint"];
  }
  return [];
}

/**
 * Curated system-prompt style fragments — provider-agnostic.
 *
 * Each entry is the voice paragraph the chat layer splices into the
 * system prompt, layered on top of the unchanged hard rules
 * (don't invent, cite wikilinks, knowledge-index awareness). The
 * `id` matches `ResponseStyle` and the `label` is what the user
 * sees in the settings dropdown. `description` is the short
 * hover-text shown in the setting's subtitle.
 *
 * To add a new style: extend the `ResponseStyle` union in
 * `settingsTypes.ts`, add a `DEFAULT_SETTINGS.ai.responseStyle`
 * fallback, then add an entry here. The migration auto-fills
 * missing keys from defaults, so no migration code change is
 * required.
 *
 * Why not just a custom-text box? A free-text style field would
 * let users shoot themselves in the foot — vague instructions
 * like "be helpful" degrade model voice, and any conflict with
 * the hard rules would silently win the prompt. Curated fragments
 * are short, tested, and have a known interaction with the rest
 * of the prompt.
 */
export interface ResponseStyleEntry {
  id: ResponseStyle;
  /** What the user sees in the dropdown. */
  label: string;
  /** Hover-text in the setting row. */
  description: string;
  /**
   * The voice paragraph. Concise enough to keep the system
   * prompt under 1k tokens; not so short that models collapse
   * back to a generic "I'm a helpful assistant" tone.
   */
  fragment: string;
}

export const RESPONSE_STYLES: readonly ResponseStyleEntry[] = [
  {
    id: "concise",
    label: "Concise (default)",
    description:
      "Compact, no-frills replies. Shortest complete answer; lists only when content is genuinely list-shaped.",
    fragment:
      "Be concise. Default to the shortest complete answer. No preamble, no recap, no 'Here's what I'll do'. " +
      "If the answer fits in one sentence, give one sentence. Use lists only when the content is genuinely list-shaped. " +
      "Skip throat-clearing ('Sure!', 'Of course, ...') and skip the recap at the end — the answer is the answer.",
  },
  {
    id: "friendly",
    label: "Friendly",
    description:
      "Warm, a little playful, like a knowledgeable friend helping you study. Stays focused, no emoji spam.",
    fragment:
      "Be warm and a little playful. Talk like a knowledgeable friend who's genuinely glad to help — contractions are fine, " +
      "occasional lightness is fine, but stay focused on the actual task. No sycophancy ('Great question!'), no emoji spam, " +
      "no over-explaining. A smile in the prose, not a performance.",
  },
  {
    id: "motivational",
    label: "Motivational",
    description:
      "Coaching tone. Holds you to a high standard, celebrates progress, ends with one concrete next step.",
    fragment:
      "Be a coach, not a cheerleader. Hold the user to a high standard without lecturing. " +
      "Name what they're avoiding when it's relevant, celebrate concrete progress when it's real, and end plans and answers " +
      "with one specific next step the user can take in the next five minutes. Direct, not preachy.",
  },
  {
    id: "formal",
    label: "Formal",
    description:
      "Precise, professional, structured. Full sentences, no contractions, no slang.",
    fragment:
      "Be formal and precise. Full sentences, no contractions, no slang, no first-person filler ('I think', 'I feel'). " +
      "Use clear structure (headings, numbered steps) when the content warrants it. Match the seriousness of a professional " +
      "study coach, not a textbook. Skip jokes unless the user opens with one.",
  },
];

/**
 * Look up a style entry by id. Falls back to `concise` if the
 * stored id is unknown (e.g. a future style was removed) — never
 * throws, never returns undefined. Used by the chat layer so a
 * stale settings blob can't crash a chat turn.
 */
export function getResponseStyle(id: string | undefined | null): ResponseStyleEntry {
  if (id) {
    const match = RESPONSE_STYLES.find((s) => s.id === id);
    if (match) return match;
  }
  // RESPONSE_STYLES is hard-coded and always has a "concise" entry,
  // so this lookup is safe.
  return RESPONSE_STYLES.find((s) => s.id === "concise")!;
}
