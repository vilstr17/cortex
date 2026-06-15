/**
 * Render a unix-millisecond timestamp as a friendly "X min ago" string.
 * Pulled out of the settings tab so the dashboard's "Vault Index"
 * section can use the same wording for the "last updated" line.
 *
 * Pure function, no Obsidian dependency — trivially testable.
 */
export function formatRelative(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
