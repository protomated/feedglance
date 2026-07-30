/**
 * Provider-independent notification event.
 *
 * Mirrors `NormalizedEvent` in `src-tauri/src/provider/mod.rs` — the two must
 * stay in sync, since this is exactly what the `get_activities` IPC command now
 * returns for every provider.
 */

export type ProviderKind = "youtrack" | "nifty";

/** Provider-independent event category. */
export type EventKind =
  | "comment"
  | "statusChange"
  | "assignment"
  | "itemCreated"
  | "itemResolved"
  | "attachment"
  | "sprint"
  | "vcsChange"
  | "other";

export interface EventActor {
  id: string;
  name: string;
  avatarUrl: string;
}

/** The work item an event is about (issue, task, …). */
export interface EventSubject {
  /** Provider-native ID, used for mutations. */
  id: string;
  /** Human-facing ID (`PROJ-123`, `PTART-1`). */
  displayId: string;
  title?: string;
  projectId?: string;
  projectName?: string;
}

export interface NormalizedEvent {
  id: string;
  provider: ProviderKind;
  /** Unix ms, UTC. */
  timestamp: number;
  kind: EventKind;
  actor?: EventActor;
  subject: EventSubject;
  text?: string;
  /** Current user is @-mentioned or directly targeted. */
  mentionsMe: boolean;
  /**
   * Server-side read state, where a provider has one.
   *
   * `null`/`undefined` means the provider has none and read state is local.
   * Both current providers report null: YouTrack has no such API, and Nifty's
   * `seen_by` field is never populated in practice (verified against a live
   * workspace), so it cannot be trusted as a read signal.
   */
  seenRemotely?: boolean | null;
  /** Deep link into the provider's web UI. */
  url?: string;
  /** Account this event belongs to. */
  accountId?: string;
  /** Provider-native payload, for provider-specific UI. */
  raw?: unknown;
}

/** Events grouped by project for the feed. */
export interface EventGroup {
  projectKey: string;
  projectName: string;
  events: NormalizedEvent[];
  latestTimestamp: number;
  hasUnread: boolean;
}

/** Human-readable label for an event kind. */
export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  comment: "Comment",
  statusChange: "Status change",
  assignment: "Assignment",
  itemCreated: "Created",
  itemResolved: "Resolved",
  attachment: "Attachment",
  sprint: "Sprint",
  vcsChange: "VCS change",
  other: "Update",
};

/**
 * Path segment for a Nifty task, appended to the workspace host.
 *
 * Nifty's web app is a client-routed SPA that serves HTTP 200 for *every* path
 * (a nonsense URL returns 200 just like a real one), so this route could not be
 * verified from outside the app and is a best guess. If deep links land on the
 * wrong screen, this constant is the single place to correct.
 */
const NIFTY_TASK_PATH = "task";

/**
 * Resolve an event's deep link.
 *
 * Providers supply `url` where they can; this falls back for cached events
 * persisted before the field existed.
 *
 * `instanceUrl` is the account's configured workspace host. Nifty has no fixed
 * public host: workspaces live at `{workspace}.nifty.pm`, and paid plans can
 * front that with a CNAME custom domain (e.g. `portal.example.com`) serving the
 * same app. The REST API exposes neither the workspace slug nor the custom
 * domain, so the host must come from account config — there is nothing sensible
 * to hardcode, and guessing would deep-link users to a workspace they cannot
 * open.
 */
export function eventUrl(event: NormalizedEvent, instanceUrl?: string): string | undefined {
  if (event.url) return event.url;

  const host = instanceUrl?.replace(/\/$/, "");
  if (!host) return undefined;

  if (event.provider === "youtrack" && event.subject.displayId) {
    return `${host}/issue/${event.subject.displayId}`;
  }
  if (event.provider === "nifty" && event.subject.id) {
    return `${host}/${NIFTY_TASK_PATH}/${event.subject.id}`;
  }
  return undefined;
}

/**
 * Normalize a user-entered workspace host into an absolute origin.
 *
 * Accepts what people actually paste — `protomated.nifty.pm`,
 * `https://portal.example.com/`, or a full task URL — and reduces it to a bare
 * origin. Returns null when there is no usable host.
 */
export function normalizeWorkspaceHost(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    // Always https: Nifty issues a certificate for custom domains, and the
    // token would otherwise ride an unencrypted request.
    return `https://${url.host}`;
  } catch {
    return null;
  }
}

/** True when an event should count as unread. */
export function isUnread(event: NormalizedEvent, readIds: Set<string>): boolean {
  // Trust server-side read state when a provider actually supplies it.
  if (event.seenRemotely === true) return false;
  if (event.seenRemotely === false) return true;
  return !readIds.has(event.id);
}
