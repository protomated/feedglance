import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "ui-prefs.json";
const KEY_REPLY_DETAILS_OPEN = "replyDetailsOpen";
const KEY_QUO_SEND_IN_APP = "quoSendInApp";

/** Small view preferences that should survive restarts but aren't filters. */
interface UiPrefsState {
  /** Whether the reply box shows the item's description card. Open by default. */
  replyDetailsOpen: boolean;
  /**
   * Send Quo replies from Feedglance through the API. Off by default: every
   * API send costs Quo credits, while replying in the Quo app is free.
   */
  quoSendInApp: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setReplyDetailsOpen: (open: boolean) => void;
  setQuoSendInApp: (enabled: boolean) => void;
}

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

function persist(key: string, value: boolean) {
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
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const store = await getStore();
      const open = await store.get<boolean>(KEY_REPLY_DETAILS_OPEN);
      const quoSendInApp = await store.get<boolean>(KEY_QUO_SEND_IN_APP);
      set({ replyDetailsOpen: open ?? true, quoSendInApp: quoSendInApp ?? false, loaded: true });
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
}));
