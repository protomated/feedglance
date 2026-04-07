import { useEffect, useState, useRef, type FormEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAuthStore } from "../stores/auth";
import { isValidYouTrackCloudUrl, normalizeUrl } from "../services/validation";
import { DEFAULT_SHORTCUT } from "../App";
import type { Update } from "@tauri-apps/plugin-updater";
import type { Account } from "../types/youtrack";

interface SettingsProps {
  onClose: () => void;
  globalShortcut: string;
  onChangeShortcut: (shortcut: string) => Promise<void>;
  availableUpdate: Update | null;
  onUpdateDismissed: () => void;
  onCheckForUpdate: () => Promise<Update | null>;
}

/** Convert a KeyboardEvent into a Tauri-compatible shortcut string. */
function keyEventToShortcut(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  if (parts.length === 0) return null;

  const key = e.code;
  if (key.startsWith("Key")) {
    parts.push(key.slice(3));
  } else if (key.startsWith("Digit")) {
    parts.push(key.slice(5));
  } else if (key.startsWith("F") && /^F\d+$/.test(key)) {
    parts.push(key);
  } else {
    return null;
  }

  return parts.join("+");
}

/** Format a shortcut string for display. */
function formatShortcut(shortcut: string): string {
  return shortcut
    .replace("CommandOrControl", navigator.platform.toUpperCase().includes("MAC") ? "Cmd" : "Ctrl")
    .replace("Control", "Ctrl");
}

export function Settings({ onClose, globalShortcut, onChangeShortcut, availableUpdate, onUpdateDismissed, onCheckForUpdate }: SettingsProps) {
  const accounts = useAuthStore((s) => s.accounts);
  const connectionStatuses = useAuthStore((s) => s.connectionStatuses);
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const updateToken = useAuthStore((s) => s.updateToken);
  const addAccount = useAuthStore((s) => s.addAccount);
  const checkHealth = useAuthStore((s) => s.checkHealth);
  const disconnect = useAuthStore((s) => s.disconnect);

  const [autostart, setAutostart] = useState(false);
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<"up-to-date" | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<string | null>(null);
  const recorderRef = useRef<HTMLButtonElement>(null);

  // Add account form state
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newToken, setNewToken] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
      if (!shortcut) return;

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
      // Silently ignore
    }
  };

  const handleAddAccount = async (e: FormEvent) => {
    e.preventDefault();
    setAddError(null);

    if (!isValidYouTrackCloudUrl(newUrl)) {
      setAddError("Please enter a valid YouTrack Cloud URL (e.g. myteam.youtrack.cloud)");
      return;
    }
    if (!newToken.trim()) {
      setAddError("Please enter your permanent token");
      return;
    }

    setAdding(true);
    try {
      await addAccount(normalizeUrl(newUrl), newToken.trim());
      setShowAddAccount(false);
      setNewUrl("");
      setNewToken("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add account");
    } finally {
      setAdding(false);
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

      {/* Accounts */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Accounts
          </h3>
          <button
            onClick={() => setShowAddAccount(!showAddAccount)}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
          >
            {showAddAccount ? "Cancel" : "+ Add account"}
          </button>
        </div>

        {/* Add account form */}
        {showAddAccount && (
          <form onSubmit={handleAddAccount} className="mb-3 p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800 space-y-2">
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="myteam.youtrack.cloud"
              disabled={adding}
              className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            <input
              type="password"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              placeholder="Permanent token"
              disabled={adding}
              className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            {addError && (
              <p className="text-xs text-red-500">{addError}</p>
            )}
            <button
              type="submit"
              disabled={adding}
              className="w-full py-1.5 px-3 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs transition-colors disabled:opacity-50"
            >
              {adding ? "Connecting..." : "Add account"}
            </button>
          </form>
        )}

        {/* Account list */}
        <div className="space-y-2">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              status={connectionStatuses[account.id] || "disconnected"}
              onRemove={() => removeAccount(account.id)}
              onUpdateToken={(token) => updateToken(account.id, token)}
              onTestConnection={() => checkHealth(account.id)}
            />
          ))}
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

        {/* Update section */}
        <div className="px-3 py-1.5 mt-1">
          {availableUpdate ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-blue-600 dark:text-blue-400">
                v{availableUpdate.version} available
              </span>
              {installingUpdate ? (
                <span className="text-xs text-gray-400">{updateProgress}</span>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      setInstallingUpdate(true);
                      setUpdateProgress("Downloading...");
                      try {
                        await availableUpdate.downloadAndInstall((event) => {
                          if (event.event === "Started" && event.data.contentLength) {
                            setUpdateProgress(`Downloading (${Math.round(event.data.contentLength / 1024)} KB)...`);
                          } else if (event.event === "Finished") {
                            setUpdateProgress("Restarting...");
                          }
                        });
                        await relaunch();
                      } catch {
                        setInstallingUpdate(false);
                        setUpdateProgress(null);
                      }
                    }}
                    className="text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 px-2 py-0.5 rounded transition-colors"
                  >
                    Install update
                  </button>
                  <button
                    onClick={onUpdateDismissed}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                  >
                    Later
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={async () => {
                setCheckingUpdate(true);
                setUpdateCheckResult(null);
                const result = await onCheckForUpdate();
                if (!result) setUpdateCheckResult("up-to-date");
                setCheckingUpdate(false);
              }}
              disabled={checkingUpdate}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
            >
              {checkingUpdate
                ? "Checking..."
                : updateCheckResult === "up-to-date"
                  ? "Up to date"
                  : "Check for updates"}
            </button>
          )}
        </div>
      </div>

      {/* Danger zone */}
      {accounts.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-red-500 uppercase tracking-wide mb-2">
            Danger Zone
          </h3>
          <button
            onClick={disconnect}
            className="w-full text-left px-3 py-1.5 rounded-md text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Disconnect all accounts
          </button>
          <p className="px-3 mt-1 text-xs text-gray-400">
            Removes all credentials and cached data.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Per-account card component ---

interface AccountCardProps {
  account: Account;
  status: string;
  onRemove: () => void;
  onUpdateToken: (token: string) => Promise<void>;
  onTestConnection: () => Promise<boolean>;
}

function AccountCard({ account, status, onRemove, onUpdateToken, onTestConnection }: AccountCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "fail" | null>(null);
  const [showUpdateToken, setShowUpdateToken] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const statusColor = status === "connected" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-yellow-400";

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const ok = await onTestConnection();
    setTestResult(ok ? "success" : "fail");
    setTesting(false);
  };

  const handleUpdateToken = async (e: FormEvent) => {
    e.preventDefault();
    if (!newToken.trim()) return;
    setUpdating(true);
    setTokenError(null);
    try {
      await onUpdateToken(newToken.trim());
      setShowUpdateToken(false);
      setNewToken("");
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : "Invalid token");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="rounded-lg bg-gray-100 dark:bg-gray-800 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 p-2.5 text-left"
      >
        {account.user?.avatarUrl ? (
          <img src={account.user.avatarUrl} alt={account.user.fullName} className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-semibold">
            {account.user?.fullName?.[0] || account.label?.[0] || "?"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {account.user?.fullName || account.label}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {account.url}
          </p>
        </div>
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          <button
            onClick={handleTest}
            disabled={testing}
            className="w-full text-left px-2 py-1 rounded text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test connection"}
            {testResult === "success" && <span className="ml-2 text-green-500">OK</span>}
            {testResult === "fail" && <span className="ml-2 text-red-500">Failed</span>}
          </button>

          <button
            onClick={() => setShowUpdateToken(!showUpdateToken)}
            className="w-full text-left px-2 py-1 rounded text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Update token
          </button>

          {showUpdateToken && (
            <form onSubmit={handleUpdateToken} className="px-2 py-1 space-y-1.5">
              <input
                type="password"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                placeholder="New permanent token"
                disabled={updating}
                className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              />
              {tokenError && <p className="text-xs text-red-500">{tokenError}</p>}
              <button
                type="submit"
                disabled={updating || !newToken.trim()}
                className="w-full py-1 px-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs transition-colors disabled:opacity-50"
              >
                {updating ? "Validating..." : "Save"}
              </button>
            </form>
          )}

          <button
            onClick={onRemove}
            className="w-full text-left px-2 py-1 rounded text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Remove account
          </button>
        </div>
      )}
    </div>
  );
}
