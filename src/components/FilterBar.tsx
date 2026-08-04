import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFilterStore } from "../stores/filters";
import { useAuthStore } from "../stores/auth";
import { useNotificationStore } from "../stores/notifications";
import type { EventKind } from "../types/event";
import { EVENT_KIND_LABELS } from "../types/event";
import {
  projectKeyOfScopedKey,
  resolveProjectKey,
  resolveProjectName,
  scopedProjectKey,
} from "../utils/projectFilter";

/**
 * Filterable event kinds, in display order.
 *
 * Listed explicitly rather than derived from `EVENT_KIND_LABELS` so the chip
 * order is intentional (most-used first) rather than object-key order. Every
 * kind appears — including `other`, so that events from provider subtypes the
 * app does not model yet are still filterable rather than stuck on screen.
 */
const ALL_KINDS: EventKind[] = [
  "comment",
  "assignment",
  "statusChange",
  "itemCreated",
  "itemResolved",
  "attachment",
  "sprint",
  "vcsChange",
  "other",
];

interface ProjectEntry {
  shortName: string;
  name: string;
}

/** A project chip: account-scoped key, display name, and owning account. */
interface ProjectChip {
  key: string;
  name: string;
  accountId: string;
  accountLabel: string;
}

export function FilterBar() {
  const activities = useNotificationStore((s) => s.activities);
  const accounts = useAuthStore((s) => s.accounts);
  const connectionStatuses = useAuthStore((s) => s.connectionStatuses);
  const selectedProjects = useFilterStore((s) => s.selectedProjects);
  const selectedTypes = useFilterStore((s) => s.selectedTypes);
  const selectedAccounts = useFilterStore((s) => s.selectedAccounts);
  const searchQuery = useFilterStore((s) => s.searchQuery);
  const assignedToMeOnly = useFilterStore((s) => s.assignedToMeOnly);
  const toggleProject = useFilterStore((s) => s.toggleProject);
  const migrateProjectKeys = useFilterStore((s) => s.migrateProjectKeys);
  const toggleType = useFilterStore((s) => s.toggleType);
  const toggleAccount = useFilterStore((s) => s.toggleAccount);
  const setSearchQuery = useFilterStore((s) => s.setSearchQuery);
  const toggleAssignedToMe = useFilterStore((s) => s.toggleAssignedToMe);
  const clearAll = useFilterStore((s) => s.clearAll);
  const hasAnyUser = useAuthStore((s) => s.accounts.some((a) => !!a.user?.login || !!a.user?.id));

  // API-fetched projects, kept per account — a project key is only meaningful
  // within its own account, so a flat list would merge same-named projects from
  // different accounts into one chip.
  const [apiProjects, setApiProjects] = useState<Map<string, ProjectEntry[]>>(new Map());

  // Fetch projects from all connected accounts.
  useEffect(() => {
    const connectedAccounts = accounts.filter(
      (a) => connectionStatuses[a.id] === "connected"
    );
    if (connectedAccounts.length === 0) return;

    let cancelled = false;
    const fetchAll = async () => {
      const byAccount = new Map<string, ProjectEntry[]>();
      for (const account of connectedAccounts) {
        // `get_projects` is YouTrack-only; Nifty projects are derived from
        // activities below rather than fetched.
        if ((account.provider ?? "youtrack") !== "youtrack") continue;
        try {
          const projects = await invoke<ProjectEntry[]>("get_projects", {
            url: account.url,
            token: account.token,
          });
          byAccount.set(account.id, projects);
        } catch {
          // Fallback: derive from activities
        }
      }
      if (!cancelled) setApiProjects(byAccount);
    };
    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [accounts, connectionStatuses]);

  // Merge API projects with activity-derived ones, scoped per account so chips
  // from different accounts never collide (API projects take priority).
  const projects = useMemo<ProjectChip[]>(() => {
    const labelOf = new Map(accounts.map((a) => [a.id, a.label || a.url || ""]));
    const chips = new Map<string, ProjectChip>();

    const add = (accountId: string, projectKey: string, name: string) => {
      if (!projectKey || projectKey === "unknown") return;
      const key = scopedProjectKey(accountId, projectKey);
      if (chips.has(key)) return;
      chips.set(key, {
        key,
        name,
        accountId,
        accountLabel: labelOf.get(accountId) ?? "",
      });
    };

    for (const [accountId, entries] of apiProjects) {
      for (const p of entries) add(accountId, p.shortName, p.name);
    }
    for (const a of activities) {
      add(a.accountId ?? "", resolveProjectKey(a), resolveProjectName(a));
    }

    return Array.from(chips.values()).sort(
      (x, y) => x.accountLabel.localeCompare(y.accountLabel) || x.name.localeCompare(y.name),
    );
  }, [apiProjects, activities, accounts]);

  /** Show the owning account on chips only when more than one account exists. */
  const showAccountOnChips = accounts.length > 1;

  // One-time upgrade of pre-scoping selections. Deferred to here because
  // binding a bare project key to an account needs the per-account key sets,
  // which only exist once projects and activities have loaded.
  useEffect(() => {
    if (projects.length === 0) return;
    const byAccount = new Map<string, Set<string>>();
    for (const chip of projects) {
      const bare = projectKeyOfScopedKey(chip.key);
      const set = byAccount.get(chip.accountId) ?? new Set<string>();
      set.add(bare);
      byAccount.set(chip.accountId, set);
    }
    migrateProjectKeys(byAccount);
  }, [projects, migrateProjectKeys]);

  const hasActiveFilters =
    selectedProjects.size > 0 ||
    selectedTypes.size > 0 ||
    selectedAccounts.size > 0 ||
    searchQuery.length > 0 ||
    assignedToMeOnly;

  return (
    <div className="border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800/50">
      {/* Search */}
      <div className="px-3 pt-2 pb-1.5">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search notifications..."
          className="w-full text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500"
        />
      </div>

      {/* Assigned to me chip */}
      {hasAnyUser && (
        <div className="px-3 pb-1.5">
          <button
            onClick={toggleAssignedToMe}
            className={`text-[10px] px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${
              assignedToMeOnly
                ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700"
                : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-gray-600"
            }`}
            title={assignedToMeOnly ? "Showing only issues assigned to you" : "Show only issues assigned to you"}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
            </svg>
            Assigned to me
          </button>
        </div>
      )}

      {/* Account chips (only when 2+ accounts) */}
      {accounts.length > 1 && (
        <div className="px-3 pb-1.5 flex flex-wrap gap-1">
          {accounts.map((account) => {
            const active = selectedAccounts.has(account.id);
            return (
              <button
                key={account.id}
                onClick={() => toggleAccount(account.id)}
                className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                  active
                    ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border border-green-300 dark:border-green-700"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {account.label || account.url}
              </button>
            );
          })}
        </div>
      )}

      {/* Project chips */}
      {projects.length > 1 && (
        <div className="px-3 pb-1.5 flex flex-wrap gap-1">
          {projects.map((chip) => {
            const active = selectedProjects.has(chip.key);
            return (
              <button
                key={chip.key}
                onClick={() => toggleProject(chip.key)}
                title={
                  showAccountOnChips && chip.accountLabel
                    ? `${chip.name} — ${chip.accountLabel}`
                    : chip.name
                }
                className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                  active
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {chip.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Category type toggles */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {ALL_KINDS.map((kind) => {
          const active = selectedTypes.has(kind);
          return (
            <button
              key={kind}
              onClick={() => toggleType(kind)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                active
                  ? "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-700"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              {EVENT_KIND_LABELS[kind]}
            </button>
          );
        })}
      </div>

      {/* Clear all */}
      {hasActiveFilters && (
        <div className="px-3 pb-2">
          <button
            onClick={clearAll}
            className="text-[10px] text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          >
            Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}
