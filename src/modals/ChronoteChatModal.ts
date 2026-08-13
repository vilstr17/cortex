import { App, Modal, Notice, setIcon } from "obsidian";
import ChronotePlugin from "../main.js";
import { GeminiService } from "../services/geminiService.js";
import type { PersistedChatMessage, PersistedChatAttachments } from "../settingsTypes.js";
import { providerMissingFields } from "../services/ai/catalog.js";
import { PROVIDER_LABELS } from "../services/ai/catalog.js";
import { createNoteTools } from "../agent/tools/notes.js";
import { createTestTools } from "../agent/tools/tests.js";
import { createReviewTools } from "../agent/tools/reviews.js";
import {
  createFlashcardTools,
  FlashcardProposal,
  pendingProposals,
} from "../agent/tools/flashcards.js";
import {
  createQuizTools,
  pendingQuizzes,
  QuizProposal,
} from "../agent/tools/quizzes.js";
import { saveProposalsToTarget } from "../services/flashcardSaveService.js";
import { promptForSaveLocation } from "./SaveFlashcardsModal.js";
import type { ToolProgressEvent } from "../services/ai/runWithTools.js";
import { renderChatMarkdown } from "../ui/chatMarkdown.js";
import { renderFlashcardDeck } from "../ui/FlashcardDeck.js";
import { renderQuizComponent } from "../ui/QuizComponent.js";

interface AIResponseWithEvents {
  text: string;
  /** Proposals made during this turn, captured from the chat. */
  flashcards: FlashcardProposal[];
  /** Quizzes proposed during this turn. */
  quizzes: QuizProposal[];
}

export class ChronoteChatModal extends Modal {
  private plugin: ChronotePlugin;
  private geminiService: GeminiService;
  private chatHistory: PersistedChatMessage[];
  private historyContainer!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private isLoading = false;
  /**
   * Live "what the agent is doing" panel inside the loading indicator,
   * plus the most recent pending tool-step row so a `tool_result`
   * event can mark it done. Both reset on every send.
   */
  private activityEl: HTMLElement | null = null;
  private pendingStepEl: HTMLElement | null = null;
  /** Maximum persisted chat turns. Keeps data.json from growing forever. */
  private readonly maxHistorySize = 100;

  constructor(app: App, plugin: ChronotePlugin) {
    super(app);
    this.plugin = plugin;
    this.chatHistory = [...(this.plugin.settings.chatHistory ?? [])];
    this.geminiService = new GeminiService(plugin.settings);
    // Register the note tools (search/read/list) with the registry.
    // We do this here rather than in main.ts so the tools are scoped
    // to a chat session — the modal owns the lifecycle.
    const knowledge = this.plugin.getKnowledgeBase();
    for (const t of createNoteTools({ app: this.app, knowledge })) {
      this.geminiService.registerTool(t);
    }
    // Register the test tool. The model calls list_tests whenever the
    // user asks about an upcoming exam or wants to plan revision. The
    // closure pulls from the live settings.tests array, so dashboard
    // edits are picked up without re-mounting the modal.
    for (const t of createTestTools({
      getTests: () => this.plugin.settings.tests,
    })) {
      this.geminiService.registerTool(t);
    }
    // Register the review tool. The model calls list_reviews whenever
    // the user asks what to revise. The factory takes the app + test
    // list as closures so the tool sees vault frontmatter edits and
    // dashboard test edits without a re-mount.
    for (const t of createReviewTools({
      app: this.app,
      getTests: () => this.plugin.settings.tests,
    })) {
      this.geminiService.registerTool(t);
    }
    // Register the flashcard tool. The model uses it to *propose*
    // cards; the user clicks Save in the chat to persist them.
    for (const t of createFlashcardTools()) {
      this.geminiService.registerTool(t);
    }
    // Register the quiz tool. The model uses it to propose interactive
    // multiple-choice quizzes; the user answers inside the chat.
    for (const t of createQuizTools()) {
      this.geminiService.registerTool(t);
    }
  }

  async onOpen(): Promise<void> {
    this.setTitle("Chronote AI Chat");
    this.modalEl.addClasses(["chronote-chat-modal"]);

    const { contentEl } = this;
    contentEl.empty();

    // Toolbar: clear conversation.
    const toolbar = contentEl.createDiv({ cls: "chat-toolbar" });
    const clearBtn = toolbar.createEl("button", {
      cls: "chat-clear-btn",
      attr: { title: "Clear conversation" },
    });
    setIcon(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => {
      void this.clearChat();
    });

    // Chat history (scrollable)
    this.historyContainer = contentEl.createDiv({ cls: "chat-history" });

    if (this.chatHistory.length > 0) {
      // Restore the previous conversation, including any interactive
      // attachments that were generated in earlier turns.
      for (const turn of this.chatHistory) {
        if (turn.role === "user") {
          this.appendUserMessage(turn.text);
        } else {
          await this.appendAssistantText(turn.text, turn.attachments);
        }
      }
    } else {
      // Welcome message for a fresh chat.
      await this.appendAssistantText(
        "Hi! I'm Chronote. Ask me about your notes, your review schedule, or what to study for an upcoming test.",
      );
    }

    // Input area
    const inputArea = contentEl.createDiv({ cls: "chat-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "chat-input",
      attr: {
        placeholder: "Ask about your notes, reviews, or upcoming tests...",
        rows: 1,
      },
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl("button", {
      cls: "chat-send-btn",
      text: "Send",
    });
    this.sendBtn.addEventListener("click", () => { void this.sendMessage(); });

    // Auto-resize textarea
    this.inputEl.addEventListener("input", () => {
      this.inputEl.setCssStyles({ height: "auto" });
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + "px";
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isLoading) return;

    // Provider-aware credentials check. The active provider decides
    // which fields are required — we surface the missing-field name
    // rather than a generic "set your API key" error.
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
        `Chronote: ${PROVIDER_LABELS[ai.provider]} is not configured. Missing: ${missing.join(", ")}. Set them in Settings → Chronote.`,
      );
      return;
    }

    // Clear input
    this.inputEl.value = "";
    this.inputEl.setCssStyles({ height: "auto" });

    // Append user message
    this.appendUserMessage(text);
    this.chatHistory.push({ role: "user", text });
    await this.persistChatHistory();

    // Show loading
    this.setLoading(true);

    try {
      // Snapshot the knowledge index state so the model can mention
      // "your index is empty" if applicable, rather than pretending
      // to search an unindexed vault. We build a short, copyable
      // string here so the service stays free of plugin references.
      const knowledge = this.plugin.getKnowledgeBase();
      const knowledgeState = knowledge.isReady()
        ? `ready (${knowledge.chunkCount} chunks indexed)`
        : "empty — user has not run a reindex";

      // Snapshot the proposal arrays *before* the chat round runs.
      // The function-call loop inside `geminiService.chat()` pushes new
      // flashcards/quizzes into the shared pending arrays, so the
      // "after" length is the array length once the call returns.
      // Capturing the before-length here is essential — doing it after
      // the await would see the already-pushed items and slice to empty.
      const proposalsBefore = pendingProposals.length;
      const quizzesBefore = pendingQuizzes.length;

      // Call Gemini. The progress callback drives the live activity
      // panel so the user sees which tools the agent is calling rather
      // than a static "Thinking…" while the loop runs.
      const responseText = await this.geminiService.chat(
        this.chatHistory,
        knowledgeState,
        (event) => this.renderProgress(event),
      );

      // Extract proposals/quizzes that were added during this turn.
      const newProposals = pendingProposals.slice(proposalsBefore);
      const newQuizzes = pendingQuizzes.slice(quizzesBefore);
      const fullParsed: AIResponseWithEvents = {
        text: responseText,
        flashcards: newProposals,
        quizzes: newQuizzes,
      };

      this.setLoading(false);
      await this.appendAssistantMessage(fullParsed);
      const attachments: PersistedChatAttachments | undefined =
        fullParsed.flashcards.length > 0 || fullParsed.quizzes.length > 0
          ? { flashcards: fullParsed.flashcards, quizzes: fullParsed.quizzes }
          : undefined;
      this.chatHistory.push({ role: "assistant", text: responseText, attachments });
      await this.persistChatHistory();
    } catch (err) {
      this.setLoading(false);
      await this.appendAssistantText(
        "Sorry, something went wrong while contacting the AI. Please check your provider settings and try again.",
      );
    }

  }

  private appendUserMessage(text: string): void {
    const msgEl = this.historyContainer.createDiv({
      cls: "chat-message chat-message-user",
    });

    msgEl.createDiv({
      cls: "chat-message-label",
      text: "You",
    });

    msgEl.createDiv({
      cls: "chat-message-text",
      text,
    });

    this.scrollToBottom();
  }

  private async appendAssistantText(
    text: string,
    attachments?: PersistedChatAttachments,
  ): Promise<HTMLElement> {
    const msgEl = this.historyContainer.createDiv({
      cls: "chat-message chat-message-assistant",
    });

    msgEl.createDiv({
      cls: "chat-message-label",
      text: "Chronote",
    });

    const textEl = msgEl.createDiv({
      cls: "chat-message-text chat-message-text-rendered",
    });
    if (text.trim().length > 0) {
      await renderChatMarkdown(this.app, text, textEl, this.plugin);
    }

    if (attachments) {
      this.renderAssistantAttachments(msgEl, attachments);
    }

    this.scrollToBottom();
    return msgEl;
  }

  /**
   * Create the shell for an assistant message that will also carry
   * interactive attachments (event approvals, flashcard decks, quizzes).
   */
  private createAssistantMessageShell(): HTMLElement {
    const msgEl = this.historyContainer.createDiv({
      cls: "chat-message chat-message-assistant",
    });

    msgEl.createDiv({
      cls: "chat-message-label",
      text: "Chronote",
    });

    return msgEl;
  }

  private async appendAssistantMessage(parsed: AIResponseWithEvents): Promise<void> {
    const msgEl = this.createAssistantMessageShell();

    const textEl = msgEl.createDiv({
      cls: "chat-message-text chat-message-text-rendered",
    });
    if (parsed.text.trim().length > 0) {
      await renderChatMarkdown(this.app, parsed.text, textEl, this.plugin);
    }

    // Optional: flashcard proposals with a Save button and interactive
    // quiz proposals. These are also written into the persisted chat
    // history so they survive closing and reopening the chat.
    this.renderAssistantAttachments(msgEl, {
      flashcards: parsed.flashcards,
      quizzes: parsed.quizzes,
    });

    this.scrollToBottom();
  }

  /**
   * Render persisted interactive attachments (flashcards, quizzes) back
   * into an assistant message when the chat is restored.
   */
  private renderAssistantAttachments(
    parent: HTMLElement,
    attachments: PersistedChatAttachments,
  ): void {
    if (attachments.flashcards && attachments.flashcards.length > 0) {
      this.renderFlashcards(parent, attachments.flashcards);
    }
    if (attachments.quizzes && attachments.quizzes.length > 0) {
      for (const quiz of attachments.quizzes) {
        renderQuizComponent(parent, quiz);
      }
    }
  }

  private async clearChat(): Promise<void> {
    this.chatHistory = [];
    this.plugin.settings.chatHistory = [];
    await this.plugin.saveData(this.plugin.settings);
    this.historyContainer.empty();
    await this.appendAssistantText(
      "Chat history cleared. What would you like to work on?",
    );
  }

  private async persistChatHistory(): Promise<void> {
    // Keep only the most recent turns so data.json never grows unbounded.
    const trimmed = this.chatHistory.slice(-this.maxHistorySize);
    this.chatHistory = trimmed;
    this.plugin.settings.chatHistory = trimmed.map((m) => ({ ...m }));
    await this.plugin.saveData(this.plugin.settings);
  }

  /**
   * Render a vertical list of flashcard proposals. Each card has a
   * "Show answer" reveal and a "💾 Save" button. The Save button
   * writes ALL visible cards to a single markdown note (per the
   * `flashcardFolder` + sanitized test name convention).
   *
   * The list is grouped by `testName` so the Save button can write
   * to the right file even if the model proposed cards for several
   * tests in one turn. The user only sees one "Save" per test.
   */
  private renderFlashcards(parent: HTMLElement, proposals: FlashcardProposal[]): void {
    // Group by testName so each Save button writes to one file.
    const groups = new Map<string, FlashcardProposal[]>();
    for (const p of proposals) {
      const arr = groups.get(p.testName) ?? [];
      arr.push(p);
      groups.set(p.testName, arr);
    }

    const actionArea = parent.createDiv({
      cls: "chat-flashcard-area",
    });
    actionArea.createEl("strong", {
      text: `Proposed ${proposals.length} flashcard${proposals.length === 1 ? "" : "s"}:`,
    });

    for (const [testName, group] of groups) {
      renderFlashcardDeck(actionArea, group, {
        testName,
        onSave: async () => {
          // Ask the user where to save. The modal resolves to a
          // SaveTarget (default / folder / existing) or null if
          // they cancel.
          const target = await promptForSaveLocation(this.app, this.plugin);
          if (target === null) return null;

          const result = await saveProposalsToTarget(
            this.app,
            group,
            testName,
            target,
          );
          if (result === null) return null;

          // Remove the saved proposals from the in-memory list so
          // they aren't re-rendered on the next send.
          for (const p of group) {
            const idx = pendingProposals.findIndex((q) => q.proposalId === p.proposalId);
            if (idx >= 0) pendingProposals.splice(idx, 1);
          }
          return result;
        },
      });
    }
  }

  private setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.sendBtn.disabled = loading;
    this.inputEl.disabled = loading;

    if (loading) {
      this.sendBtn.setText("…");
      // Show typing indicator
      const indicator = this.historyContainer.createDiv({
        cls: "chat-message chat-message-assistant chat-loading",
        attr: { id: "chat-loading-indicator" },
      });
      indicator.createDiv({ cls: "chat-message-label", text: "Chronote" });
      // Live activity panel: tool-step rows get appended here as the
      // agent works. Empty until the first tool call.
      this.activityEl = indicator.createDiv({ cls: "chat-activity" });
      this.pendingStepEl = null;
      indicator.createDiv({ cls: "chat-loading-dots", text: "Thinking…" });
      this.scrollToBottom();
    } else {
      // Remove loading indicator
      const existing = this.historyContainer.querySelector("#chat-loading-indicator");
      if (existing) existing.remove();
      this.activityEl = null;
      this.pendingStepEl = null;
      this.sendBtn.setText("Send");
    }
  }

  /**
   * Update the live activity panel from a tool-loop progress event.
   *
   * The loop emits events strictly in order — `round`, then for each
   * tool: `tool_call` immediately followed (after the await) by
   * `tool_result`. So we only ever have one pending step at a time:
   * `tool_call` appends a "running" row, `tool_result` flips that same
   * row to done / error. The panel is ephemeral — `setLoading(false)`
   * tears it down before the real assistant message is rendered.
   */
  private renderProgress(event: ToolProgressEvent): void {
    const panel = this.activityEl;
    if (!panel) return;

    switch (event.type) {
      case "tool_call": {
        const step = panel.createDiv({ cls: "chat-activity-step is-running" });
        step.createSpan({ cls: "chat-activity-icon", text: "⏳" });
        step.createSpan({
          cls: "chat-activity-text",
          text: this.toolActivityLabel(event.name, event.args),
        });
        this.pendingStepEl = step;
        this.scrollToBottom();
        break;
      }
      case "tool_result": {
        const step = this.pendingStepEl;
        if (step) {
          step.removeClass("is-running");
          step.addClass(event.ok ? "is-done" : "is-error");
          const icon = step.querySelector(".chat-activity-icon");
          if (icon) icon.setText(event.ok ? "✓" : "✕");
          this.pendingStepEl = null;
        }
        break;
      }
      case "fallback": {
        if (event.reason === "max_rounds") {
          panel.createDiv({
            cls: "chat-activity-step is-note",
            text: "Reached the tool-call limit — composing an answer…",
          });
          this.scrollToBottom();
        }
        break;
      }
      // "round" events don't need their own row; the dots already
      // signal ongoing work.
    }
  }

  /**
   * Human-friendly one-liner for a tool call shown in the activity
   * panel. Falls back to the raw tool name for anything unmapped so a
   * newly-added tool still surfaces something readable.
   */
  private toolActivityLabel(name: string, args: Record<string, unknown>): string {
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    switch (name) {
      case "search_notes": {
        const q = str(args.query).trim();
        return q ? `Searching notes for “${q}”` : "Searching notes";
      }
      case "read_note": {
        const p = str(args.path).trim();
        return p ? `Reading ${p}` : "Reading a note";
      }
      case "list_notes":
        return "Browsing the vault";
      case "list_tests":
        return "Checking upcoming tests";
      case "list_reviews":
        return "Checking due reviews";
      case "propose_flashcard":
        return "Drafting a flashcard";
      case "propose_quiz":
        return "Building a quiz";
      default:
        return `Running ${name}`;
    }
  }

  private scrollToBottom(): void {
    this.historyContainer.scrollTop = this.historyContainer.scrollHeight;
  }
}
