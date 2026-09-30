import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ActivityItem } from "../types/activity";
import type { ActivityThread } from "../stores/notifications";
import { useAuthStore } from "../stores/auth";
import { useUiPrefsStore } from "../stores/uiPrefs";
import { providerOf } from "../services/providers";
import { InlineReply } from "./InlineReply";
import {
  NotificationItem,
  relativeTime,
  resolveActionItemId,
  resolveIssueId,
  targetLabel,
} from "./NotificationItem";

/** Rows shown before "Show N earlier/more". */
const COLLAPSED_ROWS = 3;

interface Props {
  thread: ActivityThread;
  readIds: Set<string>;
  justReadIds: Set<string>;
  pinnedIds: Set<string>;
  focusedActivityId?: string | null;
  onMarkRead: (id: string) => void;
  onOpenInBrowser: (
    targetId: string,
    targetType?: string,
    accountId?: string,
    url?: string,
  ) => void;
}

/**
 * Several activities about one subject — a Quo conversation, or a YouTrack
 * issue / Nifty task — under a single header with one Reply.
 *
 * Texts read top to bottom, oldest first, like the conversation they are.
 * Work-item events keep the feed's newest-first order.
 */
export function NotificationThread({
  thread,
  readIds,
  justReadIds,
  pinnedIds,
  focusedActivityId,
  onMarkRead,
  onOpenInBrowser,
}: Props) {
  const latest = thread.activities[0];
  const isConversation = latest.kind === "message";
  const [showAll, setShowAll] = useState(false);
  const [replying, setReplying] = useState(false);

  const accounts = useAuthStore((s) => s.accounts);
  const account = latest.accountId
    ? accounts.find((a) => a.id === latest.accountId)
    : accounts[0];
  const capabilities = providerOf(account?.provider).capabilities;
  const quoSendInApp = useUiPrefsStore((s) => s.quoSendInApp);
  const loadUiPrefs = useUiPrefsStore((s) => s.load);
  useEffect(() => {
    loadUiPrefs();
  }, [loadUiPrefs]);

  const label = targetLabel(latest);
  const issueId = resolveIssueId(latest);
  const actionItemId = resolveActionItemId(latest) ?? issueId;
  const unread = thread.activities.filter((a) => !readIds.has(a.id));
  const replyExternally = capabilities.externalReply && !quoSendInApp && !!latest.url;

  const ordered = isConversation ? [...thread.activities].reverse() : thread.activities;
  const hidden = showAll ? 0 : Math.max(0, ordered.length - COLLAPSED_ROWS);
  // Conversations keep the newest messages in view; work items the newest events.
  const visible = isConversation ? ordered.slice(hidden) : ordered.slice(0, ordered.length - hidden);

  // In a 1:1 conversation every text is from the contact the header names.
  const senders = new Set(thread.activities.map((a) => a.author?.id ?? a.author?.name));
  const showAuthor = !isConversation || senders.size > 1;

  const markThreadRead = () => {
    for (const a of unread) onMarkRead(a.id);
  };

  const handleReply = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (replyExternally) {
      openUrl(latest.url!);
      markThreadRead();
      return;
    }
    setReplying((v) => !v);
  };

  const openSubject = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenInBrowser(label?.id ?? "", label?.type, latest.accountId, latest.url);
  };

  const noun = isConversation ? "text" : "update";
  const count = thread.activities.length;

  const earlierToggle = hidden > 0 || showAll;
  const toggleButton = earlierToggle && (
    <button
      onClick={() => setShowAll((v) => !v)}
      className="w-full text-left pl-8 pr-3 py-1 text-[10px] font-medium text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
    >
      {showAll
        ? "Show fewer"
        : isConversation
          ? `Show ${hidden} earlier`
          : `Show ${hidden} more`}
    </button>
  );

  return (
    <div className="border-l-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700">
      {/* Thread header: the subject, once */}
      <div className="group relative flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs min-w-0">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            thread.hasUnread ? "bg-blue-500" : "bg-transparent"
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
          <span className="truncate min-w-0 text-gray-900 dark:text-gray-100" title={label.title}>
            {label.title}
          </span>
        )}
        <span className="flex-shrink-0 text-gray-400 dark:text-gray-500">
          {count} {noun}
          {count === 1 ? "" : "s"}
          {unread.length > 0 && unread.length < count && ` · ${unread.length} new`}
        </span>
        <span className="flex-1" />
        {/* Same floating toolbar as rows, so hovering never reflows the header. */}
        <span className="relative flex-shrink-0 text-gray-400 dark:text-gray-500 whitespace-nowrap">
          <span className="group-hover:invisible">{relativeTime(thread.latestTimestamp)}</span>
        </span>
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
          {unread.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                markThreadRead();
              }}
              title={`Mark ${unread.length === 1 ? "it" : `all ${unread.length}`} read`}
              className="p-1 rounded text-gray-400 hover:text-green-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {isConversation && toggleButton}

      <div className="pl-3">
        {visible.map((activity: ActivityItem) => (
          <NotificationItem
            key={activity.id}
            activity={activity}
            isRead={readIds.has(activity.id)}
            isJustRead={justReadIds.has(activity.id)}
            isPinned={pinnedIds.has(activity.id)}
            isFocused={focusedActivityId === activity.id}
            inThread
            showAuthor={showAuthor}
            onMarkRead={onMarkRead}
            onOpenInBrowser={onOpenInBrowser}
          />
        ))}
      </div>

      {!isConversation && toggleButton}

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
