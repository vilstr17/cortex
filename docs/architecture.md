# Chronote Architecture

## Overview

Chronote is an Obsidian plugin that combines **spaced repetition (SRS)**, **Google Calendar integration**, and **AI-powered study planning** into a single command center — all running locally inside your vault.

## High-level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Obsidian Plugin Host                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │  main.ts    │  │  settings.ts │  │  ChronoteDashboardView │ │
│  │  (lifecycle)│  │  (config)    │  │  (UI / data hub)     │ │
│  └──────┬──────┘  └──────────────┘  └─────────────────────┘ │
│         │                                                    │
│  ┌──────▼──────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Commands   │  │ TestService │  │ GoogleCalendarService│ │
│  │  (review,   │  │  (tests)    │  │  (OAuth / REST)      │ │
│  │   tests)    │  └─────────────┘  └─────────────────────┘ │
│  └────────────┘                                │             │
│                                                 ▼             │
│  ┌──────────────────────────────┐  ┌─────────────────────┐   │
│  │   AI Service Registry        │  │   Vector Index      │   │
│  │ (Gemini / OpenAI-compat /    │  │  (local embeddings, │   │
│  │  Anthropic / Chronote Cloud)   │  │   RAG search)       │   │
│  └──────────────────────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Plugin Lifecycle

Entry point: `src/main.ts`

1. **`onload()`**
   - Loads settings via `this.loadData()` (merges with `DEFAULT_SETTINGS` from `src/settings.ts`).
   - Registers the custom view `chronote-dashboard` (`src/views/ChronoteDashboardView.ts`).
   - Detaches any stale dashboard leaves from previous loads.
   - Registers the Obsidian protocol handler `chronote-auth` to receive Google OAuth tokens after the browser flow.
   - Adds the ribbon icon and core commands (`open-chronote-dashboard`, plus the SRS and test commands).
   - Delegates SRS/test commands to `Commands` (`src/commands.ts`).
   - Adds the settings tab (`ChronoteSettingTab`).

2. **`onunload()`**
   - Detaches all dashboard leaves.
   - The vector index is kept on disk; nothing in memory needs explicit teardown.

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

Tests are stored in plugin settings (`ChronoteSettings.tests`) as an array of:

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
- The proxy redirects back to Obsidian via the `chronote-auth://` protocol handler.
- Tokens are persisted in Obsidian's `data.json` via `saveData()`.
- `GoogleCalendarService` maintains a preemptive refresh timer (every 60 s) and refreshes 5 minutes before expiry via the proxy (`POST /api/refresh`).
- Supports CRUD on the user's primary calendar: list, create, update, delete events.

## AI Integration

**Owner:** `src/services/ai/*` (`GeminiAdapter`, `OpenAICompatAdapter`, `AnthropicAdapter`, `createAdapter`)

- Builds a system prompt anchored to the real current date/time and user planning preferences.
- In scheduling mode, the prompt is injected with:
  - Due notes (from `metadataCache` frontmatter)
  - Existing calendar events for today
  - Upcoming tests (from `TestService`)
- All adapters expose a normalized tool-calling interface; the agent layer registers tools (`notes`, `tests`, `flashcards`, `quizzes`) on top.
- `ChronoteChatModal` (`src/modals/ChronoteChatModal.ts`) provides an interactive chat UI; scheduling queries may render an "Approve Schedule" button to bulk-create events.
- `Chronote Cloud` is wired through the same adapter interface as a fixed-base-url OpenAI-compatible endpoint. **It is not available yet** — the option is reserved in the catalog and settings, and will activate when the managed service goes live.

## Vault Search (RAG)

**Owner:** `src/agent/vectorIndex/*`

- Every markdown note is chunked (`chunker.ts`) and embedded (`embeddings.ts`) into a local index.
- The index is persisted as `knowledge-index.bin` in the plugin folder.
- The Dashboard, chat, and flashcard / quiz tools all use the same index.
- The user picks the embedding provider in **Settings → Chronote → Indexing**; local providers (Ollama, LM Studio) work without an API key, cloud providers require one.
- The chat adapter does not have direct access to embeddings — `knowledgeBase.ts` is the single owner of the local index.

## Dashboard View Architecture

**File:** `src/views/ChronoteDashboardView.ts`

The dashboard is a single custom `ItemView` rendered into the workspace. It has three main panels:

1. **Google Calendar schedule** — date-navigable; 30-second fetch cache; shows event times + links.
2. **Due Reviews** — date-navigable; filterable by test and sortable by confidence score; overdue items are highlighted.
3. **Upcoming Tests** — expandable test cards with progress bars, linked notes, exclude toggles, and done/delete actions.

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
    ├──► AI service reads metadataCache (via chat modal) → builds study plan context
    │
    ├──► GoogleCalendarService reads free/busy time → AI uses it for planning
    │
    ▼
AI returns suggested events → user approves in chat modal
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
- The vector index is a local file; the AI provider is the network boundary, and the user picks it.
