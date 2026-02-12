import { useEffect, useState, useRef, type FormEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useAuthStore } from "../stores/auth";
import { DEFAULT_SHORTCUT } from "../App";

interface SettingsProps {
  onClose: () => void;
  globalShortcut: string;
  onChangeShortcut: (shortcut: string) => Promise<void>;
}

/** Convert a KeyboardEvent into a Tauri-compatible shortcut string. */
function keyEventToShortcut(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  // Need at least one modifier
  if (parts.length === 0) return null;

  // Map the key code to a Tauri key name
  const key = e.code;
  if (key.startsWith("Key")) {
    parts.push(key.slice(3)); // KeyY → Y
  } else if (key.startsWith("Digit")) {
    parts.push(key.slice(5)); // Digit1 → 1
  } else if (key.startsWith("F") && /^F\d+$/.test(key)) {
    parts.push(key); // F1, F2, etc.
  } else {
    // Skip pure modifier presses
    return null;
  }

  return parts.join("+");
}

/** Format a shortcut string for display (e.g. "CommandOrControl+Shift+Y" → "Cmd+Shift+Y"). */
function formatShortcut(shortcut: string): string {
  return shortcut
    .replace("CommandOrControl", navigator.platform.toUpperCase().includes("MAC") ? "Cmd" : "Ctrl")
    .replace("Control", "Ctrl");
}

export function Settings({ onClose, globalShortcut, onChangeShortcut }: SettingsProps) {
  const user = useAuthStore((s) => s.user);
  const credentials = useAuthStore((s) => s.credentials);
  const disconnect = useAuthStore((s) => s.disconnect);
  const connect = useAuthStore((s) => s.connect);
  const checkHealth = useAuthStore((s) => s.checkHealth);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "fail" | null>(null);
  const [showUpdateToken, setShowUpdateToken] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const recorderRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    isEnabled().then(setAutostart).catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Listen for key combo when recording
  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        return;
      }

      const shortcut = keyEventToShortcut(e);
      if (!shortcut) return; // Pure modifier press — keep recording

      setRecording(false);
      setShortcutError(null);

      onChangeShortcut(shortcut).catch((err) => {
        setShortcutError(
          err instanceof Error ? err.message : "Failed to register shortcut"
        );
      });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recording, onChangeShortcut]);

  const handleAutostartToggle = async () => {
    try {
      if (autostart) {
        await disable();
      } else {
        await enable();
      }
      setAutostart(!autostart);
    } catch {
      // Silently ignore if autostart toggle fails
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const ok = await checkHealth();
    setTestResult(ok ? "success" : "fail");
    setTesting(false);
  };

  const handleDisconnect = async () => {
    await disconnect();
  };

  const handleUpdateToken = async (e: FormEvent) => {
    e.preventDefault();
    if (!credentials || !newToken.trim()) return;

    setUpdating(true);
    setTokenError(null);

    try {
      await connect(credentials.url, newToken.trim());
      setShowUpdateToken(false);
      setNewToken("");
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : "Invalid token");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
        >
          Back
        </button>
      </div>

      {/* Account info */}
      <div className="mb-4">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          Account
        </h3>
        <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-gray-100 dark:bg-gray-800">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.fullName} className="w-8 h-8 rounded-full" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-semibold">
              {user?.fullName?.[0] || user?.login?.[0] || "?"}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {user?.fullName || user?.login}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {credentials?.url}
            </p>
          </div>
        </div>
      </div>

      {/* Connection */}
      <div className="mb-4">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          Connection
        </h3>
        <div className="space-y-2">
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="w-full text-left px-3 py-1.5 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test connection"}
            {testResult === "success" && (
              <span className="ml-2 text-green-500">OK</span>
            )}
            {testResult === "fail" && (
              <span className="ml-2 text-red-500">Failed</span>
            )}
          </button>

          <button
            onClick={() => setShowUpdateToken(!showUpdateToken)}
            className="w-full text-left px-3 py-1.5 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Update token
          </button>

          {showUpdateToken && (
            <form onSubmit={handleUpdateToken} className="px-3 py-2 space-y-2">
              <input
                type="password"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                placeholder="New permanent token"
                disabled={updating}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
              {tokenError && (
                <p className="text-xs text-red-500">{tokenError}</p>
              )}
              <button
                type="submit"
                disabled={updating || !newToken.trim()}
                className="w-full py-1.5 px-3 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors disabled:opacity-50"
              >
                {updating ? "Validating..." : "Save new token"}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Preferences */}
      <div className="mb-4">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          Preferences
        </h3>

        {/* Global shortcut */}
        <div className="flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <div>
            <span className="text-sm text-gray-700 dark:text-gray-300">Toggle window</span>
            <p className="text-[10px] text-gray-400 mt-0.5">Global keyboard shortcut</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              ref={recorderRef}
              onClick={() => {
                setRecording(true);
                setShortcutError(null);
              }}
              className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${
                recording
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 animate-pulse"
                  : "border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500"
              }`}
            >
              {recording ? "Press keys..." : formatShortcut(globalShortcut)}
            </button>
            {globalShortcut !== DEFAULT_SHORTCUT && !recording && (
              <button
                onClick={() => {
                  setShortcutError(null);
                  onChangeShortcut(DEFAULT_SHORTCUT).catch((err) => {
                    setShortcutError(
                      err instanceof Error ? err.message : "Failed to reset"
                    );
                  });
                }}
                title="Reset to default"
                className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                Reset
              </button>
            )}
          </div>
        </div>
        {shortcutError && (
          <p className="px-3 mt-1 text-xs text-red-500">{shortcutError}</p>
        )}

        {/* Autostart */}
        <label className="flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer">
          <span className="text-sm text-gray-700 dark:text-gray-300">Launch at startup</span>
          <button
            type="button"
            role="switch"
            aria-checked={autostart}
            onClick={handleAutostartToggle}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              autostart ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                autostart ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </div>

      {/* About */}
      <div className="mb-4">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          About
        </h3>
        <div className="px-3 py-1.5 space-y-0.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700 dark:text-gray-300">YouTrackd</span>
            {appVersion && (
              <span className="text-xs font-mono text-gray-500 dark:text-gray-400">v{appVersion}</span>
            )}
          </div>
          <p className="text-xs text-gray-400">
            YouTrack Cloud notifications in your system tray.
          </p>
          <p className="text-xs text-gray-400">
            by{" "}
            <button
              onClick={() => openUrl("https://protomated.com")}
              className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 underline underline-offset-2"
            >
              Protomated
            </button>
          </p>
        </div>
      </div>

      {/* Danger zone */}
      <div>
        <h3 className="text-xs font-medium text-red-500 uppercase tracking-wide mb-2">
          Danger Zone
        </h3>
        <button
          onClick={handleDisconnect}
          className="w-full text-left px-3 py-1.5 rounded-md text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          Disconnect account
        </button>
        <p className="px-3 mt-1 text-xs text-gray-400">
          Removes all credentials and cached data.
        </p>
      </div>
    </div>
  );
}
