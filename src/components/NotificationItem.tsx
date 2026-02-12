import { useEffect, useState } from "react";
import type { ActivityItem } from "../types/activity";
import { useFilterStore } from "../stores/filters";
import { InlineReply } from "./InlineReply";
import { StatusDropdown } from "./StatusDropdown";
import { AssignDropdown } from "./AssignDropdown";

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

/** Resolve the issue's readable ID for commands — walk through target/issue refs. */
export function resolveIssueId(activity: ActivityItem): string | null {
  const t = activity.target;
  if (!t) return null;

  // Direct issue target
  if (t.idReadable && t.targetType !== "IssueComment" && t.targetType !== "ArticleComment" && t.targetType !== "Article") {
    return t.idReadable;
  }

  // Parent issue
  if (t.issue?.idReadable) return t.issue.idReadable;

  return null;
}

/** Resolve the project ID for fetching states/team. */
function resolveProjectId(activity: ActivityItem): string | null {
  const t = activity.target;
  if (!t) return null;
  return t.project?.id ?? t.issue?.project?.id ?? t.article?.project?.id ?? null;
}

type ActiveAction = "reply" | "status" | "assign" | null;

/** Check if text is likely longer than what 2 lines would show (~120 chars). */
function isLikelyMultiLine(text: string): boolean {
  return text.length > 120 || text.includes("\n");
}

interface Props {
  activity: ActivityItem;
  isRead: boolean;
  isFocused?: boolean;
  onMarkRead: (id: string) => void;
  onOpenInBrowser?: (targetId: string, targetType?: string) => void;
}

export function NotificationItem({ activity, isRead, isFocused, onMarkRead, onOpenInBrowser }: Props) {
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [commentExpanded, setCommentExpanded] = useState(false);
  const muteIssue = useFilterStore((s) => s.muteIssue);

  // Listen for keyboard-triggered actions
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.activityId === activity.id) {
        const action = detail.action as ActiveAction;
        if (action) setActiveAction((prev) => (prev === action ? null : action));
      }
    };
    window.addEventListener("kb-action", handler);
    return () => window.removeEventListener("kb-action", handler);
  }, [activity.id]);

  const authorName = activity.author?.name || activity.author?.login || "Unknown";
  const avatarUrl = activity.author?.avatarUrl;
  const description = describeActivity(activity);
  const commentText = extractCommentText(activity);
  const time = relativeTime(activity.timestamp);
  const resolved = targetLabel(activity);

  const issueId = resolveIssueId(activity);
  const projectId = resolveProjectId(activity);
  const canAct = !!issueId; // Quick actions only work on issues

  const handleOpenTarget = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onOpenInBrowser || !resolved || !resolved.id) return;
    onOpenInBrowser(resolved.id, resolved.type);
  };

  const toggleAction = (action: ActiveAction) => {
    setActiveAction((prev) => (prev === action ? null : action));
  };

  return (
    <div data-activity-id={activity.id}>
      <div
        className={`group relative flex gap-2.5 px-3 py-2 text-xs transition-colors ${
          isRead
            ? "opacity-60"
            : "bg-blue-50/50 dark:bg-blue-900/10 cursor-pointer"
        }${isFocused ? " ring-2 ring-inset ring-blue-400 dark:ring-blue-500" : ""}`}
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
            <div className="mt-0.5">
              <p
                className={`text-gray-500 dark:text-gray-400 leading-snug whitespace-pre-wrap ${
                  commentExpanded ? "" : "line-clamp-2"
                }`}
              >
                {commentText}
              </p>
              {isLikelyMultiLine(commentText) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCommentExpanded((prev) => !prev);
                  }}
                  className="mt-0.5 text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 text-[10px] font-medium transition-colors"
                >
                  {commentExpanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Timestamp + hover actions */}
        <div className="flex-shrink-0 flex items-start gap-1">
          <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap group-hover:hidden">
            {time}
          </span>

          {/* Action buttons — shown on hover */}
          {canAct && (
            <div className="hidden group-hover:flex items-center gap-0.5">
              {/* Reply */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleAction("reply");
                }}
                title="Reply"
                className={`p-1 rounded transition-colors ${
                  activeAction === "reply"
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600"
                    : "text-gray-400 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
                </svg>
              </button>

              {/* Status */}
              {projectId && (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAction("status");
                    }}
                    title="Change status"
                    className={`p-1 rounded transition-colors ${
                      activeAction === "status"
                        ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600"
                        : "text-gray-400 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
                    </svg>
                  </button>
                  {activeAction === "status" && (
                    <StatusDropdown
                      issueId={issueId!}
                      projectId={projectId}
                      onClose={() => setActiveAction(null)}
                    />
                  )}
                </div>
              )}

              {/* Assign */}
              {projectId && (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAction("assign");
                    }}
                    title="Assign"
                    className={`p-1 rounded transition-colors ${
                      activeAction === "assign"
                        ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600"
                        : "text-gray-400 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
                    </svg>
                  </button>
                  {activeAction === "assign" && (
                    <AssignDropdown
                      issueId={issueId!}
                      projectId={projectId}
                      onClose={() => setActiveAction(null)}
                    />
                  )}
                </div>
              )}

              {/* Mute issue */}
              {issueId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    muteIssue(issueId);
                  }}
                  title="Mute this issue"
                  className="p-1 rounded text-gray-400 hover:text-orange-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 2.81v10.38c0 .67-.81 1.01-1.28.53L3.63 10.63H.75a.75.75 0 0 1-.75-.75v-3.76a.75.75 0 0 1 .75-.75h2.88l3.09-3.09c.47-.47 1.28-.13 1.28.53ZM15.53 4.72a.75.75 0 0 0-1.06 0L12.78 6.4l-1.69-1.69a.75.75 0 0 0-1.06 1.06L11.72 7.5l-1.69 1.69a.75.75 0 1 0 1.06 1.06l1.69-1.69 1.69 1.69a.75.75 0 1 0 1.06-1.06L13.84 7.5l1.69-1.72a.75.75 0 0 0 0-1.06Z" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Inline reply panel */}
      {activeAction === "reply" && issueId && (
        <InlineReply
          issueId={issueId}
          projectId={projectId ?? undefined}
          onClose={() => setActiveAction(null)}
        />
      )}
    </div>
  );
}
