import { useEffect, useState, type FormEvent } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useAuthStore } from "../stores/auth";

export function Settings({ onClose }: { onClose: () => void }) {
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

  useEffect(() => {
    isEnabled().then(setAutostart).catch(() => {});
  }, []);

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
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
        >
          Back
        </button>
      </div>

      {/* Account info */}
      <div className="mb-6">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Account
        </h3>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-100 dark:bg-gray-800">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.fullName} className="w-10 h-10 rounded-full" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white font-semibold">
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
      <div className="mb-6">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Connection
        </h3>
        <div className="space-y-2">
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="w-full text-left px-3 py-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
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
            className="w-full text-left px-3 py-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
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
      <div className="mb-6">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Preferences
        </h3>
        <label className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer">
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

      {/* Danger zone */}
      <div>
        <h3 className="text-xs font-medium text-red-500 uppercase tracking-wide mb-3">
          Danger Zone
        </h3>
        <button
          onClick={handleDisconnect}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
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
