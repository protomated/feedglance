import { useState, type FormEvent } from "react";
import { useAuthStore } from "../stores/auth";
import { PROVIDER_LIST, PROVIDERS } from "../services/providers";
import type { ProviderKind, UserInfo } from "../types/youtrack";

export function Onboarding() {
  const connect = useAuthStore((s) => s.connect);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);

  const [provider, setProvider] = useState<ProviderKind>("youtrack");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successUser, setSuccessUser] = useState<UserInfo | null>(null);

  const isConnecting = connectionStatus === "connecting";
  const descriptor = PROVIDERS[provider];

  const selectProvider = (kind: ProviderKind) => {
    setProvider(kind);
    // Clear the host: it means different things per provider (API instance vs
    // deep-link origin) and a leftover value is never valid for the other.
    setHost("");
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token.trim()) {
      setError(`Please enter your ${descriptor.tokenLabel.toLowerCase()}`);
      return;
    }

    if (descriptor.hostRequired && !host.trim()) {
      setError(`Please enter your ${descriptor.hostLabel.toLowerCase()}`);
      return;
    }

    const normalized = descriptor.normalizeHost(host);
    if ("error" in normalized) {
      setError(normalized.error);
      return;
    }

    try {
      const user = await connect(normalized.value, token.trim(), provider);
      setSuccessUser(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    }
  };

  if (successUser) {
    const displayName =
      successUser.fullName || successUser.login || descriptor.name;
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gray-50 dark:bg-gray-900">
        <div className="w-full max-w-sm text-center">
          <div className="mb-4 flex justify-center">
            {successUser.avatarUrl ? (
              <img
                src={successUser.avatarUrl}
                alt={displayName}
                className="w-16 h-16 rounded-full"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-blue-500 flex items-center justify-center text-white text-xl font-semibold">
                {displayName[0] || "?"}
              </div>
            )}
          </div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Connected to {descriptor.name}
          </h2>
          {successUser.email && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {successUser.email}
            </p>
          )}
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
          Feedglance
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Connect an account to get started.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Provider
            </span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {PROVIDER_LIST.map((p) => {
                const selected = p.kind === provider;
                return (
                  <button
                    key={p.kind}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={isConnecting}
                    onClick={() => selectProvider(p.kind)}
                    className={`px-3 py-2 rounded-md border text-sm font-medium transition-colors disabled:opacity-50 ${
                      selected
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                        : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:border-gray-400"
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {descriptor.tagline}
            </p>
          </div>

          <div>
            <label
              htmlFor="host"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {descriptor.hostLabel}
              {!descriptor.hostRequired && (
                <span className="ml-1 font-normal text-gray-400">(optional)</span>
              )}
            </label>
            <input
              id="host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={descriptor.hostPlaceholder}
              disabled={isConnecting}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            />
            {descriptor.hostHelp && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {descriptor.hostHelp}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="token"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {descriptor.tokenLabel}
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={descriptor.tokenPlaceholder}
              disabled={isConnecting}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            />
            <a
              href={descriptor.tokenDocsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-1 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
            >
              {descriptor.tokenDocsLabel}
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
            {isConnecting ? "Connecting..." : `Connect to ${descriptor.name}`}
          </button>
        </form>
      </div>
    </div>
  );
}
