import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFilterStore } from "../stores/filters";
import { useAuthStore } from "../stores/auth";
import { useNotificationStore } from "../stores/notifications";
import type { ActivityCategoryId, ActivityItem } from "../types/activity";

/** Human-readable labels for each activity category. */
const CATEGORY_LABELS: Record<ActivityCategoryId, string> = {
  CommentsCategory: "Comments",
  CustomFieldCategory: "Field changes",
  AttachmentsCategory: "Attachments",
  IssueCreatedCategory: "Created",
  IssueResolvedCategory: "Resolved",
  SprintCategory: "Sprint",
  VcsChangeCategory: "VCS",
};

const ALL_CATEGORIES: ActivityCategoryId[] = Object.keys(CATEGORY_LABELS) as ActivityCategoryId[];

interface ProjectEntry {
  shortName: string;
  name: string;
}

/** Resolve the project key for an activity (mirrors notifications store helper). */
function resolveProjectKey(activity: ActivityItem): string {
  const t = activity.target;
  if (!t) return "unknown";
  const p = t.project ?? t.issue?.project ?? t.article?.project;
  return p?.shortName ?? p?.id ?? "unknown";
}

function resolveProjectName(activity: ActivityItem): string {
  const t = activity.target;
  if (!t) return "unknown";
  const p = t.project ?? t.issue?.project ?? t.article?.project;
  return p?.name ?? p?.shortName ?? p?.id ?? "unknown";
}

export function FilterBar() {
  const activities = useNotificationStore((s) => s.activities);
  const credentials = useAuthStore((s) => s.credentials);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const selectedProjects = useFilterStore((s) => s.selectedProjects);
  const selectedTypes = useFilterStore((s) => s.selectedTypes);
  const searchQuery = useFilterStore((s) => s.searchQuery);
  const toggleProject = useFilterStore((s) => s.toggleProject);
  const toggleType = useFilterStore((s) => s.toggleType);
  const setSearchQuery = useFilterStore((s) => s.setSearchQuery);
  const clearAll = useFilterStore((s) => s.clearAll);

  const [apiProjects, setApiProjects] = useState<ProjectEntry[]>([]);

  // Fetch all projects from the API when connected
  useEffect(() => {
    if (connectionStatus !== "connected" || !credentials) return;
    invoke<ProjectEntry[]>("get_projects", {
      url: credentials.url,
      token: credentials.token,
    })
      .then((projects) => setApiProjects(projects))
      .catch(() => {
        // Fallback: derive from activities if API call fails
      });
  }, [connectionStatus, credentials]);

  // Merge API projects with activity-derived projects (API projects take priority)
  const projects = useMemo(() => {
    const map = new Map<string, string>();
    // Add all projects from the API
    for (const p of apiProjects) {
      map.set(p.shortName, p.name);
    }
    // Fill in any projects found in activities but not in API response
    for (const a of activities) {
      const key = resolveProjectKey(a);
      if (key !== "unknown" && !map.has(key)) {
        map.set(key, resolveProjectName(a));
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [apiProjects, activities]);

  const hasActiveFilters =
    selectedProjects.size > 0 ||
    selectedTypes.size > 0 ||
    searchQuery.length > 0;

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

      {/* Project chips */}
      {projects.length > 1 && (
        <div className="px-3 pb-1.5 flex flex-wrap gap-1">
          {projects.map(([key, name]) => {
            const active = selectedProjects.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleProject(key)}
                className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                  active
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      {/* Category type toggles */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {ALL_CATEGORIES.map((cat) => {
          const active = selectedTypes.has(cat);
          return (
            <button
              key={cat}
              onClick={() => toggleType(cat)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                active
                  ? "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-700"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              {CATEGORY_LABELS[cat]}
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
