/**
 * Compatibility shim for the original `GeminiService` class.
 *
 * The original `services/geminiService.ts` shipped a `GeminiService`
 * class with:
 *   - a `chat(history, dueNotes, calendarEvents)` method that
 *     built the study-planner (or general) system prompt and ran the
 *     multi-round function-calling loop against the configured AI
 *     adapter, and
 *   - a public `tools: ToolRegistry` field so the chat modal and
 *     plugin can register extra tools (notes, flashcards, tests, …).
 *
 * The new multi-provider AI layer uses a normalized `ChatRequest` /
 * `ChatResponse` shape and a shared `runWithTools` loop. This file
 * re-exports a `GeminiService` class with the same public surface,
 * delegating to the configured adapter while still owning the
 * ToolRegistry and the system-prompt builders.
 *
 * Note: the previous `tests` argument to `chat()` has been removed.
 * Upcoming tests are no longer injected into the system prompt; the
 * model calls the `list_tests` tool to discover them on demand.
 */
import { requestUrl } from "obsidian";
import { CortexSettings } from "../settings.js";
import { GoogleCalendarService } from "./googleCalendarService.js";
import { localISODate } from "../utils/dateUtils.js";
import { ToolRegistry, Tool, ToolContext } from "../agent/toolRegistry.js";
import { createCalendarTools } from "../agent/tools/calendar.js";
import { createAdapter } from "./ai/index.js";
import type { AIProviderAdapter } from "./ai/types.js";
import { getResponseStyle } from "./ai/index.js";
import { buildTimeContext } from "./ai/types.js";
import { runWithTools } from "./ai/runWithTools.js";
import type { ToolProgressEvent } from "./ai/runWithTools.js";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ScheduledEvent {
  summary: string;
  description: string;
  startTime: string; // ISO 8601 datetime string
  endTime: string;   // ISO 8601 datetime string
}

export class GeminiService {
  private settings: CortexSettings;
  private calendarService?: GoogleCalendarService;
  private readonly adapter: AIProviderAdapter;

  /**
   * Tool registry. The 4 calendar tools are auto-registered when a
   * calendar service is supplied. New tools (notes, flashcards) call
   * `registerTool()` or pass a registry via `setToolRegistry()`.
   */
  readonly tools: ToolRegistry = new ToolRegistry();

  constructor(settings: CortexSettings, calendarService?: GoogleCalendarService) {
    this.settings = settings;
    this.calendarService = calendarService;
    // Pick the adapter that matches the active provider. The chat
    // path must reach the same transport as the "Test connection"
    // button in settings — that button goes through `createAdapter`
    // directly, but chat was previously hardcoded to GeminiAdapter,
    // which sent every provider's traffic to Google and produced
    // HTTP 403s for LM Studio / Ollama / Anthropic / OpenAI / Cortex
    // Cloud users.
    this.adapter = createAdapter(settings);

    if (calendarService) {
      for (const t of createCalendarTools({
        calendarService,
        timeZone: () =>
          this.settings.timeZone ||
          Intl.DateTimeFormat().resolvedOptions().timeZone,
      })) {
        this.tools.register(t);
      }
    }
  }

  /**
   * Register an additional tool. Used by the chat modal / main to
   * wire in notes and flashcards without coupling this class to them.
   */
  registerTool(tool: Tool): void {
    this.tools.register(tool);
  }

  /**
   * Build the time-context string to inject into the system instruction.
   * Ensures the AI is always anchored to the real current date/time.
   */
  private getTimeContext(): string {
    return buildTimeContext(this.settings);
  }

  /**
   * Resolve the active response-style fragment. Provider-agnostic —
   * a single string that replaces the hard-coded "persona" and
   * trailing "Style:" lines in the system prompts. Falls back to
   * the "concise" preset if the stored id is missing or unknown,
   * so a partially-migrated vault or a removed style id never
   * crashes a chat turn.
   */
  private getStyleFragment(): string {
    return getResponseStyle(this.settings.ai.responseStyle).fragment;
  }

  /**
   * Build the system prompt for scheduling mode.
   *
   * This path is taken when the user asks for a study plan
   * (detected by `isSchedulingQuery` in the chat modal). The model
   * gets due notes + today's calendar as context, and is expected to
   * produce a JSON array of study events that the chat modal renders
   * as an "Approve Schedule" button.
   *
   * Upcoming tests are NOT injected here — the model calls the
   * `list_tests` tool to discover them. That keeps the system prompt
   * stable (the test list changes whenever the user adds a test) and
   * keeps per-prompt token cost predictable.
   *
   * Voice is set by the active `responseStyle` (same fragment as the
   * general prompt). The hard rules are tighter here because the output
   * is parsed by code, not read by a human — wrong date format =
   * silent corruption. The date rules stay; the box-drawing and
   * the "STRICT RULES — you MUST follow" posturing go.
   */
  private buildSystemPrompt(
    dueNotesJson: string,
    calendarEventsJson: string,
  ): string {
    const timeContext = this.getTimeContext();
    const now = new Date();
    const isoDate = localISODate(now);

    const parts = [
      timeContext,
      "",
      "You are Cortex. " +
        "Right now the user asked for a study plan, so we're in planning mode. " +
        "Build the most useful schedule you can for today, given their notes, their calendar, and the time they actually have. " +
        "Be opinionated. If a note is overdue and the test is tomorrow, it goes first. " +
        "Don't pad the day. Don't put things in sleep hours. Don't overlap with what's already on the calendar." +
        "",

      this.getStyleFragment(),

      "Today's date: " + isoDate + ". " +
        "Schedule every event on this exact date. " +
        "If you use a different date, the calendar will silently book it on the wrong day and the user will be furious." +
        "",

      "INPUT CONTEXT",
      "─────────────",
      "Due notes (pending review):",
      dueNotesJson || "(none — nothing is due today)",
      "",
      "Calendar events today:",
      calendarEventsJson || "(the day is wide open)",
    ];

    const wakeUp = this.settings.wakeUpTime || "07:00";
    const bedTime = this.settings.bedTime || "23:00";

    parts.push(
      "",
      "Daily routine:",
      "Wake: " + wakeUp + " · Bed: " + bedTime + ". " +
        "Never schedule study in the sleep window. " +
        "Never run a study block longer than 2 hours without inserting a 15-minute break. " +
        "Lowest-scoring notes go in the morning (peak attention). " +
        "Place new study blocks only in genuine free gaps — never on top of an existing event.",
    );

    parts.push(
      "",
      "How to build the plan:",
      "1. Look at what's due, prioritize by (a) test proximity and (b) low confidence.",
      "2. Find the real free slots in the calendar.",
      "3. Fill them with 25–60 minute blocks. Title each one like 'Review: Calculus limits'.",
      "4. Use the description field for context (the source note path, the topic, why this one).",
      "5. If a test is approaching, call list_tests for the target date to see which notes are in scope — don't guess from frontmatter.",
      "6. If you need a fresh view of the review queue (the context above may be stale), call list_reviews(target date) to re-pull it before prioritizing.",
    );

    const prefs = this.settings.planningPreferences?.trim();
    if (prefs) {
      parts.push(
        "",
        "The user's planning preferences (treat as hard rules — these reflect their actual life):",
        prefs,
      );
    }

    parts.push(
      "",
      "OUTPUT FORMAT — code reads this, so be exact:",
      "Return a single JSON array, nothing else. " +
        "No prose, no markdown fence, no explanation around it. " +
        "Each element: { summary, description, startTime, endTime }. " +
        "All times are full ISO 8601 datetimes for " + isoDate + ", " +
        "formatted as '" + isoDate + "THH:MM:SS+TZ' (e.g. '" + isoDate + "T10:00:00+02:00'). " +
        "If nothing is actually worth scheduling, return [].",
    );

    return parts.join("\n");
  }

  /**
   * Build the general (non-scheduling) system prompt for chat mode.
   *
   * `knowledgeState` is a short status string describing the
   * vault's knowledge index (e.g. "ready (1247 chunks indexed)"
   * or "empty — reindex required"). The caller passes it in
   * because the `GeminiService` itself doesn't have a plugin
   * reference — keeping the seam narrow means the service can
   * be unit-tested without standing up a fake vault.
   *
   * Voice & shape: this prompt is the user's first read of the
   * assistant. We open with a concrete persona (Cortex, not
   * "intelligent personal assistant"), then layer the active
   * response-style fragment in (see `RESPONSE_STYLES` in
   * `services/ai/catalog.ts`), then put the hard "don't lie" rules
   * up front where they belong, and keep the tool list to one line
   * per tool. Verbose compliance boilerplate pushes the persona
   * out of the effective context window.
   */
  private buildGeneralSystemPrompt(knowledgeState: string = "unknown"): string {
    return (
      this.getTimeContext() +
      "\n\nYou are Cortex. You live inside the user's Obsidian vault. " +
      "Your job is to help them study, revise, and remember things — and to keep their calendar honest when they ask. " +
      this.getStyleFragment() +

      "\n\nHard rules (these are non-negotiable):" +
      "\n- Never invent content from the user's notes. If you didn't read it via a tool, you don't know it. Say 'I couldn't find that' instead of guessing." +
      "\n- When you quote or paraphrase a note, cite it inline as a wikilink — [[NoteName]], no .md extension." +
      "\n- If the user asks for flashcards, draft them with propose_flashcard, then reply with ONLY a short framing sentence such as 'Here are the flashcards.' or 'I drafted some cards for you.' DO NOT reveal the answers, list the questions, or describe the card contents in your prose." +
      "\n- If the user asks for a quiz, call propose_quiz with well-formed questions, then reply with ONLY a short framing sentence such as 'Here is a quiz.' DO NOT reveal the correct answers, list the questions, or describe the quiz contents in your prose." +
      "\n- If the user's knowledge index is empty (the tool returns an error about it), tell them to open Cortex settings and click Reindex vault. Don't pretend to search." +
      `\n- Knowledge index status right now: ${knowledgeState}.` +

      "\n\nYour tools (use them, don't talk about them):" +
      "\n- search_notes(query) — find relevant chunks across the vault. Use this for any open-ended question about their notes." +
      "\n- read_note(path, heading?) — read a specific note in full, or just one section. Use after search_notes has identified a note worth reading." +
      "\n- list_notes(folder?, tag?) — browse what's in the vault when search returns nothing and you need to discover." +
      "\n- propose_flashcard(question, answer, source_note, test_name) — draft a flashcard. The user reviews and saves from the chat." +
      "\n- propose_quiz(test_name, questions) — draft an interactive multiple-choice quiz. The user answers inside the chat." +
      "\n- list_events / create_event / update_event / delete_event — Google Calendar. Only touch the calendar when the user asks." +
      "\n- list_tests(date?, include_done?) — find upcoming tests (exams) and the notes linked to each, for a given date. Use this whenever the user asks about an exam, revision, or what to study for a deadline. The test list is the only way to discover upcoming exams — they are not in this prompt." +
      "\n- list_reviews(date?) — find notes due for spaced-repetition review on a given date (defaults to today), with how overdue each one is and its confidence. Use this whenever the user asks what to review, what's due for revision, or wants to plan a revision session. Notes linked to a finished exam are auto-retired. The review queue is not in this prompt — call the tool." +

      "\n\nTool-calling rules:" +
      "\n- For any request that can be answered by a tool, you MUST call the tool instead of answering from memory." +
      "\n- Pass exact, complete arguments. If a required argument is missing, the tool will fail and you must fix it on the next turn." +
      "\n- If a tool returns an error, report the error to the user and stop; do not pretend the call succeeded." +
      "\n- If the tool result is insufficient, call another tool before replying." +

      "\n\nWorkflow examples:" +
      "\n- 'What do my notes say about X?' → search_notes('X') → (if relevant) read_note(path) → answer with [[NoteName]] citations." +
      "\n- 'Make flashcards for X' → search_notes('X') → read_note(path) → propose_flashcard(...) for each card." +
      "\n- 'Quiz me on X' → search_notes('X') → read_note(path) → propose_quiz(test_name='General', questions=[...])." +
      "\n- 'Plan my day' → list_tests() (for exam context) → list_events() → create_event(...) for each study block." +
      "\n- 'What should I review today?' → list_reviews() → (for each) search_notes or read_note → schedule via create_event if asked." +
      "\n- For calendar work, don't ask for an event ID — find it via list_events and act on it the same turn." +
      "\n- If something is ambiguous in a way that matters (e.g. two events with the same name, or a card topic the notes don't actually cover), ask one short clarifying question. Otherwise, just do it." +
      ""
    );
  }

  /**
   * General-purpose chat with the active AI adapter, with optional
   * study-planner context. Pass dueNotes and calendarEvents to enable
   * scheduling mode. Upcoming tests are NOT passed here — the model
   * calls the `list_tests` tool to discover them on demand.
   * Returns the assistant's text response.
   *
   * Internally this delegates to the shared `runWithTools` loop with
   * the configured `adapter`. The function-call semantics, model URL,
   * and tool-declaration shape are identical to the pre-refactor
   * implementation; the prompt and tool execution are unchanged.
   */
  async chat(
    history: ChatMessage[],
    dueNotes?: unknown[],
    calendarEvents?: unknown[],
    /**
     * Short status of the vault's knowledge index, surfaced in the
     * system prompt so the model can mention "your index is empty,
     * please reindex" instead of pretending to search. The caller
     * (the chat modal) builds this from the live `KnowledgeBase`
     * because the service itself doesn't have a plugin reference.
     */
    knowledgeState?: string,
    /**
     * Observational progress callback. Fires as the tool-calling loop
     * runs — one event per round, per tool call, and per tool result —
     * so the chat UI can show what the agent is doing instead of a
     * static "Thinking…" indicator. Optional; omitting it is a no-op.
     */
    onProgress?: (event: ToolProgressEvent) => void,
  ): Promise<string> {
    let systemPrompt: string;

    if (dueNotes && calendarEvents) {
      systemPrompt = this.buildSystemPrompt(
        JSON.stringify(dueNotes, null, 2),
        JSON.stringify(calendarEvents, null, 2),
      );
    } else {
      systemPrompt = this.buildGeneralSystemPrompt(knowledgeState);
    }

    const messages = history.map((m) => ({
      role: m.role,
      text: m.text,
    })) as Array<{ role: "user" | "assistant"; text: string }>;

    return runWithTools(
      this.adapter,
      {
        system: systemPrompt,
        messages,
        tools: this.toolDeclarationsAsList(),
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
      {
        execute: (name, args) => this.dispatchTool(name, args),
      },
      {
        maxRounds: this.settings.ai.maxToolRounds,
        onEvent: onProgress,
      },
    );
  }

  /**
   * Convert the ToolRegistry's Gemini-shaped declarations to the
   * normalized list shape the new adapter layer expects.
   */
  private toolDeclarationsAsList(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> | undefined {
    const decls = this.tools.declarations();
    if (!decls || decls.length === 0) return undefined;
    return decls[0].functionDeclarations.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters as unknown as Record<string, unknown>,
    }));
  }

  /**
   * Dispatch a tool call through the ToolRegistry. The registry
   * returns a string result (or an error string) and we just hand it
   * back to the model. The `ctx.plugin` is null here because the
   * function-call loop doesn't have a plugin instance in scope; tools
   * that need vault access get it via a closure (see
   * `createCalendarTools`).
   */
  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const ctx: ToolContext = { plugin: null };
    return this.tools.execute({ name, args }, ctx);
  }
}

export { requestUrl };
