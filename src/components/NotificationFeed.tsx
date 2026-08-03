import { useEffect, useMemo, useRef, useState } from "react";
import { useNotificationStore, groupActivities, countUnread } from "../stores/notifications";
import { useFilterStore } from "../stores/filters";
import { useAuthStore } from "../stores/auth";
import { NotificationGroup } from "./NotificationGroup";
import { FilterBar } from "./FilterBar";
import { EmptyState } from "./EmptyState";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ActivityItem } from "../types/activity";
import { passesProjectFilter } from "../utils/projectFilter";

/** Best-effort: detect if an activity is an Assignee change whose `added` names a given user. */
function isAssigneeChangeTo(activity: ActivityItem, userLogin: string | null, userId: string | null): boolean {
  if (activity.category?.id !== "CustomFieldCategory") return false;
  if (activity.field?.name !== "Assignee") return false;
  const added = activity.added;
  const entries = Array.isArray(added) ? added : added != null ? [added] : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (userLogin && obj.login === userLogin) return true;
    if (userId && obj.id === userId) return true;
  }
  return false;
}

/** Resolve the project key for an activity. */
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
  const readIdsMap = useNotificationStore((s) => s.readIds);
  const allReadIds = useNotificationStore((s) => s.allReadIds);
  const markRead = useNotificationStore((s) => s.markRead);
  const markUnread = useNotificationStore((s) => s.markUnread);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const accounts = useAuthStore((s) => s.accounts);

  const currentUserId = useAuthStore((s) => s.user?.id);

  const selectedProjects = useFilterStore((s) => s.selectedProjects);
  const selectedTypes = useFilterStore((s) => s.selectedTypes);
  const mutedIssues = useFilterStore((s) => s.mutedIssues);
  const searchQuery = useFilterStore((s) => s.searchQuery);
  const selectedAccounts = useFilterStore((s) => s.selectedAccounts);
  const viewMode = useFilterStore((s) => s.viewMode);
  const assignedToMeOnly = useFilterStore((s) => s.assignedToMeOnly);
  const setViewMode = useFilterStore((s) => s.setViewMode);

  const pinnedIds = useNotificationStore((s) => s.pinnedIds);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);

  // Sticky set: in Unread mode, items marked read during this session stay
  // visible-but-dimmed briefly so rows don't jump away. They clear on any of:
  //   (a) a per-item 5s timeout, (b) the window losing focus, (c) a fresh poll.
  const [justReadIds, setJustReadIds] = useState<Set<string>>(new Set());
  const stickyTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearStickyTimer = (id: string) => {
    const t = stickyTimers.current.get(id);
    if (t) {
      clearTimeout(t);
      stickyTimers.current.delete(id);
    }
  };

  const clearAllSticky = () => {
    for (const t of stickyTimers.current.values()) clearTimeout(t);
    stickyTimers.current.clear();
    setJustReadIds(new Set());
  };

  // Clear on fresh batch of activities from polling.
  useEffect(() => {
    clearAllSticky();
    // Intentionally not including clearAllSticky in deps — it's stable for our use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities]);

  // Clear when the window loses focus (user switched away — "session" is over).
  useEffect(() => {
    const onBlur = () => clearAllSticky();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      for (const t of stickyTimers.current.values()) clearTimeout(t);
      stickyTimers.current.clear();
    };
  }, []);

  /** Toggle an activity's read state. Unread → read (with 5s sticky). Read → unread (instant). */
  const handleToggleRead = (activityId: string) => {
    const isCurrentlyRead = readIds.has(activityId);
    if (isCurrentlyRead) {
      // Un-read: remove from sticky set (if still there) and call backend.
      clearStickyTimer(activityId);
      setJustReadIds((prev) => {
        if (!prev.has(activityId)) return prev;
        const next = new Set(prev);
        next.delete(activityId);
        return next;
      });
      void markUnread(activityId);
      return;
    }
    // Mark as read, add to sticky set, schedule 5s dismissal.
    setJustReadIds((prev) => {
      const next = new Set(prev);
      next.add(activityId);
      return next;
    });
    clearStickyTimer(activityId);
    const timer = setTimeout(() => {
      setJustReadIds((prev) => {
        if (!prev.has(activityId)) return prev;
        const next = new Set(prev);
        next.delete(activityId);
        return next;
      });
      stickyTimers.current.delete(activityId);
    }, 5000);
    stickyTimers.current.set(activityId, timer);
    void markRead(activityId);
  };

  // Compute flat read IDs for display
  const readIds = useMemo(() => allReadIds(), [readIdsMap]);

  // Build a map of accountId → { login, id } for per-account assignee matching.
  const accountUsers = useMemo(() => {
    const map = new Map<string, { login: string | null; id: string | null }>();
    for (const a of accounts) {
      map.set(a.id, { login: a.user?.login ?? null, id: a.user?.id ?? null });
    }
    return map;
  }, [accounts]);

  // Apply filters client-side before grouping
  const filteredActivities = useMemo(() => {
    return activities.filter((a) => {
      // Filter out current user's own activities — unless they were @-mentioned
      // in them. Providers show self-mentions in their own notification lists,
      // so hiding them here makes the feed disagree with the source of truth.
      if (currentUserId && a.author?.id === currentUserId && !a.mentionsMe) return false;

      // Account filter
      if (selectedAccounts.size > 0 && a.accountId) {
        if (!selectedAccounts.has(a.accountId)) return false;
      }

      // Project filter — per-account, so chips selected for one account never
      // hide another's events (empty selection for an account = show all).
      if (!passesProjectFilter(a, selectedProjects)) return false;

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

      // Assigned-to-me filter
      if (assignedToMeOnly) {
        const u = a.accountId ? accountUsers.get(a.accountId) : null;
        const login = u?.login ?? null;
        const id = u?.id ?? null;
        if (!isAssigneeChangeTo(a, login, id)) return false;
      }

      return true;
    });
  }, [activities, currentUserId, selectedAccounts, selectedProjects, selectedTypes, mutedIssues, searchQuery, assignedToMeOnly, accountUsers]);

  const unreadCount = countUnread(filteredActivities, readIds);
  const readCount = filteredActivities.length - unreadCount;

  const visibleActivities = useMemo(() => {
    let result: ActivityItem[];
    if (viewMode === "all") {
      result = filteredActivities;
    } else {
      // Unread mode: show unread + sticky-just-read from this session
      result = filteredActivities.filter((a) => !readIds.has(a.id) || justReadIds.has(a.id));
    }
    if (showPinnedOnly) {
      result = result.filter((a) => pinnedIds.has(a.id));
    }
    return result;
  }, [filteredActivities, readIds, pinnedIds, viewMode, justReadIds, showPinnedOnly]);

  const pinnedCount = filteredActivities.filter((a) => pinnedIds.has(a.id)).length;
  const groups = groupActivities(visibleActivities, readIds);

  const handleOpenInBrowser = (
    targetId: string,
    targetType?: string,
    accountId?: string,
    activityUrl?: string,
  ) => {
    // The provider already computed this, and only it knows the URL shape:
    // Nifty tasks live at /{projectId}/task/{taskId}, which the YouTrack-style
    // reconstruction below cannot produce. Always prefer it.
    if (activityUrl) {
      openUrl(activityUrl);
      return;
    }

    // Fallback for events cached before `url` was carried through the feed.
    // YouTrack-shaped by construction, so it is only correct for YouTrack.
    let baseUrl: string | undefined;
    if (accountId) {
      const account = accounts.find((a) => a.id === accountId);
      baseUrl = account?.url;
    }
    if (!baseUrl && accounts.length > 0) {
      baseUrl = accounts[0].url;
    }
    if (!baseUrl) return;

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
    const url = `${baseUrl}/${path}/${targetId}`;
    openUrl(url);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <FilterBar />

      {/* Toolbar: unread/all segmented toggle + counts + mark-all-read */}
      {(filteredActivities.length > 0) && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            {/* Unread / All segmented control */}
            <div className="inline-flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden text-[10px]">
              <button
                onClick={() => setViewMode("unread")}
                className={`px-1.5 py-0.5 transition-colors ${
                  viewMode === "unread"
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                    : "bg-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                title="Show only unread"
              >
                Unread{unreadCount > 0 ? ` · ${unreadCount}` : ""}
              </button>
              <button
                onClick={() => setViewMode("all")}
                className={`px-1.5 py-0.5 transition-colors border-l border-gray-200 dark:border-gray-700 ${
                  viewMode === "all"
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                    : "bg-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                title="Show all activities"
              >
                All
              </button>
            </div>
            {pinnedCount > 0 && (
              <button
                onClick={() => setShowPinnedOnly((v) => !v)}
                className={`text-xs flex items-center gap-0.5 transition-colors ${
                  showPinnedOnly
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-gray-400 dark:text-gray-500 hover:text-amber-500"
                }`}
                title={showPinnedOnly ? "Show all" : "Show pinned only"}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826Z" />
                </svg>
                {pinnedCount}
              </button>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
            >
              Mark all read
            </button>
          )}
        </div>
      )}

      {/* Scrollable feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <EmptyState
            loading={loading}
            readCount={readCount}
            onShowRead={readCount > 0 && viewMode === "unread" ? () => setViewMode("all") : undefined}
          />
        ) : (
          groups.map((group) => (
            <NotificationGroup
              key={group.projectKey}
              group={group}
              readIds={readIds}
              justReadIds={justReadIds}
              pinnedIds={pinnedIds}
              focusedActivityId={focusedActivityId}
              onMarkRead={handleToggleRead}
              onOpenInBrowser={handleOpenInBrowser}
            />
          ))
        )}
      </div>
    </div>
  );
}
