/**
 * Calendar tool: list, create, update, delete Google Calendar events.
 *
 * These four tools already exist in the previous `geminiService.ts`
 * `executeFunctionCall` switch. They are moved here verbatim (modulo
 * the wrapper shape) so the rest of the agent can register them like
 * any other tool and we have a single place to add more calendar
 * operations later (move-to-date, recurring events, free/busy lookup).
 */

import { Tool, ToolContext } from "../toolRegistry";
import { GoogleCalendarService } from "../../services/googleCalendarService";
import { localISODate, parseLocalDate, startOfLocalDay } from "../../utils/dateUtils";

/**
 * The four calendar tools the agent can call. We declare them as
 * factory functions rather than constants so the closures bind to the
 * concrete `GoogleCalendarService` and `CortexSettings` instance the
 * caller passes in.
 */
export function createCalendarTools(deps: {
  calendarService: GoogleCalendarService;
  timeZone: () => string;
}): Tool[] {
  const { calendarService, timeZone } = deps;

  return [
    {
      name: "list_events",
      description:
        "List all calendar events for a specific date. Returns event details including id, summary, start time, and end time.",
      parameters: {
        type: "OBJECT",
        description: "The date to list events for",
        properties: {
          date: {
            type: "STRING",
            description:
              "The date in ISO 8601 format (e.g., 2026-04-12). If not specified, uses today.",
          },
        },
        required: [],
      },
      async execute(args) {
        const dateStr =
          typeof args.date === "string" ? args.date : localISODate();
        const targetDate = parseLocalDate(dateStr) || startOfLocalDay(new Date());
        const events = await calendarService.getEventsForDay(targetDate);
        if (events.length === 0) {
          return `No events found for ${dateStr}.`;
        }
        const eventList = events
          .map(
            (e) =>
              `- ID: ${e.id} | ${e.summary} | ${e.startTime.toISOString()} → ${e.endTime.toISOString()}`,
          )
          .join("\n");
        return `Found ${events.length} event(s) for ${dateStr}:\n${eventList}`;
      },
    },

    {
      name: "delete_event",
      description:
        "Delete a specific calendar event by its event ID. Use this when the user asks to remove or delete an event.",
      parameters: {
        type: "OBJECT",
        description: "Parameters for deleting an event",
        properties: {
          event_id: {
            type: "STRING",
            description:
              "The Google Calendar event ID to delete. Get this from list_events results.",
          },
        },
        required: ["event_id"],
      },
      async execute(args) {
        const eventId = typeof args.event_id === "string" ? args.event_id : "";
        if (!eventId) return "Error: event_id is required to delete an event.";
        const success = await calendarService.deleteEvent(eventId);
        return success
          ? `Successfully deleted event ${eventId}.`
          : `Failed to delete event ${eventId}. It may not exist or you may not have permission.`;
      },
    },

    {
      name: "create_event",
      description:
        "Create a new calendar event. Use this when the user asks to add, create, or schedule an event.",
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
            description:
              "Start time in ISO 8601 format (e.g., 2026-04-12T10:00:00+02:00)",
          },
          end_time: {
            type: "STRING",
            description:
              "End time in ISO 8601 format (e.g., 2026-04-12T11:00:00+02:00)",
          },
        },
        required: ["summary", "start_time", "end_time"],
      },
      async execute(args) {
        const summary = typeof args.summary === "string" ? args.summary : "";
        // Strip trailing Z if Gemini sends UTC.
        const startTime =
          typeof args.start_time === "string"
            ? args.start_time.replace(/Z$/, "")
            : "";
        const endTime =
          typeof args.end_time === "string" ? args.end_time.replace(/Z$/, "") : "";
        const description =
          typeof args.description === "string" ? args.description : "";

        if (!summary || !startTime || !endTime) {
          return "Error: summary, start_time, and end_time are required to create an event.";
        }

        const success = await calendarService.createEvent({
          summary,
          description,
          startTime,
          endTime,
          timeZone: timeZone(),
        });
        return success
          ? `Successfully created event "${summary}" from ${startTime} to ${endTime}.`
          : `Failed to create event "${summary}".`;
      },
    },

    {
      name: "update_event",
      description:
        "Update an existing calendar event. Use this when the user asks to move, reschedule, or modify an event.",
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
      async execute(args) {
        const eventId = typeof args.event_id === "string" ? args.event_id : "";
        if (!eventId) return "Error: event_id is required to update an event.";

        const startTime =
          typeof args.start_time === "string"
            ? args.start_time.replace(/Z$/, "")
            : undefined;
        const endTime =
          typeof args.end_time === "string"
            ? args.end_time.replace(/Z$/, "")
            : undefined;

        const success = await calendarService.updateEvent(eventId, {
          summary:
            typeof args.summary === "string" ? args.summary : undefined,
          description:
            typeof args.description === "string" ? args.description : undefined,
          startTime,
          endTime,
          timeZone: timeZone(),
        });
        return success
          ? `Successfully updated event ${eventId}.`
          : `Failed to update event ${eventId}. It may not exist or you may not have permission.`;
      },
    },
  ];
}
