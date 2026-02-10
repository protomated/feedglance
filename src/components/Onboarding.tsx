import { useState, type FormEvent } from "react";
import { useAuthStore } from "../stores/auth";
import { isValidYouTrackCloudUrl, normalizeUrl } from "../services/validation";
import type { UserInfo } from "../types/youtrack";

export function Onboarding() {
  const connect = useAuthStore((s) => s.connect);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successUser, setSuccessUser] = useState<UserInfo | null>(null);

  const isConnecting = connectionStatus === "connecting";

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isValidYouTrackCloudUrl(url)) {
      setError("Please enter a valid YouTrack Cloud URL (e.g. myteam.youtrack.cloud)");
      return;
    }

    if (!token.trim()) {
      setError("Please enter your permanent token");
      return;
    }

    try {
      const user = await connect(normalizeUrl(url), token.trim());
      setSuccessUser(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    }
  };

  if (successUser) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gray-50 dark:bg-gray-900">
        <div className="w-full max-w-sm text-center">
          <div className="mb-4 flex justify-center">
            {successUser.avatarUrl ? (
              <img
                src={successUser.avatarUrl}
                alt={successUser.fullName}
                className="w-16 h-16 rounded-full"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-blue-500 flex items-center justify-center text-white text-xl font-semibold">
                {successUser.fullName?.[0] || successUser.login?.[0] || "?"}
              </div>
            )}
          </div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Connected as {successUser.fullName || successUser.login}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {successUser.email}
          </p>
          <p className="text-sm text-green-600 dark:text-green-400 mt-4">
            You're all set. Loading your notifications...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">
          YouTrackd
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Connect your YouTrack Cloud instance to get started.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="url"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              YouTrack Cloud URL
            </label>
            <input
              id="url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="myteam.youtrack.cloud"
              disabled={isConnecting}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="token"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Permanent Token
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="perm:xxx-xxx-xxx..."
              disabled={isConnecting}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            />
            <a
              href="https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-1 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
            >
              How to get a permanent token
            </a>
          </div>

          {error && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isConnecting}
            className="w-full py-2 px-4 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConnecting ? "Connecting..." : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}
