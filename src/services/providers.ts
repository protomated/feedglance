/**
 * Per-provider onboarding metadata.
 *
 * Each provider needs different things from the user, so the connect form is
 * driven by this table rather than by branching in the component.
 */

import type { ProviderKind } from "../types/youtrack";
import { normalizeWorkspaceHost } from "../types/event";
import { isValidYouTrackCloudUrl, normalizeUrl } from "./validation";

export interface ProviderDescriptor {
  kind: ProviderKind;
  /** Display name in the provider picker. */
  name: string;
  /** One-line description shown under the picker. */
  tagline: string;
  /** Label for the host field. */
  hostLabel: string;
  hostPlaceholder: string;
  /** Whether the host field must be filled in to connect. */
  hostRequired: boolean;
  /** Explanatory text under the host field. */
  hostHelp?: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  /** Link to the provider's token documentation. */
  tokenDocsUrl: string;
  tokenDocsLabel: string;
  /**
   * Validate and normalize the host input.
   *
   * Returns the normalized host, or an error message. An empty string is a
   * valid result for providers where the host is optional.
   */
  normalizeHost(input: string): { value: string } | { error: string };
}

export const PROVIDERS: Record<ProviderKind, ProviderDescriptor> = {
  youtrack: {
    kind: "youtrack",
    name: "YouTrack",
    tagline: "JetBrains YouTrack Cloud",
    hostLabel: "YouTrack Cloud URL",
    hostPlaceholder: "myteam.youtrack.cloud",
    hostRequired: true,
    tokenLabel: "Permanent Token",
    tokenPlaceholder: "perm:xxx-xxx-xxx...",
    tokenDocsUrl:
      "https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html",
    tokenDocsLabel: "How to get a permanent token",
    normalizeHost(input: string) {
      if (!isValidYouTrackCloudUrl(input)) {
        return {
          error: "Enter a valid YouTrack Cloud URL (e.g. myteam.youtrack.cloud)",
        };
      }
      return { value: normalizeUrl(input) };
    },
  },

  nifty: {
    kind: "nifty",
    name: "Nifty",
    tagline: "Nifty PM workspace",
    hostLabel: "Workspace URL",
    hostPlaceholder: "myteam.nifty.pm",
    // Optional: Nifty's API host is fixed, so this is only used to build deep
    // links. Without it the app still works — notifications just don't link out.
    hostRequired: false,
    hostHelp:
      "Optional — used to open tasks in your browser. Supports custom domains.",
    tokenLabel: "API Token",
    tokenPlaceholder: "Your Nifty API token",
    tokenDocsUrl: "https://help.niftypm.com/en/articles/6749505-nifty-api-webhooks",
    tokenDocsLabel: "How to get an API token",
    normalizeHost(input: string) {
      if (!input.trim()) return { value: "" };
      const host = normalizeWorkspaceHost(input);
      if (!host) {
        return {
          error: "Enter a valid workspace URL (e.g. myteam.nifty.pm)",
        };
      }
      return { value: host };
    },
  },
};

export const PROVIDER_LIST: ProviderDescriptor[] = [
  PROVIDERS.youtrack,
  PROVIDERS.nifty,
];

/** Resolve a descriptor, defaulting to YouTrack for accounts saved without one. */
export function providerOf(kind: ProviderKind | undefined): ProviderDescriptor {
  return PROVIDERS[kind ?? "youtrack"] ?? PROVIDERS.youtrack;
}
