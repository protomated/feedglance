import { useEffect, useState, type ReactNode } from "react";
import type { ActivityItem } from "../types/activity";
import { useFilterStore } from "../stores/filters";
import { useNotificationStore } from "../stores/notifications";
import { useAuthStore } from "../stores/auth";
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

const VALUE_TRUNCATE = 40;

/** Truncate long values with ellipsis; full value is kept on the title attribute. */
function truncate(s: string): string {
  if (s.length <= VALUE_TRUNCATE) return s;
  return s.slice(0, VALUE_TRUNCATE) + "…";
}

/** Normalize added/removed into an array of entries. */
function toEntries(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/** Pick the first non-empty string among the given keys on an object. */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Keys we'll treat as a displayable label on an `added`/`removed` entry. */
const LABEL_KEYS = ["name", "localizedName", "fullName", "presentation", "text", "login"] as const;

/** Extract the first entry's displayable label, if any. */
function extractName(value: unknown): string | null {
  for (const entry of toEntries(value)) {
    if (typeof entry === "string") return entry;
    if (typeof entry === "object" && entry !== null) {
      const n = pickString(entry as Record<string, unknown>, LABEL_KEYS);
      if (n) return n;
    }
  }
  return null;
}

/** Return all entries' displayable labels (for multi-enum / tag fields). */
function extractAllNames(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of toEntries(value)) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (typeof entry === "object" && entry !== null) {
      const n = pickString(entry as Record<string, unknown>, LABEL_KEYS);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Return the first object's `login`, if present (for user references). */
function extractLogin(value: unknown): string | null {
  for (const entry of toEntries(value)) {
    if (typeof entry === "object" && entry !== null && "login" in entry) {
      const l = (entry as { login: unknown }).login;
      if (typeof l === "string" && l.length > 0) return l;
    }
  }
  return null;
}

/** Return the first object's `id`, if present (for user references). */
function extractId(value: unknown): string | null {
  for (const entry of toEntries(value)) {
    if (typeof entry === "object" && entry !== null && "id" in entry) {
      const i = (entry as { id: unknown }).id;
      if (typeof i === "string" && i.length > 0) return i;
    }
  }
  return null;
}

/** Return the first object's `presentation` (pre-formatted period values like "2h 30m"). */
function extractPresentation(value: unknown): string | null {
  for (const entry of toEntries(value)) {
    if (typeof entry === "object" && entry !== null && "presentation" in entry) {
      const p = (entry as { presentation: unknown }).presentation;
      if (typeof p === "string" && p.length > 0) return p;
    }
  }
  return null;
}

/** Return a numeric value (for date fields stored as unix-ms). */
function extractNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  for (const entry of toEntries(value)) {
    if (typeof entry === "number") return entry;
    if (typeof entry === "object" && entry !== null) {
      for (const key of ["value", "timestamp", "millis"]) {
        if (key in entry) {
          const v = (entry as Record<string, unknown>)[key];
          if (typeof v === "number") return v;
        }
      }
    }
  }
  return null;
}

const DATE_FIELD_NAMES = new Set(["Due Date", "Due date", "Start date", "End date"]);
const FREE_TEXT_FIELDS = new Set(["description", "summary"]);

/** Format a unix-ms timestamp as "Apr 20" or "Apr 20, 2027" when year differs. */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Relative suffix like "in 5 days" / "3 days ago" / "today". */
function relativeDayTail(ms: number): string {
  const now = Date.now();
  const diffMs = ms - now;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${-days} days ago`;
}

/** Presentation styles shared by the structured description renderer. */
const cls = {
  label: "text-gray-500 dark:text-gray-400",
  arrow: "text-gray-400 dark:text-gray-500 mx-1",
  oldValue: "line-through text-gray-400 dark:text-gray-500",
  newValue: "text-gray-900 dark:text-gray-100",
};

interface DescriptionResult {
  node: ReactNode;
  isAssignmentToMe: boolean;
  isUnassigned: boolean;
}

/** Render a truncated value span with full-text tooltip on hover. */
function val(raw: string, strike = false): ReactNode {
  const display = truncate(raw);
  const className = strike ? cls.oldValue : cls.newValue;
  return (
    <span className={className} title={display === raw ? undefined : raw}>
      {display}
    </span>
  );
}

/** Render "Old → New" or just "New" or "cleared". */
function oldNew(oldName: string | null, newName: string | null, clearedLabel: string): ReactNode {
  if (newName && oldName) {
    return (
      <>
        {val(oldName, true)}
        <span className={cls.arrow}>→</span>
        {val(newName)}
      </>
    );
  }
  if (newName) return val(newName);
  return <span className={cls.label}>{clearedLabel}</span>;
}

/** Describe what happened in this activity as a React node plus flags. */
function describeActivity(activity: ActivityItem, currentUserLogin: string | null, currentUserId: string | null): DescriptionResult {
  const categoryId = activity.category?.id;
  const fieldName = activity.field?.name ?? "";

  if (categoryId === "CommentsCategory") {
    return { node: "commented", isAssignmentToMe: false, isUnassigned: false };
  }
  if (categoryId === "AttachmentsCategory") {
    return { node: "added an attachment", isAssignmentToMe: false, isUnassigned: false };
  }
  if (categoryId === "IssueCreatedCategory") {
    return { node: "created this issue", isAssignmentToMe: false, isUnassigned: false };
  }
  if (categoryId === "IssueResolvedCategory") {
    return { node: "resolved this issue", isAssignmentToMe: false, isUnassigned: false };
  }
  if (categoryId === "VcsChangeCategory") {
    return { node: "linked a commit", isAssignmentToMe: false, isUnassigned: false };
  }
  if (categoryId === "SprintCategory") {
    const added = extractName(activity.added);
    const removed = extractName(activity.removed);
    if (added && !removed) return { node: <>moved to sprint {val(added)}</>, isAssignmentToMe: false, isUnassigned: false };
    if (removed && !added) return { node: <>removed from sprint {val(removed)}</>, isAssignmentToMe: false, isUnassigned: false };
    return { node: "updated sprint", isAssignmentToMe: false, isUnassigned: false };
  }
  if (categoryId !== "CustomFieldCategory" || !fieldName) {
    return { node: "made a change", isAssignmentToMe: false, isUnassigned: false };
  }

  const added = activity.added;
  const removed = activity.removed;

  // Assignee field — match by login (preferred) or id, whichever we have.
  if (fieldName === "Assignee") {
    const addedLogin = extractLogin(added);
    const addedId = extractId(added);
    const addedName = extractName(added);
    const isMe = (!!currentUserLogin && addedLogin === currentUserLogin)
      || (!!currentUserId && addedId === currentUserId);
    if (addedName) {
      return { node: <>assigned to {val(addedName)}</>, isAssignmentToMe: isMe, isUnassigned: false };
    }
    // Cleared assignment
    return { node: <span className={cls.label}>unassigned</span>, isAssignmentToMe: false, isUnassigned: true };
  }

  // Date fields
  if (DATE_FIELD_NAMES.has(fieldName)) {
    const newMs = extractNumber(added);
    const oldMs = extractNumber(removed);
    const labelPrefix = fieldName === "Due Date" || fieldName === "Due date" ? "Due" : fieldName;
    if (newMs != null) {
      const newStr = formatDate(newMs);
      const tail = relativeDayTail(newMs);
      if (oldMs != null) {
        return {
          node: (
            <>
              <span className={cls.label}>{labelPrefix}</span>{" "}
              {val(formatDate(oldMs), true)}
              <span className={cls.arrow}>→</span>
              {val(newStr)}
              <span className={cls.label}> · {tail}</span>
            </>
          ),
          isAssignmentToMe: false, isUnassigned: false,
        };
      }
      return {
        node: (
          <>
            <span className={cls.label}>{labelPrefix}</span> {val(newStr)}
            <span className={cls.label}> · {tail}</span>
          </>
        ),
        isAssignmentToMe: false, isUnassigned: false,
      };
    }
    return { node: <span className={cls.label}>{labelPrefix.toLowerCase()} cleared</span>, isAssignmentToMe: false, isUnassigned: false };
  }

  // Period fields (Estimation, Spent time) — YouTrack returns { presentation: "2h 30m" }
  const newPres = extractPresentation(added);
  const oldPres = extractPresentation(removed);
  if (newPres || oldPres) {
    return {
      node: (
        <>
          <span className={cls.label}>{fieldName}:</span>{" "}
          {oldNew(oldPres, newPres, `${fieldName.toLowerCase()} cleared`)}
        </>
      ),
      isAssignmentToMe: false, isUnassigned: false,
    };
  }

  // Free-text fields — don't diff prose
  if (FREE_TEXT_FIELDS.has(fieldName.toLowerCase())) {
    return { node: `updated ${fieldName.toLowerCase()}`, isAssignmentToMe: false, isUnassigned: false };
  }

  // Multi-enum / tags: both added and removed may be multi-entry
  const addedNames = extractAllNames(added);
  const removedNames = extractAllNames(removed);
  if (addedNames.length + removedNames.length > 1) {
    const parts: ReactNode[] = [];
    addedNames.forEach((n, i) => {
      parts.push(<span key={`a${i}`}>+{val(n)}</span>);
    });
    removedNames.forEach((n, i) => {
      parts.push(<span key={`r${i}`}>−{val(n, true)}</span>);
    });
    return {
      node: (
        <>
          <span className={cls.label}>{fieldName}:</span>{" "}
          {parts.map((p, i) => (
            <span key={i}>
              {i > 0 && <span className={cls.label}>, </span>}
              {p}
            </span>
          ))}
        </>
      ),
      isAssignmentToMe: false, isUnassigned: false,
    };
  }

  // Single-value fallback (State, Priority, Type, single-enum, plain text values)
  const newName = addedNames[0] ?? null;
  const oldName = removedNames[0] ?? null;
  return {
    node: (
      <>
        <span className={cls.label}>{fieldName}:</span>{" "}
        {oldNew(oldName, newName, `${fieldName.toLowerCase()} cleared`)}
      </>
    ),
    isAssignmentToMe: false, isUnassigned: false,
  };
}

const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv", "ogv"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif"]);

/** Match YouTrack markdown attachment refs: ![alt](filename.ext) */
const ATTACHMENT_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function classifyAttachment(filename: string): "video" | "image" | "file" {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "file";
  const ext = filename.slice(dot + 1).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "file";
}

/** Render comment text with ![](file.ext) refs replaced by compact chips. */
function renderCommentBody(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  const re = new RegExp(ATTACHMENT_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const filename = match[1];
    const kind = classifyAttachment(filename);
    const icon = kind === "video" ? "🎬" : kind === "image" ? "🖼" : "📎";
    parts.push(
      <span
        key={`att-${key++}`}
        className="inline-flex items-center gap-1 px-1.5 py-[1px] mx-[1px] rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-[10px] align-middle"
        title={filename}
      >
        <span aria-hidden>{icon}</span>
        <span className="truncate max-w-[160px]">{truncate(filename)}</span>
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <>{parts}</>;
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
  isJustRead?: boolean;
  isPinned?: boolean;
  isFocused?: boolean;
  onMarkRead: (id: string) => void;
  onOpenInBrowser?: (targetId: string, targetType?: string, accountId?: string) => void;
}

export function NotificationItem({ activity, isRead, isJustRead, isPinned, isFocused, onMarkRead, onOpenInBrowser }: Props) {
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [commentExpanded, setCommentExpanded] = useState(false);
  const muteIssue = useFilterStore((s) => s.muteIssue);
  const pinActivity = useNotificationStore((s) => s.pinActivity);
  const unpinActivity = useNotificationStore((s) => s.unpinActivity);

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

  const accounts = useAuthStore((s) => s.accounts);
  const authorName = activity.author?.name || activity.author?.login || "Unknown";
  const avatarUrl = activity.author?.avatarUrl;
  // Resolve the current-user identity for the account this activity belongs to
  // (we have multiple accounts, each with its own user).
  const activityAccount = activity.accountId
    ? accounts.find((a) => a.id === activity.accountId)
    : accounts[0];
  const currentUserLogin = activityAccount?.user?.login ?? null;
  const currentUserId = activityAccount?.user?.id ?? null;
  const { node: description, isAssignmentToMe } = describeActivity(activity, currentUserLogin, currentUserId);
  const commentText = extractCommentText(activity);
  const time = relativeTime(activity.timestamp);
  const resolved = targetLabel(activity);

  const issueId = resolveIssueId(activity);
  const projectId = resolveProjectId(activity);
  const canAct = !!issueId; // Quick actions only work on issues

  const handleOpenTarget = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onOpenInBrowser || !resolved || !resolved.id) return;
    onOpenInBrowser(resolved.id, resolved.type, activity.accountId);
  };

  const toggleAction = (action: ActiveAction) => {
    setActiveAction((prev) => (prev === action ? null : action));
  };

  return (
    <div data-activity-id={activity.id} className={isJustRead ? "animate-fade-out-read" : ""}>
      <div
        className={`group relative flex gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
          isAssignmentToMe && !isRead ? "border-l-2 border-amber-400 dark:border-amber-500 pl-[10px]" : ""
        } ${
          isRead
            ? "opacity-60 hover:opacity-80 hover:bg-gray-50 dark:hover:bg-gray-800/50"
            : isAssignmentToMe
              ? "bg-amber-50/60 dark:bg-amber-900/10"
              : "bg-blue-50/50 dark:bg-blue-900/10"
        }${isFocused ? " ring-2 ring-inset ring-blue-400 dark:ring-blue-500" : ""}`}
        title={isRead ? "Click to mark unread" : "Click to mark read"}
        onClick={() => onMarkRead(activity.id)}
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
            {isAssignmentToMe && (
              <span className="ml-1.5 inline-flex items-center rounded px-1 py-[1px] text-[9px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 align-middle">
                Assigned to you
              </span>
            )}
          </p>
          {commentText && (
            <div className="mt-0.5">
              <p
                className={`text-gray-500 dark:text-gray-400 leading-snug whitespace-pre-wrap ${
                  commentExpanded ? "" : "line-clamp-2"
                }`}
              >
                {renderCommentBody(commentText)}
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
          <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap group-hover:hidden flex items-center gap-1">
            {isPinned && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="text-amber-500">
                <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826Z" />
              </svg>
            )}
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
                      accountId={activity.accountId}
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
                      accountId={activity.accountId}
                      onClose={() => setActiveAction(null)}
                    />
                  )}
                </div>
              )}

              {/* Pin/Unpin */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (isPinned) {
                    unpinActivity(activity.id);
                  } else {
                    pinActivity(activity.id);
                  }
                }}
                title={isPinned ? "Unpin" : "Pin for later"}
                className={`p-1 rounded transition-colors ${
                  isPinned
                    ? "text-amber-500 hover:text-amber-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    : "text-gray-400 hover:text-amber-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  {isPinned ? (
                    <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826Z" />
                  ) : (
                    <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826Zm1.84.86a.25.25 0 0 0-.404.072l-.613 1.327a4.58 4.58 0 0 1-3.098 2.537l-1.327.613a.25.25 0 0 0-.072.404l4.5 4.5a.25.25 0 0 0 .404-.072l.613-1.327a4.58 4.58 0 0 1 2.537-3.098l1.327-.613a.25.25 0 0 0 .072-.404Z" />
                  )}
                </svg>
              </button>

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
          activityId={activity.id}
          projectId={projectId ?? undefined}
          accountId={activity.accountId}
          isRead={isRead}
          onClose={() => setActiveAction(null)}
        />
      )}
    </div>
  );
}
