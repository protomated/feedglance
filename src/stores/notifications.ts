import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import type { Account } from "../types/youtrack";
import type {
  ActivityItem,
  ActivityProject,
  NotificationGroup,
} from "../types/activity";

const READ_STORE_NAME = "read_ids.json";
const KEY_PINNED_IDS = "pinned_ids";

let readStoreInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getReadStore() {
  if (!readStoreInstance) {
    readStoreInstance = await load(READ_STORE_NAME);
  }
  return readStoreInstance;
}

/** Get the store key for per-account read IDs. */
function readIdsKey(accountId: string): string {
  return accountId ? `read_ids:${accountId}` : "read_ids";
}

/** Persist read IDs to disk for a specific account. */
let persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};
async function persistReadIds(accountId: string, readIds: Set<string>) {
  if (persistTimers[accountId]) clearTimeout(persistTimers[accountId]);
  persistTimers[accountId] = setTimeout(async () => {
    try {
      const store = await getReadStore();
      await store.set(readIdsKey(accountId), Array.from(readIds));
      await store.save();
    } catch {
      // Store may not be ready yet
    }
  }, 500);
}

/** Persist pinned IDs to disk. */
async function persistPinnedIds(pinnedIds: Set<string>) {
  try {
    const store = await getReadStore();
    await store.set(KEY_PINNED_IDS, Array.from(pinnedIds));
    await store.save();
  } catch {
    // Store may not be ready yet
  }
}

/** Sync read IDs to the backend for a specific account. */
async function syncReadIdsToBackend(accountId: string, readIds: Set<string>) {
  try {
    await invoke("set_read_ids", { readIds: Array.from(readIds), accountId });
  } catch {
    // Backend may not be ready yet
  }
}

interface NotificationState {
  activities: ActivityItem[];
  /** Per-account read IDs. */
  readIds: Map<string, Set<string>>;
  pinnedIds: Set<string>;
  loading: boolean;
  error: string | null;

  /** Initialize: load activities from backend, subscribe to events. */
  initialize: (accounts: Account[]) => Promise<void>;
  /** Start polling for a single account. */
  startPollingForAccount: (account: Account) => Promise<void>;
  /** Start polling for all accounts. */
  startAllPolling: (accounts: Account[]) => Promise<void>;
  /** Stop polling for a specific account or all. */
  stopPolling: (accountId?: string) => Promise<void>;
  /** Set focus state for adaptive intervals. */
  setFocusState: (focus: "focused" | "minimized" | "idle") => Promise<void>;
  /** Mark a single activity as read (requires accountId). */
  markRead: (activityId: string, accountId?: string) => Promise<void>;
  /** Mark a single activity as unread (reverses markRead). */
  markUnread: (activityId: string, accountId?: string) => Promise<void>;
  /** Mark all activities as read. */
  markAllRead: () => Promise<void>;
  /** Refresh activities from backend cache. */
  refresh: () => Promise<void>;
  /** Pin an activity for later review. */
  pinActivity: (activityId: string) => void;
  /** Unpin an activity. */
  unpinActivity: (activityId: string) => void;

  /** Check if an activity is read (looks up by accountId). */
  isRead: (activityId: string, accountId?: string) => boolean;
  /** Get a flat set of all read IDs across all accounts (for backward compat). */
  allReadIds: () => Set<string>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  activities: [],
  readIds: new Map(),
  pinnedIds: new Set(),
  loading: false,
  error: null,

  initialize: async (accounts: Account[]) => {
    set({ loading: true });

    // Load persisted read IDs per account and pinned IDs
    try {
      const store = await getReadStore();
      const readIdsMap = new Map<string, Set<string>>();

      for (const account of accounts) {
        const key = readIdsKey(account.id);
        const saved = await store.get<string[]>(key);
        const idSet = new Set(saved ?? []);
        readIdsMap.set(account.id, idSet);
        syncReadIdsToBackend(account.id, idSet);
      }

      // Also try to load legacy flat read_ids and attribute to first account
      if (accounts.length > 0) {
        const legacyReadIds = await store.get<string[]>("read_ids");
        if (legacyReadIds && legacyReadIds.length > 0) {
          const firstId = accounts[0].id;
          const existing = readIdsMap.get(firstId) ?? new Set();
          for (const id of legacyReadIds) {
            existing.add(id);
          }
          readIdsMap.set(firstId, existing);
          // Migrate: write to new key and remove old
          await store.set(readIdsKey(firstId), Array.from(existing));
          await store.delete("read_ids");
          await store.save();
          syncReadIdsToBackend(firstId, existing);
        }
      }

      const savedPinnedIds = await store.get<string[]>(KEY_PINNED_IDS);
      const pinnedIdSet = new Set(savedPinnedIds ?? []);
      set({ readIds: readIdsMap, pinnedIds: pinnedIdSet });
    } catch {
      // First run — no stored data
    }

    // Listen for backend polling events (new payload shape: { accountId, count })
    await listen<{ accountId: string; count: number }>("activities-updated", async (event) => {
      const payload = event.payload;
      // Handle both old (number) and new ({ accountId, count }) payload shapes
      const count = typeof payload === "number" ? payload : payload.count;
      if (count > 0) {
        await get().refresh();
      }
    });

    await listen<{ accountId?: string; error?: string } | string>("poll-error", (event) => {
      const payload = event.payload;
      const errorMsg = typeof payload === "string" ? payload : payload.error ?? "Unknown error";
      set({ error: errorMsg });
    });

    // Load existing activities from backend
    await get().refresh();
    set({ loading: false });
  },

  startPollingForAccount: async (account: Account) => {
    await invoke("start_polling", {
      accountId: account.id,
      url: account.url,
      token: account.token,
      currentUserId: account.user?.id,
    });
  },

  startAllPolling: async (accounts: Account[]) => {
    for (const account of accounts) {
      await get().startPollingForAccount(account);
    }
  },

  stopPolling: async (accountId?: string) => {
    await invoke("stop_polling", { accountId: accountId ?? null });
  },

  setFocusState: async (focus: string) => {
    await invoke("set_focus_state", { focus });
  },

  markRead: async (activityId: string, accountId?: string) => {
    // Find the activity to determine its accountId if not provided
    const resolvedAccountId = accountId || get().activities.find((a) => a.id === activityId)?.accountId;
    if (!resolvedAccountId) {
      // Fallback: mark in all accounts
      const readIdsMap = new Map(get().readIds);
      for (const [acctId, ids] of readIdsMap) {
        const newIds = new Set(ids);
        newIds.add(activityId);
        readIdsMap.set(acctId, newIds);
        await invoke("mark_activity_read", { activityId, accountId: acctId });
        persistReadIds(acctId, newIds);
      }
      set({ readIds: readIdsMap });
      return;
    }

    await invoke("mark_activity_read", { activityId, accountId: resolvedAccountId });
    const readIdsMap = new Map(get().readIds);
    const accountIds = readIdsMap.get(resolvedAccountId) ?? new Set();
    const newIds = new Set(accountIds);
    newIds.add(activityId);
    readIdsMap.set(resolvedAccountId, newIds);
    set({ readIds: readIdsMap });
    persistReadIds(resolvedAccountId, newIds);
  },

  markUnread: async (activityId: string, accountId?: string) => {
    const resolvedAccountId = accountId || get().activities.find((a) => a.id === activityId)?.accountId;
    if (!resolvedAccountId) {
      // Fallback: remove from all accounts
      const readIdsMap = new Map(get().readIds);
      for (const [acctId, ids] of readIdsMap) {
        if (!ids.has(activityId)) continue;
        const newIds = new Set(ids);
        newIds.delete(activityId);
        readIdsMap.set(acctId, newIds);
        await invoke("mark_activity_unread", { activityId, accountId: acctId });
        persistReadIds(acctId, newIds);
      }
      set({ readIds: readIdsMap });
      return;
    }

    await invoke("mark_activity_unread", { activityId, accountId: resolvedAccountId });
    const readIdsMap = new Map(get().readIds);
    const accountIds = readIdsMap.get(resolvedAccountId) ?? new Set();
    const newIds = new Set(accountIds);
    newIds.delete(activityId);
    readIdsMap.set(resolvedAccountId, newIds);
    set({ readIds: readIdsMap });
    persistReadIds(resolvedAccountId, newIds);
  },

  markAllRead: async () => {
    await invoke("mark_all_read", { accountId: null });
    const readIdsMap = new Map(get().readIds);
    for (const a of get().activities) {
      const acctId = a.accountId || "";
      const ids = readIdsMap.get(acctId) ?? new Set();
      const newIds = new Set(ids);
      newIds.add(a.id);
      readIdsMap.set(acctId, newIds);
    }
    set({ readIds: readIdsMap });
    // Persist all accounts
    for (const [acctId, ids] of readIdsMap) {
      persistReadIds(acctId, ids);
    }
  },

  refresh: async () => {
    try {
      const activities = await invoke<ActivityItem[]>("get_activities", { accountId: null });
      set({
        activities,
        error: null,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  pinActivity: (activityId: string) => {
    const newPinnedIds = new Set(get().pinnedIds);
    newPinnedIds.add(activityId);
    set({ pinnedIds: newPinnedIds });
    persistPinnedIds(newPinnedIds);
  },

  unpinActivity: (activityId: string) => {
    const newPinnedIds = new Set(get().pinnedIds);
    newPinnedIds.delete(activityId);
    set({ pinnedIds: newPinnedIds });
    persistPinnedIds(newPinnedIds);
  },

  isRead: (activityId: string, accountId?: string) => {
    if (accountId) {
      return get().readIds.get(accountId)?.has(activityId) ?? false;
    }
    // Check all accounts
    for (const ids of get().readIds.values()) {
      if (ids.has(activityId)) return true;
    }
    return false;
  },

  allReadIds: () => {
    const all = new Set<string>();
    for (const ids of get().readIds.values()) {
      for (const id of ids) {
        all.add(id);
      }
    }
    return all;
  },
}));

/**
 * Resolve the project for an activity by walking:
 *   target.project  →  target.issue.project  →  target.article.project
 */
function resolveProject(activity: ActivityItem): ActivityProject | undefined {
  const t = activity.target;
  if (!t) return undefined;
  return t.project ?? t.issue?.project ?? t.article?.project ?? undefined;
}

/** Compute grouped notifications from state, grouped by project (and account). */
export function groupActivities(
  activities: ActivityItem[],
  readIds: Set<string>
): NotificationGroup[] {
  const groupMap = new Map<string, NotificationGroup>();

  for (const activity of activities) {
    const project = resolveProject(activity);
    const projectKey = project?.shortName ?? project?.id ?? "unknown";
    // Prefix with accountId to prevent cross-account merging
    const groupKey = activity.accountId ? `${activity.accountId}:${projectKey}` : projectKey;
    const projectName = project?.name ?? projectKey;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        projectKey,
        projectName,
        activities: [],
        latestTimestamp: 0,
        hasUnread: false,
      });
    }

    const group = groupMap.get(groupKey)!;
    group.activities.push(activity);
    if (activity.timestamp > group.latestTimestamp) {
      group.latestTimestamp = activity.timestamp;
    }
    if (!readIds.has(activity.id)) {
      group.hasUnread = true;
    }
  }

  return Array.from(groupMap.values()).sort(
    (a, b) => b.latestTimestamp - a.latestTimestamp
  );
}

/** Compute unread count from state. Use as a pure derived value. */
export function countUnread(
  activities: ActivityItem[],
  readIds: Set<string>
): number {
  return activities.filter((a) => !readIds.has(a.id)).length;
}
