import type { EventKind } from "./event";

export interface ActivityAuthor {
  id: string;
  login: string;
  name: string;
  avatarUrl: string;
}

export interface ActivityCategory {
  id: string;
}

export interface ActivityProject {
  id: string;
  name?: string;
  shortName?: string;
}

/** Lightweight ref to a parent issue or article embedded in a target. */
export interface ActivityTargetRef {
  id?: string;
  idReadable?: string;
  summary?: string;
  project?: ActivityProject;
}

export interface ActivityTarget {
  id?: string;
  idReadable?: string;
  targetType?: string; // $type from API, renamed by Rust serde
  text?: string;
  summary?: string; // Article/issue title
  project?: ActivityProject;
  issue?: ActivityTargetRef; // parent issue (when target is a comment, attachment, etc.)
  article?: ActivityTargetRef; // parent article (when target is an article comment)
}

export interface ActivityField {
  name?: string;
}

export interface ActivityItem {
  id: string;
  author?: ActivityAuthor;
  timestamp: number;
  category?: ActivityCategory;
  target?: ActivityTarget;
  targetMember?: string;
  added: unknown;
  removed: unknown;
  field?: ActivityField;
  activityType?: string; // $type from API
  /**
   * Provider-independent event kind, carried straight through from
   * `NormalizedEvent`.
   *
   * This is what type filtering keys on. The legacy `category.id` cannot serve
   * that role: it is a YouTrack vocabulary of 7 values that three distinct
   * kinds (assignment, statusChange, other) all collapse into as
   * `CustomFieldCategory`, making them impossible to tell apart in a filter.
   * `category` is retained only for rendering, which still branches on it.
   */
  kind?: EventKind;
  /**
   * Provider-rendered description of the change, for providers that supply one.
   *
   * YouTrack sends a structured `added`/`removed` diff the UI formats itself.
   * Nifty instead pre-renders every non-comment event as a sentence ("Assigned
   * @Bo to this task") and sends no diff at all, so this is the only
   * description those events have. When present it wins over diff formatting.
   */
  description?: string;
  /** Account ID this activity belongs to (injected by polling engine). */
  accountId?: string;
  /**
   * True when the current user is @-mentioned or directly targeted.
   *
   * Carried through from the normalized event so the feed can exempt mentions
   * from own-activity filtering: a comment you wrote that tags you is a real
   * notification in the provider's own UI, and hiding it makes the app disagree
   * with what the user sees there.
   */
  mentionsMe?: boolean;
  /**
   * Deep link into the provider's web UI, as computed by the provider.
   *
   * Carried through from the normalized event because the URL shape is
   * provider-specific — YouTrack's `/issue/{displayId}` and Nifty's
   * `/{projectId}/task/{taskId}` share no structure — and only the backend
   * knows the workspace host. Rebuilding it in the UI produces a YouTrack-shaped
   * link for every provider.
   */
  url?: string;
}

/** Category IDs matching YouTrack API. */
export type ActivityCategoryId =
  | "CommentsCategory"
  | "CustomFieldCategory"
  | "AttachmentsCategory"
  | "IssueCreatedCategory"
  | "IssueResolvedCategory"
  | "SprintCategory"
  | "VcsChangeCategory";

/** Activities grouped by project for the feed. */
export interface NotificationGroup {
  projectKey: string; // project shortName or fallback id
  projectName: string; // human-readable project name
  activities: ActivityItem[];
  latestTimestamp: number;
  hasUnread: boolean;
}
