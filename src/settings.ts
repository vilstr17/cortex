import { App, FuzzySuggestModal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { requestUrl } from "obsidian";
import ChronotePlugin from "./main.js";

// Re-export the pure data types from the dependency-free module so tests
// and other non-Obsidian code paths can import them without pulling in
// the full plugin runtime.
export type {
  AIProvider,
  AIProviderConfig,
  ChronoteTest,
  ChronoteSettings,
  ResponseStyle,
} from "./settingsTypes.js";
export { DEFAULT_SETTINGS } from "./settingsTypes.js";
import type { AIProvider, AIProviderConfig, ChronoteSettings, ResponseStyle } from "./settingsTypes.js";
import { formatRelative } from "./utils/formatRelative.js";

import { DEFAULT_SETTINGS } from "./settingsTypes.js";
import {
  PROVIDER_CATALOG,
  PROVIDER_LABELS,
  DEFAULT_BASE_URL,
  MODEL_PLACEHOLDER,
  BASE_URL_PLACEHOLDER,
  providerMissingFields,
  RESPONSE_STYLES,
} from "./services/ai/catalog.js";
import { listLocalModels } from "./services/ai/listLocalModels.js";

export class ChronoteSettingTab extends PluginSettingTab {
  plugin: ChronotePlugin;

  /**
   * Cache of models fetched from local AI servers. Persisted across
   * re-renders so the user doesn't have to click "Load models" every
   * time they reopen the settings tab. Keyed by provider id; resets
   * when the plugin reloads.
   */
  private localModelsCache: Record<string, string[]> = {
    ollama: [],
    lmstudio: [],
  };

  constructor(app: App, plugin: ChronotePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "All review data is stored locally in each note's YAML frontmatter (confidence, interval, next_review).",
    });

    new Setting(containerEl).setName("AI Provider").setHeading();
    containerEl.createEl("p", {
      text: "Pick a provider and supply credentials. Local providers (Ollama, LM Studio) run on your machine; the others call out to a hosted API. Only the fields for the active provider are used.",
    });

    // Important: embeddings are provider-specific, so the index must be rebuilt.
    containerEl.createEl("div", {
      cls: "chronote-provider-warning",
      text: "Important: each provider uses a different embedding model and index format. After switching providers, open the Dashboard and click Reindex vault. We recommend sticking with one provider to avoid rebuilding your index.",
    });

    // Primary provider dropdown
    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Switching providers does not clear the others' credentials — you can flip back without re-entering anything.")
      .addDropdown((dropdown) => {
        for (const p of Object.keys(PROVIDER_LABELS) as AIProvider[]) {
          dropdown.addOption(p, PROVIDER_LABELS[p]);
        }
        dropdown.setValue(this.plugin.settings.ai.provider);
        dropdown.onChange(async (value) => {
          const provider = value as AIProvider;
          const prevProvider = this.plugin.settings.ai.provider;
          const ai = this.plugin.settings.ai;
          // Stash the URL for the provider we're leaving into the
          // persisted per-provider map (not gated on DEFAULT_BASE_URL
          // — Custom needs to be cached too). The active provider's
          // URL always lives in `ai.baseUrl`; the map is just
          // storage for the other providers so a round-trip
          // Ollama → LM Studio → Ollama restores the typed URL.
          if (ai.baseUrl) {
            ai.baseUrls = { ...ai.baseUrls, [prevProvider]: ai.baseUrl };
          }
          // Load the new provider's URL: prefer the persisted
          // per-provider value, fall back to the documented default,
          // and finally to an empty string for providers with no
          // default (Custom without a saved URL).
          const next =
            ai.baseUrls[provider] ?? DEFAULT_BASE_URL[provider] ?? "";
          ai.baseUrl = next;
          // Same idea for the fetched-model list — clear the saved
          // model id when switching between two local providers so
          // the new dropdown doesn't show a stale id from the old
          // server.
          if (
            prevProvider !== provider &&
            (prevProvider === "ollama" || prevProvider === "lmstudio") !==
              (provider === "ollama" || provider === "lmstudio")
          ) {
            ai.model = "";
          }
          ai.provider = provider;
          await this.plugin.saveData(this.plugin.settings);
          // Switching provider changes the embedding transport (and
          // its default embedding model), so rebuild the live embedder
          // now — otherwise chat-side search would keep using the old
          // provider's adapter until the next reindex.
          this.plugin.onSettingsChange();
          this.display();
        });
      });

    // Provider-specific sub-sections
    const ai = this.plugin.settings.ai;
    switch (ai.provider) {
      case "gemini":
        this.renderGeminiSettings(containerEl, ai);
        break;
      case "openai":
        this.renderOpenAISettings(containerEl, ai);
        break;
      case "anthropic":
        this.renderAnthropicSettings(containerEl, ai);
        break;
      case "ollama":
      case "lmstudio":
        this.renderLocalSettings(containerEl, ai);
        break;
      case "custom":
        this.renderCustomSettings(containerEl, ai);
        break;
    }

    // Response style dropdown — a provider-agnostic voice preset.
    // Sits in the shared AI section so it's visible regardless of the
    // active provider. The fragment is spliced into the system prompt
    // for both chat and study-plan prompts (see
    // `geminiService.buildGeneralSystemPrompt` / `buildSystemPrompt`).
    // Iterating `RESPONSE_STYLES` keeps the dropdown in lockstep with
    // the catalog: adding a new style there is the only place a
    // contributor needs to touch.
    new Setting(containerEl)
      .setName("Response style")
      .setDesc(
        "How the AI talks. Changes the system prompt only — same provider, " +
        "same model, same tools. Applies to both chat and study plans.",
      )
      .addDropdown((dropdown) => {
        for (const s of RESPONSE_STYLES) {
          dropdown.addOption(s.id, s.label);
        }
        // Defensive fallback: if the saved id is missing (older
        // vault) or unknown (style was removed in a future build),
        // surface the canonical "concise" option in the dropdown
        // without forcing a save — the value normalizer on the
        // server side (getResponseStyle) would do the same thing
        // at chat time.
        const known = RESPONSE_STYLES.some((s) => s.id === ai.responseStyle);
        dropdown.setValue(known ? ai.responseStyle : "concise");
        dropdown.onChange(async (value) => {
          this.plugin.settings.ai.responseStyle = value as ResponseStyle;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    new Setting(containerEl)
      .setName("Max tool-call rounds")
      .setDesc(
        "How many times the AI may call tools (notes search, " +
        "flashcards…) in a single reply before it must answer. Small local " +
        "models sometimes loop — raise this if replies get cut off, lower " +
        "it to fail faster. When the limit is hit, the AI is asked once " +
        "more with tools off so you still get an answer.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(3, 30, 1)
          .setValue(ai.maxToolRounds ?? 20)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.ai.maxToolRounds = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc(
        "Sends a small probe request to the active provider. " +
        "Use this to confirm the API key, base URL, and model are all wired up.",
      )
      .addButton((button) =>
        button
          .setButtonText("Test")
          .setCta()
          .onClick(() => this.testAiConnection())
      );

    new Setting(containerEl)
      .setName("Planning preferences")
      .setDesc(
        "Add your daily schedule rules, e.g., 'no studying after 8 PM, take 15m breaks between sessions, prefer mornings for math'. The AI will strictly follow these rules when generating study plans.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("e.g., No studying after 8 PM\nTake 15-minute breaks between sessions\nPrefer mornings for math")
          .setValue(this.plugin.settings.planningPreferences)
          .onChange(async (value) => {
            this.plugin.settings.planningPreferences = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    const prefTextArea = containerEl.querySelector("textarea");
    if (prefTextArea) {
      prefTextArea.rows = 4;
    }
    
    new Setting(containerEl)
      .setName("Timezone")
      .setDesc("The IANA timezone name (e.g., Europe/Prague) used for AI context.")
      .addText((text) =>
        text
          .setPlaceholder("e.g., Europe/Prague")
          .setValue(this.plugin.settings.timeZone)
          .onChange(async (value) => {
            this.plugin.settings.timeZone = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
    
    // Daily Routine section
    new Setting(containerEl).setName("Daily Routine").setHeading();
    
    new Setting(containerEl)
      .setName("Wake Up Time")
      .setDesc("Your usual wake up time (e.g., 07:00)")
      .addText((text) =>
        text
          .setPlaceholder("07:00")
          .setValue(this.plugin.settings.wakeUpTime)
          .onChange(async (value) => {
            this.plugin.settings.wakeUpTime = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
      
    new Setting(containerEl)
      .setName("Bed Time")
      .setDesc("Your usual bed time (e.g., 23:00)")
      .addText((text) =>
        text
          .setPlaceholder("23:00")
          .setValue(this.plugin.settings.bedTime)
          .onChange(async (value) => {
            this.plugin.settings.bedTime = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
      
    // Review load balancing section
    new Setting(containerEl).setName("Review scheduling").setHeading();

    const clampDailyLimit = (value: number): number => {
      return Math.max(1, Math.min(20, value));
    };

    new Setting(containerEl)
      .setName("Max reviews per day")
      .setDesc("Maximum scheduled reviews for one day (1-20). Leave empty for no limit.")
      .addText((text) =>
        text
          .setPlaceholder("No limit")
          .setValue(
            this.plugin.settings.dailyLimitMax === null
              ? ""
              : String(this.plugin.settings.dailyLimitMax)
          )
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === "") {
              this.plugin.settings.dailyLimitMax = null;
              await this.plugin.saveData(this.plugin.settings);
              return;
            }

            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isNaN(parsed)) return;

            this.plugin.settings.dailyLimitMax = clampDailyLimit(parsed);
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    const clampMaxReviewInterval = (value: number): number => {
      return Math.max(1, Math.min(365, value));
    };

    new Setting(containerEl)
      .setName("Maximum interval between reviews (days)")
      .setDesc("Optional. Leave empty for no maximum.")
      .addText((text) =>
        text
          .setPlaceholder("empty = no limit")
          .setValue(
            this.plugin.settings.maxReviewIntervalDays === null
              ? ""
              : String(this.plugin.settings.maxReviewIntervalDays)
          )
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === "") {
              this.plugin.settings.maxReviewIntervalDays = null;
              await this.plugin.saveData(this.plugin.settings);
              return;
            }

            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isNaN(parsed)) {
              return;
            }

            this.plugin.settings.maxReviewIntervalDays =
              clampMaxReviewInterval(parsed);
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    // Indexing — vault search + flashcard persistence.
    //
    // Embeddings use the active AI provider's key / base URL and an
    // embedding model derived from the provider (see
    // `DEFAULT_EMBEDDING_MODEL`) — there's no separate field to keep
    // in sync. The status line is a small `setDesc` we refresh on
    // every `display()` call so it reflects the live index state.
    new Setting(containerEl).setName("Indexing").setHeading();
    containerEl.createEl("p", {
      text:
        "Embeddings use the active AI provider's key and base URL, with " +
        "the embedding model chosen automatically for that provider. " +
        "The vault index powers AI search and flashcard proposals.",
    });

    new Setting(containerEl)
      .setName("Flashcard folder")
      .setDesc(
        "Vault-relative folder where the AI's proposed flashcards are saved " +
          "as markdown. Pick a folder with the Browse button, or leave empty " +
          "to save in the vault root. The folder is created automatically " +
          "if it doesn't exist.",
      )
      .addText((text) => {
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.flashcardFolder)
          // Read-only display — selection happens via the Browse button.
          // Disabling keeps the chosen path visible without inviting typos.
          text.inputEl.readOnly = true;
      })
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(() => this.pickFlashcardFolder())
      );

    new Setting(containerEl)
      .setName("Auto-index vault")
      .setDesc(
        "Automatically rebuild the vault index in the background. " +
          "Daily runs roughly every 24 hours, weekly every 7 days. " +
          "Manual disables automatic runs.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("manual", "Manual");
        dropdown.addOption("daily", "Daily");
        dropdown.addOption("weekly", "Weekly");
        dropdown.setValue(this.plugin.settings.autoIndexInterval);
        dropdown.onChange(async (value) => {
          this.plugin.settings.autoIndexInterval = value as
            | "manual"
            | "daily"
            | "weekly";
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.updateAutoIndexSchedule();
        });
      });

    // Index status + the Index vault button. Both the command
    // palette and the settings tab go through the same `runIndex()`
    // helper, so the click experience is identical across both
    // surfaces. The status line is recomputed on every `display()`
    // call. The dashboard no longer shows this section.
    const knowledge = this.plugin.getKnowledgeBase();
    const statusText = knowledge.isReady()
      ? `Indexed: ${knowledge.chunkCount} chunks (last updated ${formatRelative(knowledge.lastIndexedAt)}).`
      : knowledge.chunkCount > 0
        ? `Index is empty — click "Index vault" to start.`
        : `Not yet indexed. Click "Index vault" to start.`;
    new Setting(containerEl)
      .setName("Vault index")
      .setDesc(statusText)
      .addButton((button) =>
        button
          .setButtonText("Index vault")
          .setCta()
          .setDisabled(knowledge.isReindexInFlight())
          .onClick(async () => {
            const { runIndex } = await import("./services/indexRunner.js");
            await runIndex(this.plugin, {
              onStateChange: () => this.display(),
            });
          })
      );
  }

  // ── Provider-specific settings renderers ─────────────────────────
  //
  // Each renderer adds the input fields for one provider to the
  // supplied container. The dropdown selection above is in charge of
  // showing only the active provider's fields; these methods don't
  // hide or unhide anything themselves.

  private renderGeminiSettings(
    containerEl: HTMLElement,
    ai: AIProviderConfig,
  ): void {
    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("API key for Google Gemini AI.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your Gemini API key")
          .setValue(ai.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.ai.geminiApiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc(
        "Pick a model from the catalog. " +
        "2.5 family is GA until Oct 16, 2026.",
      )
      .addDropdown((dropdown) => {
        for (const m of PROVIDER_CATALOG.gemini) {
          dropdown.addOption(m.id, m.label);
        }
        // Same silent catalog-miss fallback as OpenAI / Anthropic:
        // if the saved model isn't in the catalog, fall back to the
        // first entry. Keeps a fresh install on the default
        // ("gemini-2.5-flash") and avoids a broken dropdown.
        const initial = ai.geminiModel && PROVIDER_CATALOG.gemini.some((m) => m.id === ai.geminiModel)
          ? ai.geminiModel
          : PROVIDER_CATALOG.gemini[0]?.id ?? "";
        dropdown.setValue(initial);
        dropdown.onChange(async (value) => {
          this.plugin.settings.ai.geminiModel = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }

  private renderOpenAISettings(
    containerEl: HTMLElement,
    ai: AIProviderConfig,
  ): void {
    containerEl.createEl("p", {
      text: "Get an OpenAI API key from https://platform.openai.com/api-keys.",
      cls: "chronote-settings-hint",
    });
    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("API key for OpenAI (sk-…).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(ai.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.ai.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Pick a model from the catalog.")
      .addDropdown((dropdown) => {
        for (const m of PROVIDER_CATALOG.openai) {
          dropdown.addOption(m.id, m.label);
        }
        const initial = ai.model && PROVIDER_CATALOG.openai.some((m) => m.id === ai.model)
          ? ai.model
          : PROVIDER_CATALOG.openai[0]?.id ?? "";
        dropdown.setValue(initial);
        dropdown.onChange(async (value) => {
          this.plugin.settings.ai.model = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }

  private renderAnthropicSettings(
    containerEl: HTMLElement,
    ai: AIProviderConfig,
  ): void {
    containerEl.createEl("p", {
      text: "Get an Anthropic API key from https://console.anthropic.com/settings/keys.",
      cls: "chronote-settings-hint",
    });
    // Anthropic has no embedding endpoint, so we surface a clear
    // warning here. The user can still use Anthropic for chat — the
    // "Index vault" button will throw a clear "Anthropic has no
    // embedding endpoint" error at click time, which is the right
    // moment to tell the user why their index is empty.
    const warn = containerEl.createEl("p", { cls: "chronote-settings-warning" });
    warn.createEl("strong", { text: "Anthropic has no embedding endpoint. " });
    warn.appendText(
      "To use AI search, switch to OpenAI, Gemini, or set a " +
        "Custom OpenAI-compatible endpoint that serves /v1/embeddings.",
    );
    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("API key for Anthropic Claude (sk-ant-…).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-ant-…")
          .setValue(ai.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.ai.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Pick a Claude model from the catalog.")
      .addDropdown((dropdown) => {
        for (const m of PROVIDER_CATALOG.anthropic) {
          dropdown.addOption(m.id, m.label);
        }
        const initial = ai.model && PROVIDER_CATALOG.anthropic.some((m) => m.id === ai.model)
          ? ai.model
          : PROVIDER_CATALOG.anthropic[0]?.id ?? "";
        dropdown.setValue(initial);
        dropdown.onChange(async (value) => {
          this.plugin.settings.ai.model = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }

  private renderLocalSettings(
    containerEl: HTMLElement,
    ai: AIProviderConfig,
  ): void {
    const provider = ai.provider;
    const providerName = PROVIDER_LABELS[provider];

    const helpText =
      provider === "ollama"
        ? "Ollama must be running locally. Install from https://ollama.com and pull a model with `ollama pull llama3.3`. Click 'Load models' below to populate the dropdown."
        : "Start LM Studio's local server (Developer → OpenAI-compatible API server) on the port below. Click 'Load models' to populate the dropdown.";
    containerEl.createEl("p", {
      text: helpText,
      cls: "chronote-settings-hint",
    });

    new Setting(containerEl)
      .setName(`${providerName} base URL`)
      .setDesc("Local OpenAI-compatible endpoint. The chat completions path is appended automatically.")
      .addText((text) =>
        text
          .setPlaceholder(BASE_URL_PLACEHOLDER[provider] ?? "")
          .setValue(ai.baseUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.ai.baseUrl = trimmed;
            // Mirror the typed value into the persisted per-provider
            // map so switching to another provider and back doesn't
            // lose it (and so it survives an Obsidian restart).
            this.plugin.settings.ai.baseUrls = {
              ...this.plugin.settings.ai.baseUrls,
              [provider]: trimmed,
            };
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    // Model: a dropdown populated by GET /v1/models, with a Load
    // models button next to it. The dropdown accepts custom values
    // (Obsidian's `addDropdown` allows typing in the underlying
    // <select>), so a user can still hand-type a model id if the
    // load fails or they want a model we haven't fetched yet.
    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Click 'Load models' to fetch the list from your local server. " +
        "You can also type any model id directly — the dropdown accepts custom values.",
      )
      .addDropdown((dropdown) => {
        const cached = this.localModelsCache[provider] ?? [];
        if (cached.length > 0) {
          for (const id of cached) dropdown.addOption(id, id);
        } else {
          dropdown.addOption("", "(click 'Load models')");
        }
        // Preserve the user's previously-saved model — even if it's
        // not in the cached list yet — by adding it as an option.
        if (ai.model && !cached.includes(ai.model)) {
          dropdown.addOption(ai.model, ai.model);
        }
        if (ai.model) dropdown.setValue(ai.model);
        dropdown.onChange(async (value) => {
          this.plugin.settings.ai.model = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Load models")
          .setCta()
          .onClick(async () => {
            const cur = this.plugin.settings.ai;
            const baseUrl = (cur.baseUrl || "").trim();
            if (!baseUrl) {
              new Notice("Chronote: enter the base URL first.");
              return;
            }
            button.setDisabled(true);
            button.setButtonText("Loading…");
            try {
              const apiKey = (cur.apiKey || "").trim() || null;
              const models = await listLocalModels(baseUrl, apiKey);
              if (models.length === 0) {
                new Notice(
                  `Chronote: could not load models from ${baseUrl}. ` +
                  "Is the server running? Check the base URL.",
                );
                return;
              }
              this.localModelsCache[provider] = models.map((m) => m.id);
              // Don't clobber a user-typed model unless it's not in
              // the freshly-loaded list — that way switching baseUrl
              // to a server that has the same model id is a no-op.
              const currentModel = this.plugin.settings.ai.model;
              if (
                !currentModel ||
                !this.localModelsCache[provider].includes(currentModel)
              ) {
                this.plugin.settings.ai.model = this.localModelsCache[provider][0];
                await this.plugin.saveData(this.plugin.settings);
              }
              new Notice(
                `Chronote: loaded ${models.length} model${models.length === 1 ? "" : "s"} from ${baseUrl}.`,
              );
              this.display(); // re-render so the dropdown shows the new options
            } finally {
              button.setDisabled(false);
              button.setButtonText("Load models");
            }
          })
      );

    // API key is ignored by local providers, but the field is shown
    // so users have a single mental model for "credentials".
    new Setting(containerEl)
      .setName("API key (optional)")
      .setDesc(
        provider === "ollama"
          ? "Ollama ignores this. LM Studio and most local servers don't need one."
          : "LM Studio doesn't require a key, but you can type one if you've enabled auth.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("(not required)")
          .setValue(ai.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.ai.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    // Tool-calling reality check. Local models are gated by their
    // chat template; the user has no way to know in advance whether
    // the model they pulled supports tools. The graceful-degradation
    // in `runWithTools` will retry text-only on failure, so this is
    // an informational nudge rather than a blocking warning.
    containerEl.createEl("p", {
      text: "Tool calling depends on the model and quant — if the model rejects tools we'll fall back to text-only.",
      cls: "chronote-settings-hint",
    });

    if (provider === "ollama") {
      containerEl.createEl("p", {
        text: "Embeddings use nomic-embed-text — run `ollama pull nomic-embed-text` once so the vault index can build.",
        cls: "chronote-settings-hint",
      });
    }
  }

  private renderCustomSettings(
    containerEl: HTMLElement,
    ai: AIProviderConfig,
  ): void {
    containerEl.createEl("p", {
      text: "Custom works with any OpenAI Chat Completions-compatible endpoint (OpenRouter, Groq, Together, vLLM, llama.cpp server, …).",
      cls: "chronote-settings-hint",
    });

    // Custom is fully free-form: the user types whatever they want
    // into Base URL / API key / Model. All fields are optional
    // (the OpenAI-compat adapter omits the Authorization header when
    // apiKey is empty, so a keyless local server works too). We
    // intentionally don't ship a preset dropdown here — Obsidian's
    // renderer doesn't support window.prompt, and a curated list of
    // gateways would go stale faster than the user can type the
    // docs URL into the Base URL field.

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("e.g., https://openrouter.ai/api/v1")
      .addText((text) =>
        text
          .setPlaceholder(BASE_URL_PLACEHOLDER.custom ?? "")
          .setValue(ai.baseUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.ai.baseUrl = trimmed;
            this.plugin.settings.ai.baseUrls = {
              ...this.plugin.settings.ai.baseUrls,
              custom: trimmed,
            };
            await this.plugin.saveData(this.plugin.settings);
          })
      );
    new Setting(containerEl)
      .setName("API key")
      .setDesc("Bearer token. Sent as `Authorization: Bearer …`.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("API key")
          .setValue(ai.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.ai.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Free text. e.g., `openai/gpt-4o-mini` for OpenRouter.")
      .addText((text) =>
        text
          .setPlaceholder(MODEL_PLACEHOLDER.custom)
          .setValue(ai.model)
          .onChange(async (value) => {
            this.plugin.settings.ai.model = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }

  /**
   * Probe the active provider with a tiny `say "ok"`-style request.
   * On success, shows a green Notice; on failure, the error message
   * so the user can fix the URL / key / model.
   */
  private async testAiConnection(): Promise<void> {
    const ai = this.plugin.settings.ai;
    const missing = providerMissingFields(ai.provider, {
      geminiApiKey: ai.geminiApiKey,
      geminiModel: ai.geminiModel,
      apiKey: ai.apiKey,
      model: ai.model,
      baseUrl: ai.baseUrl,
    });
    if (missing.length > 0) {
      new Notice(
        `Chronote: ${PROVIDER_LABELS[ai.provider]} is missing: ${missing.join(", ")}.`,
      );
      return;
    }

    try {
      const { createAdapter } = await import("./services/ai/index.js");
      const adapter = createAdapter(this.plugin.settings);
      const reply = await adapter.chat({
        system: "You are a connectivity check. Respond with the single word 'ok' and nothing else.",
        messages: [{ role: "user", text: "ping" }],
        maxOutputTokens: 8,
        temperature: 0,
      });
      if (reply.text) {
        new Notice(`Chronote: ${PROVIDER_LABELS[ai.provider]} reachable. Reply: "${reply.text.slice(0, 80)}"`);
      } else {
        new Notice(`Chronote: ${PROVIDER_LABELS[ai.provider]} reachable (empty body).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Chronote: ${PROVIDER_LABELS[ai.provider]} test failed — ${msg}`);
    }
  }

  /**
   * Open an interactive vault-folder browser so the user can choose
   * the default flashcard folder without typing a path. Selected path
   * (or "" for the vault root) is written straight into settings.
   */
  private async pickFlashcardFolder(): Promise<void> {
    const picker = new FlashcardFolderPickerModal(
      this.app,
      this.plugin.settings.flashcardFolder,
    );
    const picked = await picker.pick();
    if (picked === null) return; // user cancelled
    this.plugin.settings.flashcardFolder = picked;
    await this.plugin.saveData(this.plugin.settings);
    // Re-render the tab so the read-only field reflects the new value.
    this.display();
  }

}

/**
 * Fuzzy picker over every folder in the vault, with the vault root
 * surfaced as a distinct entry. Resolves with the chosen folder path
 * (empty string = vault root), or null if the user dismisses.
 *
 * Mirrors the folder-half of `VaultLocationPickerModal` in
 * `modals/SaveFlashcardsModal.ts`. Kept separate to avoid coupling
 * the settings tab to a modal that's only ever opened from chat.
 */
class FlashcardFolderPickerModal extends FuzzySuggestModal<string> {
  private resolvePick: ((value: string | null) => void) | null = null;
  private folders: string[];

  constructor(app: App, current: string) {
    super(app);
    this.setPlaceholder("Pick a folder…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "select" },
      { command: "esc", purpose: "cancel" },
    ]);

    const fromVault = collectVaultFolders(app);
    // Include the current setting even if it doesn't correspond to a
    // folder that currently has markdown files in it — otherwise the
    // user could be locked out of a saved value that became empty.
    if (current.trim() !== "" && !fromVault.includes(current)) {
      fromVault.push(current);
    }
    this.folders = ["", ...fromVault.sort((a, b) => a.localeCompare(b))];
  }

  pick(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolvePick = resolve;
      this.open();
    });
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(item: string): string {
    return item === "" ? "📁 (vault root)" : `📁 ${item}`;
  }

  onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
    const resolver = this.resolvePick;
    this.resolvePick = null;
    resolver?.(item);
  }

  onClose(): void {
    if (this.resolvePick) {
      const resolver = this.resolvePick;
      this.resolvePick = null;
      resolver(null);
    }
    super.onClose();
  }
}

/**
 * Every folder mentioned by any markdown file in the vault. Paths are
 * vault-relative, no trailing slash. Vault root is NOT included.
 */
function collectVaultFolders(app: App): string[] {
  const set = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    const idx = f.path.lastIndexOf("/");
    if (idx <= 0) continue; // file is in the vault root
    set.add(f.path.slice(0, idx));
  }
  return Array.from(set);
}
