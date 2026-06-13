import { requestUrl } from "obsidian";
import { CortexSettings } from "../settings";

const GOOGLE_CLIENT_ID = "243033885510-h3dur7p7gm579nk5o2s0prr3pppp1fjb.apps.googleusercontent.com";
const GOOGLE_REFRESH_PROXY_BASE_URL = "https://cortex-proxy.vercel.app";
const PREEMPTIVE_REFRESH_MS = 5 * 60 * 1000; // refresh 5 min before expiry

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Proxy / API Response Types ────────────────────────────────────

interface ProxyRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  expires_in?: number;
}

function isValidProxyRefreshResponse(obj: unknown): obj is ProxyRefreshResponse {
  if (!isPlainObject(obj)) return false;
  const rec = obj as Record<string, unknown>;
  if ("access_token" in rec && typeof rec.access_token !== "string") return false;
  if ("refresh_token" in rec && typeof rec.refresh_token !== "string") return false;
  if ("error" in rec && typeof rec.error !== "string") return false;
  if ("expires_in" in rec && typeof rec.expires_in !== "number") return false;
  return true;
}

interface CalendarListResponse {
  items?: unknown[];
}

function isValidCalendarListResponse(obj: unknown): obj is CalendarListResponse {
  return isPlainObject(obj) && (!("items" in obj) || Array.isArray((obj as Record<string, unknown>).items));
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
  if (!isPlainObject(value)) return false;
  const rec = value as Record<string, unknown>;
  return isPlainObject(rec.start) && isPlainObject(rec.end);
}

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

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  htmlLink?: string;
}

export class GoogleCalendarService {
  private readonly CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  private settings: CortexSettings;
  private saveSettingsCallback: () => Promise<void>;
  private refreshMutex: Promise<string> | null = null;
  private preemptiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings: CortexSettings, saveSettingsCallback: () => Promise<void>) {
    this.settings = settings;
    this.saveSettingsCallback = saveSettingsCallback;
    this.startPreemptiveRefresh();
  }

  destroy(): void {
    if (this.preemptiveTimer) {
      clearInterval(this.preemptiveTimer);
      this.preemptiveTimer = null;
    }
  }

  // ── Token management ─────────────────────────────────────────────

  /**
   * Single serialized refresh. Concurrent callers wait on the same promise.
   * Handles invalid_grant (permanent) vs transient errors with retry.
   */
  private async serializedRefresh(): Promise<string> {
    if (this.refreshMutex) return this.refreshMutex;

    const doRefresh = async (retryCount = 0): Promise<string> => {
      const rt = this.settings.googleRefreshToken;
      if (!rt) throw new Error("No refresh token");

      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        if (attempt > 0) {
          await this.sleep(Math.pow(2, attempt) * 1000);
        }

        try {
          const url = `${GOOGLE_REFRESH_PROXY_BASE_URL}/api/refresh`;
          const response = await requestUrl({
            url,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: rt }),
          });
          const data = response.json;
          if (!isValidProxyRefreshResponse(data) || !data.access_token) {
            throw new Error(isValidProxyRefreshResponse(data) && data.error ? data.error : "Proxy refresh failed");
          }

          this.settings.googleAccessToken = data.access_token;
          this.settings.googleTokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;

          if (data.refresh_token) {
            this.settings.googleRefreshToken = data.refresh_token;
          }

          await this.saveSettingsCallback();
          return data.access_token;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const msg = lastError.message;

          if (msg === "invalid_grant" || msg.includes("invalid_grant")) {
            break; // permanent — don't retry
          }

          if (msg.includes("network") || msg.includes("timeout") || msg.includes("fetch")) {
            continue; // transient — retry
          }

          break; // unknown error — don't retry
        }
      }

      throw lastError ?? new Error("Token refresh failed");
    };

    this.refreshMutex = doRefresh(3).finally(() => { this.refreshMutex = null; });
    return this.refreshMutex;
  }

  private async ensureValidToken(): Promise<boolean> {
    if (!this.settings.googleAccessToken) return false;

    if (Date.now() < this.settings.googleTokenExpiry - PREEMPTIVE_REFRESH_MS) {
      return true;
    }

    if (!this.settings.googleRefreshToken) {
      console.error("[cortex] No refresh token — reconnect Google Calendar");
      return false;
    }

    try {
      await this.serializedRefresh();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[cortex] Token refresh failed:", msg);

      if (msg === "invalid_grant" || msg.includes("invalid_grant")) {
        console.warn("[cortex] Refresh token revoked — disconnecting Google Calendar");
        this.settings.googleAccessToken = "";
        this.settings.googleRefreshToken = "";
        this.settings.googleTokenExpiry = 0;
        await this.saveSettingsCallback();
      }

      return false;
    }
  }

  // ── Preemptive background refresh ─────────────────────────────────

  private startPreemptiveRefresh(): void {
    if (this.preemptiveTimer) return;

    this.preemptiveTimer = setInterval(async () => {
      if (!this.settings.googleAccessToken || !this.settings.googleRefreshToken) return;

      const msUntilExpiry = this.settings.googleTokenExpiry - Date.now();
      if (msUntilExpiry < PREEMPTIVE_REFRESH_MS && msUntilExpiry > -60_000) {
        try {
          await this.serializedRefresh();
          console.log("[cortex] Preemptive token refresh succeeded");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[cortex] Preemptive token refresh failed:", msg);
          if (msg === "invalid_grant" || msg.includes("invalid_grant")) {
            this.settings.googleAccessToken = "";
            this.settings.googleRefreshToken = "";
            this.settings.googleTokenExpiry = 0;
            await this.saveSettingsCallback();
          }
        }
      }
    }, 60_000);
  }

  // ── Calendar operations ──────────────────────────────────────────

  async createEvent(options: {
    summary: string;
    description?: string;
    startTime: string;
    endTime: string;
    timeZone?: string;
  }): Promise<boolean> {
    const hasToken = await this.ensureValidToken();
    if (!hasToken) {
      console.error("Cortex: Cannot create event — no valid Google access token.");
      return false;
    }

    const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const eventData = {
      summary: options.summary,
      description: options.description ?? "",
      start: { dateTime: options.startTime, timeZone },
      end: { dateTime: options.endTime, timeZone },
    };

    console.log("Cortex: Creating event with payload:", JSON.stringify(eventData));

    const response = await requestUrl({
      url: this.CALENDAR_API,
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.settings.googleAccessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventData),
      throw: false,
    });

    if (response.status !== 200) {
      console.error("Cortex: Failed to create event. Status:", response.status, response.text);
      throw new Error("Failed to create event");
    }

    console.log("Cortex: Event created successfully!");
    return true;
  }

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

    try {
      const response = await requestUrl({
        url: `${this.CALENDAR_API}?${params.toString()}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settings.googleAccessToken}`,
        },
      });

      const data = response.json;
      const items: CalendarEvent[] = isValidCalendarListResponse(data)
        ? (data.items ?? []).filter(isCalendarEvent)
        : [];

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

  async deleteEvent(eventId: string): Promise<boolean> {
    const hasToken = await this.ensureValidToken();
    if (!hasToken) {
      console.error("Cortex: Cannot delete event — no valid Google access token.");
      return false;
    }

    console.log(`Cortex: Deleting event ${eventId}...`);

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

  async updateEvent(eventId: string, options: {
    summary?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    timeZone?: string;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
