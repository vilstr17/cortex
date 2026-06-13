import { requestUrl } from "obsidian";
import { CortexSettings, CortexTest } from "../settings";
import { GoogleCalendarService } from "./googleCalendarService";
import { localISODate, parseLocalDate, startOfLocalDay } from "../utils/dateUtils";

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

// ── Gemini API Response Types ─────────────────────────────────────

interface GeminiApiCandidate {
  content?: {
    parts?: Array<{
      text?: string;
      functionCall?: GeminiFunctionCall;
    }>;
  };
}

interface GeminiApiResponse {
  candidates?: GeminiApiCandidate[];
}

function isGeminiApiResponse(obj: unknown): obj is GeminiApiResponse {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    ("candidates" in obj ? Array.isArray((obj as Record<string, unknown>).candidates) : true)
  );
}

// ── Gemini Function Calling Types ──────────────────────────────────

interface GeminiFunctionParameter {
  type: string;
  description: string;
  properties?: Record<string, GeminiFunctionParameter>;
  required?: string[];
  items?: GeminiFunctionParameter;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiFunctionParameter;
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

interface GeminiFunctionResponse {
  name: string;
  response: {
    result: string;
    details?: string;
  };
}

interface GeminiContentPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

interface GeminiContent {
  role: string;
  parts: GeminiContentPart[];
}

export class GeminiService {
  private settings: CortexSettings;
  private calendarService?: GoogleCalendarService;
  private readonly API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
  private history: GeminiContent[] = [];

  constructor(settings: CortexSettings, calendarService?: GoogleCalendarService) {
    this.settings = settings;
    this.calendarService = calendarService;
    this.history = [];
  }

  private get model(): string {
    return this.settings.geminiModel || "gemini-2.5-flash";
  }

  private get apiKey(): string {
    return this.settings.geminiApiKey;
  }

  /**
   * Build the time-context string to inject into the system instruction.
   * Ensures the AI is always anchored to the real current date/time.
   */
  private getTimeContext(): string {
    const now = new Date();
    // Použijeme undefined, aby si systém sám vybral jazyk podle nastavení OS/Obsidianu
    const locale = undefined;
  
    const dateStr = now.toLocaleDateString(locale, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const isoDate = localISODate(now);
    const timeStr = now.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  
    const timeZone = this.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  
    // Do System Note přidáme instrukci, aby se přizpůsobil jazyku uživatele a používal správnou časovou zónu
    return `[System Note: Current date is ${dateStr} (${isoDate}), current local time is ${timeStr}. Timezone is ${timeZone}. NEVER use UTC/Z-suffix. All times are local. Always respond in the language the user uses.]`;
  }

  /**
   * Tool declarations for Gemini Function Calling.
   * These enable Gemini to actually execute calendar operations instead of hallucinating.
   */
  private getToolDeclarations(): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> {
    return [
      {
        functionDeclarations: [
          {
            name: "list_events",
            description: "List all calendar events for a specific date. Returns event details including id, summary, start time, and end time.",
            parameters: {
              type: "OBJECT",
              description: "The date to list events for",
              properties: {
                date: {
                  type: "STRING",
                  description: "The date in ISO 8601 format (e.g., 2026-04-12). If not specified, uses today.",
                },
              },
              required: [],
            },
          },
          {
            name: "delete_event",
            description: "Delete a specific calendar event by its event ID. Use this when the user asks to remove or delete an event.",
            parameters: {
              type: "OBJECT",
              description: "Parameters for deleting an event",
              properties: {
                event_id: {
                  type: "STRING",
                  description: "The Google Calendar event ID to delete. Get this from list_events results.",
                },
              },
              required: ["event_id"],
            },
          },
          {
            name: "create_event",
            description: "Create a new calendar event. Use this when the user asks to add, create, or schedule an event.",
            parameters: {
              type: "OBJECT",
              description: "Parameters for creating an event",
              properties: {
                summary: {
                  type: "STRING",
                  description: "Event title (e.g., 'Review: Calculus limits')",
                },
                description: {
                  type: "STRING",
                  description: "Event description or notes",
                },
                start_time: {
                  type: "STRING",
                  description: "Start time in ISO 8601 format (e.g., 2026-04-12T10:00:00+02:00)",
                },
                end_time: {
                  type: "STRING",
                  description: "End time in ISO 8601 format (e.g., 2026-04-12T11:00:00+02:00)",
                },
              },
              required: ["summary", "start_time", "end_time"],
            },
          },
          {
            name: "update_event",
            description: "Update an existing calendar event. Use this when the user asks to move, reschedule, or modify an event.",
            parameters: {
              type: "OBJECT",
              description: "Parameters for updating an event",
              properties: {
                event_id: {
                  type: "STRING",
                  description: "The Google Calendar event ID to update",
                },
                summary: {
                  type: "STRING",
                  description: "New event title (optional)",
                },
                description: {
                  type: "STRING",
                  description: "New description (optional)",
                },
                start_time: {
                  type: "STRING",
                  description: "New start time in ISO 8601 format (optional)",
                },
                end_time: {
                  type: "STRING",
                  description: "New end time in ISO 8601 format (optional)",
                },
              },
              required: ["event_id"],
            },
          },
        ],
      },
    ];
  }

  /**
   * Execute a function call from Gemini and return the result.
   */
  private async executeFunctionCall(
    functionCall: GeminiFunctionCall,
  ): Promise<string> {
    const { name, args } = functionCall;

    if (!this.calendarService) {
      return "Error: Google Calendar service is not connected. Please connect it first.";
    }

    try {
      switch (name) {
        case "list_events": {
          const dateStr = typeof args.date === "string" ? args.date : localISODate();
          const targetDate = parseLocalDate(dateStr) || startOfLocalDay(new Date());
          const events = await this.calendarService.getEventsForDay(targetDate);

          if (events.length === 0) {
            return `No events found for ${dateStr}.`;
          }

          const eventList = events
            .map(
              (e) =>
                `- ID: ${e.id} | ${e.summary} | ${e.startTime.toISOString()} → ${e.endTime.toISOString()}`
            )
            .join("\n");

          return `Found ${events.length} event(s) for ${dateStr}:\n${eventList}`;
        }

        case "delete_event": {
          const eventId = typeof args.event_id === "string" ? args.event_id : "";
          if (!eventId) {
            return "Error: event_id is required to delete an event.";
          }

          const success = await this.calendarService.deleteEvent(eventId);
          if (success) {
            return `Successfully deleted event ${eventId}.`;
          } else {
            return `Failed to delete event ${eventId}. It may not exist or you may not have permission.`;
          }
        }

        case "create_event": {
          const summary = typeof args.summary === "string" ? args.summary : "";
          let startTime = typeof args.start_time === "string" ? args.start_time : "";
          let endTime = typeof args.end_time === "string" ? args.end_time : "";
          const description = typeof args.description === "string" ? args.description : "";
        
          if (!summary || !startTime || !endTime) {
            return "Error: summary, start_time, and end_time are required to create an event.";
          }
        
          // Strip 'Z' suffix if present (Gemini sometimes sends UTC format)
          startTime = startTime.replace(/Z$/, "");
          endTime = endTime.replace(/Z$/, "");
        
          const timeZone = this.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        
          const success = await this.calendarService.createEvent({
            summary,
            description,
            startTime,
            endTime,
            timeZone,
          });
        
          if (success) {
            return `Successfully created event "${summary}" from ${startTime} to ${endTime}.`;
          } else {
            return `Failed to create event "${summary}".`;
          }
        }

        case "update_event": {
          const eventId = typeof args.event_id === "string" ? args.event_id : "";
          if (!eventId) {
            return "Error: event_id is required to update an event.";
          }

          let startTime = typeof args.start_time === "string" ? args.start_time : undefined;
          let endTime = typeof args.end_time === "string" ? args.end_time : undefined;
        
          // Strip 'Z' suffix if present (Gemini sometimes sends UTC format)
          if (startTime) startTime = startTime.replace(/Z$/, "");
          if (endTime) endTime = endTime.replace(/Z$/, "");
        
          const timeZone = this.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        
          const success = await this.calendarService.updateEvent(eventId, {
            summary: typeof args.summary === "string" ? args.summary : undefined,
            description: typeof args.description === "string" ? args.description : undefined,
            startTime,
            endTime,
            timeZone,
          });
        
          if (success) {
            return `Successfully updated event ${eventId}.`;
          } else {
            return `Failed to update event ${eventId}. It may not exist or you may not have permission.`;
          }
        }

        default:
          return `Error: Unknown function "${name}". Available functions: list_events, delete_event, create_event, update_event.`;
      }
    } catch (err) {
      console.error(`Cortex: Function call "${name}" failed:`, err);
      return `Error executing ${name}: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  /**
   * Build the system prompt that instructs Gemini to act as a study-planner AI.
   */
  private buildSystemPrompt(
    dueNotesJson: string,
    calendarEventsJson: string,
    testsJson?: string,
  ): string {
    const timeContext = this.getTimeContext();
    const now = new Date();
    const isoDate = localISODate(now);

    const parts = [
      timeContext,
      "",
      "═══════════════════════════════════════════",
      "ROLE & BEHAVIOR",
      "═══════════════════════════════════════════",
      "",
      "You are an intelligent personal assistant integrated into Obsidian.",
      "Your goal is to help the user manage their knowledge and schedule.",
      "",
      "CRITICAL: ONLY create or modify calendar events when explicitly asked or when it is a direct result of a study plan request.",
      "Do NOT generate a study plan or calendar events unless the user specifically asks for it.",
      "You can answer questions, summarize notes, and manage Google Calendar (list, create, delete, move events).",
      "Always check the current date and time provided in the context before performing any calendar actions.",
      "",
      "TOOL USAGE — CRITICAL:",
      "You have access to calendar management tools: list_events, delete_event, create_event, update_event.",
      "When the user asks you to list, delete, create, or modify calendar events, YOU MUST USE THESE TOOLS.",
      "Do NOT just say you performed an action — actually call the appropriate tool.",
      "If you say you deleted an event without calling delete_event, the user will not see any change.",
      "Always use tools to get real results before confirming any calendar action to the user.",
      "",
      "═══════════════════════════════════════════",
      "CURRENT DATE & TIME — GROUND TRUTH",
      "═══════════════════════════════════════════",
      "",
      `IMPORTANT: The current date is ${isoDate}.`,
      `You MUST schedule all events for TODAY (${isoDate}).`,
      `Do not use any other date. Do not confuse day and month.`,
      `Use exactly '${isoDate}' for the date portion of startTime and endTime in ALL events.`,
      "",
      "When the user asks for a study plan, you are a study-planner AI assistant. Create an optimal study schedule for today based on the user's pending review notes and existing calendar commitments.",
      "",
      "═══════════════════════════════════════════",
      "INPUT CONTEXT",
      "═══════════════════════════════════════════",
      "",
      "--- Due Notes (pending review) ---",
      dueNotesJson || "(None — no notes are due for review.)",
      "",
      "--- Existing Calendar Events (today: " + isoDate + ") ---",
      calendarEventsJson || "(None — the day is wide open.)",
    ];

    // Add tests context if provided
    if (testsJson) {
      parts.push(
        "",
        "--- Upcoming Tests ---",
        testsJson,
        "",
        "═══════════════════════════════════════════",
        "TEST-AWARE STUDY PLANNING",
        "═══════════════════════════════════════════",
        "",
        "You can see the user's upcoming tests. When the user asks for a study plan, prioritize files that are associated with the closest upcoming test.",
        "If a test is in 2 days and the user hasn't reviewed half of the files, warn them and prioritize those files in the calendar.",
        "",
        "RULES FOR TEST-AWARE PLANNING:",
        "1. Always check the test dates and their associated filePaths.",
        "2. Prioritize study blocks for files linked to the closest upcoming tests.",
        "3. If a test is within 48 hours and fewer than 50% of its associated files have been reviewed (check next_review dates), warn the user explicitly.",
        "4. In your warning, mention which files need urgent attention before the test.",
        "5. Schedule those urgent files FIRST in the calendar, before less time-sensitive material.",
        "6. For tests further in the future, distribute review more evenly across available days.",
      );
    }
    
    const wakeUp = this.settings.wakeUpTime || "07:00";
    const bedTime = this.settings.bedTime || "23:00";

    parts.push(
      "",
      "═══════════════════════════════════════════",
      "DAILY ROUTINE & EFFICIENCY RULES",
      "═══════════════════════════════════════════",
      `Wake Up Time: ${wakeUp}`,
      `Bed Time: ${bedTime}`,
      "",
      "Your primary goal is to optimize the user's learning efficiency, not just fill slots.",
      "Respect the Daily Routine: Never schedule study during sleep hours.",
      "Block Limits: Never schedule continuous study blocks longer than 2 hours. Automatically insert a 15-minute 'Break' event after any long block.",
      "Prioritization: Look at the lastScore of pending reviews. Schedule the lowest scores during the user's peak morning hours. High scores can be reviewed later in the day.",
      "Calendar Awareness: You MUST check existing calendar events and only place new study sessions in genuine free gaps."
    );

    parts.push(
      "",
      "═══════════════════════════════════════════",
      "TASK",
      "═══════════════════════════════════════════",
      "",
      "1. Examine the Due Notes above and determine which ones warrant a study block today.",
      "2. Look at the Existing Calendar Events and fit study blocks into the gaps — never create overlaps.",
      "3. Each study block should be 25–60 minutes depending on note complexity and total count.",
      "4. Use 'summary' for a short title (e.g., \"Review: Calculus limits\").",
      "5. Use 'description' for extra context (e.g., original note path, topic hints).",
      "",
      "DATE & TIME FORMAT — STRICT:",
      `- All 'startTime' and 'endTime' values MUST be full ISO 8601 datetimes for TODAY (${isoDate}).`,
      `- Format: "${isoDate}THH:MM:SS+TZ" (e.g., "${isoDate}T10:00:00+02:00").`,
      `- The date portion MUST be ${isoDate}. The time portion MUST be HH:MM:SS with your local timezone offset.`,
      "- Never output a date-only string. Always include the full datetime with timezone.",
    );

    // Inject user planning preferences as STRICT rules
    const prefs = this.settings.planningPreferences?.trim();
    if (prefs) {
      parts.push(
        "",
        "═══════════════════════════════════════════",
        "USER PLANNING PREFERENCES (STRICT RULES — you MUST follow these)",
        "═══════════════════════════════════════════",
        prefs,
      );
    }

    parts.push(
      "",
      "═══════════════════════════════════════════",
      "OUTPUT",
      "═══════════════════════════════════════════",
      "",
      "Create a specific study schedule for the Due Notes above.",
      "Return ONLY a valid JSON array. No markdown, no explanation, no code fences.",
      "Each element must have exactly these keys: summary, description, startTime, endTime.",
      `Use exactly '${isoDate}' as the date in startTime and endTime for every event.`,
      "If no study sessions are needed, return an empty array [].",
    );

    return parts.join("\n");
  }

  /**
   * Build the general (non-scheduling) system prompt for chat mode.
   */
  private buildGeneralSystemPrompt(): string {
    const wakeUp = this.settings.wakeUpTime || "07:00";
    const bedTime = this.settings.bedTime || "23:00";

    return (
      this.getTimeContext() +
      "\n\nYou operate in the timezone specified in the context. Always provide and accept times in local format. Do not convert to UTC." +
      "\n\nYou are an intelligent personal assistant integrated into Obsidian. " +
      "Your goal is to help the user manage their knowledge and schedule. " +
      `\n\nDaily Routine:\nWake Up Time: ${wakeUp}\nBed Time: ${bedTime}` +
      "\n\nScheduling Rules:\n" +
      "- Your primary goal is to optimize the user's learning efficiency, not just fill slots.\n" +
      "- Respect the Daily Routine: Never schedule study during sleep hours.\n" +
      "- Block Limits: Never schedule continuous study blocks longer than 2 hours. Automatically insert a 15-minute 'Break' event after any long block.\n" +
      "- Prioritization: Look at the lastScore of pending reviews. Schedule the lowest scores during the user's peak morning hours. High scores can be reviewed later in the day.\n" +
      "- Calendar Awareness: You MUST check existing calendar events and only place new study sessions in genuine free gaps.\n" +
      "\nONLY create or modify calendar events when explicitly asked. " +
      "Do not generate study plans or calendar events unless specifically requested. " +
      "You can answer questions, summarize notes, and manage Google Calendar (list, create, delete, move events). " +
      "Always check the current date and time provided in the context before performing any calendar actions. " +
      "Be concise and practical. Always respond in users language." +
      "\n\nTOOL USAGE — CRITICAL: " +
      "You have access to calendar management tools: list_events, delete_event, create_event, update_event. " +
      "When the user asks you to list, delete, create, or modify calendar events, YOU MUST USE THESE TOOLS. " +
      "Do NOT just say you performed an action — actually call the appropriate tool. " +
      "If you say you deleted an event without calling delete_event, the user will not see any change. " +
      "Always use tools to get real results before confirming any calendar action to the user." +
      "\n\nAUTONOMOUS BEHAVIOR — STRICT RULES:" +
      "1. NEVER ask the user for an Event ID. Users do not know IDs." +
      "2. If the user asks to delete, move, or modify an event by its name, DO NOT ask for permission to search. Immediately use the list_events tool to find the event's ID, then call the appropriate tool (delete_event, update_event) in the same turn." +
      "3. Chain actions: After list_events returns results, immediately execute the requested action (delete, update) without asking for confirmation." +
      "4. No unnecessary confirmations: Only ask for clarification if multiple events have the exact same name and you are genuinely confused. Otherwise, just execute the user's request silently and reply with 'Done'." +
      "5. Be proactive: If the user says 'delete my 3pm meeting', search for events around 3pm using list_events and delete the matching one automatically."
    );
  }

  /**
   * General-purpose chat with Gemini, with optional study-planner context.
   * Pass dueNotes, calendarEvents, and tests to enable scheduling mode.
   * Returns the assistant's text response.
   */
  async chat(
    history: ChatMessage[],
    dueNotes?: unknown[],
    calendarEvents?: unknown[],
    tests?: CortexTest[],
  ): Promise<string> {
    let systemPrompt: string;

    if (dueNotes && calendarEvents) {
      systemPrompt = this.buildSystemPrompt(
        JSON.stringify(dueNotes, null, 2),
        JSON.stringify(calendarEvents, null, 2),
        tests ? JSON.stringify(tests, null, 2) : undefined,
      );
    } else {
      systemPrompt = this.buildGeneralSystemPrompt();
    }

    // Reset history for this conversation turn
    this.history = [];

    // Build the conversation contents from history + system prompt
    const userMessages: GeminiContent[] = history.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.text }],
    }));

    // Add user messages to history
    for (const msg of userMessages) {
      this.history.push(msg);
    }

    // Prepend system instruction
    const url = `${this.API_URL}/${this.model}:generateContent?key=${this.apiKey}`;

    // Maximum number of function call rounds to prevent infinite loops
    const MAX_FUNCTION_CALL_ROUNDS = 10;
    let functionCallRounds = 0;

    while (functionCallRounds < MAX_FUNCTION_CALL_ROUNDS) {
      functionCallRounds++;

      const body: Record<string, unknown> = {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: this.history,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      };

      // Include tools if calendar service is available
      if (this.calendarService) {
        body.tools = this.getToolDeclarations();
      }

      const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = response.json;
      if (!isGeminiApiResponse(data)) {
        console.error("Cortex: Gemini returned an unexpected response structure.", data);
        return "Sorry, I couldn't process that request.";
      }
      const candidates = data.candidates;
      if (!candidates || candidates.length === 0) {
        console.error("Cortex: Gemini returned no candidates.", data);
        return "Sorry, I couldn't process that request.";
      }

      const candidate = candidates[0];
      const parts: GeminiContentPart[] = candidate?.content?.parts ?? [];

      // Check if Gemini wants to call a function
      const functionCallPart = parts.find((p) => p.functionCall);

      if (functionCallPart?.functionCall) {
        const functionCall = functionCallPart.functionCall;
        console.log(`Cortex: Gemini requested function call: ${functionCall.name}`, functionCall.args);

        // STEP 1: FIRST push the model's function call to history (EXACTLY as returned by the model)
        this.history.push({
          role: "model",
          parts: [{ functionCall: functionCall }],
        });

        // STEP 2: Execute the function call locally
        const functionResult = await this.executeFunctionCall(functionCall);
        console.log(`Cortex: Function call result:`, functionResult);

        // STEP 3: Create the function response message
        // For the REST API, role MUST be "function" and response MUST be a JSON object (not a string)
        const responseMessage: GeminiContent = {
          role: "function",
          parts: [{
            functionResponse: {
              name: functionCall.name,
              response: {
                // This MUST be a JSON object, not a string
                result: "Success",
                details: functionResult,
              },
            },
          }],
        };

        // Push the function response to history
        this.history.push(responseMessage);

        // STEP 4: Send the ENTIRE updated history back to generateContent
        // Loop back so the model can generate its final text response
        console.log(`Cortex: History after function call:`, JSON.stringify(this.history, null, 2));
        continue;
      }

      // No function call — extract the text response
      const rawText: string = parts[0]?.text ?? "";

      if (!rawText) {
        console.warn("Cortex: Gemini returned empty text.");
        return "Sorry, I didn't have a response for that.";
      }

      // Push the model's response to history
      this.history.push({
        role: "model",
        parts: [{ text: rawText }],
      });

      return rawText.trim();
    }

    // If we hit the max rounds, return what we have
    console.warn(`Cortex: Hit maximum function call rounds (${MAX_FUNCTION_CALL_ROUNDS}).`);
    return "I processed your request but hit a limit on the number of operations. Please try again if needed.";
  }

}
