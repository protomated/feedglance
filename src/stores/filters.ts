import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import type { ActivityCategoryId } from "../types/activity";

const STORE_NAME = "filters.json";
const KEY_PROJECTS = "selected_projects";
const KEY_TYPES = "selected_types";
const KEY_MUTED = "muted_issues";
const KEY_ACCOUNTS = "selected_accounts";

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

  /** Load persisted filters from store. */
  initialize: () => Promise<void>;
  /** Toggle a project filter chip. */
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
) {
  const store = await getStore();
  await store.set(KEY_PROJECTS, Array.from(projects));
  await store.set(KEY_TYPES, Array.from(types));
  await store.set(KEY_MUTED, Array.from(muted));
  await store.set(KEY_ACCOUNTS, Array.from(accounts));
  await store.save();
  syncMutedToBackend(muted);
}

export const useFilterStore = create<FilterState>((set, get) => ({
  selectedProjects: new Set(),
  selectedTypes: new Set(),
  mutedIssues: new Set(),
  selectedAccounts: new Set(),
  searchQuery: "",

  initialize: async () => {
    try {
      const store = await getStore();
      const projects = await store.get<string[]>(KEY_PROJECTS);
      const types = await store.get<string[]>(KEY_TYPES);
      const muted = await store.get<string[]>(KEY_MUTED);
      const accounts = await store.get<string[]>(KEY_ACCOUNTS);
      const mutedSet = new Set(muted ?? []);
      set({
        selectedProjects: new Set(projects ?? []),
        selectedTypes: new Set((types ?? []) as ActivityCategoryId[]),
        mutedIssues: mutedSet,
        selectedAccounts: new Set(accounts ?? []),
      });
      syncMutedToBackend(mutedSet);
    } catch {
      // First run — no stored filters
    }
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
    persist(next, s.selectedTypes, s.mutedIssues, s.selectedAccounts);
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
    persist(s.selectedProjects, next, s.mutedIssues, s.selectedAccounts);
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
    persist(s.selectedProjects, s.selectedTypes, s.mutedIssues, next);
  },

  muteIssue: (issueId: string) => {
    const s = get();
    const next = new Set(s.mutedIssues);
    next.add(issueId);
    set({ mutedIssues: next });
    persist(s.selectedProjects, s.selectedTypes, next, s.selectedAccounts);
  },

  unmuteIssue: (issueId: string) => {
    const s = get();
    const next = new Set(s.mutedIssues);
    next.delete(issueId);
    set({ mutedIssues: next });
    persist(s.selectedProjects, s.selectedTypes, next, s.selectedAccounts);
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
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
    });
    persist(empty, emptyTypes, new Set(), new Set());
  },
}));
