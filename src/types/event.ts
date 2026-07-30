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
 * Resolve an event's deep link.
 *
 * Providers supply `url` where they can; this falls back for cached events
 * persisted before the field existed.
 */
export function eventUrl(event: NormalizedEvent, instanceUrl?: string): string | undefined {
  if (event.url) return event.url;
  if (event.provider === "youtrack" && instanceUrl && event.subject.displayId) {
    return `${instanceUrl.replace(/\/$/, "")}/issue/${event.subject.displayId}`;
  }
  if (event.provider === "nifty" && event.subject.id) {
    return `https://app.niftypm.com/task/${event.subject.id}`;
  }
  return undefined;
}

/** True when an event should count as unread. */
export function isUnread(event: NormalizedEvent, readIds: Set<string>): boolean {
  // Trust server-side read state when a provider actually supplies it.
  if (event.seenRemotely === true) return false;
  if (event.seenRemotely === false) return true;
  return !readIds.has(event.id);
}
