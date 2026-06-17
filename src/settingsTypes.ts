/**
 * Pure-data settings types. No runtime imports from obsidian or any
 * plugin module so this file is trivially testable in Node.
 *
 * `settings.ts` re-exports these and adds the Obsidian-coupled setting
 * tab UI. Keep this file dependency-free.
 */
import type { FlashcardProposal } from "./agent/tools/flashcards.js";
import type { QuizProposal } from "./agent/tools/quizzes.js";

export interface ChronoteTest {
  id: string;
  name: string;
  date: string; // ISO date string
  filePaths: string[];
  done?: boolean;
}

/** Attachments saved alongside an assistant chat turn. */
export interface PersistedChatAttachments {
  flashcards?: FlashcardProposal[];
  quizzes?: QuizProposal[];
}

/** One chat turn as persisted to plugin data. */
export interface PersistedChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Interactive attachments generated during this turn (flashcards, quizzes). */
  attachments?: PersistedChatAttachments;
}

// ── AI provider types ─────────────────────────────────────────────

/**
 * The seven supported AI providers. Adding a new provider means:
 *   1. extend this union
 *   2. add a case to `createAdapter()` in `src/services/ai/index.ts`
 *   3. add a UI sub-section in `src/settings.ts`
 *   4. add a curated model list in `PROVIDER_CATALOG` (services/ai/catalog.ts)
 *
 * `chronote_cloud` is the managed proxy: users paste an `acct_…` id
 * from the billing flow and the proxy picks the model. There is no
 * model dropdown and no API key — just the account id.
 */
export type AIProvider =
  | "chronote_cloud"
  | "gemini"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio"
  | "custom";

/**
 * AI response style — a provider-agnostic persona preset that
 * modifies ONLY the system prompt's voice paragraph. Each id maps
 * to a curated tone fragment in `RESPONSE_STYLES` (services/ai/catalog.ts);
 * adding a new style means adding an entry there and extending this
 * union.
 *
 * The active style is applied to both the general chat prompt and
 * the study-planner prompt. The hard rules (don't invent, cite
 * wikilinks, knowledge-index awareness) stay identical across styles.
 */
export type ResponseStyle = "concise" | "friendly" | "motivational" | "formal";

/**
 * Provider-agnostic AI configuration. All fields are kept on a single
 * flat object (rather than per-provider sub-objects) so users can
 * pre-fill credentials for several providers and switch between them
 * without losing anything. Fields unused by the active provider are
 * simply ignored.
 */
export interface AIProviderConfig {
  /** Active provider. */
  provider: AIProvider;

  // Chronote Cloud — managed proxy. User pastes the account id they
  // get from the proxy's sign-up flow; no model field is exposed.
  chronoteAccountId: string;

  // Gemini — kept separate so we don't disturb the (already-shipping)
  // settings keys that may live in user vaults.
  geminiApiKey: string;
  geminiModel: string;

  // OpenAI / Anthropic / Custom
  apiKey: string;
  model: string;

  // Local + Custom — OpenAI-compatible base URL.
  //   ollama:   "http://localhost:11434/v1"
  //   lmstudio: "http://127.0.0.1:1234/v1"
  //   custom:   user-supplied, e.g. "https://openrouter.ai/api/v1"
  baseUrl: string;

  /**
   * Per-provider base URL. `ai.baseUrl` is the URL for the *active*
   * provider and stays the single field the rest of the runtime reads
   * (adapters, embedding factory, chat modal). The settings tab keeps
   * this map in sync so switching between Ollama / LM Studio / Custom
   * (or any local pair) round-trips each provider's URL across
   * Obsidian restarts — not just within a single settings-tab session.
   *
   * Why a map and not just one shared `baseUrl`? The user wants to
   * flip between two local servers and have both URLs preserved. The
   * in-memory cache we had before reset on every plugin reload, so
   * the user had to re-visit each provider after a restart to
   * repopulate it.
   */
  baseUrls: Partial<Record<AIProvider, string>>;

  /**
   * Embedding model id. Per-provider defaults are surfaced in the
   * settings tab as placeholders. The active provider's embedding
   * model is what `runIndex()` / `KnowledgeBase.reindexVault()`
   * send to the embed endpoint.
   *
   * - gemini: "gemini-embedding-001"
   * - openai: "text-embedding-3-small"
   * - ollama: "nomic-embed-text"
   * - lmstudio / custom: free-text (server picks if empty)
   * - anthropic: unused (the adapter has no embed endpoint)
   * - chronote_cloud: empty (the proxy picks)
   */
  embeddingModel: string;

  /**
   * Embedding dimension override. Most users leave this unset
   * (`null`) — the embedder autodetects on the first response.
   *
   * @internal Set by `migrateSettings()` from the on-disk
   * `knowledge-index.bin` header (the `CTX1` format stores dim
   * right after the magic + version). One-time seed; never read or
   * written by the UI. Exists solely to prevent the dim-mismatch
   * check in `KnowledgeBase.loadFromDisk` from dropping an existing
   * pre-simplification index whose dim is not 384.
   */
  embeddingDim: number | null;

  /** Attach the calendar tool declarations to chat requests. */
  enableCalendarTools: boolean;

  /**
   * Active response-style preset. The fragment is spliced into the
   * system prompt at chat time — see `RESPONSE_STYLES` in
   * `services/ai/catalog.ts` for the available tones. Provider-agnostic.
   */
  responseStyle: ResponseStyle;

  /**
   * Maximum number of tool-call rounds the chat loop will run before
   * forcing a final answer. Each round is one model turn that may
   * request tools; the loop executes them and calls the model again.
   * Larger / hosted models converge in 1–3 rounds, but small local
   * models (Ollama, LM Studio) sometimes loop — re-calling tools or
   * never deciding they're done. When this budget is exhausted the
   * loop asks the model once more with tools disabled, so the user
   * gets an answer instead of an error. Provider-agnostic.
   */
  maxToolRounds: number;
}

export interface ChronoteSettings {
  ai: AIProviderConfig;
  planningPreferences: string;
  timeZone: string;
  googleAccessToken: string;
  googleRefreshToken: string;
  googleTokenExpiry: number;
  tests: ChronoteTest[];
  wakeUpTime: string;
  bedTime: string;
  dailyLimitMax: number | null;
  maxReviewIntervalDays: number | null;

  // ── Legacy / migration-only fields ──────────────────────────────
  // `migrateSettings()` reads these and copies them into `ai` on
  // first load, then strips them on the next save. They are NEVER
  // read at runtime — only during migration.
  /** @deprecated use `ai.geminiApiKey` */
  geminiApiKey?: string;
  /** @deprecated use `ai.geminiModel` */
  geminiModel?: string;

  // ── AI knowledge index ─────────────────────────────────────────
  /**
   * Where flashcard markdown notes are saved. Empty string means
   * vault root. The path is created on first save if it doesn't
   * exist. The file name pattern is `Flashcards - <TestName>.md`.
   */
  flashcardFolder: string;

  /**
   * Persisted chat history. Kept in plugin data so the chat modal
   * can restore the conversation after it is closed or after a
   * reload. Trimmed to a bounded number of turns at runtime.
   */
  chatHistory: PersistedChatMessage[];

  /**
   * How often the vault index should be rebuilt automatically.
   * "manual" means indexing only happens when the user clicks the
   * "Index vault" button or runs the command. "daily" / "weekly"
   * trigger a background reindex once the elapsed time since the
   * last index exceeds the interval.
   */
  autoIndexInterval: "manual" | "daily" | "weekly";
}

export const DEFAULT_SETTINGS: ChronoteSettings = {
  ai: {
    provider: "chronote_cloud",
    chronoteAccountId: "",
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash",
    apiKey: "",
    model: "",
    baseUrl: "",
    baseUrls: {},
    embeddingModel: "",
    embeddingDim: null,
    enableCalendarTools: true,
    responseStyle: "concise",
    maxToolRounds: 20,
  },
  planningPreferences: "",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  googleAccessToken: "",
  googleRefreshToken: "",
  googleTokenExpiry: 0,
  tests: [],
  wakeUpTime: "07:00",
  bedTime: "23:00",
  dailyLimitMax: null,
  maxReviewIntervalDays: null,
  flashcardFolder: "",
  autoIndexInterval: "manual",
  chatHistory: [],
};
