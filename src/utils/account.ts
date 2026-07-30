import type { ProviderKind } from "../types/youtrack";

/**
 * Generate a deterministic account ID.
 *
 * The ID is derived from the provider plus its identifying key so the same URL
 * on two providers never collides, and so existing YouTrack IDs stay stable.
 *
 * The key differs by provider:
 * - YouTrack: the instance URL, which uniquely identifies the account.
 * - Nifty: the token. Nifty's workspace URL is optional and purely cosmetic
 *   (deep links only), so hashing it would give every host-less Nifty account
 *   the same ID and silently merge distinct workspaces into one.
 */
export async function generateAccountId(
  url: string,
  provider: ProviderKind = "youtrack",
  token?: string,
): Promise<string> {
  const key = provider === "nifty" ? `nifty:${token ?? ""}` : url;
  return hash12(key.toLowerCase().replace(/\/+$/, ""));
}

async function hash12(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 12);
}

/** Extract a short label from a URL (e.g. "myteam" from "https://myteam.youtrack.cloud"). */
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

/**
 * Display label for an account.
 *
 * Falls back through host, then the user's own name, then the provider name —
 * a Nifty account with no workspace URL still needs something to show.
 */
export function labelForAccount(
  url: string,
  provider: ProviderKind | undefined,
  userName?: string,
): string {
  if (url) {
    const fromUrl = labelFromUrl(url);
    if (fromUrl) return fromUrl;
  }
  if (userName) return userName;
  return provider === "nifty" ? "Nifty" : "YouTrack";
}
