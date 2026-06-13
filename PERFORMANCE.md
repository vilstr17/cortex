# Focus Detection — Review, Root Causes & Performance Notes

Review date: 2026-06-11. Covers the BLE phone detector, webcam face tracking,
their consolidation into a unified detection system, and startup/runtime
performance work.

## 1. Root cause analysis

### BLE detector — intermittent lag / unresponsiveness

| # | Root cause | Effect |
|---|-----------|--------|
| 1 | **`POST /start` never responded.** The HTTP handler in `ble-scanner.cjs` did `await startScanLoop()`, but `startScanLoop` contained an infinite `while (scanning)` loop — the response was only sent when scanning *stopped*. | Every plugin code path that awaited `/start` (auto-start at launch, dashboard toggle, device selection) hung. Node's default 5-minute request timeout sometimes released it, which is why the failure looked *intermittent* rather than total. The `bleToggling`/`faceToggling` guards then latched `true` forever, making toggles dead until restart. |
| 2 | **Scan churn.** The scan loop started and stopped CoreBluetooth scanning every ~800 ms with two competing timers. | Missed advertisements, RSSI gaps, spurious 5 s session timeouts, and constant IPC churn in the scanner process — the "laggy/flappy" readings. |
| 3 | **Infinite reconnect loop.** `start()` reset `reconnectAttempts = 0`, and the reconnect path called `start()` — so `MAX_RECONNECT_ATTEMPTS` was never reached. | If the scanner kept dying (e.g. wrong node path), the plugin respawned a process every 3 s forever. |
| 4 | **No HTTP timeouts.** `requestUrl` calls to the scanner had no timeout. | A wedged scanner process could stall any plugin operation awaiting it. |
| 5 | Hard-coded `/opt/homebrew/bin/node`. | Silent total failure on Intel-Homebrew (`/usr/local/bin`) or installer-based Node setups. |

### Face tracking — non-functional

| # | Root cause | Effect |
|---|-----------|--------|
| 1 | **Single-frame sampling every 10 s.** One frame was captured per interval; blink detection compared eye state *across 10-second gaps*; the 2 s face-dropout grace period could never apply (always exceeded by the 10 s gap); head-stability variance was computed across samples minutes apart. | Blink rate was always ~0 or random; "fidgeting" detection was noise; a single bad frame reset state confirmation. |
| 2 | **3-confirmation state machine on 10 s samples** + a "no strong signal" evaluation that returns the *current* state and resets pending progress. | A state change needed 30 s+ of perfectly consistent single-frame readings. In practice the state never changed → no warnings ever fired → feature appeared dead even with the camera light on. |
| 3 | **`pendingState` used `"UNKNOWN"` as a sentinel**, which is also a real state. | Confirmation counting was corrupted whenever the real UNKNOWN state was involved (face leaves frame). |
| 4 | **`@latest` CDN URLs for both the wasm runtime and model, re-downloaded (≈15 MB) on every start, with no timeout.** | Any version skew between the bundled JS (0.10.35) and "latest" wasm breaks init; on a slow/offline network the UI showed "Initializing…" forever with no error. |
| 5 | **GPU delegate with no CPU fallback.** | Hard failure on machines/Electron configs where the WebGL backend is unavailable (e.g. hardware acceleration disabled). |
| 6 | `display:none` video element. | Chromium may stop decoding frames for fully hidden videos; detection then sees `readyState < 2` and returns empty state. |

## 2. Architecture changes

```
src/detection/DetectionManager.ts   ← NEW: unified detection system
 ├── owns BleFocusDetector (src/ble/…)
 ├── owns FaceFocusEvaluator (src/face/…) → FaceDetector
 ├── shared warning overlay (one implementation, per-source content)
 ├── per-source cooldowns + toggle guards
 ├── vault-backed asset cache (wasm runtime + face model)
 └── settings-driven lifecycle: startEnabled() / toggleBle() / toggleFace()
```

- **`main.ts` was slimmed down** from ~380 to ~150 lines: all detection
  lifecycle, overlay and cooldown code moved into `DetectionManager`. The
  plugin exposes `detection`, plus `bleDetector`/`faceEvaluator` getters for
  views and modals.
- **Independent configuration**: Settings → "Focus Detection" now has separate
  enable toggles for phone detection (Bluetooth) and face tracking (webcam),
  each with its own configuration. The face toggle in settings previously only
  flipped the flag without starting/stopping anything — it now actually starts
  and stops the detector.
- **Shared resources**: one warning overlay, one cooldown mechanism, one asset
  cache, one dashboard update ticker — previously duplicated per feature.

## 3. Key fixes

### BLE
- `ble-scanner.cjs`: continuous scanning (single `startScanningAsync` with
  duplicates) replaces the 800 ms start/stop churn; a watchdog restarts the
  scan only if *no* advertisement arrives for 8 s (CoreBluetooth stall
  recovery). `/start` responds immediately (verified: **17 ms**, previously
  never).
- Plugin side: 5 s timeout on every scanner API call (15 s+ for discovery),
  reconnect budget no longer resets itself (max 5 attempts honored), node
  binary probed across `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.

### Face
- **Burst sampling**: every interval (default 10 s) a ~1.5 s burst of ~15
  frames at 10 fps is captured and aggregated (median pose/gaze, ≥30 %
  visibility threshold, within-burst variance for stability, real blink edge
  detection at 100 ms resolution with duty-cycle-corrected blinks/min).
  Average detection load ≈ 2 frames/s instead of 1 frame/10 s — accurate *and*
  cheap.
- **Pinned + cached assets**: wasm runtime and face model are pinned to the
  installed `@mediapipe/tasks-vision@0.10.35` and cached in
  `.obsidian/plugins/cortex/.assets/` (~15 MB, one-time). Subsequent starts
  are network-free. Fallback chain: local cache → pinned CDN.
- **Delegate fallback**: GPU → CPU → CDN-runtime CPU, each with a 60 s timeout
  and a user-visible error instead of an infinite "Initializing…".
- **State machine**: `null` sentinel for pending state; 2 confirmations of
  burst aggregates (≈20 s worst-case to warn, vs. 30 s+ of noise-free single
  frames that effectively never happened).
- Camera released and overlay torn down properly on stop/unload (unchanged
  behavior, now centralized).

## 4. Performance work

| Change | Impact |
|---|---|
| `/start` responds immediately | BLE enable goes from "hangs (sometimes 5 min)" to <100 ms; toggles can no longer latch shut |
| Continuous BLE scan + watchdog | Steady 1 s RSSI updates; no more start/stop IPC churn (~75 scan restarts/min → ~0); fewer false session timeouts |
| Face burst sampling | ~2 frames/s average detection load, bursts skipped entirely while the window is hidden (`document.hidden`) |
| Asset cache | ~15 MB download eliminated from every face start after the first (start time after first run: model load only, no network) |
| Lazy `import("@mediapipe/tasks-vision")` | 134 KB of the 240 KB bundle (57 %) no longer executes at plugin load; module-eval measured ~25 ms → ~23 ms warm in Node (larger on cold caches, where the gap measured 47 ms → 23 ms) |
| Dashboard: 2 tickers → 1, paused when hidden | Half the per-second DOM work; zero when window hidden |
| Dashboard: metadata-change re-render debounced (2 s) | Previously every file save re-rendered the entire dashboard including a Google Calendar fetch — a real typing-lag source with the dashboard open |
| Detector startup deferred to `onLayoutReady` + 1 s | Unchanged (was already correct); now centralized in `DetectionManager.startEnabled()` |

Bundle size: 246 KB (unchanged ±1 % — lazy import defers execution, it cannot
shrink a single-file plugin bundle).

### Verification performed
- `tsc -noEmit` clean; production esbuild clean.
- New scanner exercised end-to-end against a stubbed `noble`:
  `/health`, `/start` (17 ms), name discovery, EMA smoothing, `/status`,
  `/stop` state reset — all correct.
- Live CoreBluetooth and webcam paths could not be exercised from the review
  environment (Bluetooth TCC permission belongs to Obsidian, not the shell;
  `noble` SIGABRTs outside it). **First manual run should verify:** BLE toggle
  on dashboard turns green and shows dBm within ~10 s, and face tracking shows
  stats after the one-time model download.

## 5. Follow-up incident (2026-06-12): orphaned scanner on port 18888

After the initial fixes, BLE failed with `EADDRINUSE` and face tracking was
sluggish. Diagnosis: an **orphaned scanner process from a previous session
(old scan-churn code) was still listening on port 18888 at 99.5 % CPU** —
every newly spawned scanner crashed on bind, and the pegged core slowed
everything else. Fixes:

- Plugin kills any stale listener on the port (`lsof -sTCP:LISTEN`) before
  spawning a scanner.
- Scanner exits with code 2 on `EADDRINUSE` instead of lingering half-alive.
- Scanner stdin is piped from the plugin; when Obsidian dies — even
  force-quit — the pipe closes and the scanner exits, so it can never orphan
  again. (Verified: bind-conflict exit and stdin-close exit both tested.)
- Face wasm/loader now served via `blob:` URLs from the disk cache (immune
  to vault-path/URL-scheme quirks), and the dashboard shows init progress
  ("Downloading face_landmarker.task (one-time)…") plus a STARTING toggle
  state instead of appearing dead during the first-run model download.

## 6. Known residual risks / follow-ups
- The scanner still depends on a system Node + globally installed
  `@abandonware/noble` (native module; cannot run under Electron's ABI).
  Bundling a prebuilt binary would remove this external dependency.
- Face thresholds (blink, pitch) are heuristics; the settings sliders allow
  per-user tuning. Slider changes apply the next time face tracking starts.
- `.assets/` cache is gitignored; delete it to force a re-download.
