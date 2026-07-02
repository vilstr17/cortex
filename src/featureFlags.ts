/**
 * Feature flags for optional Chronote functionality.
 *
 * A flag here is the single switch that turns a feature on or off across
 * the whole plugin. Every surface that touches the feature (UI, settings,
 * agent tools, background services) reads from this module, so flipping
 * one constant is enough — no code needs to be deleted or restored from
 * git history.
 */

/**
 * Google Calendar integration.
 *
 * When `true` (the historical default), Chronote can connect a Google
 * account and:
 *   - show today's schedule on the Dashboard,
 *   - let the AI agent list / create / move / delete calendar events,
 *   - push an approved study plan onto the user's real calendar.
 *
 * When `false` (current setting), the feature is fully disabled:
 *   - the Dashboard hides the "Connect Google Calendar" button and the
 *     schedule section,
 *   - the settings tab hides the Google Calendar section and the
 *     "Enable calendar tools" toggle,
 *   - the AI agent is not given the calendar tools,
 *   - the chat's study-plan flow no longer offers to sync to the calendar,
 *   - no `GoogleCalendarService` is constructed and the Google OAuth
 *     protocol handlers are not registered.
 *
 * All Google Calendar code is intentionally left in the tree
 * (`services/googleCalendarService.ts`, `agent/tools/calendar.ts`, and the
 * gated blocks in the dashboard / settings / chat modal). To re-enable the
 * feature, set this constant back to `true` and rebuild — that is the only
 * change required. See `docs/developer-guide.md` → "Feature flags".
 */
export const GOOGLE_CALENDAR_ENABLED = false;
