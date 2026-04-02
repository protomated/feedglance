import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import type {
  ActivityItem,
  ActivityProject,
  NotificationGroup,
} from "../types/activity";

const READ_STORE_NAME = "read_ids.json";
const KEY_READ_IDS = "read_ids";
const KEY_PINNED_IDS = "pinned_ids";

let readStoreInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getReadStore() {
  if (!readStoreInstance) {
    readStoreInstance = await load(READ_STORE_NAME);
  }
  return readStoreInstance;
}

/** Persist read IDs to disk. */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
async function persistReadIds(readIds: Set<string>) {
  // Debounce writes — multiple marks in quick succession only write once
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const store = await getReadStore();
      await store.set(KEY_READ_IDS, Array.from(readIds));
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

/** Sync read IDs to the backend so tray badge is correct. */
async function syncReadIdsToBackend(readIds: Set<string>) {
  try {
    await invoke("set_read_ids", { readIds: Array.from(readIds) });
  } catch {
    // Backend may not be ready yet
  }
}

interface NotificationState {
  activities: ActivityItem[];
  readIds: Set<string>;
  pinnedIds: Set<string>;
  loading: boolean;
  error: string | null;

  /** Initialize: load activities from backend, subscribe to events. */
  initialize: () => Promise<void>;
  /** Start polling with credentials. */
  startPolling: (url: string, token: string, currentUserId?: string) => Promise<void>;
  /** Stop polling. */
  stopPolling: () => Promise<void>;
  /** Set focus state for adaptive intervals. */
  setFocusState: (focus: "focused" | "minimized" | "idle") => Promise<void>;
  /** Mark a single activity as read. */
  markRead: (activityId: string) => Promise<void>;
  /** Mark all activities as read. */
  markAllRead: () => Promise<void>;
  /** Refresh activities from backend cache. */
  refresh: () => Promise<void>;
  /** Pin an activity for later review. */
  pinActivity: (activityId: string) => void;
  /** Unpin an activity. */
  unpinActivity: (activityId: string) => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  activities: [],
  readIds: new Set(),
  pinnedIds: new Set(),
  loading: false,
  error: null,

  initialize: async () => {
    set({ loading: true });

    // Load persisted read IDs and pinned IDs from store
    try {
      const store = await getReadStore();
      const savedReadIds = await store.get<string[]>(KEY_READ_IDS);
      const savedPinnedIds = await store.get<string[]>(KEY_PINNED_IDS);
      const readIdSet = new Set(savedReadIds ?? []);
      const pinnedIdSet = new Set(savedPinnedIds ?? []);
      set({ readIds: readIdSet, pinnedIds: pinnedIdSet });
      // Sync persisted read IDs to backend so tray badge is correct
      syncReadIdsToBackend(readIdSet);
    } catch {
      // First run — no stored data
    }

    // Listen for backend polling events
    await listen<number>("activities-updated", async (event) => {
      if (event.payload > 0) {
        await get().refresh();
      }
    });

    await listen<string>("poll-error", (event) => {
      set({ error: event.payload });
    });

    // Load existing activities from backend
    await get().refresh();
    set({ loading: false });
  },

  startPolling: async (url: string, token: string, currentUserId?: string) => {
    await invoke("start_polling", { url, token, currentUserId });
  },

  stopPolling: async () => {
    await invoke("stop_polling");
  },

  setFocusState: async (focus: string) => {
    await invoke("set_focus_state", { focus });
  },

  markRead: async (activityId: string) => {
    await invoke("mark_activity_read", { activityId });
    const newReadIds = new Set(get().readIds);
    newReadIds.add(activityId);
    set({ readIds: newReadIds });
    persistReadIds(newReadIds);
  },

  markAllRead: async () => {
    await invoke("mark_all_read");
    const newReadIds = new Set(get().readIds);
    for (const a of get().activities) {
      newReadIds.add(a.id);
    }
    set({ readIds: newReadIds });
    persistReadIds(newReadIds);
  },

  refresh: async () => {
    try {
      const activities = await invoke<ActivityItem[]>("get_activities");
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

/** Compute grouped notifications from state, grouped by project. */
export function groupActivities(
  activities: ActivityItem[],
  readIds: Set<string>
): NotificationGroup[] {
  const groupMap = new Map<string, NotificationGroup>();

  for (const activity of activities) {
    const project = resolveProject(activity);
    const projectKey = project?.shortName ?? project?.id ?? "unknown";
    const projectName = project?.name ?? projectKey;

    if (!groupMap.has(projectKey)) {
      groupMap.set(projectKey, {
        projectKey,
        projectName,
        activities: [],
        latestTimestamp: 0,
        hasUnread: false,
      });
    }

    const group = groupMap.get(projectKey)!;
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
