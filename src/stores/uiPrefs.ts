import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "ui-prefs.json";
const KEY_REPLY_DETAILS_OPEN = "replyDetailsOpen";
const KEY_QUO_SEND_IN_APP = "quoSendInApp";
const KEY_DATE_STYLE = "dateStyle";

/**
 * How the feed shows when something happened.
 * - relative: "2h ago", "12d ago"
 * - absolute: "8:37 AM" today, "Sep 26, 4:10 PM" earlier
 * - mixed: relative for the last week, then the date
 */
export type DateStyle = "relative" | "absolute" | "mixed";
const DATE_STYLES: readonly DateStyle[] = ["relative", "absolute", "mixed"];

/** Small view preferences that should survive restarts but aren't filters. */
interface UiPrefsState {
  /** Whether the reply box shows the item's description card. Open by default. */
  replyDetailsOpen: boolean;
  /**
   * Send Quo replies from Feedglance through the API. Off by default: every
   * API send costs Quo credits, while replying in the Quo app is free.
   */
  quoSendInApp: boolean;
  dateStyle: DateStyle;
  loaded: boolean;
  load: () => Promise<void>;
  setReplyDetailsOpen: (open: boolean) => void;
  setQuoSendInApp: (enabled: boolean) => void;
  setDateStyle: (style: DateStyle) => void;
}

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

function persist(key: string, value: unknown) {
  getStore()
    .then(async (store) => {
      await store.set(key, value);
      await store.save();
    })
    .catch(() => {
      // Preference only — losing it costs one extra click next launch.
    });
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  replyDetailsOpen: true,
  quoSendInApp: false,
  dateStyle: "relative",
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const store = await getStore();
      const open = await store.get<boolean>(KEY_REPLY_DETAILS_OPEN);
      const quoSendInApp = await store.get<boolean>(KEY_QUO_SEND_IN_APP);
      const dateStyle = await store.get<DateStyle>(KEY_DATE_STYLE);
      set({
        replyDetailsOpen: open ?? true,
        quoSendInApp: quoSendInApp ?? false,
        dateStyle: dateStyle && DATE_STYLES.includes(dateStyle) ? dateStyle : "relative",
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  setReplyDetailsOpen: (open) => {
    set({ replyDetailsOpen: open });
    persist(KEY_REPLY_DETAILS_OPEN, open);
  },

  setQuoSendInApp: (enabled) => {
    set({ quoSendInApp: enabled });
    persist(KEY_QUO_SEND_IN_APP, enabled);
  },

  setDateStyle: (style) => {
    set({ dateStyle: style });
    persist(KEY_DATE_STYLE, style);
  },
}));
