# Chronote — Performance Notes

This document records the runtime-cost considerations and optimization work in the current Chronote tree. It is meant for contributors who need to know *why* the codebase is shaped the way it is.

## Principles

- **The vault is the database.** Review state lives in note frontmatter; tests live in `data.json`. There is no separate DB, so the main cost of "the system running" is Obsidian's own `metadataCache`.
- **The user is the bottleneck, not Chronote.** A typical review takes 5–10 seconds; a single chat turn costs more than a hundred background ticks. Optimize for the user, then for the system.
- **The AI provider is the network boundary.** Whatever the chat or embedding provider costs is on the provider. Chronote's job is to not send more than it needs to.

## Startup

- `main.ts` is intentionally small. The plugin does as little as possible during `onload()`; heavier wiring (settings tab, commands, dashboard leaves) follows standard Obsidian patterns.
- The vector index is built lazily: the first reindex of the vault is what populates `knowledge-index.bin`. Subsequent loads reuse the on-disk file.

## Render costs

- **Dashboard re-renders are debounced 2 seconds.** `metadataCache.on("changed", ...)` fires on every save while the user is typing, and a re-render fetches Google Calendar. The 2 s debounce keeps the editor responsive when the dashboard is open.
- **The dashboard uses short-lived service instances.** `GoogleCalendarService` is created per consumer (Dashboard, Chat Modal) so its 60 s refresh timer is owned by the component that actually uses it. Always call `.destroy()` on tear-down.
- **The 30-second calendar fetch cache** keeps repeated tab switches cheap.

## Network costs

- **Chat calls.** Chronote sends the user's message plus the minimum context the active adapter needs (due notes metadata, file basenames, today's calendar events, upcoming tests). It does not silently upload the whole vault.
- **Embedding calls** happen only when the user explicitly clicks **Reindex vault**. The chunker (`src/agent/vectorIndex/chunker.ts`) bounds the size of each request.
- **Provider keys** are sent in the format the provider's API expects. The user's choice of provider is the only network destination Chronote uses for AI traffic.

## Bundle size

- The plugin ships as a single `main.js`. `esbuild` bundles all dependencies.
- AI-provider SDKs and embedding libraries are **lazy-imported** inside the adapter that uses them. They do not execute at plugin load, which keeps startup fast and avoids loading code paths the user has not enabled.
- Lazy import defers execution; it does not shrink the bundle. Adding a heavy dependency still costs disk space — only add it if the user can opt out.

## Tool calls

- The agent layer (`src/agent/toolRegistry.ts`) validates arguments against the tool's JSON Schema before dispatch and returns a clear error string to the model on failure. This avoids the model getting stuck in invalid-argument loops.
- The OpenAI-compatible adapter has a manual `<tool_call>{...}</tool_call>` fallback for local models that don't emit native tool calls. The fallback only fires when the assistant text looks intentional, so it doesn't churn on plain prose.

## Reindex cost

- The vector index is a single file (`knowledge-index.bin`) and is loaded into memory. Reindexing a large vault takes a while but is bounded by the embedding provider's throughput. Local Ollama is roughly 50–200 notes/minute depending on model; cloud providers are faster but cost money.
- The user is in control: the **Reindex vault** button is the only place embedding traffic is generated. There is no background reindex.

## Known limitations

- A very large vault (10,000+ notes) reindexed against a slow local model can take hours. There is no parallel chunking yet; embedding requests are issued serially per note to avoid overwhelming the local server.
- A long chat session with many tool calls grows the prompt, and the chat adapter does not yet summarize old history. If responses slow down, click **Clear chat** to reset.
