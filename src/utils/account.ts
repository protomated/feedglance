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
 * Default display label for an account.
 *
 * Deriving this from the host only works when the host encodes the workspace,
 * which is true for YouTrack (`myteam.youtrack.cloud`) and for Nifty's default
 * form (`myteam.nifty.pm`). It is NOT true for a Nifty CNAME custom domain:
 * `portal.protomated.com` yields "portal", which names the subdomain rather
 * than the workspace and is meaningless to the user.
 *
 * So the host is used only when it matches a known workspace-encoding pattern.
 * Otherwise we prefer the account owner's name, then the registrable domain,
 * then the provider name. Users can override any of this via renameAccount.
 */
export function labelForAccount(
  url: string,
  provider: ProviderKind | undefined,
  userName?: string,
): string {
  const providerName = provider === "nifty" ? "Nifty" : "YouTrack";

  if (url) {
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = "";
    }

    if (hostname) {
      // Workspace-encoding hosts: the first segment IS the workspace name.
      if (/\.youtrack\.cloud$/i.test(hostname) || /\.nifty\.pm$/i.test(hostname)) {
        const first = hostname.split(".")[0];
        if (first) return first;
      }

      // Custom domain — the subdomain is not the workspace name. Prefer the
      // person's name, else fall back to the registrable domain
      // ("protomated.com" reads better than "portal").
      if (userName) return userName;
      const parts = hostname.split(".").filter(Boolean);
      if (parts.length >= 2) return parts.slice(-2).join(".");
      return hostname;
    }
  }

  if (userName) return userName;
  return providerName;
}
