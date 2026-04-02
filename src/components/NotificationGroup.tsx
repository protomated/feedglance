import { useState } from "react";
import type { NotificationGroup as GroupType } from "../types/activity";
import { NotificationItem } from "./NotificationItem";
interface Props {
  group: GroupType;
  readIds: Set<string>;
  pinnedIds: Set<string>;
  focusedActivityId?: string | null;
  onMarkRead: (id: string) => void;
  onOpenInBrowser: (targetId: string, targetType?: string) => void;
}

export function NotificationGroup({
  group,
  readIds,
  pinnedIds,
  focusedActivityId,
  onMarkRead,
  onOpenInBrowser,
}: Props) {
  const [expanded, setExpanded] = useState(group.hasUnread);

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

        {/* Activity count */}
        <span className="text-gray-400 dark:text-gray-500">
          {group.activities.length} activit{group.activities.length === 1 ? "y" : "ies"}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Open project in browser */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            onOpenInBrowser(group.projectKey, "Project");
          }}
          className="text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          title="Open project in browser"
        >
          &#8599;
        </span>

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
        <div className="border-t border-gray-50 dark:border-gray-800/50">
          {group.activities.map((activity) => (
            <NotificationItem
              key={activity.id}
              activity={activity}
              isRead={readIds.has(activity.id)}
              isPinned={pinnedIds.has(activity.id)}
              isFocused={focusedActivityId === activity.id}
              onMarkRead={onMarkRead}
              onOpenInBrowser={onOpenInBrowser}
            />
          ))}
        </div>
      )}
    </div>
  );
}
