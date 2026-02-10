import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActivityItem,
  ActivityProject,
  NotificationGroup,
} from "../types/activity";

interface NotificationState {
  activities: ActivityItem[];
  readIds: Set<string>;
  loading: boolean;
  error: string | null;

  /** Initialize: load activities from backend, subscribe to events. */
  initialize: () => Promise<void>;
  /** Start polling with credentials. */
  startPolling: (url: string, token: string) => Promise<void>;
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
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  activities: [],
  readIds: new Set(),
  loading: false,
  error: null,

  initialize: async () => {
    set({ loading: true });

    // Listen for backend polling events
    await listen<number>("activities-updated", async (event) => {
      if (event.payload > 0) {
        await get().refresh();
      }
    });

    await listen<string>("poll-error", (event) => {
      set({ error: event.payload });
    });

    // Load existing activities and read state from backend
    await get().refresh();
    set({ loading: false });
  },

  startPolling: async (url: string, token: string) => {
    await invoke("start_polling", { url, token });
  },

  stopPolling: async () => {
    await invoke("stop_polling");
  },

  setFocusState: async (focus: string) => {
    await invoke("set_focus_state", { focus });
  },

  markRead: async (activityId: string) => {
    await invoke("mark_activity_read", { activityId });
    set((state) => {
      const newReadIds = new Set(state.readIds);
      newReadIds.add(activityId);
      return { readIds: newReadIds };
    });
  },

  markAllRead: async () => {
    await invoke("mark_all_read");
    set((state) => {
      const newReadIds = new Set(state.readIds);
      for (const a of state.activities) {
        newReadIds.add(a.id);
      }
      return { readIds: newReadIds };
    });
  },

  refresh: async () => {
    try {
      const [activities, readIds] = await Promise.all([
        invoke<ActivityItem[]>("get_activities"),
        invoke<string[]>("get_read_ids"),
      ]);
      set({
        activities,
        readIds: new Set(readIds),
        error: null,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
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
