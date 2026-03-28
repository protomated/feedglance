import { useMemo, useRef, useState } from "react";
import { useNotificationStore, groupActivities, countUnread } from "../stores/notifications";
import { useFilterStore } from "../stores/filters";
import { useAuthStore } from "../stores/auth";
import { NotificationGroup } from "./NotificationGroup";
import { FilterBar } from "./FilterBar";
import { EmptyState } from "./EmptyState";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ActivityItem } from "../types/activity";

/** Resolve the project key for an activity. */
function resolveProjectKey(activity: ActivityItem): string {
  const t = activity.target;
  if (!t) return "unknown";
  const p = t.project ?? t.issue?.project ?? t.article?.project;
  return p?.shortName ?? p?.id ?? "unknown";
}

/** Resolve the issue readable ID for an activity (for mute matching). */
function resolveIssueIdForFilter(activity: ActivityItem): string | null {
  const t = activity.target;
  if (!t) return null;
  if (t.idReadable && t.targetType !== "IssueComment" && t.targetType !== "ArticleComment" && t.targetType !== "Article") {
    return t.idReadable;
  }
  return t.issue?.idReadable ?? null;
}

/** Check if an activity matches the search query. */
function matchesSearch(activity: ActivityItem, query: string): boolean {
  const q = query.toLowerCase();
  const author = activity.author;
  if (author?.name?.toLowerCase().includes(q)) return true;
  if (author?.login?.toLowerCase().includes(q)) return true;

  const t = activity.target;
  if (t?.idReadable?.toLowerCase().includes(q)) return true;
  if (t?.summary?.toLowerCase().includes(q)) return true;
  if (t?.text?.toLowerCase().includes(q)) return true;
  if (t?.issue?.idReadable?.toLowerCase().includes(q)) return true;
  if (t?.issue?.summary?.toLowerCase().includes(q)) return true;

  // Search in comment text (can be in added array)
  if (activity.category?.id === "CommentsCategory" && Array.isArray(activity.added)) {
    for (const item of activity.added) {
      if (typeof item === "object" && item !== null && "text" in item) {
        if ((item as { text: string }).text.toLowerCase().includes(q)) return true;
      }
    }
  }

  return false;
}

interface Props {
  focusedActivityId?: string | null;
}

export function NotificationFeed({ focusedActivityId }: Props) {
  const loading = useNotificationStore((s) => s.loading);
  const activities = useNotificationStore((s) => s.activities);
  const readIds = useNotificationStore((s) => s.readIds);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const credentials = useAuthStore((s) => s.credentials);

  const currentUserId = useAuthStore((s) => s.user?.id);

  const selectedProjects = useFilterStore((s) => s.selectedProjects);
  const selectedTypes = useFilterStore((s) => s.selectedTypes);
  const mutedIssues = useFilterStore((s) => s.mutedIssues);
  const searchQuery = useFilterStore((s) => s.searchQuery);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showRead, setShowRead] = useState(false);

  // Apply filters client-side before grouping
  const filteredActivities = useMemo(() => {
    return activities.filter((a) => {
      // Filter out current user's own activities
      if (currentUserId && a.author?.id === currentUserId) return false;

      // Project filter (empty = show all)
      if (selectedProjects.size > 0) {
        const pk = resolveProjectKey(a);
        if (!selectedProjects.has(pk)) return false;
      }

      // Type filter (empty = show all)
      if (selectedTypes.size > 0) {
        const cat = a.category?.id;
        if (!cat || !selectedTypes.has(cat as any)) return false;
      }

      // Muted issues
      if (mutedIssues.size > 0) {
        const issueId = resolveIssueIdForFilter(a);
        if (issueId && mutedIssues.has(issueId)) return false;
      }

      // Search
      if (searchQuery.length > 0) {
        if (!matchesSearch(a, searchQuery)) return false;
      }

      return true;
    });
  }, [activities, currentUserId, selectedProjects, selectedTypes, mutedIssues, searchQuery]);

  const unreadCount = countUnread(filteredActivities, readIds);
  const readCount = filteredActivities.length - unreadCount;

  // When there are no unread items and showRead is off, show the "all caught up" state.
  // When showRead is toggled on (or there are unread items), show everything.
  const visibleActivities = useMemo(() => {
    if (unreadCount > 0 || showRead) return filteredActivities;
    // 0 unread, showRead off → show only unread (i.e. nothing)
    return filteredActivities.filter((a) => !readIds.has(a.id));
  }, [filteredActivities, readIds, unreadCount, showRead]);

  const groups = groupActivities(visibleActivities, readIds);

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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <FilterBar />

      {/* Toolbar: unread count or "showing read" indicator */}
      {unreadCount > 0 ? (
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
      ) : showRead && readCount > 0 ? (
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Showing read activity
          </span>
          <button
            onClick={() => setShowRead(false)}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
          >
            Hide read
          </button>
        </div>
      ) : null}

      {/* Scrollable feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <EmptyState
            loading={loading}
            readCount={readCount}
            onShowRead={readCount > 0 ? () => setShowRead(true) : undefined}
          />
        ) : (
          groups.map((group) => (
            <NotificationGroup
              key={group.projectKey}
              group={group}
              readIds={readIds}
              focusedActivityId={focusedActivityId}
              onMarkRead={markRead}
              onOpenInBrowser={handleOpenInBrowser}
            />
          ))
        )}
      </div>
    </div>
  );
}
