import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import "./App.css";

type View = "feed" | "settings";

const SETTINGS_STORE = "settings.json";
const KEY_GLOBAL_SHORTCUT = "global_shortcut";
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
export const DEFAULT_SHORTCUT = IS_MAC ? "CommandOrControl+Shift+Y" : "Control+Shift+Y";

/** Resolve the project key for an activity. */
function resolveProjectKey(activity: ActivityItem): string {
  const t = activity.target;
  if (!t) return "unknown";
  const p = t.project ?? t.issue?.project ?? t.article?.project;
  return p?.shortName ?? p?.id ?? "unknown";
}

/** Resolve the issue readable ID for mute matching. */
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

function App() {
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const user = useAuthStore((s) => s.user);
  const credentials = useAuthStore((s) => s.credentials);
  const initialize = useAuthStore((s) => s.initialize);
  const [view, setView] = useState<View>("feed");
  const [initialized, setInitialized] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const initNotifications = useNotificationStore((s) => s.initialize);
  const startPolling = useNotificationStore((s) => s.startPolling);
  const stopPolling = useNotificationStore((s) => s.stopPolling);
  const setFocusState = useNotificationStore((s) => s.setFocusState);
  const activities = useNotificationStore((s) => s.activities);
  const readIds = useNotificationStore((s) => s.readIds);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const initFilters = useFilterStore((s) => s.initialize);
  const selectedProjects = useFilterStore((s) => s.selectedProjects);
  const selectedTypes = useFilterStore((s) => s.selectedTypes);
  const mutedIssues = useFilterStore((s) => s.mutedIssues);
  const searchQuery = useFilterStore((s) => s.searchQuery);

  const [globalShortcut, setGlobalShortcut] = useState(DEFAULT_SHORTCUT);
  const pollingStartedRef = useRef(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);

  // Compute the flat (filtered) activity list for keyboard navigation
  const flatActivities = useMemo(() => {
    return activities.filter((a) => {
      if (selectedProjects.size > 0) {
        const pk = resolveProjectKey(a);
        if (!selectedProjects.has(pk)) return false;
      }
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
      return true;
    });
  }, [activities, selectedProjects, selectedTypes, mutedIssues, searchQuery]);

  // Unread count derived from filtered activities so badge matches the feed
  const unreadCount = countUnread(flatActivities, readIds);

  // Keyboard action: open in browser
  const handleKbOpen = useCallback(
    (activityId: string) => {
      if (!credentials?.url) return;
      const activity = activities.find((a) => a.id === activityId);
      if (!activity) return;
      const t = activity.target;
      if (!t) return;
      const idReadable =
        t.idReadable ?? t.issue?.idReadable ?? t.article?.idReadable;
      if (!idReadable) return;
      const path = t.targetType === "Article" ? "articles" : "issue";
      openUrl(`${credentials.url}/${path}/${idReadable}`);
    },
    [credentials, activities],
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

  const kbActions = useMemo(
    () => ({
      onOpenInBrowser: handleKbOpen,
      onReply: handleKbReply,
      onStatus: handleKbStatus,
      onAssign: handleKbAssign,
      onMarkRead: handleKbMarkRead,
      onMarkAllRead: handleKbMarkAllRead,
      onToggleHelp: handleToggleHelp,
    }),
    [handleKbOpen, handleKbReply, handleKbStatus, handleKbAssign, handleKbMarkRead, handleKbMarkAllRead, handleToggleHelp],
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

        // Unregister any previous shortcuts, then register the current one
        await unregisterAll();
        await register(shortcut, () => {
          // Handler is in Rust (with_handler) — this JS callback is a no-op.
          // The Rust handler toggles the window.
        });
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

    // Delay initial check by 5s to avoid slowing down startup
    const initial = setTimeout(doCheck, 5_000);
    const interval = setInterval(doCheck, 6 * 60 * 60 * 1000);

    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  // Initialize notification store and start polling when connected
  useEffect(() => {
    if (connectionStatus !== "connected" || !credentials) return;

    const setup = async () => {
      if (!pollingStartedRef.current) {
        await initNotifications();
        await startPolling(credentials.url, credentials.token, user?.id);
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
  }, [connectionStatus, credentials, user, initNotifications, startPolling, stopPolling]);

  // Window focus detection for adaptive poll intervals
  useEffect(() => {
    if (connectionStatus !== "connected") return;

    let idleTimer: ReturnType<typeof setTimeout>;

    const handleFocus = () => {
      clearTimeout(idleTimer);
      setFocusState("focused");
    };

    const handleBlur = () => {
      // Hide window when it loses focus (close on outside click)
      getCurrentWindow().hide();
      setFocusState("minimized");
      // After 5 minutes of being minimized, switch to idle
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
  }, [connectionStatus, setFocusState]);

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

  if (connectionStatus === "disconnected" || (!user && connectionStatus !== "connecting")) {
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
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">YouTrackd</h1>
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
