import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "./stores/auth";
import { useNotificationStore, countUnread } from "./stores/notifications";
import { Onboarding } from "./components/Onboarding";
import { Settings } from "./components/Settings";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { NotificationFeed } from "./components/NotificationFeed";
import "./App.css";

type View = "feed" | "settings";

function App() {
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const user = useAuthStore((s) => s.user);
  const credentials = useAuthStore((s) => s.credentials);
  const initialize = useAuthStore((s) => s.initialize);
  const [view, setView] = useState<View>("feed");
  const [initialized, setInitialized] = useState(false);

  const initNotifications = useNotificationStore((s) => s.initialize);
  const startPolling = useNotificationStore((s) => s.startPolling);
  const stopPolling = useNotificationStore((s) => s.stopPolling);
  const setFocusState = useNotificationStore((s) => s.setFocusState);
  const activities = useNotificationStore((s) => s.activities);
  const readIds = useNotificationStore((s) => s.readIds);
  const unreadCount = countUnread(activities, readIds);

  const pollingStartedRef = useRef(false);

  // Initialize auth
  useEffect(() => {
    initialize().finally(() => setInitialized(true));
  }, [initialize]);

  // Initialize notification store and start polling when connected
  useEffect(() => {
    if (connectionStatus !== "connected" || !credentials) return;

    const setup = async () => {
      if (!pollingStartedRef.current) {
        await initNotifications();
        await startPolling(credentials.url, credentials.token);
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
  }, [connectionStatus, credentials, initNotifications, startPolling, stopPolling]);

  // Window focus detection for adaptive poll intervals
  useEffect(() => {
    if (connectionStatus !== "connected") return;

    let idleTimer: ReturnType<typeof setTimeout>;

    const handleFocus = () => {
      clearTimeout(idleTimer);
      setFocusState("focused");
    };

    const handleBlur = () => {
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
    return <Settings onClose={() => setView("feed")} />;
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
            onClick={() => setView("settings")}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Feed */}
      <NotificationFeed />
    </div>
  );
}

export default App;
