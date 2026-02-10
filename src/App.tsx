import { useEffect, useState } from "react";
import { useAuthStore } from "./stores/auth";
import { Onboarding } from "./components/Onboarding";
import { Settings } from "./components/Settings";
import { ConnectionStatus } from "./components/ConnectionStatus";
import "./App.css";

type View = "feed" | "settings";

function App() {
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const user = useAuthStore((s) => s.user);
  const initialize = useAuthStore((s) => s.initialize);
  const [view, setView] = useState<View>("feed");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    initialize().finally(() => setInitialized(true));
  }, [initialize]);

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

  // Main feed view (placeholder for Epic 2)
  return (
    <div className="flex flex-col min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">YouTrackd</h1>
          <ConnectionStatus onClickError={() => setView("settings")} />
        </div>
        <button
          onClick={() => setView("settings")}
          className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          Settings
        </button>
      </header>

      {/* Feed placeholder */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            All caught up!
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Notifications will appear here.
          </p>
        </div>
      </main>
    </div>
  );
}

export default App;
