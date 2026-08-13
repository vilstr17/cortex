# Chronote Security

## Threat Model

Chronote operates inside an Obsidian vault with access to note contents, frontmatter, and the network. The primary concerns are:

- API key storage (AI providers, embedding providers)
- Third-party service interactions (the user's chosen AI provider)

## AI Provider Credentials

**Files:** `src/services/ai/*`, `src/settings.ts`

- AI provider API keys are stored as plaintext in `data.json` (the active provider's field, e.g. `settings.geminiApiKey`).
- Each adapter (`GeminiAdapter`, `OpenAICompatAdapter`, `AnthropicAdapter`) sends the credential using the format the upstream API requires. Consult the destination's own docs for the canonical transmission rules.
- No vault note contents are sent to a provider unless the user opens the chat modal and the message or context gathering intentionally includes them (the model pulls due-review and test metadata on demand via the `list_reviews` / `list_tests` tools).

## Embedding Provider Credentials

**File:** `src/agent/vectorIndex/embeddings.ts`

- The embedding provider (used for vault search and flashcard suggestions) is configured separately from the chat provider, in **Settings → Chronote → Indexing**.
- The same credential rules as chat apply: keys are stored in `data.json`, sent in the format the provider's API requires, and never used to send anything other than embedding requests.
- Local servers (Ollama, LM Studio) require no API key at all.

## Credential Transmission Summary

| Credential | Destination | Method | Location in Request |
|---|---|---|---|
| Chat / embedding API key | The user-selected AI provider | per the provider's API spec | per the provider's API spec |

## Known Limitations

- `data.json` is plaintext. If you sync your vault with an untrusted host, tokens and API keys are exposed.
- Vault search sends a small embedding request per note when the user clicks **Reindex vault**. The size of those requests is bounded by the chunker; embedding traffic is only triggered on explicit user action.
