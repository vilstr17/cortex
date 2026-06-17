# Chronote Security

## Threat Model

Chronote operates inside an Obsidian vault with access to note contents, frontmatter, and the network. The primary concerns are:

- OAuth token handling (Google Calendar)
- API key storage (AI providers, embedding providers)
- Third-party service interactions (Google Calendar, the user's chosen AI provider)

## OAuth Flow & Token Storage

### Flow

1. The user clicks **Connect Google Calendar** in the Dashboard.
2. Obsidian opens a browser tab to `https://cortex-proxy.vercel.app/api/auth`.
3. The user authenticates with Google and authorizes calendar access.
4. The proxy redirects to the Obsidian protocol `chronote-auth://?access_token=...&refresh_token=...&expires_in=...`.
5. `main.ts` registers an Obsidian protocol handler (`chronote-auth`) that captures these parameters and persists them.

### Token Storage

- Access token, refresh token, and expiry timestamp are stored in **Obsidian's plugin `data.json`** via the standard `Plugin.loadData()` / `Plugin.saveData()` APIs.
- This file lives inside the vault at `.obsidian/plugins/chronote/data.json`.
- There is no encryption at rest; Obsidian does not provide an encrypted settings store.
- The refresh token is the most sensitive credential. If the vault is synced to a cloud provider, `data.json` travels with it.

### Transmission

- The refresh token is sent to the Chronote proxy via **HTTP POST** (`POST /api/refresh`) with the token in the JSON body, not in the URL query string.
- Access tokens are transmitted to Google APIs in the `Authorization: Bearer` header.
- The user's chosen AI provider sees the prompt, the user's message, and any context Chronote needs to answer it (selected by the user when they open the chat or ask for a study plan). API keys are sent in the format the provider requires (header, query parameter, or body) — the exact format is whatever that provider's API expects.

### Scope & Data Handling

- The plugin requests the Google Calendar API scope needed for primary calendar read/write.
- Calendar event data (titles, times, descriptions) is fetched from Google and displayed in the Dashboard. It is **not persisted locally** beyond the 30-second in-memory fetch cache.
- No vault note contents are sent to Google Calendar.

## AI Provider Credentials

**Files:** `src/services/ai/*`, `src/settings.ts`

- AI provider API keys are stored as plaintext in `data.json` (the active provider's field, e.g. `settings.geminiApiKey`).
- Each adapter (`GeminiAdapter`, `OpenAICompatAdapter`, `AnthropicAdapter`) sends the credential using the format the upstream API requires. Consult the destination's own docs for the canonical transmission rules.
- No vault note contents are sent to a provider unless the user opens the chat modal and the message or context gathering intentionally includes them (due notes metadata and file basenames are included in scheduling mode).
- **Chronote Cloud** is the planned managed option for users who don't want to manage their own API keys. It is **not available yet** — the option is reserved in the catalog and settings, and will activate when the managed service goes live. Once it does, the same context rules apply: the prompt goes to the cloud, but nothing leaves the vault until the user actively asks for it.

## Embedding Provider Credentials

**File:** `src/agent/vectorIndex/embeddings.ts`

- The embedding provider (used for vault search and flashcard suggestions) is configured separately from the chat provider, in **Settings → Chronote → Indexing**.
- The same credential rules as chat apply: keys are stored in `data.json`, sent in the format the provider's API requires, and never used to send anything other than embedding requests.
- Local servers (Ollama, LM Studio) require no API key at all.

## Credential Transmission Summary

| Credential | Destination | Method | Location in Request |
|---|---|---|---|
| Google refresh token | `cortex-proxy.vercel.app` | POST | JSON body (`{ refresh_token }`) |
| Google access token | `www.googleapis.com` | GET/POST/PATCH/DELETE | `Authorization: Bearer` header |
| Chat / embedding API key | The user-selected AI provider | per the provider's API spec | per the provider's API spec |

## Mitigations & Hardening

- `GoogleCalendarService` uses a **serialized refresh mutex** so concurrent callers do not trigger multiple refresh requests.
- `invalid_grant` is treated as a permanent failure; tokens are wiped from settings and the user must re-authenticate.

## Known Limitations

- `data.json` is plaintext. If you sync your vault with an untrusted host, tokens and API keys are exposed.
- The proxy (`cortex-proxy.vercel.app`) is operated by the plugin authors. It sees refresh tokens transiently during the refresh exchange.
- Vault search sends a small embedding request per note when the user clicks **Reindex vault**. The size of those requests is bounded by the chunker; embedding traffic is only triggered on explicit user action.
