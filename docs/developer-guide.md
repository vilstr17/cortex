# Chronote Developer Guide

## Development Setup

### Prerequisites
- **Node.js** (LTS recommended; the build pipeline targets modern Node)
- **npm**
- **Obsidian** desktop app for local testing

### Install
```bash
npm install --legacy-peer-deps
```

(The `--legacy-peer-deps` flag matches the older `@types/node@^16` pin in `package.json` against newer vitest peer ranges. The CI workflow uses the same flag.)

### Build & Watch
```bash
# Development watch (esbuild with source maps)
npm run dev

# Production build (typecheck + minified bundle)
npm run build
```

Build artifacts:
- `main.js` — bundled plugin code
- `styles.css` — plugin styles (keep in sync with source changes)
- `manifest.json` — plugin metadata

These must be placed in `<Vault>/.obsidian/plugins/chronote/` for Obsidian to load them.

### Testing Locally
1. Build the plugin (`npm run dev` or `npm run build`).
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/chronote/` folder.
3. Open Obsidian → **Settings → Community plugins** → enable **Chronote**.
4. For dev iteration, keep `npm run dev` running and reload Obsidian after changes (**Command Palette → Reload app without saving**).
5. Open the Developer Tools (`Cmd+Option+I` on macOS) to see console output from the plugin.

## Code Organization

```
src/
  main.ts                       # Plugin lifecycle (onload/onunload); keep minimal
  settings.ts                   # Settings interface, defaults, and Settings tab UI
  settingsTypes.ts              # Plain interfaces for the settings shape
  commands.ts                   # SRS review command + test commands
  services/
    geminiService.ts            # Prompt building + function calling + REST client
    testService.ts              # In-memory test registry (backed by settings)
    flashcardSaveService.ts     # Persisting AI-proposed flashcards to a deck
    flashcardStudyPostProcessor.ts  # Post-processing of saved-card study sessions
    indexRunner.ts              # Background runner for the local vector index
    ai/                         # Adapters: Gemini, OpenAI-compat, Anthropic, listLocalModels
  agent/
    toolRegistry.ts             # Tool name → implementation registry
    tools/                      # Notes, tests, reviews, flashcards, quizzes
    vectorIndex/                # chunker, embeddings, in-memory index, persistence, knowledgeBase
  views/
    ChronoteDashboardView.ts      # Custom ItemView: reviews, tests
  modals/
    ChronoteChatModal.ts          # AI chat UI with flashcard/quiz attachments
    CreateTestModal.ts          # Test creation form
    AddToTestModal.ts           # Add current note to an existing test
    MarkTestDoneModal.ts        # Mark a test as completed
    ReviewScoreModal.ts         # 1–5 score picker for SRS review
    ReviewFilterModal.ts        # Filter/sort controls for due reviews
    ReviewScoreInfoModal.ts     # Score explanation helper
    SaveFlashcardsModal.ts      # Save proposed flashcards to a deck
    StudyFlashcardsModal.ts     # Re-open a saved deck as an interactive study session
  ui/
    chatMarkdown.ts             # Obsidian MarkdownRenderer wrapper
    FlashcardDeck.ts            # Interactive flashcard UI inside chat
    QuizComponent.ts            # Interactive quiz UI inside chat
  utils/
    srsLogic.ts                 # Interval calculation (SM-2 inspired)
    dateUtils.ts                # Local-date helpers (start-of-day, formatting)
    formatRelative.ts           # Human-friendly "in 3 days" rendering
    notice.ts                   # Styled Notice wrappers
    settingsMigration.ts        # Forward-compatibility for older data.json blobs
```

## Adding New Commands

The plugin follows the convention that `main.ts` stays minimal; commands are registered in `src/commands.ts` via the `Commands` class.

Example:
```ts
plugin.addCommand({
  id: "my-new-command",
  name: "My New Command",
  checkCallback: (checking) => {
    const file = plugin.app.workspace.getActiveFile();
    if (checking) return file !== null;
    // execute...
  },
});
```

Use `checkCallback` when the command should only appear in the palette under specific conditions (e.g., an active markdown file).

## Adding New Modals

1. Create a new file in `src/modals/` extending `Modal` from `obsidian`.
2. Implement `onOpen()` to build the DOM inside `this.contentEl`.
3. Implement `onClose()` to clean up `this.contentEl`.
4. Open it from a command, the Dashboard, or a settings button:
   ```ts
   new MyModal(app, plugin).open();
   ```

Keep modals self-contained; pass callbacks for actions that need to trigger a parent re-render.

## Adding New AI Tools

The agent layer (`src/agent/toolRegistry.ts`) maps a tool name to a typed implementation. To add a new tool:

1. Create a new file under `src/agent/tools/` exporting a `Tool` object (name, description, JSON Schema, and `execute(args, ctx)`).
2. Register it in `ChronoteChatModal` (or wherever the tool list lives) so it gets passed to the active AI adapter.
3. Add a unit test in `src/agent/tools/__tests__/`.

## Key Conventions

### Date Handling
- **Always use `dateUtils.ts` patterns** (or inline equivalents) that create dates at midnight local time:
  ```ts
  const d = new Date();
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  ```
- Avoid `new Date("2026-06-12")` — it parses as UTC midnight and shifts in non-UTC timezones.
- The chat prompt explicitly anchors the model to local time and forbids UTC/Z-suffix outputs.

### Service Ownership
- **Single-owner services**: `TestService` owns the `tests` array in settings. The chat adapter owns chat history for its instance.
- Services that need to write settings receive a `saveSettingsCallback` rather than holding a reference to the plugin.

### Frontmatter Access
- Use `app.fileManager.processFrontMatter(file, (fm) => { ... })` for writes.
- Use `app.metadataCache.getFileCache(file)?.frontmatter` for reads.
- Never parse frontmatter manually; let Obsidian handle YAML round-tripping.

### Settings Persistence
- Every settings change must end with `await this.plugin.saveData(this.plugin.settings)`.
- The settings tab re-renders itself (`this.display()`) after toggles so the UI reflects the real state if startup failed.

## Common Pitfalls

### UTC vs Local Dates
- `Date.toISOString()` produces UTC. Use it for API payloads and ISO date extraction (`split("T")[0]`), but never for user-facing display.
- `new Date(2026, 5, 12)` is local; `new Date("2026-06-12")` is UTC. The codebase prefers the former for internal date math.

### Metadata Cache Events
- Obsidian fires `metadataCache.on("changed", ...)` on every save while typing.
- The Dashboard debounces re-renders to 2 seconds so the UI does not lag the editor.
- If you build a new feature that reacts to file changes, apply a similar debounce.

### Bundle Size
- The plugin is a single `main.js`. `esbuild` bundles everything.
- Large AI-provider SDKs and embedding libraries are imported lazily inside the adapter that uses them so they do not run at plugin load.
- Do not add large runtime dependencies without considering mobile impact.
