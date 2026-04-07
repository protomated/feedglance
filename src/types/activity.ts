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
  /** Account ID this activity belongs to (injected by polling engine). */
  accountId?: string;
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
