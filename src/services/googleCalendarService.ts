import { requestUrl } from "obsidian";
import { CortexSettings } from "../settings";

// Google OAuth 2.0 credentials — replace before distributing.
const GOOGLE_CLIENT_ID = "243033885510-h3dur7p7gm579nk5o2s0prr3pppp1fjb.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "";

// ── Public interfaces ──────────────────────────────────────────────

export interface DisplayCalendarEvent {
  id: string;
  summary: string;
  startTime: Date;
  endTime: Date;
  htmlLink?: string;
}

export interface SimplifiedEvent {
  title: string;
  startTime: string;
  endTime: string;
}

// ── Internal interfaces ────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  htmlLink?: string;
}

/**
 * Google Calendar service using OAuth 2.0 Device Authorization Grant.
 * Works in browser / Obsidian environments without a local redirect server.
 */
export class GoogleCalendarService {
  private readonly TOKEN_URL = "https://oauth2.googleapis.com/token";
  private readonly DEVICE_AUTH_URL = "https://oauth2.googleapis.com/device/code";
  private readonly CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  private readonly CALENDAR_EVENTS_SCOPES = "https://www.googleapis.com/auth/calendar.events";
  private readonly CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
  private readonly COMBINED_SCOPES = `${this.CALENDAR_EVENTS_SCOPES} ${this.CALENDAR_READONLY_SCOPE}`;

  private settings: CortexSettings;
  private saveSettingsCallback: () => Promise<void>;

  constructor(settings: CortexSettings, saveSettingsCallback: () => Promise<void>) {
    this.settings = settings;
    this.saveSettingsCallback = saveSettingsCallback;
  }

  // ── Token management ─────────────────────────────────────────────

  /**
   * Refresh the access token using the stored refresh token.
   */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.settings.googleRefreshToken) return false;

    try {
      const response = await requestUrl({
        url: this.TOKEN_URL,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: this.settings.googleRefreshToken,
          grant_type: "refresh_token",
        }).toString(),
      });

      const data = response.json as TokenResponse;
      if (data.error) {
        console.error("Cortex: Google token refresh failed:", data.error);
        return false;
      }

      this.settings.googleAccessToken = data.access_token;
      this.settings.googleTokenExpiry = Date.now() + data.expires_in * 1000;
      await this.saveSettingsCallback();
      return true;
    } catch (err) {
      console.error("Cortex: Failed to refresh Google token:", err);
      return false;
    }
  }

  /**
   * Ensure we have a valid, non-expired access token. Refreshes if needed.
   */
  private async ensureValidToken(): Promise<boolean> {
    if (!this.settings.googleAccessToken) return false;

    if (Date.now() < this.settings.googleTokenExpiry - 60_000) {
      return true;
    }

    return this.refreshAccessToken();
  }

  // ── Calendar operations ──────────────────────────────────────────

  /**
   * Create a new event in the primary calendar.
   */
  async createEvent(options: {
    summary: string;
    description?: string;
    startTime: string; // ISO 8601 datetime string
    endTime: string; // ISO 8601 datetime string
    timeZone?: string; // IANA timezone name (e.g., Europe/Prague)
  }): Promise<boolean> {
    const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const eventData = {
      summary: options.summary,
      description: options.description ?? "",
      start: { dateTime: options.startTime, timeZone },
      end: { dateTime: options.endTime, timeZone },
    };

    console.log("Cortex: Creating event with payload:", JSON.stringify(eventData));
    console.log("Cortex: Access token present:", !!this.settings.googleAccessToken);

    const response = await requestUrl({
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.settings.googleAccessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventData),
      throw: false,
    });

    if (response.status !== 200) {
      console.error("Cortex: Failed to create event. Google response:", response.text);
      console.error("Cortex: Response status:", response.status);
      throw new Error("Failed to create event");
    } else {
      console.log("Cortex: Event created successfully!");
      console.log("Cortex: Google response:", response.text);
      return true;
    }
  }

  /**
   * Fetch calendar events for a specific day (primary calendar).
   */
  async getEventsForDay(day: Date): Promise<DisplayCalendarEvent[]> {
    const hasToken = await this.ensureValidToken();
    if (!hasToken) return [];

    const startOfDay = new Date(day);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);

    const params = new URLSearchParams({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });

    console.log(`Cortex: Fetching events for ${startOfDay.toISOString()} → ${endOfDay.toISOString()}`);

    try {
      const response = await requestUrl({
        url: `${this.CALENDAR_API}?${params.toString()}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settings.googleAccessToken}`,
        },
      });

      const data = response.json;
      const items: CalendarEvent[] = data?.items ?? [];
      console.log(`Cortex: Found ${items.length} event(s) for the day.`);

      return items
        .map((item): DisplayCalendarEvent | null => {
          const startStr = item.start?.dateTime ?? item.start?.date;
          const endStr = item.end?.dateTime ?? item.end?.date;
          if (!startStr || !endStr) return null;

          return {
            id: item.id ?? "",
            summary: item.summary ?? "(No title)",
            startTime: new Date(startStr),
            endTime: new Date(endStr),
            htmlLink: item.htmlLink,
          };
        })
        .filter((e): e is DisplayCalendarEvent => e !== null);
    } catch (err) {
      console.error("Cortex: Failed to fetch calendar events:", err);
      return [];
    }
  }

  /**
   * Delete an event by its Google Calendar event ID.
   */
  async deleteEvent(eventId: string): Promise<boolean> {
    const hasToken = await this.ensureValidToken();
    if (!hasToken) {
      console.error("Cortex: Cannot delete event — no valid Google access token.");
      return false;
    }

    console.log(`Cortex: Deleting event ${eventId}…`);

    const response = await requestUrl({
      url: `${this.CALENDAR_API}/${encodeURIComponent(eventId)}`,
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.settings.googleAccessToken}`,
      },
      throw: false,
    });

    if (response.status === 204) {
      console.log("Cortex: Event deleted successfully.");
      return true;
    }

    console.error(`Cortex: Failed to delete event ${eventId}. Status: ${response.status}`, response.text);
    return false;
  }

  /**
   * Delete all events for a specific day.
   * Returns { attempted, succeeded, failed }.
   */
  async deleteEventsForDay(day: Date): Promise<{ attempted: number; succeeded: number; failed: number }> {
    const events = await this.getEventsForDay(day);

    let succeeded = 0;
    let failed = 0;

    for (const event of events) {
      const ok = await this.deleteEvent(event.id);
      if (ok) succeeded++;
      else failed++;
    }

    return { attempted: events.length, succeeded, failed };
  }

  /**
   * Update an existing event by its Google Calendar event ID.
   * Only the fields provided in `options` will be updated; others remain unchanged.
   */
  async updateEvent(eventId: string, options: {
    summary?: string;
    description?: string;
    startTime?: string; // ISO 8601 datetime string
    endTime?: string; // ISO 8601 datetime string
    timeZone?: string; // IANA timezone name (e.g., Europe/Prague)
  }): Promise<boolean> {
    const hasToken = await this.ensureValidToken();
    if (!hasToken) {
      console.error("Cortex: Cannot update event — no valid Google access token.");
      return false;
    }
  
    const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  
    console.log(`Cortex: Updating event ${eventId} with:`, options);
  
    const payload: Record<string, unknown> = {};
    if (options.summary !== undefined) payload.summary = options.summary;
    if (options.description !== undefined) payload.description = options.description;
    if (options.startTime !== undefined) payload.start = { dateTime: options.startTime, timeZone };
    if (options.endTime !== undefined) payload.end = { dateTime: options.endTime, timeZone };

    const response = await requestUrl({
      url: `${this.CALENDAR_API}/${encodeURIComponent(eventId)}`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.settings.googleAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    if (response.status === 200) {
      console.log("Cortex: Event updated successfully.");
      return true;
    }

    console.error(`Cortex: Failed to update event ${eventId}. Status: ${response.status}`, response.text);
    return false;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
