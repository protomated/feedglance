import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "ui-prefs.json";
const KEY_REPLY_DETAILS_OPEN = "replyDetailsOpen";

/** Small view preferences that should survive restarts but aren't filters. */
interface UiPrefsState {
  /** Whether the reply box shows the item's description card. Open by default. */
  replyDetailsOpen: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setReplyDetailsOpen: (open: boolean) => void;
}

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  replyDetailsOpen: true,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const store = await getStore();
      const open = await store.get<boolean>(KEY_REPLY_DETAILS_OPEN);
      set({ replyDetailsOpen: open ?? true, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setReplyDetailsOpen: (open) => {
    set({ replyDetailsOpen: open });
    getStore()
      .then(async (store) => {
        await store.set(KEY_REPLY_DETAILS_OPEN, open);
        await store.save();
      })
      .catch(() => {
        // Preference only — losing it costs one extra click next launch.
      });
  },
}));
