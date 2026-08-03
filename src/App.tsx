import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { load } from "@tauri-apps/plugin-store";
import { useAuthStore } from "./stores/auth";
import { useNotificationStore, countUnread } from "./stores/notifications";
import { useFilterStore } from "./stores/filters";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { Onboarding } from "./components/Onboarding";
import { Settings } from "./components/Settings";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { NotificationFeed } from "./components/NotificationFeed";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { ToastContainer } from "./components/Toast";
import { UpdateBanner, checkForUpdate } from "./components/UpdateBanner";
import type { Update } from "@tauri-apps/plugin-updater";
import type { ActivityItem } from "./types/activity";
import { passesProjectFilter } from "./utils/projectFilter";
import "./App.css";

type View = "feed" | "settings";

const SETTINGS_STORE = "settings.json";
const KEY_GLOBAL_SHORTCUT = "global_shortcut";
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
export const DEFAULT_SHORTCUT = IS_MAC ? "CommandOrControl+Shift+Y" : "Control+Shift+Y";

/** Resolve the issue readable ID for mute matching. */
function resolveIssueIdForFilter(activity: ActivityItem): string | null {
  const t = activity.target;
  if (!t) return null;
  if (t.idReadable && t.targetType !== "IssueComment" && t.targetType !== "ArticleComment" && t.targetType !== "Article") {
    return t.idReadable;
  }
  return t.issue?.idReadable ?? null;
}

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

function App() {
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const accounts = useAuthStore((s) => s.accounts);
  const hasAccounts = useAuthStore((s) => s.hasAccounts);
  const credentials = useAuthStore((s) => s.credentials);
  const initialize = useAuthStore((s) => s.initialize);
  const [view, setView] = useState<View>("feed");
  const [initialized, setInitialized] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const initNotifications = useNotificationStore((s) => s.initialize);
  const startAllPolling = useNotificationStore((s) => s.startAllPolling);
  const stopPolling = useNotificationStore((s) => s.stopPolling);
  const setFocusState = useNotificationStore((s) => s.setFocusState);
  const activities = useNotificationStore((s) => s.activities);
  const readIdsMap = useNotificationStore((s) => s.readIds);
  const allReadIds = useNotificationStore((s) => s.allReadIds);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const initFilters = useFilterStore((s) => s.initialize);
  const selectedProjects = useFilterStore((s) => s.selectedProjects);
  const selectedTypes = useFilterStore((s) => s.selectedTypes);
  const mutedIssues = useFilterStore((s) => s.mutedIssues);
  const searchQuery = useFilterStore((s) => s.searchQuery);
  const selectedAccounts = useFilterStore((s) => s.selectedAccounts);
  const assignedToMeOnly = useFilterStore((s) => s.assignedToMeOnly);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const [globalShortcut, setGlobalShortcut] = useState(DEFAULT_SHORTCUT);
  const pollingStartedRef = useRef(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);

  // Compute flat read IDs for filtering. Depend on readIdsMap so this
  // recomputes whenever the store's read IDs change (e.g. after markRead).
  const readIds = useMemo(() => allReadIds(), [readIdsMap]);

  const accountUsers = useMemo(() => {
    const map = new Map<string, { login: string | null; id: string | null }>();
    for (const a of accounts) {
      map.set(a.id, { login: a.user?.login ?? null, id: a.user?.id ?? null });
    }
    return map;
  }, [accounts]);

  // Must mirror NotificationFeed's filters exactly so the header/tray badge
  // matches what the feed actually shows.
  const flatActivities = useMemo(() => {
    return activities.filter((a) => {
      if (currentUserId && a.author?.id === currentUserId && !a.mentionsMe) return false;
      if (selectedAccounts.size > 0 && a.accountId) {
        if (!selectedAccounts.has(a.accountId)) return false;
      }
      if (!passesProjectFilter(a, selectedProjects)) return false;
      if (selectedTypes.size > 0) {
        const cat = a.category?.id;
        if (!cat || !selectedTypes.has(cat as any)) return false;
      }
      if (mutedIssues.size > 0) {
        const issueId = resolveIssueIdForFilter(a);
        if (issueId && mutedIssues.has(issueId)) return false;
      }
      if (searchQuery.length > 0) {
        if (!matchesSearch(a, searchQuery)) return false;
      }
      if (assignedToMeOnly) {
        const u = a.accountId ? accountUsers.get(a.accountId) : null;
        const login = u?.login ?? null;
        const id = u?.id ?? null;
        if (!isAssigneeChangeTo(a, login, id)) return false;
      }
      return true;
    });
  }, [activities, currentUserId, selectedAccounts, selectedProjects, selectedTypes, mutedIssues, searchQuery, assignedToMeOnly, accountUsers]);

  // Unread count derived from filtered activities so badge matches the feed
  const unreadCount = countUnread(flatActivities, readIds);

  // Sync the filtered unread count to the tray badge so it matches the feed
  useEffect(() => {
    invoke("set_tray_badge", { count: unreadCount }).catch(() => {});
  }, [unreadCount]);

  // Keyboard action: open in browser — resolve the correct account's base URL
  const handleKbOpen = useCallback(
    (activityId: string) => {
      const activity = activities.find((a) => a.id === activityId);
      if (!activity) return;

      // Prefer the provider-computed deep link. The reconstruction below keys
      // off `idReadable`, which Nifty tasks do not have, so without this the
      // shortcut silently did nothing on Nifty.
      if (activity.url) {
        openUrl(activity.url);
        return;
      }

      // Find the correct base URL from the activity's account
      let baseUrl: string | undefined;
      if (activity.accountId) {
        const account = accounts.find((a) => a.id === activity.accountId);
        baseUrl = account?.url;
      }
      if (!baseUrl) baseUrl = credentials?.url;
      if (!baseUrl) return;

      const t = activity.target;
      if (!t) return;
      const idReadable =
        t.idReadable ?? t.issue?.idReadable ?? t.article?.idReadable;
      if (!idReadable) return;
      const path = t.targetType === "Article" ? "articles" : "issue";
      openUrl(`${baseUrl}/${path}/${idReadable}`);
    },
    [accounts, credentials, activities],
  );

  // Keyboard actions that emit custom events to trigger UI in NotificationItem
  const handleKbReply = useCallback(
    (activityId: string) => {
      window.dispatchEvent(
        new CustomEvent("kb-action", { detail: { action: "reply", activityId } }),
      );
    },
    [],
  );

  const handleKbStatus = useCallback(
    (activityId: string) => {
      window.dispatchEvent(
        new CustomEvent("kb-action", { detail: { action: "status", activityId } }),
      );
    },
    [],
  );

  const handleKbAssign = useCallback(
    (activityId: string) => {
      window.dispatchEvent(
        new CustomEvent("kb-action", { detail: { action: "assign", activityId } }),
      );
    },
    [],
  );

  const handleKbMarkRead = useCallback(
    (activityId: string) => {
      markRead(activityId);
    },
    [markRead],
  );

  const handleKbMarkAllRead = useCallback(() => {
    markAllRead();
  }, [markAllRead]);

  const handleToggleHelp = useCallback(() => {
    setShowHelp((prev) => !prev);
  }, []);

  const pinActivity = useNotificationStore((s) => s.pinActivity);
  const unpinActivity = useNotificationStore((s) => s.unpinActivity);
  const pinnedIds = useNotificationStore((s) => s.pinnedIds);

  const handleKbPin = useCallback(
    (activityId: string) => {
      if (pinnedIds.has(activityId)) {
        unpinActivity(activityId);
      } else {
        pinActivity(activityId);
      }
    },
    [pinnedIds, pinActivity, unpinActivity],
  );

  const kbActions = useMemo(
    () => ({
      onOpenInBrowser: handleKbOpen,
      onReply: handleKbReply,
      onStatus: handleKbStatus,
      onAssign: handleKbAssign,
      onMarkRead: handleKbMarkRead,
      onMarkAllRead: handleKbMarkAllRead,
      onToggleHelp: handleToggleHelp,
      onPin: handleKbPin,
    }),
    [handleKbOpen, handleKbReply, handleKbStatus, handleKbAssign, handleKbMarkRead, handleKbMarkAllRead, handleToggleHelp, handleKbPin],
  );

  const { focusedActivityId, setFlatActivities } = useKeyboardNavigation(kbActions);

  // Keep the hook's flat list in sync with the filtered activities
  useEffect(() => {
    setFlatActivities(flatActivities);
  }, [flatActivities, setFlatActivities]);

  // Initialize auth
  useEffect(() => {
    initialize().finally(() => setInitialized(true));
  }, [initialize]);

  // Initialize filter store
  useEffect(() => {
    initFilters();
  }, [initFilters]);

  // Load and register the global shortcut
  useEffect(() => {
    const setupShortcut = async () => {
      try {
        const store = await load(SETTINGS_STORE);
        const saved = await store.get<string>(KEY_GLOBAL_SHORTCUT);
        const shortcut = saved || DEFAULT_SHORTCUT;
        setGlobalShortcut(shortcut);

        await unregisterAll();
        await register(shortcut, () => {});
      } catch (e) {
        console.error("Failed to register global shortcut:", e);
      }
    };
    setupShortcut();
  }, []);

  /** Update the global shortcut (called from Settings). */
  const updateGlobalShortcut = useCallback(async (newShortcut: string) => {
    try {
      await unregisterAll();
      await register(newShortcut, () => {});
      setGlobalShortcut(newShortcut);
      const store = await load(SETTINGS_STORE);
      await store.set(KEY_GLOBAL_SHORTCUT, newShortcut);
      await store.save();
    } catch (e) {
      console.error("Failed to update global shortcut:", e);
      throw e;
    }
  }, []);

  // Check for updates on startup and every 6 hours
  useEffect(() => {
    const doCheck = () => {
      checkForUpdate().then((update) => {
        if (update) setAvailableUpdate(update);
      });
    };

    const initial = setTimeout(doCheck, 5_000);
    const interval = setInterval(doCheck, 6 * 60 * 60 * 1000);

    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  // Initialize notification store and start polling when connected
  useEffect(() => {
    if (connectionStatus !== "connected" || !hasAccounts) return;

    const connectedAccounts = accounts.filter(
      (a) => useAuthStore.getState().connectionStatuses[a.id] === "connected"
    );
    if (connectedAccounts.length === 0) return;

    const setup = async () => {
      if (!pollingStartedRef.current) {
        await initNotifications(connectedAccounts);
        await startAllPolling(connectedAccounts);
        pollingStartedRef.current = true;
      }
    };
    setup();

    return () => {
      if (pollingStartedRef.current) {
        stopPolling();
        pollingStartedRef.current = false;
      }
    };
  }, [connectionStatus, hasAccounts, accounts, initNotifications, startAllPolling, stopPolling]);

  // Window focus detection for adaptive poll intervals
  useEffect(() => {
    if (!hasAccounts || connectionStatus !== "connected") return;

    let idleTimer: ReturnType<typeof setTimeout>;

    const handleFocus = () => {
      clearTimeout(idleTimer);
      setFocusState("focused");
    };

    const handleBlur = () => {
      getCurrentWindow().hide();
      setFocusState("minimized");
      idleTimer = setTimeout(() => {
        setFocusState("idle");
      }, 5 * 60 * 1000);
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      clearTimeout(idleTimer);
    };
  }, [hasAccounts, connectionStatus, setFocusState]);

  // Listen for tray menu events
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen("tray-mark-all-read", () => {
      markAllRead();
    }).then((u) => unlisteners.push(u));

    listen("tray-open-settings", () => {
      setView("settings");
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [markAllRead]);

  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!hasAccounts && connectionStatus === "disconnected") {
    return <Onboarding />;
  }

  if (view === "settings") {
    return (
      <Settings
        onClose={() => setView("feed")}
        globalShortcut={globalShortcut}
        onChangeShortcut={updateGlobalShortcut}
        availableUpdate={availableUpdate}
        onUpdateDismissed={() => setAvailableUpdate(null)}
        onCheckForUpdate={async () => {
          const update = await checkForUpdate();
          if (update) setAvailableUpdate(update);
          return update;
        }}
      />
    );
  }

  // Main feed view
  return (
    <div className="flex flex-col min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Feedglance</h1>
          <ConnectionStatus onClickError={() => setView("settings")} />
        </div>
        <div className="flex items-center gap-3">
          {unreadCount > 0 && (
            <span className="text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 rounded-full">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          <button
            onClick={() => setShowHelp(true)}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
          <button
            onClick={() => setView("settings")}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Update banner */}
      {availableUpdate && (
        <UpdateBanner
          update={availableUpdate}
          onDismiss={() => setAvailableUpdate(null)}
        />
      )}

      {/* Feed */}
      <NotificationFeed focusedActivityId={focusedActivityId} />

      {/* Keyboard shortcut help overlay */}
      {showHelp && <KeyboardShortcutHelp onClose={() => setShowHelp(false)} />}

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}

export default App;
