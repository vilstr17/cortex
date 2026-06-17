# Chronote

**Study smarter inside Obsidian.** Chronote turns the notes you already have into a spaced-repetition study system, links them to your Google Calendar, and uses AI to plan your day and search your vault — all without leaving your editor.

## What Chronote does for you

- **Spaced repetition on your existing notes** — Every note becomes a flashcard-style review. Score how well you remember it (1–5) and Chronote schedules the next review automatically.
- **Tests and exams** — Group related notes into a test, see your preparation progress, and let Chronote track each linked note's exam date.
- **Flashcards and quizzes** — Ask the AI to generate flashcards or a quiz from any note, then study them as a saved deck.
- **Google Calendar, inside Obsidian** — See today's schedule, and ask the AI to place study sessions directly into your real calendar.
- **AI study planner** — Chat with the AI about your schedule. It knows what you're due to review, what's on your calendar, and what tests are coming up, and it suggests study blocks you can approve in one click.
- **Vault-wide AI search** — Every note is indexed locally so the AI can find the right information when you ask.

## Why people use Chronote

- **You don't lose your notes** — Review state lives in each note's own frontmatter. Your data stays in your vault, in plain Markdown.
- **You pick the AI** — Use a free local model, your own API key, or (coming soon) Chronote Cloud for users who'd rather not manage keys at all.
- **It's keyboard-friendly** — Most of what you do is a one-line command: log a review, ask the planner, open the dashboard.

*(Note: This plugin was originally called **Cortex**, but we renamed it to **Chronote** to avoid confusion with another existing plugin of the same name.)*


## Quick start

1. **Install** Chronote into your vault.
   - Download the latest release and copy `main.js`, `manifest.json`, and `styles.css` into your vault's `/.obsidian/plugins/chronote/` folder.
   - Open Obsidian, go to **Settings → Community plugins**, and turn on **Chronote**.

2. **Open the Dashboard.**
   - Click the brain icon in the ribbon (left side of Obsidian), or run **Open Chronote Dashboard** from the Command Palette.
   - This is your home base — you'll see what's due, what's coming up, and your schedule.

3. **Pick an AI provider.**
   - Open **Settings → Chronote** and choose a provider from the dropdown.
   - **Local, free, no API key:** Install [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) on your computer and pick one of those. Chronote fills in the local URL for you.
   - **Bring your own key:** Pick Google Gemini, OpenAI, Anthropic, or any OpenAI-compatible service (OpenRouter, Groq, Together, vLLM, llama.cpp, …) and paste your API key.
   - **No key at all:** Chronote Cloud is **coming soon** — a managed option for users who don't want to manage API keys. The setting is already in place and will start working as soon as the cloud service is live. Until then, please use one of the other options.
   - When you're done, click **Test connection** to confirm everything is reachable.

4. **Turn on vault search (optional but recommended).**
   - Still in Settings → Chronote, open the **Indexing** section.
   - Pick an **Embedding preset** — Ollama, LM Studio, OpenAI, OpenRouter, … — to pre-fill the URL and default model in one click. You can still override the fields.
   - Local servers (Ollama at `http://localhost:11434/v1`, LM Studio at `http://127.0.0.1:1234/v1`) don't need a key; cloud providers do.
   - Click **Test embedding** to confirm the endpoint is reachable.
   - Click **Reindex vault** to embed your notes. This runs in the background.

5. **Connect Google Calendar (optional).**
   - From the Dashboard, click **Connect Google Calendar**.
   - Sign in with the Google account that owns the calendar you want Chronote to read and write to.
   - You can disconnect at any time from the Dashboard.

6. **Start reviewing.**
   - Open any note and run **Log Chronote Review** from the Command Palette.
   - Pick a score from 1 (I forgot) to 5 (I could recite it in my sleep).
   - Chronote writes the score and the next review date into the note's frontmatter. Open the Dashboard to see it appear under "Due Reviews."

## How to use Chronote day to day

This is the rhythm most people settle into:

### 1. Keep studying your way
Chronote doesn't change how you take notes. Write the way you always do. When a note contains something you want to remember — a definition, a concept, a fact — add two short lines to the top of the file:

```yaml
---
confidence: 4
next_review: 2026-06-20
interval: 7
---
```

If you don't want to write YAML, you don't have to: scoring through the **Log Chronote Review** command fills this in for you.

### 2. Review what's due
Open the Dashboard. The **Due Reviews** panel shows what's on your plate today. Click a note to open it, then run **Log Chronote Review** and pick a score. Chronote pushes the next review out further (or pulls it back in, if you forgot).

### 3. Group notes into a test
When an exam or deadline is approaching, create a **Test** from the Dashboard. Add the notes you want to study for it. Chronote tracks your overall preparation and syncs the exam date to every linked note.

### 4. Let the AI help
- **Ask the planner** — Open the chat from the Dashboard and say something like *"Plan my study day."* The AI looks at what's due, what's already on your calendar, and what tests are coming up, then suggests specific study blocks. Click **Approve** to put them on your real Google Calendar.
- **Generate flashcards** — In the chat, ask *"Make flashcards from the photosynthesis note."* Chronote proposes cards, you flip through them, and you save the ones you like into a deck.
- **Take a quiz** — Ask for a quiz on a note or topic. The AI writes the questions, you answer them, and you get immediate feedback.
- **Find things in your vault** — Ask *"What did I write about spaced repetition?"* Chronote searches your indexed notes and shows you the relevant passages.

### 5. Stay in control
- **Cap your daily reviews.** In Settings → Chronote → Study, set a daily review limit. If you fall behind, overflow automatically shifts to the next day.
- **Skip a note for a test.** If a particular note shouldn't be on a test, open the test from the Dashboard and toggle it off — Chronote excludes it from your preparation score.
- **Take a break.** Chronote is just YAML in your notes. If you stop using the plugin, your notes still work, and your data still works.

## Tips

- **Start with 5–10 notes.** Don't try to index your entire vault on day one. Add a handful of important notes, log a few reviews, and get a feel for the loop before scaling up.
- **Reviews are cheap.** A "review" can take 5–10 seconds if you already know the material. The point is the small, frequent touch.
- **The AI only sees what you ask about.** Chronote sends a prompt to your chosen AI provider when you open the chat or ask for a study plan. It does not silently upload your vault.
- **Local first.** If you'd rather nothing leave your computer, run Ollama or LM Studio on your laptop and pick them in Settings. Both work for chat and for vault indexing.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — System design, data flow, and subsystem overview
- [`docs/security.md`](docs/security.md) — OAuth, token storage, and privacy model
- [`docs/developer-guide.md`](docs/developer-guide.md) — Setup, build commands, and conventions for contributors

## Requirements

- Obsidian desktop
- An AI provider:
  - A free local server (Ollama, LM Studio) — recommended if you don't want to send your data anywhere
  - **Or** an API key for Google Gemini, OpenAI, Anthropic, or any OpenAI-compatible service
  - **Or** Chronote Cloud (coming soon) — a managed option for users who don't want to manage API keys
- A Google account, *only* if you want Calendar integration

## Privacy at a glance

- Your notes stay in your vault. Chronote only reads them.
- API keys, OAuth tokens, and review state are stored inside the plugin's `data.json`, in your vault. They are not encrypted; if you sync your vault to a cloud service you trust, this is fine — if you don't, keep that in mind.
- When you ask the AI a question, the question (and any context Chronote needs to answer it) is sent to the AI provider you've selected. Pick a local one if you'd rather keep that on your machine.
- No analytics, no telemetry, no background phone-home.
- **Infrastructure:** Google Calendar integration uses a lightweight proxy (`cortex-proxy.vercel.app`) to handle OAuth authentication and token refreshing. Your data is transmitted securely, and tokens are only stored in your vault.



