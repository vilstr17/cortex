# Cortex

Cortex is an Obsidian plugin that turns your notes into a **spaced repetition (SRS)** system, connects them to **Google Calendar**, and uses **AI** to build study plans and search your vault. It also includes local **focus detection** (Bluetooth phone proximity + webcam face tracking) to warn you when you get distracted.

## Features

- **Note-based SRS** — Review scores (1–5) are stored in each note's frontmatter (`confidence`, `interval`, `next_review`). Notes with upcoming or past `next_review` dates appear in the Dashboard.
- **Test-aware studying** — Group notes into tests/exams. Cortex tracks per-test preparation progress and syncs `exam_date` to linked notes.
- **Google Calendar integration** — View today's schedule inside Obsidian, and let the AI planner create study events directly in your calendar.
- **AI study planner** — Chat with your AI about your schedule, or ask it to plan your day. It reads your due reviews, existing calendar events, and tests to suggest optimal study blocks.
- **Vault search (RAG)** — Every markdown note is embedded into a local index the AI can search. The Dashboard, chat, and flashcard suggestion tools all use the same index.
- **Multi-provider AI** — Works with Cortex Cloud (default, no model picking), Google Gemini, OpenAI, Anthropic, Ollama, LM Studio, or any OpenAI-compatible endpoint (OpenRouter, Groq, Together, vLLM, llama.cpp server, …).
- **Focus detection (desktop only)**
  - *Phone detection*: Calibrate your phone's Bluetooth signal; Cortex warns you when you're holding it.
  - *Face tracking*: MediaPipe-based gaze, blink, and head-pose tracking warns you when you look away.
    - ⚠️ **Not available on macOS** — Obsidian's signed app binary is currently missing the `com.apple.security.device.camera` entitlement, so macOS will not show the camera permission dialog and `getUserMedia` cannot open the webcam. Use the BLE Focus Detector on macOS instead, or track [forum.obsidian.md/t/76265](https://forum.obsidian.md/t/add-camera-permissions-for-obsidian-mac-so-the-obsidian-camera-plugin-works/76265) for a fix.
- **Daily review limits** — Cap the number of reviews per day; overflow automatically shifts to the next day.

## Quick Start

1. **Install** the plugin into your vault:
   ```
   <Vault>/.obsidian/plugins/cortex/
   ```
   Place `main.js`, `manifest.json`, and `styles.css` in that folder.

2. **Enable** the plugin in Obsidian: **Settings → Community plugins → Cortex**.

3. **Configure** in **Settings → Cortex**:
   - **AI provider** — pick from the dropdown. Cortex Cloud works out of the box after you paste an account id; the other providers need their own API key. A **Test connection** button probes the active provider with a one-word ping.
   - **Timezone** and **daily routine** (wake up / bed time).

4. **Configure embeddings** (vault search + flashcard suggestions) in **Settings → Cortex → Indexing**:
   - Pick an **Embedding preset** (Ollama, LM Studio, OpenAI, OpenRouter, …) to pre-fill the base URL and default model in one click. You can still override the fields below.
   - For local servers (Ollama at `http://localhost:11434/v1`, LM Studio at `http://127.0.0.1:1234/v1`) no API key is required; cloud providers do require one.
   - Click **Test embedding** to confirm the endpoint is reachable and the model is loaded. Click **Reindex vault** to embed every note in the background.

5. **Open the Dashboard** via the ribbon icon (brain) or the Command Palette: **Open Cortex Dashboard**.

6. **Connect Google Calendar** from the Dashboard by clicking **Connect Google Calendar**.

7. **Start reviewing** — Open any note and run **Log Cortex Review** from the Command Palette to score your recall. The Dashboard will show when it's due next.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — System design, data flow, and subsystem overview
- [`docs/security.md`](docs/security.md) — OAuth, token storage, and privacy model
- [`docs/developer-guide.md`](docs/developer-guide.md) — Setup, build commands, and conventions for contributors
- [`PERFORMANCE.md`](PERFORMANCE.md) — Performance notes and recent focus-detection improvements

## Requirements

- Obsidian desktop (focus detection features are desktop-only; core SRS works everywhere)
- A system Node.js installation for BLE phone detection (used by the background scanner)
- An AI provider (Cortex Cloud account id, or an API key for Gemini / OpenAI / Anthropic / any OpenAI-compatible gateway, or a local Ollama / LM Studio server)
- A Google account for calendar integration
