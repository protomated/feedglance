import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NotificationGroup as GroupType } from "../types/activity";
import { threadActivities } from "../stores/notifications";
import { NotificationThread } from "./NotificationThread";

/**
 * Where the group header's ↗ goes, or null to hide it.
 *
 * YouTrack projects go through the feed's URL builder. A Quo line opens its
 * inbox. Nifty has no verified project route, so it gets no link rather than
 * a guessed one.
 */
function groupLink(group: GroupType): "youtrack" | string | null {
  switch (group.provider ?? "youtrack") {
    case "youtrack":
      return "youtrack";
    case "quo":
      return group.projectId ? `https://my.quo.com/inbox/${group.projectId}` : null;
    default:
      return null;
  }
}
interface Props {
  group: GroupType;
  readIds: Set<string>;
  justReadIds: Set<string>;
  pinnedIds: Set<string>;
  focusedActivityId?: string | null;
  openThreads: Set<string>;
  onToggleThread: (key: string) => void;
  onMarkRead: (id: string) => void;
  onMarkThreadRead: (ids: string[]) => void;
  onOpenInBrowser: (
    targetId: string,
    targetType?: string,
    accountId?: string,
    url?: string,
  ) => void;
}

export function NotificationGroup({
  group,
  readIds,
  justReadIds,
  pinnedIds,
  focusedActivityId,
  openThreads,
  onToggleThread,
  onMarkRead,
  onMarkThreadRead,
  onOpenInBrowser,
}: Props) {
  const [expanded, setExpanded] = useState(group.hasUnread);
  const threads = useMemo(
    () => threadActivities(group.activities, readIds),
    [group.activities, readIds],
  );
  const link = groupLink(group);
  const allTexts = group.activities.every((a) => a.kind === "message");
  const newThreads = threads.filter((t) => t.hasUnread).length;

  return (
    <div className="border-b border-gray-100 dark:border-gray-800">
      {/* Group header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      >
        {/* Unread dot */}
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            group.hasUnread ? "bg-blue-500" : "bg-transparent"
          }`}
        />

        {/* Project name */}
        <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
          {group.projectName}
        </span>

        {/* Thread count: one row per issue or conversation below */}
        <span className="flex-shrink-0 text-gray-400 dark:text-gray-500">
          {threads.length} {allTexts ? "conversation" : "item"}
          {threads.length === 1 ? "" : "s"}
          {newThreads > 0 && newThreads < threads.length && ` · ${newThreads} new`}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Open project in browser */}
        {link && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (link === "youtrack") {
                onOpenInBrowser(group.projectKey, "Project", group.accountId);
              } else {
                openUrl(link);
              }
            }}
            className="text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
            title={allTexts ? "Open this line in Quo" : "Open project in browser"}
          >
            &#8599;
          </span>
        )}

        {/* Expand/collapse chevron */}
        <span
          className={`text-gray-400 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        >
          &#9656;
        </span>
      </button>

      {/* Expanded activities */}
      {expanded && (
        <div className="border-t border-gray-50 dark:border-gray-800/50 divide-y divide-gray-50 dark:divide-gray-800/50">
          {threads.map((thread) => (
            <NotificationThread
              key={thread.key}
              thread={thread}
              readIds={readIds}
              justReadIds={justReadIds}
              pinnedIds={pinnedIds}
              focusedActivityId={focusedActivityId}
              expanded={openThreads.has(thread.key)}
              onToggleExpanded={onToggleThread}
              onMarkRead={onMarkRead}
              onMarkThreadRead={onMarkThreadRead}
              onOpenInBrowser={onOpenInBrowser}
            />
          ))}
        </div>
      )}
    </div>
  );
}
