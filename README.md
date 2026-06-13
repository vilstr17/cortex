# Cortex

Cortex is an Obsidian plugin that turns your notes into a **spaced repetition (SRS)** system, connects them to **Google Calendar**, and uses **Gemini AI** to build study plans. It also includes local **focus detection** (Bluetooth phone proximity + webcam face tracking) to warn you when you get distracted.

## Features

- **Note-based SRS** — Review scores (1–5) are stored in each note's frontmatter (`confidence`, `interval`, `next_review`). Notes with upcoming or past `next_review` dates appear in the Dashboard.
- **Test-aware studying** — Group notes into tests/exams. Cortex tracks per-test preparation progress and syncs `exam_date` to linked notes.
- **Google Calendar integration** — View today's schedule inside Obsidian, and let the AI planner create study events directly in your calendar.
- **AI study planner** — Chat with Gemini about your schedule, or ask it to plan your day. It reads your due reviews, existing calendar events, and tests to suggest optimal study blocks.
- **Focus detection (desktop only)**
  - *Phone detection*: Calibrate your phone's Bluetooth signal; Cortex warns you when you're holding it.
  - *Face tracking*: MediaPipe-based gaze, blink, and head-pose tracking warns you when you look away.
- **Daily review limits** — Cap the number of reviews per day; overflow automatically shifts to the next day.

## Quick Start

1. **Install** the plugin into your vault:
   ```
   <Vault>/.obsidian/plugins/cortex/
   ```
   Place `main.js`, `manifest.json`, and `styles.css` in that folder.

2. **Enable** the plugin in Obsidian: **Settings → Community plugins → Cortex**.

3. **Configure** in **Settings → Cortex**:
   - Add your **Gemini API key** (get one at [Google AI Studio](https://aistudio.google.com/apikey)).
   - Set your **timezone** and **daily routine** (wake up / bed time).

4. **Open the Dashboard** via the ribbon icon (brain) or the Command Palette: **Open Cortex Dashboard**.

5. **Connect Google Calendar** from the Dashboard by clicking **Connect Google Calendar**.

6. **Start reviewing** — Open any note and run **Log Cortex Review** from the Command Palette to score your recall. The Dashboard will show when it's due next.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — System design, data flow, and subsystem overview
- [`docs/security.md`](docs/security.md) — OAuth, token storage, and privacy model
- [`docs/developer-guide.md`](docs/developer-guide.md) — Setup, build commands, and conventions for contributors
- [`PERFORMANCE.md`](PERFORMANCE.md) — Performance notes and recent focus-detection improvements

## Requirements

- Obsidian desktop (focus detection features are desktop-only; core SRS works everywhere)
- A system Node.js installation for BLE phone detection (used by the background scanner)
- A Gemini API key for AI scheduling
- A Google account for calendar integration
