import { useEffect, useRef } from "react";
import { useAuthStore, type ConnectionStatus as Status } from "../stores/auth";

const STATUS_COLORS: Record<Status, string> = {
  connected: "bg-green-500",
  connecting: "bg-yellow-400 animate-pulse",
  error: "bg-red-500",
  disconnected: "bg-gray-400",
};

const STATUS_LABELS: Record<Status, string> = {
  connected: "Connected",
  connecting: "Connecting...",
  error: "Connection lost",
  disconnected: "Disconnected",
};

const HEALTH_CHECK_INTERVAL = 60_000; // 60s
const MAX_BACKOFF = 300_000; // 5 min

export function ConnectionStatus({ onClickError }: { onClickError?: () => void }) {
  const status = useAuthStore((s) => s.connectionStatus);
  const accounts = useAuthStore((s) => s.accounts);
  const consecutiveFailures = useAuthStore((s) => s.consecutiveFailures);
  const checkHealth = useAuthStore((s) => s.checkHealth);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Use max consecutive failures across all accounts for backoff
  const maxFailures = Object.values(consecutiveFailures).reduce((max, f) => Math.max(max, f), 0);

  useEffect(() => {
    if (status === "disconnected" || accounts.length === 0) return;

    const scheduleCheck = () => {
      const backoff = Math.min(
        HEALTH_CHECK_INTERVAL * Math.pow(2, maxFailures),
        MAX_BACKOFF
      );
      timerRef.current = setTimeout(async () => {
        await checkHealth();
        scheduleCheck();
      }, backoff);
    };

    scheduleCheck();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [status, maxFailures, checkHealth, accounts.length]);

  if (status === "disconnected") return null;

  // Show account count when multiple accounts
  const accountInfo = accounts.length > 1 ? ` (${accounts.length})` : "";

  return (
    <button
      onClick={status === "error" ? onClickError : undefined}
      className={`flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 ${
        status === "error" ? "cursor-pointer hover:text-red-500" : "cursor-default"
      }`}
      title={status === "error" && maxFailures >= 3 ? "Click to open settings" : undefined}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${STATUS_COLORS[status]}`} />
      <span>{STATUS_LABELS[status]}{accountInfo}</span>
      {status === "error" && maxFailures >= 3 && (
        <span className="text-red-500 font-medium ml-1">-- Check settings</span>
      )}
    </button>
  );
}
