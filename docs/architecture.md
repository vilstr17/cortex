# Cortex Architecture

## Overview

Cortex is an Obsidian plugin that combines **spaced repetition (SRS)**, **Google Calendar integration**, **AI-powered study planning**, and **local focus detection** (Bluetooth proximity + webcam face tracking) into a single command center.

## High-level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Obsidian Plugin Host                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │  main.ts    │  │  settings.ts │  │  CortexDashboardView │ │
│  │  (lifecycle)│  │  (config)      │  │  (UI / data hub)     │ │
│  └──────┬──────┘  └──────────────┘  └─────────────────────┘ │
│         │                                                    │
│  ┌──────▼──────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Commands   │  │ DetectionManager│  │  TestService         │ │
│  │  (review,   │  │ (BLE + Face)    │  │  (tests registry)    │ │
│  │   tests)    │  └──────┬────────┘  └─────────────────────┘ │
│  └─────────────┘         │                                  │
│                          │                                  │
│         ┌────────────────┼────────────────┐                 │
│         ▼                ▼                ▼                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │BleFocusDetector│ │FaceFocusEvaluator│ │ GoogleCalendarService│ │
│  │  (child proc)  │ │  (MediaPipe)     │ │  (OAuth / REST)      │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
│         ▲                                    │                │
│         │                                    ▼                │
│  ┌─────────────┐                    ┌─────────────────────┐  │
│  │ble-scanner.cjs│                  │    GeminiService      │  │
│  │(Node + noble)│                  │  (Function Calling)   │  │
│  └─────────────┘                    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Plugin Lifecycle

Entry point: `src/main.ts`

1. **`onload()`**
   - Loads settings via `this.loadData()` (merges with `DEFAULT_SETTINGS` from `src/settings.ts`).
   - Registers the custom view `cortex-dashboard` (`src/views/CortexDashboardView.ts`).
   - Detaches any stale dashboard leaves from previous loads.
   - Instantiates `DetectionManager` (desktop only; skipped on mobile via `Platform.isMobile`).
   - Registers the Obsidian protocol handler `cortex-auth` to receive Google OAuth tokens after browser flow.
   - Adds ribbon icon and core commands (`open-cortex-dashboard`, `toggle-face-detection`, `toggle-ble-detection`, `select-ble-device`).
   - Delegates SRS/test commands to `Commands` (`src/commands.ts`).
   - Adds the settings tab (`CortexSettingTab`).
   - Defers detector startup to `app.workspace.onLayoutReady()` + 1 s delay so it never competes with vault indexing.

2. **`onunload()`**
   - Detaches all dashboard leaves.
   - Calls `detection.destroy()` to stop BLE scanner child process and release webcam + MediaPipe resources.

## Detection Subsystem

**Owner:** `src/detection/DetectionManager.ts`

`DetectionManager` is the unified owner of both focus-detection backends. It handles:
- Independent enable/disable toggles for BLE and face.
- A shared DOM warning overlay with per-source cooldowns (15 s).
- Toggle guards (`toggling` flag) to prevent concurrent start/stop races.
- Vault-backed asset cache for the MediaPipe wasm runtime + model (~15 MB), stored in `.obsidian/plugins/cortex/.assets/`.

### BLE Path
- `BleFocusDetector` (`src/ble/BleFocusDetector.ts`) spawns `ble-scanner.cjs` as a Node child process.
- Communication is local HTTP to `127.0.0.1:18888`.
- The scanner process uses `@abandonware/noble` to read RSSI of a calibrated Bluetooth device (typically a phone).
- Calibration is user-driven: hold the phone, collect 10 s of RSSI readings, compute average + tolerance.
- State transitions require 2 consecutive classified readings to avoid flapping.

### Face Path
- `FaceFocusEvaluator` (`src/face/FaceFocusEvaluator.ts`) wraps `FaceDetector` (`src/FaceDetector.ts`).
- MediaPipe `FaceLandmarker` runs in **burst mode**: every sample interval (default 10 s) a ~1.5 s burst of ~15 frames at 10 fps is captured and aggregated.
- Detection is skipped entirely while `document.hidden` to save CPU.
- Evaluates gaze, head pitch, blink rate, and head stability; transitions require 2 confirmations.

## SRS Subsystem

**Core logic:** `src/utils/srsLogic.ts`  
**Frontmatter writer:** `src/commands.ts` (`applyReviewToFrontmatter`)

Spaced repetition data lives **in each note's YAML frontmatter**:
- `confidence` — last review score (1–5)
- `interval` — days until next review
- `next_review` — ISO date (`YYYY-MM-DD`)
- `exam_date` — optional exam date, synced from linked tests

Algorithm (`calculateNextReview`):
- Score 1–2: reset interval to 1 day.
- Score 3: keep current interval.
- Score 4: multiply by 2.
- Score 5: multiply by 3.
- If `exam_date` is today or past, set interval to 9999 and date to `9999-12-31` (archived).
- Optional user caps: `maxReviewIntervalDays` and `dailyLimitMax` (overflows to next day if daily cap exceeded).

The dashboard and chat modals read this data via `app.metadataCache.getFileCache()` — no separate database.

## Test Subsystem

**Owner:** `src/services/testService.ts`

Tests are stored in plugin settings (`CortexSettings.tests`) as an array of:
```ts
{ id: string; name: string; date: string; filePaths: string[]; done?: boolean }
```

- `TestService` provides CRUD + `toggleDone`.
- When a file is added to a test, its `exam_date` frontmatter is synced to the test date.
- When a test date is updated, all linked notes receive the new `exam_date`.
- Dashboard calculates per-test progress from the `confidence` scores of linked notes (excluding notes with `exclude_from_exam: true`).

## Calendar Integration

**Owner:** `src/services/googleCalendarService.ts`

- OAuth 2.0 flow initiated from the Dashboard opens the browser to `https://cortex-proxy.vercel.app/api/auth`.
- The proxy redirects back to Obsidian via the `cortex-auth://` protocol handler.
- Tokens are persisted in Obsidian's `data.json` via `saveData()`.
- `GoogleCalendarService` maintains a preemptive refresh timer (every 60 s) and refreshes 5 minutes before expiry via the proxy (`POST /api/refresh`).
- Supports CRUD on the user's primary calendar: list, create, update, delete events.

## AI Integration

**Owner:** `src/services/geminiService.ts`

- Builds a large system prompt anchored to the real current date/time and user planning preferences.
- In scheduling mode, the prompt is injected with:
  - Due notes (from `metadataCache` frontmatter)
  - Existing calendar events for today
  - Upcoming tests (from `TestService`)
- Uses **Gemini Function Calling** to give the model real calendar tools (`list_events`, `create_event`, `update_event`, `delete_event`).
- `CortexChatModal` (`src/modals/CortexChatModal.ts`) provides an interactive chat UI; scheduling queries trigger context gathering and may render an "Approve Schedule" button to bulk-create events.
- `generateStudyPlan()` is a direct API path that returns a JSON array of events, post-processed to enforce correct dates.

## Dashboard View Architecture

**File:** `src/views/CortexDashboardView.ts`

The dashboard is a single custom `ItemView` rendered into the workspace. It has four main panels:

1. **Google Calendar schedule** — date-navigable; 30-second fetch cache; shows event times + links.
2. **Due Reviews** — date-navigable; filterable by test and sortable by confidence score; overdue items are highlighted.
3. **Upcoming Tests** — expandable test cards with progress bars, linked notes, exclude toggles, and done/delete actions.
4. **Focus Panels** — side-by-side BLE and Face status with live tickers (1 s interval, paused when window hidden).

Re-rendering is debounced: metadata changes from typing trigger a 2-second delay so the dashboard does not refetch the calendar on every keystroke.

## Data Flow

```
User edits a note
    │
    ▼
Obsidian metadataCache updates frontmatter (confidence, interval, next_review, exam_date)
    │
    ├──► Dashboard reads metadataCache → renders due reviews + test progress
    │
    ├──► GeminiService reads metadataCache (via chat modal) → builds study plan context
    │
    ├──► GoogleCalendarService reads free/busy time → Gemini uses it for planning
    │
    ▼
Gemini returns suggested events → user approves in chat modal
    │
    ▼
GoogleCalendarService.createEvent() → POST to Google Calendar API
    │
    ▼
Dashboard re-fetches calendar → shows new events in schedule panel
```

Key conventions:
- `metadataCache` is the single source of truth for SRS state.
- `settings.tests` is the single source of truth for tests.
- `GoogleCalendarService` instances are created per-consumer (Dashboard, Chat Modal) but share the same underlying settings object.
