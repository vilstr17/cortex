import { App, Modal, Notice, Setting } from "obsidian";
import CortexPlugin from "../main";
import { GeminiService, ChatMessage } from "../services/geminiService";
import { ScheduledEvent } from "../services/geminiService";

interface AIResponseWithEvents {
  text: string;
  events: ScheduledEvent[] | null;
}

export class CortexChatModal extends Modal {
  private plugin: CortexPlugin;
  private geminiService: GeminiService;
  private chatHistory: ChatMessage[] = [];
  private historyContainer!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private isLoading = false;

  constructor(app: App, plugin: CortexPlugin) {
    super(app);
    this.plugin = plugin;
    this.geminiService = new GeminiService(plugin.settings, this.plugin.getCalendarService());
  }

  onOpen(): void {
    this.setTitle("Cortex AI Chat");
    this.modalEl.addClasses(["cortex-chat-modal"]);

    const { contentEl } = this;
    contentEl.empty();

    // Chat history (scrollable)
    this.historyContainer = contentEl.createDiv({ cls: "chat-history" });

    // Welcome message
    this.appendMessage("assistant", "Hi! I'm Cortex. Ask me about your review schedule, or request a study plan for today.");

    // Input area
    const inputArea = contentEl.createDiv({ cls: "chat-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "chat-input",
      attr: {
        placeholder: "Ask about your schedule, or type 'plan my day'...",
        rows: 1,
      },
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl("button", {
      cls: "chat-send-btn",
      text: "Send",
    });
    this.sendBtn.addEventListener("click", () => this.sendMessage());

    // Auto-resize textarea
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
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

    // Check for Gemini API key
    if (!this.plugin.settings.geminiApiKey) {
      new Notice("Cortex: Please set your Gemini API key in Settings first.");
      return;
    }

    // Clear input
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";

    // Append user message
    this.appendMessage("user", text);
    this.chatHistory.push({ role: "user", text });

    // Show loading
    this.setLoading(true);

    try {
      // Gather context for scheduling mode
      const isSchedulingQuery = this.isSchedulingQuery(text);
      let dueNotes: unknown[] | undefined;
      let calendarEvents: unknown[] | undefined;

      if (isSchedulingQuery) {
        dueNotes = this.getDueNotesData();
        // Scheduling always plans for TODAY. The AI prompt and dashboard
        // both anchor on the local current date, so the calendar context
        // we hand Gemini must match — otherwise we'd tell it to "schedule
        // for today" while feeding it tomorrow's free slots.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const events = await this.plugin.getCalendarService().getEventsForDay(today);
        calendarEvents = events.map((e) => ({
          summary: e.summary,
          startTime: e.startTime.toISOString(),
          endTime: e.endTime.toISOString(),
        }));
      }

      // Call Gemini
      const responseText = await this.geminiService.chat(
        this.chatHistory,
        dueNotes,
        calendarEvents,
      );

      // Parse response for embedded events
      const parsed = this.parseResponseForEvents(responseText);

      this.setLoading(false);
      this.appendMessageWithEvents("assistant", parsed);
      this.chatHistory.push({ role: "assistant", text: responseText });
    } catch (err) {
      this.setLoading(false);
      console.error("Cortex: Chat error:", err);
      this.appendMessage("assistant", "Sorry, something went wrong while contacting Gemini. Please check your API key and try again.");
    }
  }

  private appendMessage(role: "user" | "assistant", text: string): void {
    const msgEl = this.historyContainer.createDiv({
      cls: `chat-message chat-message-${role}`,
    });

    const label = msgEl.createDiv({
      cls: "chat-message-label",
      text: role === "user" ? "You" : "Cortex",
    });

    msgEl.createDiv({
      cls: "chat-message-text",
      text,
    });

    this.scrollToBottom();
  }

  private appendMessageWithEvents(
    role: "assistant",
    parsed: AIResponseWithEvents,
  ): void {
    const msgEl = this.historyContainer.createDiv({
      cls: `chat-message chat-message-${role}`,
    });

    msgEl.createDiv({
      cls: "chat-message-label",
      text: "Cortex",
    });

    msgEl.createDiv({
      cls: "chat-message-text",
      text: parsed.text,
    });

    // If there are suggested events, render the Approve Schedule button
    if (parsed.events && parsed.events.length > 0) {
      const actionArea = msgEl.createDiv({
        cls: "chat-action-area",
      });

      const eventPreview = actionArea.createDiv({
        cls: "chat-event-preview",
      });
      eventPreview.createEl("strong", { text: `Suggested ${parsed.events.length} study block(s):` });

      const list = eventPreview.createEl("ul", {
        cls: "chat-event-list",
      });
      for (const event of parsed.events) {
        const startStr = new Date(event.startTime).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
        const endStr = new Date(event.endTime).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
        const li = list.createEl("li", {
          text: `${startStr} – ${endStr}: ${event.summary}`,
        });
        li.title = event.description;
      }

      const approveBtn = actionArea.createEl("button", {
        cls: "mod-cta",
        text: "✓ Approve Schedule",
      });
      approveBtn.addEventListener("click", async () => {
        await this.approveSchedule(parsed.events!);
        approveBtn.disabled = true;
        approveBtn.setText("✓ Events created");
      });
    }

    this.scrollToBottom();
  }

  private async approveSchedule(events: ScheduledEvent[]): Promise<void> {
    if (!this.plugin.settings.googleAccessToken) {
      new Notice("Cortex: Please connect Google Calendar first from the dashboard.");
      return;
    }

    let successCount = 0;
    for (const event of events) {
      try {
        const ok = await this.plugin.getCalendarService().createEvent({
          summary: event.summary,
          description: event.description,
          startTime: event.startTime,
          endTime: event.endTime,
        });
        if (ok) successCount++;
      } catch (err) {
        console.error(`Cortex: Failed to create event "${event.summary}":`, err);
      }
    }

    if (successCount === events.length) {
      new Notice(`Cortex: All ${successCount} event(s) added to your Google Calendar.`);
    } else {
      new Notice(`Cortex: ${successCount}/${events.length} event(s) added. Some may have failed.`);
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
      indicator.createDiv({ cls: "chat-message-label", text: "Cortex" });
      indicator.createDiv({ cls: "chat-loading-dots", text: "Thinking…" });
      this.scrollToBottom();
    } else {
      // Remove loading indicator
      const existing = this.historyContainer.querySelector("#chat-loading-indicator");
      if (existing) existing.remove();
      this.sendBtn.setText("Send");
    }
  }

  private scrollToBottom(): void {
    this.historyContainer.scrollTop = this.historyContainer.scrollHeight;
  }

  // ── Heuristics ───────────────────────────────────────────────────

  /**
   * Detect whether the user query is about scheduling / planning.
   * If so, enrich the Gemini call with due notes + calendar context.
   */
  private isSchedulingQuery(text: string): boolean {
    const lower = text.toLowerCase();
    const keywords = [
      "plan", "schedule", "study", "calendar", "today", "tomorrow",
      "when should i", "what should i review", "review plan",
      "create events", "add to calendar", "organize my day",
    ];
    return keywords.some((kw) => lower.includes(kw));
  }

  /**
   * Collect due notes data to send to Gemini.
   */
  private getDueNotesData(): unknown[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueNotes: unknown[] = [];

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      const rawDate = fm.next_review;
      if (!rawDate) continue;

      dueNotes.push({
        file: file.basename,
        next_review: rawDate,
        lastScore: fm.confidence ?? null,
        confidence: fm.confidence ?? null,
        interval: fm.interval ?? null,
        exam_date: fm.exam_date ?? null,
      });
    }

    return dueNotes;
  }

  /**
   * Try to extract a JSON array of ScheduledEvent objects from the AI response.
   * Falls back to returning the text with no events.
   */
  private parseResponseForEvents(text: string): AIResponseWithEvents {
    // Try to find a JSON array in the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { text, events: null };

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const hasEventShape = parsed.every(
          (item: unknown) =>
            typeof item === "object" &&
            item !== null &&
            "summary" in item &&
            "startTime" in item &&
            "endTime" in item,
        );
        if (hasEventShape) {
          const events = parsed as ScheduledEvent[];
          // Return the text with the JSON stripped out (so the user sees prose only)
          const cleanText = text.replace(jsonMatch[0], "").trim() || "Here's your suggested schedule:";
          return { text: cleanText, events };
        }
      }
    } catch {
      // Not valid JSON — just show the raw text
    }

    return { text, events: null };
  }
}
