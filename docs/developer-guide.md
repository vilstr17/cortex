# Cortex Developer Guide

## Development Setup

### Prerequisites
- **Node.js** (LTS recommended; the BLE scanner requires a system Node binary at runtime)
- **npm**
- **Obsidian** desktop app for local testing

### Install
```bash
npm install
```

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

These must be placed in `<Vault>/.obsidian/plugins/cortex/` for Obsidian to load them.

### Testing Locally
1. Build the plugin (`npm run dev` or `npm run build`).
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/cortex/` folder.
3. Open Obsidian → **Settings → Community plugins** → enable **Cortex**.
4. For dev iteration, keep `npm run dev` running and reload Obsidian after changes (**Command Palette → Reload app without saving**).
5. Open the Developer Tools (`Cmd+Option+I` on macOS) to see console output from the plugin and the BLE scanner child process.

## Code Organization

```
src/
  main.ts                    # Plugin lifecycle (onload/onunload); keep minimal
  settings.ts                # Settings interface, defaults, and Settings tab UI
  commands.ts                # SRS review command + test commands
  detection/
    DetectionManager.ts        # Unified BLE + Face lifecycle and warning overlay
  ble/
    BleFocusDetector.ts      # Node child-process manager for BLE scanning
    types.ts                 # BLE types + calibration logic
    initBle.ts               # BLE initialization helpers
    CalibrationModal.ts      # UI for calibration collection
    BleDevicePickerModal.ts  # UI for selecting a BLE device
  face/
    FaceFocusEvaluator.ts    # State machine + evaluation logic
    initFace.ts              # Face initialization helpers
  FaceDetector.ts            # MediaPipe wrapper (burst sampling, asset caching)
  services/
    googleCalendarService.ts # OAuth token refresh + Calendar CRUD
    geminiService.ts         # Prompt building + function calling + REST client
    testService.ts           # In-memory test registry (backed by settings)
  views/
    CortexDashboardView.ts   # Custom ItemView: calendar, reviews, tests, focus
  modals/
    CortexChatModal.ts       # AI chat UI with schedule approval
    CreateTestModal.ts       # Test creation form
    AddToTestModal.ts        # Add current note to an existing test
    MarkTestDoneModal.ts     # Mark a test as completed
    ReviewScoreModal.ts      # 1–5 score picker for SRS review
    ReviewFilterModal.ts     # Filter/sort controls for due reviews
    ReviewScoreInfoModal.ts  # Score explanation helper
    TestCreationModal.ts     # Alternative test creation path
  utils/
    srsLogic.ts              # Interval calculation (SM-2 inspired)
    notice.ts                # Styled Notice wrappers
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

## Key Conventions

### Date Handling
- **Always use `dateUtils.ts` patterns** (or inline equivalents) that create dates at midnight local time:
  ```ts
  const d = new Date();
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  ```
- Avoid `new Date("2026-06-12")` — it parses as UTC midnight and shifts in non-UTC timezones.
- The Gemini prompt explicitly anchors the model to local time and forbids UTC/Z-suffix outputs.

### Service Ownership
- **Single-owner services**: `TestService` owns the `tests` array in settings. `GoogleCalendarService` owns token refresh timers. `GeminiService` owns chat history for its instance.
- Services that need to write settings receive a `saveSettingsCallback` rather than holding a reference to the plugin.
- The Dashboard creates short-lived service instances (`new GoogleCalendarService(...)`) but shares the same underlying settings object.

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

### Service Lifecycle
- `GoogleCalendarService` starts a `setInterval` for preemptive token refresh. Always call `.destroy()` when the consumer (Dashboard, Chat Modal) is torn down.
- `DetectionManager.destroy()` must be awaited in `onunload` to kill the BLE child process and release the webcam.

### BLE Scanner Coupling
- The BLE scanner is an external Node process. It can crash, hang, or fail to find the Node binary. All HTTP calls to `127.0.0.1:18888` have a 5-second timeout and swallow errors gracefully.
- On macOS the scanner needs Bluetooth permission for the **Obsidian** app, not just the terminal.

### Metadata Cache Events
- Obsidian fires `metadataCache.on("changed", ...)` on every save while typing.
- The Dashboard debounces re-renders to 2 seconds so calendar fetches do not lag the editor.
- If you build a new feature that reacts to file changes, apply a similar debounce.

### Bundle Size
- The plugin is a single `main.js`. `esbuild` bundles everything.
- `@mediapipe/tasks-vision` is lazy-imported inside `FaceDetector.ts` so it does not execute at plugin load.
- Do not add large runtime dependencies without considering mobile impact.
