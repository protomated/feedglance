import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../stores/auth";
import { useNotificationStore } from "../stores/notifications";
import { showToast } from "./Toast";
import type { TeamMember, CommandResult } from "../types/youtrack";

interface Props {
  issueId: string;
  projectId: string;
  accountId?: string;
  onClose: () => void;
}

export function AssignDropdown({ issueId, projectId, accountId, onClose }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [filtered, setFiltered] = useState<TeamMember[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getAccountCredentials = useAuthStore((s) => s.getAccountCredentials);
  const legacyCredentials = useAuthStore((s) => s.credentials);
  const credentials = accountId ? getAccountCredentials(accountId) : legacyCredentials;
  const refresh = useNotificationStore((s) => s.refresh);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!credentials) return;

    const fetchTeam = async () => {
      try {
        const result = await invoke<TeamMember[]>("get_project_team", {
          url: credentials.url,
          token: credentials.token,
          projectId,
        });
        setMembers(result);
        setFiltered(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    };

    fetchTeam();
  }, [credentials, projectId]);

  useEffect(() => {
    if (!loading) searchRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(
      members.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.login.toLowerCase().includes(q)
      )
    );
  }, [search, members]);

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

  const handleSelect = async (member: TeamMember) => {
    if (!credentials || executing) return;

    setExecuting(true);
    try {
      await invoke<CommandResult>("execute_command", {
        url: credentials.url,
        token: credentials.token,
        issueId,
        command: `for ${member.login}`,
      });
      showToast("success", `${issueId} assigned to ${member.name}`);
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
      className="absolute right-0 top-full mt-1 z-40 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg overflow-hidden"
    >
      <div className="px-2 py-1.5 text-[10px] font-medium text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
        Assign to
      </div>
      {!loading && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-gray-700">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400"
          />
        </div>
      )}
      {loading && (
        <div className="px-2 py-3 text-[10px] text-gray-400 text-center">Loading...</div>
      )}
      {error && (
        <div className="px-2 py-3 text-[10px] text-red-500 text-center">{error}</div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="px-2 py-3 text-[10px] text-gray-400 text-center">
          {search ? "No matches" : "No team members"}
        </div>
      )}
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((member) => (
          <button
            key={member.id}
            onClick={() => handleSelect(member)}
            disabled={executing}
            className="w-full text-left px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {member.avatarUrl ? (
              <img
                src={member.avatarUrl}
                alt={member.name}
                className="w-4 h-4 rounded-full flex-shrink-0"
              />
            ) : (
              <div className="w-4 h-4 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-[8px] font-medium text-gray-600 dark:text-gray-300 flex-shrink-0">
                {member.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate">{member.name}</div>
              <div className="text-[10px] text-gray-400 truncate">{member.login}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
