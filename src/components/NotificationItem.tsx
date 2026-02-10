import type { ActivityItem } from "../types/activity";

/** Format a timestamp as relative time (e.g. "2m ago", "3h ago"). */
function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Describe what happened in this activity. */
function describeActivity(activity: ActivityItem): string {
  const categoryId = activity.category?.id;
  const fieldName = activity.field?.name;

  switch (categoryId) {
    case "CommentsCategory":
      return "commented";
    case "CustomFieldCategory":
      if (fieldName) {
        const added = extractName(activity.added);
        if (added) return `changed ${fieldName} to ${added}`;
        return `updated ${fieldName}`;
      }
      return "updated a field";
    case "AttachmentsCategory":
      return "added an attachment";
    case "IssueCreatedCategory":
      return "created this issue";
    case "IssueResolvedCategory":
      return "resolved this issue";
    case "SprintCategory":
      return "updated sprint";
    case "VcsChangeCategory":
      return "linked a commit";
    default:
      return "made a change";
  }
}

/** Extract a human-readable name from the `added` or `removed` value. */
function extractName(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "object" && first !== null && "name" in first) {
      return (first as { name: string }).name;
    }
  }
  if (typeof value === "object" && value !== null && "name" in value) {
    return (value as { name: string }).name;
  }
  return null;
}

/** Extract comment text from the added value. */
function extractCommentText(activity: ActivityItem): string | null {
  if (activity.category?.id !== "CommentsCategory") return null;
  const added = activity.added;
  if (Array.isArray(added) && added.length > 0) {
    const first = added[0];
    if (typeof first === "object" && first !== null && "text" in first) {
      return (first as { text: string }).text;
    }
  }
  if (activity.target?.text) return activity.target.text;
  return null;
}

/**
 * Derive the target label shown on each activity item.
 * Resolves through nested issue/article when the direct target is a
 * comment, attachment, or VCS change.
 */
function targetLabel(activity: ActivityItem): { label: string; id: string; type?: string } | null {
  const t = activity.target;
  if (!t) return null;

  // Direct issue target (e.g. IssueCreated, CustomField, IssueResolved)
  if (t.idReadable && t.targetType !== "IssueComment" && t.targetType !== "ArticleComment") {
    if (t.targetType === "Article") {
      return { label: t.summary ?? t.idReadable, id: t.idReadable, type: "Article" };
    }
    return { label: t.idReadable, id: t.idReadable, type: "Issue" };
  }

  // Target is a comment/attachment/vcs-change — resolve through parent issue or article
  const issue = t.issue;
  if (issue?.idReadable) {
    return { label: issue.idReadable, id: issue.idReadable, type: "Issue" };
  }
  const article = t.article;
  if (article) {
    const label = article.summary ?? article.idReadable ?? "Article";
    const id = article.idReadable ?? article.id ?? "";
    return { label, id, type: "Article" };
  }

  return null;
}

interface Props {
  activity: ActivityItem;
  isRead: boolean;
  onMarkRead: (id: string) => void;
  onOpenInBrowser?: (targetId: string, targetType?: string) => void;
}

export function NotificationItem({ activity, isRead, onMarkRead, onOpenInBrowser }: Props) {
  const authorName = activity.author?.name || activity.author?.login || "Unknown";
  const avatarUrl = activity.author?.avatarUrl;
  const description = describeActivity(activity);
  const commentText = extractCommentText(activity);
  const time = relativeTime(activity.timestamp);
  const resolved = targetLabel(activity);

  const handleOpenTarget = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onOpenInBrowser || !resolved || !resolved.id) return;
    onOpenInBrowser(resolved.id, resolved.type);
  };

  return (
    <div
      className={`flex gap-2.5 px-3 py-2 text-xs transition-colors ${
        isRead
          ? "opacity-60"
          : "bg-blue-50/50 dark:bg-blue-900/10 cursor-pointer"
      }`}
      onClick={() => {
        if (!isRead) onMarkRead(activity.id);
      }}
    >
      {/* Avatar */}
      <div className="flex-shrink-0 mt-0.5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={authorName}
            className="w-5 h-5 rounded-full"
          />
        ) : (
          <div className="w-5 h-5 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-[9px] font-medium text-gray-600 dark:text-gray-300">
            {authorName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {resolved && (
          <p className="mb-0.5">
            <span
              onClick={handleOpenTarget}
              className={`font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer ${
                resolved.type !== "Article" ? "font-mono" : ""
              }`}
            >
              {resolved.label}
            </span>
          </p>
        )}
        <p className="text-gray-700 dark:text-gray-300 leading-snug">
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {authorName}
          </span>{" "}
          {description}
        </p>
        {commentText && (
          <p className="mt-0.5 text-gray-500 dark:text-gray-400 line-clamp-2 leading-snug">
            {commentText}
          </p>
        )}
      </div>

      {/* Timestamp */}
      <span className="flex-shrink-0 text-gray-400 dark:text-gray-500 whitespace-nowrap">
        {time}
      </span>
    </div>
  );
}
