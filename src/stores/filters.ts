import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import type { ActivityCategoryId } from "../types/activity";
import { migrateLegacyProjectKeys } from "../utils/projectFilter";

const STORE_NAME = "filters.json";
const KEY_PROJECTS = "selected_projects";
const KEY_TYPES = "selected_types";
const KEY_MUTED = "muted_issues";
const KEY_ACCOUNTS = "selected_accounts";
const KEY_VIEW_MODE = "view_mode";
const KEY_ASSIGNED_ONLY = "assigned_to_me_only";

export type ViewMode = "unread" | "all";

interface FilterState {
  /** Selected project keys to show (empty = show all). */
  selectedProjects: Set<string>;
  /** Selected activity category IDs to show (empty = show all). */
  selectedTypes: Set<ActivityCategoryId>;
  /** Muted issue IDs (always hidden). */
  mutedIssues: Set<string>;
  /** Selected account IDs to show (empty = show all). */
  selectedAccounts: Set<string>;
  /** Text search query. */
  searchQuery: string;
  /** Which items to show: unread-only (default) or all. */
  viewMode: ViewMode;
  /** When true, show only activities that assigned an issue to the current user. */
  assignedToMeOnly: boolean;

  /** Load persisted filters from store. */
  initialize: () => Promise<void>;
  /** Toggle a project filter chip. */
  /**
   * Upgrade legacy unscoped project keys to account-scoped ones.
   *
   * Runs once activities are loaded, since binding a bare key to its account
   * requires knowing which account actually has a project by that name.
   */
  migrateProjectKeys: (knownKeysByAccount: Map<string, Set<string>>) => void;
  toggleProject: (projectKey: string) => void;
  /** Toggle a category type filter. */
  toggleType: (typeId: ActivityCategoryId) => void;
  /** Toggle an account filter. */
  toggleAccount: (accountId: string) => void;
  /** Mute an issue by its readable ID. */
  muteIssue: (issueId: string) => void;
  /** Unmute an issue. */
  unmuteIssue: (issueId: string) => void;
  /** Set the search query string. */
  setSearchQuery: (query: string) => void;
  /** Set the view mode (unread / all). */
  setViewMode: (mode: ViewMode) => void;
  /** Toggle the assigned-to-me filter. */
  toggleAssignedToMe: () => void;
  /** Clear all filters. */
  clearAll: () => void;
}

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

/** Sync muted issue IDs to the backend so OS notifications skip them. */
async function syncMutedToBackend(muted: Set<string>) {
  try {
    await invoke("set_muted_issues", { mutedIds: Array.from(muted), accountId: null });
  } catch {
    // Backend may not be ready yet — will sync on next change
  }
}

async function persist(
  projects: Set<string>,
  types: Set<ActivityCategoryId>,
  muted: Set<string>,
  accounts: Set<string>,
  viewMode: ViewMode,
  assignedToMeOnly: boolean,
) {
  const store = await getStore();
  await store.set(KEY_PROJECTS, Array.from(projects));
  await store.set(KEY_TYPES, Array.from(types));
  await store.set(KEY_MUTED, Array.from(muted));
  await store.set(KEY_ACCOUNTS, Array.from(accounts));
  await store.set(KEY_VIEW_MODE, viewMode);
  await store.set(KEY_ASSIGNED_ONLY, assignedToMeOnly);
  await store.save();
  syncMutedToBackend(muted);
}

export const useFilterStore = create<FilterState>((set, get) => ({
  selectedProjects: new Set(),
  selectedTypes: new Set(),
  mutedIssues: new Set(),
  selectedAccounts: new Set(),
  searchQuery: "",
  viewMode: "unread",
  assignedToMeOnly: false,

  initialize: async () => {
    try {
      const store = await getStore();
      const projects = await store.get<string[]>(KEY_PROJECTS);
      const types = await store.get<string[]>(KEY_TYPES);
      const muted = await store.get<string[]>(KEY_MUTED);
      const accounts = await store.get<string[]>(KEY_ACCOUNTS);
      const viewMode = await store.get<ViewMode>(KEY_VIEW_MODE);
      const assignedToMeOnly = await store.get<boolean>(KEY_ASSIGNED_ONLY);
      const mutedSet = new Set(muted ?? []);
      set({
        // Stored keys may still be legacy unscoped ones; `migrateProjectKeys`
        // upgrades them once activities are loaded and accounts are known.
        selectedProjects: new Set(projects ?? []),
        selectedTypes: new Set((types ?? []) as ActivityCategoryId[]),
        mutedIssues: mutedSet,
        selectedAccounts: new Set(accounts ?? []),
        viewMode: viewMode === "all" ? "all" : "unread",
        assignedToMeOnly: assignedToMeOnly === true,
      });
      syncMutedToBackend(mutedSet);
    } catch {
      // First run — no stored filters
    }
  },

  migrateProjectKeys: (knownKeysByAccount: Map<string, Set<string>>) => {
    const s = get();
    if (s.selectedProjects.size === 0) return;
    const next = migrateLegacyProjectKeys(Array.from(s.selectedProjects), knownKeysByAccount);
    // Same membership means nothing to migrate — avoid a pointless write and
    // the re-render it would cause on every activity update.
    if (
      next.size === s.selectedProjects.size &&
      Array.from(next).every((k) => s.selectedProjects.has(k))
    ) {
      return;
    }
    set({ selectedProjects: next });
    persist(next, s.selectedTypes, s.mutedIssues, s.selectedAccounts, s.viewMode, s.assignedToMeOnly);
  },

  toggleProject: (projectKey: string) => {
    const s = get();
    const next = new Set(s.selectedProjects);
    if (next.has(projectKey)) {
      next.delete(projectKey);
    } else {
      next.add(projectKey);
    }
    set({ selectedProjects: next });
    persist(next, s.selectedTypes, s.mutedIssues, s.selectedAccounts, s.viewMode, s.assignedToMeOnly);
  },

  toggleType: (typeId: ActivityCategoryId) => {
    const s = get();
    const next = new Set(s.selectedTypes);
    if (next.has(typeId)) {
      next.delete(typeId);
    } else {
      next.add(typeId);
    }
    set({ selectedTypes: next });
    persist(s.selectedProjects, next, s.mutedIssues, s.selectedAccounts, s.viewMode, s.assignedToMeOnly);
  },

  toggleAccount: (accountId: string) => {
    const s = get();
    const next = new Set(s.selectedAccounts);
    if (next.has(accountId)) {
      next.delete(accountId);
    } else {
      next.add(accountId);
    }
    set({ selectedAccounts: next });
    persist(s.selectedProjects, s.selectedTypes, s.mutedIssues, next, s.viewMode, s.assignedToMeOnly);
  },

  muteIssue: (issueId: string) => {
    const s = get();
    const next = new Set(s.mutedIssues);
    next.add(issueId);
    set({ mutedIssues: next });
    persist(s.selectedProjects, s.selectedTypes, next, s.selectedAccounts, s.viewMode, s.assignedToMeOnly);
  },

  unmuteIssue: (issueId: string) => {
    const s = get();
    const next = new Set(s.mutedIssues);
    next.delete(issueId);
    set({ mutedIssues: next });
    persist(s.selectedProjects, s.selectedTypes, next, s.selectedAccounts, s.viewMode, s.assignedToMeOnly);
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  setViewMode: (mode: ViewMode) => {
    const s = get();
    set({ viewMode: mode });
    persist(s.selectedProjects, s.selectedTypes, s.mutedIssues, s.selectedAccounts, mode, s.assignedToMeOnly);
  },

  toggleAssignedToMe: () => {
    const s = get();
    const next = !s.assignedToMeOnly;
    set({ assignedToMeOnly: next });
    persist(s.selectedProjects, s.selectedTypes, s.mutedIssues, s.selectedAccounts, s.viewMode, next);
  },

  clearAll: () => {
    const empty = new Set<string>();
    const emptyTypes = new Set<ActivityCategoryId>();
    set({
      selectedProjects: empty,
      selectedTypes: emptyTypes,
      mutedIssues: new Set(),
      selectedAccounts: new Set(),
      searchQuery: "",
      assignedToMeOnly: false,
      // viewMode intentionally preserved — it's a persistent preference, not a transient filter
    });
    persist(empty, emptyTypes, new Set(), new Set(), get().viewMode, false);
  },
}));
