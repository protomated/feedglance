import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ActivityItem } from "../types/activity";
import type { ActivityThread } from "../stores/notifications";
import { useAuthStore } from "../stores/auth";
import { useUiPrefsStore } from "../stores/uiPrefs";
import { useFilterStore } from "../stores/filters";
import { providerOf } from "../services/providers";
import { toPlainSnippet } from "../utils/plainText";
import { InlineReply } from "./InlineReply";
import {
  NotificationItem,
  authorInitial,
  describeActivity,
  extractCommentText,
  formatTime,
  resolveActionItemId,
  resolveIssueId,
  targetLabel,
  type ActiveAction,
} from "./NotificationItem";

/** Rows shown when a thread opens, before "Show N earlier". */
const EXPANDED_ROWS = 5;

interface Props {
  thread: ActivityThread;
  readIds: Set<string>;
  justReadIds: Set<string>;
  pinnedIds: Set<string>;
  focusedActivityId?: string | null;
  expanded: boolean;
  onToggleExpanded: (key: string) => void;
  /** Toggle one activity's read state (rows inside an open thread). */
  onMarkRead: (id: string) => void;
  /** Mark every listed activity read: the thread is caught up. */
  onMarkThreadRead: (ids: string[]) => void;
  onOpenInBrowser: (
    targetId: string,
    targetType?: string,
    accountId?: string,
    url?: string,
  ) => void;
}

/**
 * One issue, task or conversation as a single inbox row: the subject, the
 * newest activity, and how many came before it. Opening the row shows the
 * whole thread oldest-first and counts as reading all of it.
 *
 * Read state stays per activity on disk, but every thread action marks the
 * whole thread, so older activities can't pile up unread behind a new one.
 */
export function NotificationThread({
  thread,
  readIds,
  justReadIds,
  pinnedIds,
  focusedActivityId,
  expanded,
  onToggleExpanded,
  onMarkRead,
  onMarkThreadRead,
  onOpenInBrowser,
}: Props) {
  const latest = thread.activities[0];
  const isConversation = latest.kind === "message";
  const [showAll, setShowAll] = useState(false);
  const [replying, setReplying] = useState(false);
  const [pendingAction, setPendingAction] = useState<ActiveAction>(null);
  // What was unread when the thread opened. Opening marks it all read, so this
  // is what keeps the new comments highlighted while you read them.
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  const accounts = useAuthStore((s) => s.accounts);
  const account = latest.accountId
    ? accounts.find((a) => a.id === latest.accountId)
    : accounts[0];
  const capabilities = providerOf(account?.provider).capabilities;
  const quoSendInApp = useUiPrefsStore((s) => s.quoSendInApp);
  const dateStyle = useUiPrefsStore((s) => s.dateStyle);
  const loadUiPrefs = useUiPrefsStore((s) => s.load);
  useEffect(() => {
    loadUiPrefs();
  }, [loadUiPrefs]);

  const label = targetLabel(latest);
  const issueId = resolveIssueId(latest);
  const actionItemId = resolveActionItemId(latest) ?? issueId;
  const unread = thread.activities.filter((a) => !readIds.has(a.id));
  // Only the Unread view drops read threads, so only there do they fade out.
  const leaving =
    useFilterStore((s) => s.viewMode) === "unread" &&
    unread.length === 0 &&
    thread.activities.some((a) => justReadIds.has(a.id));
  const replyExternally = capabilities.externalReply && !quoSendInApp && !!latest.url;
  const count = thread.activities.length;
  const isFocused = focusedActivityId === latest.id;

  // In a 1:1 conversation every text is from the contact the row names.
  const senders = new Set(thread.activities.map((a) => a.author?.id ?? a.author?.name));
  const showAuthor = !isConversation || senders.size > 1;

  const markThreadRead = () => {
    if (unread.length > 0) onMarkThreadRead(unread.map((a) => a.id));
  };

  const openThread = () => {
    setFreshIds(new Set(unread.map((a) => a.id)));
    markThreadRead();
    onToggleExpanded(thread.key);
  };

  // Keyboard actions target the newest activity. While the thread is open its
  // row hears them itself; while closed, open it and hand the action over.
  useEffect(() => {
    if (expanded) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.activityId !== latest.id) return;
      const action = detail.action as ActiveAction;
      if (!action) return;
      setPendingAction(action);
      openThread();
    };
    window.addEventListener("kb-action", handler);
    return () => window.removeEventListener("kb-action", handler);
  });

  // The newest row consumes the action as it mounts (children's effects run
  // first), so drop it before a later re-open would replay it.
  useEffect(() => {
    if (expanded && pendingAction) setPendingAction(null);
  }, [expanded, pendingAction]);

  const toggleOpen = () => {
    if (expanded) {
      setFreshIds(new Set());
      onToggleExpanded(thread.key);
    } else {
      openThread();
    }
  };

  const handleReply = (e: React.MouseEvent) => {
    e.stopPropagation();
    markThreadRead();
    if (replyExternally) {
      openUrl(latest.url!);
      return;
    }
    setReplying((v) => !v);
  };

  const openSubject = (e: React.MouseEvent) => {
    e.stopPropagation();
    markThreadRead();
    onOpenInBrowser(label?.id ?? "", label?.type, latest.accountId, latest.url);
  };

  const toggleRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Unread → the whole thread is read. Read → only the newest comes back,
    // so the thread returns as "1 new" rather than its whole history.
    if (unread.length > 0) markThreadRead();
    else onMarkRead(latest.id);
  };

  // --- Collapsed preview ---------------------------------------------------
  const authorName = latest.author?.name || latest.author?.login || "Unknown";
  const firstName = authorName.split(/\s+/)[0];
  const commentText = extractCommentText(latest);
  const preview = commentText
    ? toPlainSnippet(commentText)
    : describeActivity(latest, account?.user?.login ?? null, account?.user?.id ?? null).node;

  // An unread assignment to me keeps the amber treatment single rows give it.
  const assignedToMe = unread.some(
    (a) =>
      describeActivity(a, account?.user?.login ?? null, account?.user?.id ?? null)
        .isAssignmentToMe,
  );

  const earlier = count - 1;
  const chip =
    unread.length > 1
      ? { text: `${unread.length} new`, loud: true }
      : earlier > 0
        ? { text: `+${earlier}`, loud: false }
        : null;

  // --- Expanded thread: oldest first, like the conversation it is ----------
  const ordered = [...thread.activities].reverse();
  const hidden = showAll ? 0 : Math.max(0, ordered.length - EXPANDED_ROWS);
  const visible = ordered.slice(hidden);

  return (
    <div className={leaving && !expanded ? "animate-fade-out-read" : ""}>
      <div
        data-activity-id={latest.id}
        onClick={toggleOpen}
        title={expanded ? "Collapse" : "Open thread"}
        className={`group relative px-3 py-2 text-xs cursor-pointer transition-colors ${
          assignedToMe
            ? "border-l-2 border-amber-400 dark:border-amber-500 pl-[10px] bg-amber-50/60 dark:bg-amber-900/10"
            : unread.length > 0
              ? "bg-blue-50/50 dark:bg-blue-900/10 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              : "hover:bg-gray-50 dark:hover:bg-gray-800/50"
        }${isFocused ? " ring-2 ring-inset ring-blue-400 dark:ring-blue-500" : ""}`}
      >
        {/* Line 1: the subject, once */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              unread.length > 0 ? "bg-blue-500" : "bg-transparent"
            }`}
          />
          <button
            onClick={openSubject}
            className={`flex-shrink-0 font-semibold text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[55%] ${
              isConversation || label?.type === "Article" ? "" : "font-mono"
            }`}
            title={isConversation ? "Open conversation" : "Open in browser"}
          >
            {label?.label ?? "Untitled"}
          </button>
          {label?.title && (
            <span
              className={`truncate min-w-0 ${
                unread.length > 0
                  ? "font-medium text-gray-900 dark:text-gray-100"
                  : "text-gray-600 dark:text-gray-400"
              }`}
              title={label.title}
            >
              {label.title}
            </span>
          )}
          <span className="flex-1" />
          {/* Same floating toolbar as rows, so hovering never reflows the line. */}
          <span
            className="flex-shrink-0 text-gray-400 dark:text-gray-500 whitespace-nowrap flex items-center gap-1 group-hover:invisible"
            title={new Date(thread.latestTimestamp).toLocaleString()}
          >
            {thread.activities.some((a) => pinnedIds.has(a.id)) && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="text-amber-500">
                <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826Z" />
              </svg>
            )}
            {formatTime(thread.latestTimestamp, dateStyle)}
          </span>
        </div>

        {/* Line 2: the newest activity, and how much came before it */}
        {!expanded && (
          <div className="mt-1 ml-3 flex items-start gap-1.5 min-w-0">
            {showAuthor && (
              <span className="mt-[1px] w-4 h-4 rounded-full flex-shrink-0 overflow-hidden bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-[8px] font-medium text-gray-600 dark:text-gray-300">
                {latest.author?.avatarUrl ? (
                  <img src={latest.author.avatarUrl} alt={authorName} className="w-4 h-4" />
                ) : (
                  authorInitial(authorName)
                )}
              </span>
            )}
            <p
              className={`flex-1 min-w-0 leading-snug line-clamp-2 ${
                unread.length > 0
                  ? "text-gray-700 dark:text-gray-300"
                  : "text-gray-500 dark:text-gray-400"
              }`}
            >
              {showAuthor && (
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {commentText ? `${firstName}: ` : `${authorName} `}
                </span>
              )}
              {preview}
            </p>
            {chip && (
              <span
                className={`flex-shrink-0 rounded-full border px-1.5 text-[10px] font-semibold leading-4 ${
                  chip.loud
                    ? "border-blue-200 text-blue-600 dark:border-blue-800 dark:text-blue-400"
                    : "border-gray-200 text-gray-400 dark:border-gray-700 dark:text-gray-500"
                }`}
                title={
                  chip.loud
                    ? `${unread.length} unread of ${count}`
                    : `${earlier} earlier ${earlier === 1 ? "update" : "updates"}`
                }
              >
                {chip.text}
              </span>
            )}
          </div>
        )}

        <div className="absolute top-1 right-2 z-10 hidden group-hover:flex items-center gap-0.5 rounded-md bg-white dark:bg-gray-800 px-0.5 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700">
          {actionItemId && (
            <button
              onClick={handleReply}
              title={replyExternally ? "Reply in Quo" : "Reply"}
              className={`p-1 rounded transition-colors ${
                replying
                  ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600"
                  : "text-gray-400 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
              </svg>
            </button>
          )}
          <button
            onClick={toggleRead}
            title={
              unread.length > 0
                ? `Mark ${unread.length === 1 ? "read" : `all ${unread.length} read`}`
                : "Mark unread"
            }
            className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
              unread.length > 0 ? "text-gray-400 hover:text-green-600" : "text-green-600 hover:text-gray-500"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="pl-3 border-l-2 border-gray-100 dark:border-gray-800 ml-3 min-w-0">
          {hidden > 0 || showAll ? (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full text-left px-3 py-1 text-[10px] font-medium text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
            >
              {showAll ? "Show fewer" : `Show ${hidden} earlier`}
            </button>
          ) : null}
          {visible.map((activity: ActivityItem, i) => {
            const isNew = freshIds.has(activity.id);
            // A "New" line where the already-seen history ends, unless the
            // whole visible thread is new.
            const firstNew =
              isNew && i > 0 && !freshIds.has(visible[i - 1].id);
            return (
              <div key={activity.id}>
                {firstNew && (
                  <div className="flex items-center gap-2 px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-500 dark:text-blue-400">
                    New
                    <span className="flex-1 h-px bg-blue-300 dark:bg-blue-700" />
                  </div>
                )}
                <NotificationItem
                  activity={activity}
                  isRead={readIds.has(activity.id)}
                  isNew={isNew}
                  isPinned={pinnedIds.has(activity.id)}
                  inThread
                  showAuthor={showAuthor}
                  initialAction={activity.id === latest.id ? pendingAction : null}
                  onMarkRead={onMarkRead}
                  onOpenInBrowser={onOpenInBrowser}
                />
              </div>
            );
          })}
        </div>
      )}

      {replying && actionItemId && (
        <InlineReply
          issueId={actionItemId}
          displayId={issueId ?? actionItemId}
          title={label?.title}
          activityId={latest.id}
          projectId={latest.target?.project?.id ?? latest.target?.issue?.project?.id}
          accountId={latest.accountId}
          isRead={unread.length === 0}
          mentions={capabilities.mentions}
          isConversation={isConversation}
          onClose={() => setReplying(false)}
        />
      )}
    </div>
  );
}
