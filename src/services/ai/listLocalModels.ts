/**
 * Discover the model list exposed by a local OpenAI-compatible
 * server (Ollama, LM Studio, vLLM with `--api`, …).
 *
 * Both Ollama (`GET /v1/models`) and LM Studio
 * (`GET /v1/models`) follow the OpenAI list-models shape:
 *
 *   { "data": [ { "id": "model-name" }, ... ] }
 *
 * We accept any of these baseUrl forms and normalize to a `/v1/models`
 * URL:
 *
 *   http://localhost:11434        →  http://localhost:11434/v1/models
 *   http://localhost:11434/       →  http://localhost:11434/v1/models
 *   http://localhost:11434/v1     →  http://localhost:11434/v1/models
 *   http://localhost:11434/v1/    →  http://localhost:11434/v1/models
 *
 * Returns `[]` on every failure path (network error, non-2xx, missing
 * `data` array, empty baseUrl). The caller decides whether to surface
 * a Notice; this function never throws.
 *
 * Auth: the `Authorization` header is sent only when a non-empty key
 * is supplied. Local servers ignore auth, but newer Ollama builds
 * reject placeholder bearer tokens with HTTP 403, so omitting the
 * header when no real key is configured is the safe default.
 */
import { requestUrl } from "obsidian";

export async function listLocalModels(
  baseUrl: string,
  apiKey: string | null,
): Promise<{ id: string }[]> {
  if (!baseUrl) return [];

  // Normalize: trim, drop trailing slashes, ensure /v1 suffix.
  let url = baseUrl.trim().replace(/\/+$/, "");
  if (!/\/v1$/.test(url)) url = `${url}/v1`;

  const headers: Record<string, string> = {};
  if (apiKey && apiKey.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }

  let response: { status: number; json: unknown };
  try {
    response = await requestUrl({
      url: `${url}/models`,
      method: "GET",
      headers,
    });
  } catch {
    // Network error, CORS rejection, DNS failure, server down, …
    return [];
  }

  if (response.status < 200 || response.status >= 300) return [];

  const json = response.json as { data?: Array<{ id?: string }> } | null;
  if (!json || !Array.isArray(json.data)) return [];

  return json.data
    .map((m) => (m && typeof m.id === "string" ? { id: m.id } : null))
    .filter((m): m is { id: string } => m !== null);
}
