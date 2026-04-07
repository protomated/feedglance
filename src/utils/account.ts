/**
 * Generate a deterministic account ID from a normalized YouTrack URL.
 * Uses the first 12 hex chars of a SHA-256 hash of the URL.
 */
export async function generateAccountId(url: string): Promise<string> {
  const normalized = url.toLowerCase().replace(/\/+$/, "");
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 12);
}

/** Extract a short label from a YouTrack Cloud URL (e.g. "myteam" from "https://myteam.youtrack.cloud"). */
export function labelFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // "myteam.youtrack.cloud" → "myteam"
    const parts = hostname.split(".");
    return parts[0] || hostname;
  } catch {
    return url;
  }
}
