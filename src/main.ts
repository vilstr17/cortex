import { Plugin, Notice, TFile } from "obsidian";
import Commands from "./commands.js";
import {
  ChronoteDashboardView,
  CHRONOTE_DASHBOARD_VIEW,
} from "./views/ChronoteDashboardView.js";
import { ChronoteSettings, DEFAULT_SETTINGS, ChronoteSettingTab } from "./settings.js";
import { GoogleCalendarService } from "./services/googleCalendarService.js";
import { TestService } from "./services/testService.js";
import {
  migrateSettings,
  seedEmbeddingDimFromDisk,
} from "./utils/settingsMigration.js";
import { KnowledgeBase } from "./agent/vectorIndex/knowledgeBase.js";
import {
  providerMissingFields,
  embeddingMissingFields,
} from "./services/ai/catalog.js";
import {
  chronoteStudyPostProcessor,
  openStudyForFile,
} from "./services/flashcardStudyPostProcessor.js";

export type { ChronoteSettings };
export { DEFAULT_SETTINGS };

export default class ChronotePlugin extends Plugin {
  settings: ChronoteSettings = DEFAULT_SETTINGS;
  commands!: Commands;
  private oauthState: string | null = null;

  calendarService: GoogleCalendarService | null = null;
  testService!: TestService;
  knowledgeBase: KnowledgeBase | null = null;

  getCalendarService(): GoogleCalendarService {
    if (!this.calendarService) {
      this.calendarService = new GoogleCalendarService(
        this.settings,
        () => this.saveData(this.settings),
      );
    }
    return this.calendarService;
  }

  /**
   * Lazily construct the knowledge base. We hold a single instance
   * for the plugin lifetime so the index survives view open/close
   * cycles (the chat modal is opened and closed repeatedly). The
   * `pluginDataDir` is derived from the Obsidian plugin manifest
   * — the caller has the right to store our `index.bin` there.
   */
  getKnowledgeBase(): KnowledgeBase {
    if (!this.knowledgeBase) {
      // `.obsidian/plugins/<id>/` — the standard plugin data dir.
      const pluginDataDir = (this.manifest as { dir?: string } | undefined)?.dir ??
        `.obsidian/plugins/chronote`;
      this.knowledgeBase = new KnowledgeBase({
        app: this.app,
        settings: this.settings,
        saveSettings: async () => {
          await this.saveData(this.settings);
        },
        pluginDataDir,
      });
    }
    return this.knowledgeBase;
  }

  /**
   * Called by the settings tab after the user edits any AI provider
   * field that affects embeddings. Diffs the new (provider, embedding
   * model, dim) triple against the last-known set; if nothing changed,
   * no-op. Otherwise rebuilds the live embedder.
   *
   * The settings tab historically fired a Notice on every keystroke
   * for these fields (via `recreateEmbedder`); we removed the Notice
   * spam because (a) the dashboard "Index vault" button now gives
   * the user a clean way to apply their settings, and (b) the
   * status notice on every keystroke was confusing.
   */
  private lastAIConfigForEmbed: { provider: string; model: string; dim: number | null } | null = null;
  onSettingsChange(): void {
    const ai = this.settings.ai;
    const last = this.lastAIConfigForEmbed;
    const cur = {
      provider: ai.provider,
      model: ai.embeddingModel,
      dim: ai.embeddingDim ?? null,
    };
    if (
      last &&
      last.provider === cur.provider &&
      last.model === cur.model &&
      last.dim === cur.dim
    ) {
      return;
    }
    this.lastAIConfigForEmbed = cur;
    this.getKnowledgeBase().recreateEmbedder();
  }

  /** Handle for the periodic auto-index check; cleared on re-schedule and unload. */
  private autoIndexIntervalId: number | null = null;

  /**
   * (Re-)schedule the background auto-index task based on the current
   * `autoIndexInterval` setting. Called once during `onload()` and
   * again whenever the user changes the dropdown in Settings.
   */
  updateAutoIndexSchedule(): void {
    if (this.autoIndexIntervalId !== null) {
      window.clearInterval(this.autoIndexIntervalId);
      this.autoIndexIntervalId = null;
    }

    const interval = this.settings.autoIndexInterval;
    if (interval === "manual") return;

    // Check every minute; the actual run is gated by elapsed time since
    // the last successful index, so this is cheap and responsive.
    this.autoIndexIntervalId = window.setInterval(() => {
      void this.maybeRunAutoIndex(interval);
    }, 60 * 1000);
  }

  private async maybeRunAutoIndex(
    interval: "daily" | "weekly",
  ): Promise<void> {
    const kb = this.knowledgeBase;
    if (!kb || !kb.isReady() || kb.isReindexInFlight()) return;

    const thresholdMs =
      interval === "daily"
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
    const lastIndexed = kb.lastIndexedAt;
    if (lastIndexed > 0 && Date.now() - lastIndexed < thresholdMs) return;

    // Silently skip if the active provider isn't configured — avoids
    // spamming a Notice every time the interval elapses.
    const ai = this.settings.ai;
    const missing = providerMissingFields(ai.provider, {
      chronoteAccountId: ai.chronoteAccountId,
      geminiApiKey: ai.geminiApiKey,
      geminiModel: ai.geminiModel,
      apiKey: ai.apiKey,
      model: ai.model,
      baseUrl: ai.baseUrl,
    });
    if (missing.length > 0) return;
    if (embeddingMissingFields(ai.provider, ai.embeddingModel).length > 0) return;

    const { runIndex } = await import("./services/indexRunner.js");
    await runIndex(this);
  }

  generateOAuthState(): string {
    const state = crypto.randomUUID();
    this.oauthState = state;
    return state;
  }

  async onload() {
    // Build marker — lets us confirm which main.js Obsidian actually
    // loaded. If this line isn't in the console after a reload, the
    // new build didn't take (stale plugin in memory).
    const raw = await this.loadData();

    this.settings = migrateSettings(raw);

    if (!Array.isArray(this.settings.tests)) {
      this.settings.tests = [];
    }

    // Persist the migrated blob so obsolete keys (e.g. legacy OAuth
    // client secrets, the pre-simplification embedding fields) are
    // physically removed from data.json rather than just ignored
    // at runtime.
    await this.saveData(this.settings);

    // One-time seed: read the on-disk knowledge-index.bin header
    // (just the dim) and seed `ai.embeddingDim` so a
    // pre-simplification user with a non-384-dim index doesn't get
    // their persisted chunks dropped by the dim-mismatch check in
    // `KnowledgeBase.loadFromDisk`. Idempotent — a subsequent save
    // round-trips the seeded value.
    const pluginDataDir = (this.manifest as { dir?: string } | undefined)?.dir ??
      `.obsidian/plugins/chronote`;
    const seeded = await seedEmbeddingDimFromDisk(
      this.settings,
      this.app,
      pluginDataDir,
    );
    if (seeded !== this.settings) {
      this.settings = seeded;
      await this.saveData(this.settings);
    }

    this.registerView(
      CHRONOTE_DASHBOARD_VIEW,
      (leaf) => new ChronoteDashboardView(leaf, this),
    );

    // Ensure any stale dashboard views from a previous plugin load are closed
    this.app.workspace.detachLeavesOfType(CHRONOTE_DASHBOARD_VIEW);

    // Register the flashcard-study post-processor and a workspace-level
    // click delegate so clicking the injected "▶ Study flashcards" button
    // opens the saved deck as an interactive modal. The post-processor
    // checks the frontmatter (`flashcards: true`) and only adds the
    // button on notes the save service wrote — so other notes that
    // happen to mention flashcards aren't affected.
    this.registerMarkdownPostProcessor(chronoteStudyPostProcessor(this));
    const studyClickHandler = (evt: MouseEvent) => {
      const target = evt.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest<HTMLElement>("[data-chronote-study]");
      if (!btn) return;
      const path = btn.getAttribute("data-chronote-study");
      if (!path) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file || !(file instanceof TFile)) return;
      evt.preventDefault();
      void openStudyForFile(this, file);
    };
    // Listen on the document so the handler works regardless of
    // which leaf is focused, and survives Obsidian re-rendering
    // the markdown view.
    this.registerDomEvent(document, "click", studyClickHandler);

    this.testService = new TestService(this);

    // Load the persisted knowledge index in the background. We don't
    // await — first-time users have nothing on disk, and a 1k-note
    // vault takes a couple of seconds to load. The chat UI checks
    // `isReady()` and surfaces a friendly "run Reindex" hint.
    void this.getKnowledgeBase().loadFromDisk();

    // Watch for vault changes and re-chunk the changed file. We
    // debounce lightly so a bulk paste doesn't trigger 50 re-embeds.
    let changeDebounce: number | null = null;
    const pendingPaths = new Set<string>();
    const flushChanges = () => {
      const paths = Array.from(pendingPaths);
      pendingPaths.clear();
      changeDebounce = null;
      const kb = this.knowledgeBase;
      if (!kb) return;
      void Promise.all(paths.map((p) => kb.updateFile(p)));
    };
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!file.path.endsWith(".md")) return;
        pendingPaths.add(file.path);
        if (changeDebounce !== null) window.clearTimeout(changeDebounce);
        changeDebounce = window.setTimeout(flushChanges, 2000);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!file.path.endsWith(".md")) return;
        pendingPaths.add(file.path);
        if (changeDebounce !== null) window.clearTimeout(changeDebounce);
        changeDebounce = window.setTimeout(flushChanges, 2000);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file.path.endsWith(".md")) pendingPaths.add(file.path);
        if (oldPath.endsWith(".md")) pendingPaths.add(oldPath);
        if (changeDebounce !== null) window.clearTimeout(changeDebounce);
        changeDebounce = window.setTimeout(flushChanges, 2000);
      }),
    );

    // The proxy still redirects to the legacy `cortex-auth` action from before
    // the plugin was renamed to Chronote. Register both names so existing
    // installs and the current proxy callback continue to work.
    this.registerObsidianProtocolHandler("chronote-auth", (params) =>
      this.handleGoogleAuthCallback(params),
    );
    this.registerObsidianProtocolHandler("cortex-auth", (params) =>
      this.handleGoogleAuthCallback(params),
    );

    this.addRibbonIcon("brain", "Open Chronote Dashboard", () => {
      this.openDashboard();
    });

    this.addCommand({
      id: "open-chronote-dashboard",
      name: "Open Chronote Dashboard",
      callback: () => this.openDashboard(),
    });

    this.addCommand({
      id: "reindex-knowledge-base",
      name: "Reindex vault for AI search",
      // The dashboard button, the command palette, and the
      // settings-tab button all funnel through `runIndex()` so
      // validation, the in-flight guard, the progress Notice, and
      // the success / failure Notice are identical across surfaces.
      callback: () => import("./services/indexRunner.js").then(({ runIndex }) => runIndex(this)),
    });

    this.commands = new Commands(this);
    this.commands.addCommands();

    this.addSettingTab(new ChronoteSettingTab(this.app, this));

    // Start the background auto-index scheduler. The first check is
    // delayed by the interval timer, so vault restore isn't delayed.
    this.updateAutoIndexSchedule();
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(CHRONOTE_DASHBOARD_VIEW);
    if (this.autoIndexIntervalId !== null) {
      window.clearInterval(this.autoIndexIntervalId);
      this.autoIndexIntervalId = null;
    }
    this.calendarService?.destroy();
    this.calendarService = null;
  }

  async openDashboard() {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(CHRONOTE_DASHBOARD_VIEW);

    if (existingLeaves.length > 0) {
      workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CHRONOTE_DASHBOARD_VIEW });
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Re-render the dashboard's Google Calendar section so the "Waiting for
   * authorization…" UI is replaced by either the connected schedule view
   * or the connect button (depending on outcome). Called from both the
   * `chronote-auth` and legacy `cortex-auth` protocol handlers on every
   * callback path.
   */
  private async refreshDashboardCalendarSection(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(CHRONOTE_DASHBOARD_VIEW);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof ChronoteDashboardView) {
        view.refreshGoogleCalendarSection();
      }
    }
  }

  /**
   * Handle the Google OAuth token callback from the proxy. Shared by the
   * `chronote-auth` and legacy `cortex-auth` protocol handlers so the rename
   * does not break users whose proxy session still redirects to the old action.
   */
  private async handleGoogleAuthCallback(params: Record<string, string>): Promise<void> {
    // CSRF guard: only reject if a state was supplied AND it doesn't match.

    // A missing state (proxy didn't echo it back) is treated as a proxy bug,
    // not a security failure — we still accept the tokens. This avoids the
    // situation where a misconfigured proxy strands the user with valid
    // tokens that get thrown away.
    if (params.state && params.state !== this.oauthState) {
      new Notice("Chronote: OAuth state mismatch. Authentication rejected for security.");
      this.oauthState = null;
      await this.refreshDashboardCalendarSection();
      return;
    }
    this.oauthState = null;

    if (params.access_token) {
      this.settings.googleAccessToken = params.access_token;
      if (params.refresh_token) {
        this.settings.googleRefreshToken = params.refresh_token;
      }
      if (params.expires_in) {
        this.settings.googleTokenExpiry = Date.now() + parseInt(params.expires_in, 10) * 1000;
      } else {
        this.settings.googleTokenExpiry = Date.now() + 3600 * 1000;
      }

      await this.saveData(this.settings);
      new Notice("Chronote: Google Calendar connected successfully!");
      await this.refreshDashboardCalendarSection();
    } else if (params.error) {
      new Notice(`Chronote: Failed to connect Google Calendar: ${params.error}`);
      await this.refreshDashboardCalendarSection();
    } else {
      // Callback fired but carried neither tokens nor an error — the proxy
      // likely misrouted. Re-render so the UI unsticks from "Waiting…".
      new Notice("Chronote: Google auth callback had no tokens. Try connecting again.");
      await this.refreshDashboardCalendarSection();
    }
  }
}
