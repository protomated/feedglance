import { useNotificationStore, groupActivities, countUnread } from "../stores/notifications";
import { useAuthStore } from "../stores/auth";
import { NotificationGroup } from "./NotificationGroup";
import { EmptyState } from "./EmptyState";
import { openUrl } from "@tauri-apps/plugin-opener";

export function NotificationFeed() {
  const loading = useNotificationStore((s) => s.loading);
  const activities = useNotificationStore((s) => s.activities);
  const readIds = useNotificationStore((s) => s.readIds);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const credentials = useAuthStore((s) => s.credentials);

  const groups = groupActivities(activities, readIds);
  const unreadCount = countUnread(activities, readIds);

  const handleOpenInBrowser = (targetId: string, targetType?: string) => {
    if (!credentials?.url) return;
    let path: string;
    switch (targetType) {
      case "Project":
        path = "projects";
        break;
      case "Article":
        path = "articles";
        break;
      default:
        path = "issue";
        break;
    }
    const url = `${credentials.url}/${path}/${targetId}`;
    openUrl(url);
  };

  if (groups.length === 0) {
    return <EmptyState loading={loading} />;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      {unreadCount > 0 && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {unreadCount} unread
          </span>
          <button
            onClick={markAllRead}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
          >
            Mark all read
          </button>
        </div>
      )}

      {/* Scrollable feed */}
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <NotificationGroup
            key={group.projectKey}
            group={group}
            readIds={readIds}
            onMarkRead={markRead}
            onOpenInBrowser={handleOpenInBrowser}
          />
        ))}
      </div>
    </div>
  );
}
