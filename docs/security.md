# Cortex Security

## Threat Model

Cortex operates inside an Obsidian vault with access to note contents, frontmatter, and the network. The primary concerns are:
- OAuth token handling
- API key storage
- Local hardware access (Bluetooth, webcam)
- Third-party service interactions (Google Calendar, Gemini)

## OAuth Flow & Token Storage

### Flow
1. The user clicks **Connect Google Calendar** in the Dashboard.
2. Obsidian opens a browser tab to `https://cortex-proxy.vercel.app/api/auth`.
3. The user authenticates with Google and authorizes calendar access.
4. The proxy redirects to the Obsidian protocol `cortex-auth://?access_token=...&refresh_token=...&expires_in=...`.
5. `main.ts` registers an Obsidian protocol handler (`cortex-auth`) that captures these parameters and persists them.

### Token Storage
- Access token, refresh token, and expiry timestamp are stored in **Obsidian's plugin `data.json`** via the standard `Plugin.loadData()` / `Plugin.saveData()` APIs.
- This file lives inside the vault at `.obsidian/plugins/cortex/data.json`.
- There is no encryption at rest; Obsidian does not provide a encrypted settings store.
- The refresh token is the most sensitive credential. If the vault is synced to a cloud provider, `data.json` travels with it.

### Transmission
- The refresh token is sent to the Cortex proxy via **HTTP POST** (`POST /api/refresh`) with the token in the JSON body, not in the URL query string.
- Access tokens are transmitted to Google APIs in the `Authorization: Bearer` header.
- **Exception:** The Gemini API key is sent as a query parameter (`?key=`) because the Gemini REST API requires this. The request body (prompt) travels separately.

### Scope & Data Handling
- The plugin requests the Google Calendar API scope needed for primary calendar read/write.
- Calendar event data (titles, times, descriptions) is fetched from Google and displayed in the Dashboard. It is **not persisted locally** beyond the 30-second in-memory fetch cache.
- No vault note contents are sent to Google Calendar.

## BLE Security

**File:** `src/ble/BleFocusDetector.ts`, `ble-scanner.cjs`

- BLE scanning is **local-only**.
- The scanner is a Node child process using `@abandonware/noble`. It communicates with the plugin over HTTP on `127.0.0.1:18888`.
- No Bluetooth data (RSSI, device names, MAC addresses) leaves the machine.
- The scanner process is killed on plugin unload.
- Requires the user to explicitly select and calibrate a device before detection is meaningful.

## Face Detection Security

**File:** `src/FaceDetector.ts`, `src/face/FaceFocusEvaluator.ts`

- Face detection is **local-only**.
- Uses MediaPipe FaceLandmarker in the Obsidian/Electron renderer process.
- Camera frames are analyzed in-memory and **never recorded, stored, or transmitted**.
- The video element is positioned off-screen (`left: -10000px`) rather than `display:none` to keep Chromium decoding frames.
- Camera permission is requested via Electron's `systemPreferences.askForMediaAccess("camera")` where available.
- The detection model and wasm runtime are downloaded once (~15 MB) and cached in `.obsidian/plugins/cortex/.assets/` inside the vault. Subsequent starts are network-free.

## Gemini API Key Handling

**File:** `src/services/geminiService.ts`

- The API key is stored as plaintext in `data.json` (`settings.geminiApiKey`).
- It is sent to `https://generativelanguage.googleapis.com`.
- No vault note contents are sent to Gemini unless the user opens the chat modal and the message or context gathering intentionally includes them (due notes metadata and file basenames are included in scheduling mode).

## Credential Transmission Summary

| Credential | Destination | Method | Location in Request |
|---|---|---|---|
| Google refresh token | `cortex-proxy.vercel.app` | POST | JSON body (`{ refresh_token }`) |
| Google access token | `www.googleapis.com` | GET/POST/PATCH/DELETE | `Authorization: Bearer` header |
| Gemini API key | `generativelanguage.googleapis.com` | POST | URL query parameter (`?key=`) |

## Mitigations & Hardening

- `GoogleCalendarService` uses a **serialized refresh mutex** so concurrent callers do not trigger multiple refresh requests.
- `invalid_grant` is treated as a permanent failure; tokens are wiped from settings and the user must re-authenticate.
- The BLE scanner API has a 5-second timeout on every local HTTP call so a wedged child process cannot hang the plugin.
- Face detection initialization has a 60-second timeout and a GPU → CPU → CDN-runtime fallback chain to avoid silent stalls.

## Known Limitations

- `data.json` is plaintext. If you sync your vault with an untrusted host, tokens and API keys are exposed.
- The proxy (`cortex-proxy.vercel.app`) is operated by the plugin authors. It sees refresh tokens transiently during the refresh exchange.
- MediaPipe assets are fetched from public CDNs (jsdelivr, Google Storage) on first run; the vault adapter caches them locally after that.
