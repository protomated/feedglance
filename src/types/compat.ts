/**
 * Compatibility shim: `NormalizedEvent` -> legacy `ActivityItem`.
 *
 * The backend now emits provider-independent `NormalizedEvent`s, but the feed
 * components still read YouTrack-shaped fields (`category.id`, `target.idReadable`,
 * `added`, `field.name`). Rather than rewrite every component at once, this
 * reconstructs the legacy shape so existing rendering keeps working for both
 * providers.
 *
 * For YouTrack events the original payload is carried verbatim in `raw`, so the
 * shim returns it unchanged and rendering is bit-identical to before. For Nifty
 * it synthesizes the minimum the components actually read.
 *
 * This is deliberately a migration aid. New UI should consume `NormalizedEvent`
 * directly via `src/types/event.ts`; components can be ported incrementally and
 * this file deleted once none remain.
 */

import type { ActivityItem } from "./activity";
import type { EventKind, NormalizedEvent } from "./event";

/** Map the normalized taxonomy back onto YouTrack category IDs. */
const KIND_TO_CATEGORY: Record<EventKind, string> = {
  comment: "CommentsCategory",
  statusChange: "CustomFieldCategory",
  assignment: "CustomFieldCategory",
  itemCreated: "IssueCreatedCategory",
  itemResolved: "IssueResolvedCategory",
  attachment: "AttachmentsCategory",
  sprint: "SprintCategory",
  vcsChange: "VcsChangeCategory",
  other: "CustomFieldCategory",
};

/** True when the value looks like a legacy YouTrack activity payload. */
function isLegacyActivity(v: unknown): v is ActivityItem {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    ("category" in v || "target" in v || "$type" in v)
  );
}

/**
 * Convert a normalized event into the legacy activity shape the feed renders.
 */
export function toActivityItem(event: NormalizedEvent): ActivityItem {
  // YouTrack: `raw` is the original activity — return it untouched so existing
  // rendering (field diffs, comment text, article targets) is unchanged.
  if (event.provider === "youtrack" && isLegacyActivity(event.raw)) {
    return { ...event.raw, accountId: event.accountId };
  }

  const project = event.subject.projectId
    ? {
        id: event.subject.projectId,
        name: event.subject.projectName,
        shortName: event.subject.projectName,
      }
    : undefined;

  const isComment = event.kind === "comment";

  return {
    id: event.id,
    author: event.actor
      ? {
          id: event.actor.id,
          login: event.actor.name,
          name: event.actor.name,
          avatarUrl: event.actor.avatarUrl,
        }
      : undefined,
    timestamp: event.timestamp,
    category: { id: KIND_TO_CATEGORY[event.kind] },
    target: {
      id: event.subject.id,
      idReadable: event.subject.displayId,
      // Comments hang off a parent item in the YouTrack shape; mirroring that
      // makes the components resolve the right issue ID and title.
      targetType: isComment ? "IssueComment" : "Issue",
      text: event.text,
      summary: event.subject.title,
      project,
      issue: isComment
        ? {
            id: event.subject.id,
            idReadable: event.subject.displayId,
            summary: event.subject.title,
            project,
          }
        : undefined,
    },
    // Nifty pre-renders its change descriptions, so there is no structured
    // added/removed diff to surface.
    added: null,
    removed: null,
    field:
      event.kind === "assignment"
        ? { name: "Assignee" }
        : event.kind === "statusChange"
          ? { name: "State" }
          : undefined,
    activityType: event.provider,
    accountId: event.accountId,
  };
}

export function toActivityItems(events: NormalizedEvent[]): ActivityItem[] {
  return events.map(toActivityItem);
}
