import { useState, useEffect, useRef } from "react";
import { useAuthStore } from "../stores/auth";
import { useNotificationStore } from "../stores/notifications";
import { showToast } from "./Toast";
import { fetchStatuses, setStatus, type StatusOption } from "../services/actions";

interface Props {
  issueId: string;
  projectId: string;
  accountId?: string;
  onClose: () => void;
}

export function StatusDropdown({ issueId, projectId, accountId, onClose }: Props) {
  const [states, setStates] = useState<StatusOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getActionAccount = useAuthStore((s) => s.getActionAccount);
  const credentials = getActionAccount(accountId);
  const refresh = useNotificationStore((s) => s.refresh);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!credentials) return;

    const fetchStates = async () => {
      try {
        setStates(await fetchStatuses(credentials, projectId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    };

    fetchStates();
  }, [credentials, projectId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    // Use capture phase so Escape closes dropdown before keyboard navigation hook runs
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [onClose]);

  const handleSelect = async (state: StatusOption) => {
    if (!credentials || executing) return;

    setExecuting(true);
    try {
      await setStatus(credentials, issueId, state.id);
      showToast("success", `${issueId} → ${state.name}`);
      onClose();
      await refresh();
    } catch (e) {
      showToast("error", `Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      ref={dropdownRef}
      className="absolute right-0 top-full mt-1 z-40 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg overflow-hidden"
    >
      <div className="px-2 py-1.5 text-[10px] font-medium text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
        Set status
      </div>
      {loading && (
        <div className="px-2 py-3 text-[10px] text-gray-400 text-center">Loading...</div>
      )}
      {error && (
        <div className="px-2 py-3 text-[10px] text-red-500 text-center">{error}</div>
      )}
      {!loading && !error && states.length === 0 && (
        <div className="px-2 py-3 text-[10px] text-gray-400 text-center">No states found</div>
      )}
      <div className="max-h-48 overflow-y-auto">
        {states.map((state) => (
          <button
            key={state.id}
            onClick={() => handleSelect(state)}
            disabled={executing}
            className="w-full text-left px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                state.isResolved ? "bg-green-500" : "bg-blue-500"
              }`}
            />
            {state.name}
          </button>
        ))}
      </div>
    </div>
  );
}
