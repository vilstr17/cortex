import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression test for the Gemini API key handling.
 *
 * The original implementation passed the API key as a `?key=` query
 * parameter on the URL. That is a security regression: query-string
 * credentials get logged by intermediaries, cached in browser history,
 * and forwarded in referer headers. The fix moves the key to the
 * `x-goog-api-key` header, which is the documented authentication
 * channel for the Gemini REST API.
 *
 * This test mocks the Obsidian `requestUrl` module and asserts that:
 *   1. The URL no longer contains `key=`.
 *   2. The `x-goog-api-key` header carries the API key.
 *
 * If a future contributor reverts the fix, the first assertion fails
 * immediately and the issue is caught at PR time.
 */

const requestUrlMock = vi.fn();

vi.mock("obsidian", () => ({
  requestUrl: (...args: unknown[]) => requestUrlMock(...args),
}));

import { GeminiService } from "../geminiService";
import { DEFAULT_SETTINGS, CortexSettings } from "../../settingsTypes";

function settingsWithKey(key: string): CortexSettings {
  return { ...DEFAULT_SETTINGS, geminiApiKey: key };
}

describe("GeminiService — API key transport", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    // First response: a text-only candidate. Stops the function-call loop.
    requestUrlMock.mockResolvedValue({
      json: {
        candidates: [
          {
            content: {
              parts: [{ text: "ok" }],
            },
          },
        ],
      },
    });
  });

  it("does not include the API key in the request URL", async () => {
    const svc = new GeminiService(settingsWithKey("AIza-LEAKED-KEY-12345"));
    await svc.chat([{ role: "user", text: "hi" }]);

    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    const call = requestUrlMock.mock.calls[0][0] as { url: string; headers: Record<string, string> };
    expect(call.url).not.toMatch(/[?&]key=/);
    expect(call.url).not.toContain("AIza-LEAKED-KEY-12345");
  });

  it("sends the API key in the x-goog-api-key header", async () => {
    const svc = new GeminiService(settingsWithKey("AIza-LEAKED-KEY-12345"));
    await svc.chat([{ role: "user", text: "hi" }]);

    const call = requestUrlMock.mock.calls[0][0] as { headers: Record<string, string> };
    expect(call.headers["x-goog-api-key"]).toBe("AIza-LEAKED-KEY-12345");
  });

  it("uses POST with JSON content-type", async () => {
    const svc = new GeminiService(settingsWithKey("k"));
    await svc.chat([{ role: "user", text: "hi" }]);

    const call = requestUrlMock.mock.calls[0][0] as { method: string; headers: Record<string, string> };
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/json");
  });

  it("targets the configured Gemini model in the URL", async () => {
    const svc = new GeminiService({ ...settingsWithKey("k"), geminiModel: "gemini-2.5-pro" });
    await svc.chat([{ role: "user", text: "hi" }]);

    const call = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(call.url).toMatch(/gemini-2\.5-pro:generateContent$/);
  });
});
