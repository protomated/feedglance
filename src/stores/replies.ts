import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { postComment, type AssigneeOption } from "../services/actions";
import type { Account } from "../types/youtrack";
import { useNotificationStore } from "./notifications";
import { showToast } from "../components/Toast";

const STORE_NAME = "drafts.json";
const KEY_DRAFTS = "drafts";
/** Drafts untouched for this long are dropped on load, like read IDs. */
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How far a provider's timestamp may trail the moment Send was pressed and
 * still count as the comment that was sent (clock skew, server queueing).
 */
const ARRIVAL_SLACK_MS = 60 * 1000;

/** An unsent reply, kept until it is sent or deliberately cancelled. */
export interface Draft {
  text: string;
  /** People picked from the @ dropdown, so mentions still link once restored. */
  mentioned: AssigneeOption[];
  updatedAt: number;
}

export type SendStatus = "sending" | "sent" | "failed";

/**
 * A reply shown in its thread from the moment Send is pressed until the
 * provider's copy of it arrives with the next poll.
 */
export interface PendingReply {
  id: string;
  threadKey: string;
  draftKey: string;
  text: string;
  mentioned: AssigneeOption[];
  status: SendStatus;
  /** When Send was pressed (ms). */
  at: number;
  error?: string;
}

export interface SendRequest {
  threadKey: string;
  draftKey: string;
  credentials: Pick<Account, "url" | "token" | "provider">;
  /** Provider-native item ID to post on. */
  itemId: string;
  /** What the user typed, as shown in the thread. */
  text: string;
  /** The same text with mentions in provider form, as posted. */
  body: string;
  mentioned: AssigneeOption[];
  /** Says what failed, for the error toast: "Comment not posted on PROJ-1". */
  failureLabel: string;
}

/**
 * How drafts used to be keyed: by the activity's item, which changed whenever
 * new activity arrived on the issue. Drafts are now keyed by thread (issue);
 * old ones are moved over by {@link RepliesState.adoptDrafts}.
 */
export function legacyDraftKey(accountId: string | undefined, itemId: string): string {
  return `${accountId ?? ""}:${itemId}`;
}

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;
async function getStore() {
  if (!storeInstance) storeInstance = await load(STORE_NAME);
  return storeInstance;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistDrafts(drafts: Record<string, Draft>) {
  if (persistTimer) clearTimeout(persistTimer);
  // Debounced: this runs on every keystroke.
  persistTimer = setTimeout(() => {
    getStore()
      .then(async (store) => {
        await store.set(KEY_DRAFTS, drafts);
        await store.save();
      })
      .catch(() => {
        // The draft is still in memory; only a restart would lose it.
      });
  }, 400);
}

/** What a retry needs that doesn't belong in rendered state (the token). */
const requests = new Map<string, SendRequest>();

/**
 * Who shows a thread's open reply box: the thread row itself, or one activity
 * row inside it (by activity ID).
 */
export type ReplyOwner = "thread" | string;

interface RepliesState {
  drafts: Record<string, Draft>;
  pending: PendingReply[];
  loaded: boolean;
  /**
   * Open reply boxes by thread key. Kept here rather than in the rows so a box
   * survives its row unmounting, e.g. the window hiding on blur.
   */
  openReplies: Record<string, ReplyOwner>;
  /** The thread whose box was last opened or focused: where coming back lands. */
  activeReply: string | null;
  /** Bumped to ask the active box to scroll into view and take focus. */
  resumeSeq: number;
  load: () => Promise<void>;
  /** Open (owner) or close (null) a thread's reply box. */
  setOpenReply: (threadKey: string, owner: ReplyOwner | null) => void;
  /** Mark a thread's box as the one being worked in. */
  touchReply: (threadKey: string) => void;
  /**
   * Bring a reply box back: the given thread's (opening it if closed), or
   * the active one if still open.
   */
  resume: (threadKey?: string) => void;
  /** Drafts are keyed by thread key. */
  setDraft: (key: string, text: string, mentioned: AssigneeOption[]) => void;
  /** Move drafts from old keys to thread keys, as `{ [oldKey]: threadKey }`. */
  adoptDrafts: (moves: Record<string, string>) => void;
  clearDraft: (key: string) => void;
  send: (req: SendRequest) => void;
  retry: (id: string) => void;
  /** Drop a failed reply, putting its text back as the draft. */
  edit: (id: string) => void;
  /** Forget replies whose provider copy has arrived. */
  settle: (ids: string[]) => void;
}

export const useRepliesStore = create<RepliesState>((set, get) => {
  const post = async (id: string) => {
    const req = requests.get(id);
    if (!req) return;
    try {
      await postComment(req.credentials, req.itemId, req.body);
      requests.delete(id);
      // A failed attempt put the text back as the draft; it's sent now.
      if (get().drafts[req.draftKey]?.text === req.text) get().clearDraft(req.draftKey);
      set({
        pending: get().pending.map((p) => (p.id === id ? { ...p, status: "sent" } : p)),
      });
      void useNotificationStore.getState().refresh();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      set({
        pending: get().pending.map((p) =>
          p.id === id ? { ...p, status: "failed", error: reason } : p,
        ),
      });
      // Back in the draft too, so quitting before a retry loses nothing.
      if (!get().drafts[req.draftKey]) get().setDraft(req.draftKey, req.text, req.mentioned);
      showToast("error", `${req.failureLabel}: ${reason}`);
    }
  };

  return {
    drafts: {},
    pending: [],
    loaded: false,
    openReplies: {},
    activeReply: null,
    resumeSeq: 0,

    setOpenReply: (threadKey, owner) => {
      const openReplies = { ...get().openReplies };
      if (owner) {
        openReplies[threadKey] = owner;
        set({ openReplies, activeReply: threadKey });
      } else {
        if (!(threadKey in openReplies)) return;
        delete openReplies[threadKey];
        const activeReply = get().activeReply === threadKey ? null : get().activeReply;
        set({ openReplies, activeReply });
      }
    },

    touchReply: (threadKey) => {
      if (get().activeReply !== threadKey) set({ activeReply: threadKey });
    },

    resume: (threadKey) => {
      if (threadKey) {
        if (!get().openReplies[threadKey]) {
          set({ openReplies: { ...get().openReplies, [threadKey]: "thread" } });
        }
        set({ activeReply: threadKey, resumeSeq: get().resumeSeq + 1 });
        return;
      }
      const active = get().activeReply;
      if (active && get().openReplies[active]) set({ resumeSeq: get().resumeSeq + 1 });
    },

    load: async () => {
      if (get().loaded) return;
      try {
        const store = await getStore();
        const saved = (await store.get<Record<string, Draft>>(KEY_DRAFTS)) ?? {};
        const cutoff = Date.now() - DRAFT_TTL_MS;
        const drafts: Record<string, Draft> = {};
        for (const [key, d] of Object.entries(saved)) {
          if (d && typeof d.text === "string" && d.text.trim() && d.updatedAt >= cutoff) {
            drafts[key] = { text: d.text, mentioned: d.mentioned ?? [], updatedAt: d.updatedAt };
          }
        }
        // Anything typed before the load finished wins over the disk copy.
        set({ drafts: { ...drafts, ...get().drafts }, loaded: true });
      } catch {
        set({ loaded: true });
      }
    },

    setDraft: (key, text, mentioned) => {
      const drafts = { ...get().drafts };
      if (text.trim()) {
        drafts[key] = { text, mentioned, updatedAt: Date.now() };
      } else if (key in drafts) {
        delete drafts[key];
      } else {
        return;
      }
      set({ drafts });
      persistDrafts(drafts);
    },

    adoptDrafts: (moves) => {
      const drafts = { ...get().drafts };
      let changed = false;
      for (const [from, to] of Object.entries(moves)) {
        const draft = drafts[from];
        if (!draft || from === to) continue;
        // Never overwrite a draft already on the thread.
        if (!drafts[to]) drafts[to] = draft;
        delete drafts[from];
        changed = true;
      }
      if (!changed) return;
      set({ drafts });
      persistDrafts(drafts);
    },

    clearDraft: (key) => {
      if (!(key in get().drafts)) return;
      const drafts = { ...get().drafts };
      delete drafts[key];
      set({ drafts });
      persistDrafts(drafts);
    },

    send: (req) => {
      const id = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      requests.set(id, req);
      // The text now lives in the thread; a failure puts it back.
      get().clearDraft(req.draftKey);
      set({
        pending: [
          ...get().pending,
          {
            id,
            threadKey: req.threadKey,
            draftKey: req.draftKey,
            text: req.text,
            mentioned: req.mentioned,
            status: "sending",
            at: Date.now(),
          },
        ],
      });
      void post(id);
    },

    retry: (id) => {
      set({
        pending: get().pending.map((p) =>
          p.id === id ? { ...p, status: "sending", error: undefined } : p,
        ),
      });
      void post(id);
    },

    edit: (id) => {
      const reply = get().pending.find((p) => p.id === id);
      if (!reply) return;
      requests.delete(id);
      set({ pending: get().pending.filter((p) => p.id !== id) });
      // Never overwrite something typed since.
      if (!get().drafts[reply.draftKey]) {
        get().setDraft(reply.draftKey, reply.text, reply.mentioned);
      }
    },

    settle: (ids) => {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      for (const id of ids) requests.delete(id);
      set({ pending: get().pending.filter((p) => !drop.has(p.id)) });
    },
  };
});

/**
 * Sent replies whose provider copy has now arrived, given the timestamps of
 * your own activities in the thread.
 *
 * Matched by count, oldest first: each of your activities at or after a sent
 * reply's send time accounts for one reply. Text can't be compared, since
 * providers rewrite mentions and markup.
 */
export function arrivedReplies(replies: PendingReply[], mineTimestamps: number[]): string[] {
  const sent = replies.filter((r) => r.status === "sent").sort((a, b) => a.at - b.at);
  if (sent.length === 0) return [];
  const since = sent[0].at - ARRIVAL_SLACK_MS;
  const arrived = mineTimestamps.filter((t) => t >= since).length;
  return sent.slice(0, arrived).map((r) => r.id);
}
