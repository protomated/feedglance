import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { useAuthStore } from "../stores/auth";
import {
  fetchAssignees,
  fetchItemDetails,
  postComment,
  type AssigneeOption,
  type ItemDetails,
} from "../services/actions";
import { useNotificationStore } from "../stores/notifications";
import { useUiPrefsStore } from "../stores/uiPrefs";
import { toPlainSnippet } from "../utils/plainText";
import { showToast } from "./Toast";
import type { ThreadMessage } from "../services/actions";

/**
 * How long a details fetch may run before a placeholder appears. Faster loads
 * fill in without flashing a skeleton first.
 */
const SKELETON_DELAY_MS = 1000;


interface Props {
  /** Provider-native ID, used for API calls. */
  issueId: string;
  /** Human-facing ID (`PROJ-142`), used for everything the user reads. */
  displayId?: string;
  /** Title already known from the feed; shown before details arrive. */
  title?: string;
  activityId?: string;
  projectId?: string;
  accountId?: string;
  isRead?: boolean;
  /** Whether the provider supports @-mentions. */
  mentions?: boolean;
  /**
   * The item is a text conversation (Quo): show its recent messages instead of
   * a description, and word the UI as sending a text.
   */
  isConversation?: boolean;
  onClose: () => void;
}

export function InlineReply({
  issueId,
  displayId,
  title,
  activityId,
  projectId,
  accountId,
  isRead,
  mentions = true,
  isConversation = false,
  onClose,
}: Props) {
  const shownId = displayId ?? issueId;
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const getActionAccount = useAuthStore((s) => s.getActionAccount);
  const credentials = getActionAccount(accountId);
  const refresh = useNotificationStore((s) => s.refresh);
  const markRead = useNotificationStore((s) => s.markRead);

  // @mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(-1);
  const [members, setMembers] = useState<AssigneeOption[]>([]);
  const [filtered, setFiltered] = useState<AssigneeOption[]>([]);
  /** People picked from the dropdown, so their IDs survive to send time. */
  const [mentioned, setMentioned] = useState<AssigneeOption[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Reply context: title, description snippet and headline fields.
  const detailsOpen = useUiPrefsStore((s) => s.replyDetailsOpen);
  const setDetailsOpen = useUiPrefsStore((s) => s.setReplyDetailsOpen);
  const loadUiPrefs = useUiPrefsStore((s) => s.load);
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descOverflows, setDescOverflows] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    loadUiPrefs();
  }, [loadUiPrefs]);

  useEffect(() => {
    if (!credentials) return;
    let cancelled = false;
    const timer = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    fetchItemDetails(credentials, issueId)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => !cancelled && setDetailsFailed(true))
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `credentials` is a fresh object each render; the account + item pair is
    // what identifies the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, issueId]);

  const snippet = details?.description ? toPlainSnippet(details.description) : "";
  const fullTitle = details?.title ?? title;
  const detailsLoading = !details && !detailsFailed;

  useLayoutEffect(() => {
    if (!snippet || descExpanded) return;
    const el = descRef.current;
    if (el) setDescOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [snippet, descExpanded, detailsOpen]);

  // Fetch team members fresh when @ is typed
  const fetchTeam = useCallback(async () => {
    if (!credentials || !projectId) return;
    setLoadingMembers(true);
    try {
      setMembers(await fetchAssignees(credentials, projectId));
    } catch {
      setMembers([]);
    } finally {
      setLoadingMembers(false);
    }
  }, [credentials, projectId]);

  // Filter members as mentionQuery changes
  useEffect(() => {
    if (mentionQuery === null) {
      setFiltered([]);
      return;
    }
    const q = mentionQuery.toLowerCase();
    setFiltered(
      members.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.login.toLowerCase().includes(q)
      )
    );
    setSelectedIndex(0);
  }, [mentionQuery, members]);

  const closeMention = () => {
    setMentionQuery(null);
    setMentionStart(-1);
    setFiltered([]);
  };

  const insertMention = (member: AssigneeOption) => {
    // The box shows a readable `@Name`; the ID needed to actually link the
    // mention rides along in `mentioned` and is reattached in serializeMentions.
    const before = text.slice(0, mentionStart);
    const after = text.slice(
      mentionStart + 1 + (mentionQuery?.length ?? 0)
    );
    const newText = `${before}@${member.name} ${after}`;
    setText(newText);
    setMentioned((prev) =>
      prev.some((m) => m.id === member.id) ? prev : [...prev, member]
    );
    closeMention();

    // Re-focus and set cursor position after the inserted mention
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const cursorPos = before.length + 1 + member.name.length + 1;
        ta.setSelectionRange(cursorPos, cursorPos);
      }
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    const cursorPos = e.target.selectionStart ?? val.length;

    // Detect if we're in an @mention context
    // Look backwards from cursor for an @ that starts a mention
    const textBeforeCursor = val.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex >= 0) {
      // Check that @ is at start or preceded by whitespace
      const charBefore = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
      const queryText = textBeforeCursor.slice(atIndex + 1);
      // Only trigger if no spaces in the query (still typing the mention)
      if (/\s/.test(charBefore) || atIndex === 0) {
        if (!queryText.includes(" ")) {
          if (!mentions) return;
          if (mentionQuery === null && projectId) {
            // Just started a mention — fetch team fresh
            fetchTeam();
          }
          setMentionStart(atIndex);
          setMentionQuery(queryText);
          return;
        }
      }
    }

    // No active mention
    if (mentionQuery !== null) {
      closeMention();
    }
  };

  /**
   * Turn the displayed `@Name` back into the `@[Name](id)` token the provider
   * layer rewrites into provider-native mention markup.
   *
   * Matching is longest-name-first because display names contain spaces and one
   * can prefix another ("Dele" vs "Dele Tosh") — shortest-first would match the
   * prefix and strand the remainder. A name the user edited after picking it no
   * longer matches, and is left as plain text: it posts as typed rather than
   * linking the wrong person.
   */
  const serializeMentions = (raw: string) => {
    const byLongestName = [...mentioned].sort(
      (a, b) => b.name.length - a.name.length
    );
    let out = "";
    let i = 0;
    outer: while (i < raw.length) {
      if (raw[i] === "@") {
        for (const m of byLongestName) {
          if (raw.startsWith(m.name, i + 1)) {
            out += `@[${m.name}](${m.id})`;
            i += 1 + m.name.length;
            continue outer;
          }
        }
      }
      out += raw[i];
      i += 1;
    }
    return out;
  };

  const handleSubmit = async () => {
    if (!text.trim() || !credentials || submitting) return;

    setSubmitting(true);
    try {
      await postComment(credentials, issueId, serializeMentions(text.trim()));
      showToast("success", isConversation ? `Text sent to ${shownId}` : `Comment posted on ${shownId}`);
      if (activityId && !isRead) {
        await markRead(activityId, accountId);
      }
      onClose();
      await refresh();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      showToast("error", isConversation ? `Text not sent: ${reason}` : `Failed to comment: ${reason}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // If mention dropdown is open, handle navigation
    if (mentionQuery !== null && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  const showDropdown = mentionQuery !== null && (loadingMembers || filtered.length > 0);

  const metaChips = [details?.priority, details?.assignee && `Assignee: ${details.assignee}`].filter(
    (c): c is string => !!c,
  );

  return (
    <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700">
      {/* Context strip: what this reply is going to */}
      <div className="flex items-center gap-1.5 min-w-0 mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="flex-shrink-0">Replying to</span>
        <span className="flex-shrink-0 font-mono font-medium text-blue-600 dark:text-blue-400">
          {shownId}
        </span>
        {fullTitle && (
          <span className="truncate min-w-0 text-gray-900 dark:text-gray-100" title={fullTitle}>
            {fullTitle}
          </span>
        )}
        <span className="flex-1" />
        {details?.state && (
          <span className="flex-shrink-0 rounded px-1 py-[1px] text-[10px] bg-gray-200/70 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
            {details.state}
          </span>
        )}
        {!detailsFailed && (
          <button
            type="button"
            onClick={() => setDetailsOpen(!detailsOpen)}
            aria-expanded={detailsOpen}
            className="flex-shrink-0 text-[10px] font-medium text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
          >
            {detailsOpen ? "Hide \u25B4" : isConversation ? "Thread \u25BE" : "Details \u25BE"}
          </button>
        )}
      </div>

      {/* Conversation thread: the last few texts, both directions */}
      {detailsOpen && !detailsFailed && isConversation && (
        <div className="mb-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs">
          {detailsLoading ? (
            <div className="h-[3.75em] space-y-1.5 pt-0.5" aria-label="Loading conversation">
              {showSkeleton && (
                <>
                  <div className="h-2 rounded bg-gray-200 dark:bg-gray-700 animate-pulse motion-reduce:animate-none" />
                  <div className="h-2 w-4/5 ml-auto rounded bg-gray-200 dark:bg-gray-700 animate-pulse motion-reduce:animate-none" />
                  <div className="h-2 w-3/5 rounded bg-gray-200 dark:bg-gray-700 animate-pulse motion-reduce:animate-none" />
                </>
              )}
            </div>
          ) : details?.thread && details.thread.length > 0 ? (
            <ThreadView messages={details.thread} contactLabel={shownId} />
          ) : (
            <p className="italic text-gray-400 dark:text-gray-500">No messages</p>
          )}
        </div>
      )}

      {/* Details card: full title, description snippet, headline fields */}
      {detailsOpen && !detailsFailed && !isConversation && (
        <div className="mb-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 space-y-1 text-xs">
          {fullTitle && (
            <p className="font-medium text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">
              {fullTitle}
            </p>
          )}
          {detailsLoading ? (
            // Fixed-height slot so the textarea doesn't jump when text lands.
            <div className="h-[3.75em] space-y-1.5 pt-0.5" aria-label="Loading description">
              {showSkeleton && (
                <>
                  <div className="h-2 rounded bg-gray-200 dark:bg-gray-700 animate-pulse motion-reduce:animate-none" />
                  <div className="h-2 rounded bg-gray-200 dark:bg-gray-700 animate-pulse motion-reduce:animate-none" />
                  <div className="h-2 w-3/5 rounded bg-gray-200 dark:bg-gray-700 animate-pulse motion-reduce:animate-none" />
                </>
              )}
            </div>
          ) : snippet ? (
            <div>
              <p
                ref={descRef}
                className={`text-gray-500 dark:text-gray-400 leading-snug ${
                  descExpanded ? "max-h-40 overflow-y-auto" : "line-clamp-3"
                }`}
              >
                {snippet}
              </p>
              {(descOverflows || descExpanded) && (
                <button
                  type="button"
                  onClick={() => setDescExpanded((prev) => !prev)}
                  className="mt-0.5 text-[10px] font-medium text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                >
                  {descExpanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          ) : (
            <p className="italic text-gray-400 dark:text-gray-500">No description</p>
          )}
          {metaChips.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {metaChips.map((chip) => (
                <span
                  key={chip}
                  className="rounded px-1 py-[1px] text-[10px] bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                >
                  {chip}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={isConversation ? `Text ${shownId}...` : `Reply to ${shownId}...`}
          rows={3}
          disabled={submitting}
          className="w-full text-xs bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400 disabled:opacity-50"
        />

        {/* @mention dropdown */}
        {showDropdown && (
          <div
            ref={dropdownRef}
            className="absolute left-0 right-0 bottom-full mb-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg overflow-hidden"
          >
            {loadingMembers && filtered.length === 0 ? (
              <div className="px-2 py-2 text-[10px] text-gray-400 text-center">
                Loading team...
              </div>
            ) : (
              <div className="max-h-36 overflow-y-auto">
                {filtered.map((member, i) => (
                  <button
                    key={member.id}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent textarea blur
                      insertMention(member);
                    }}
                    className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                      i === selectedIndex
                        ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                        : "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    {member.avatarUrl ? (
                      <img
                        src={member.avatarUrl}
                        alt={member.name}
                        className="w-4 h-4 rounded-full flex-shrink-0"
                      />
                    ) : (
                      <div className="w-4 h-4 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-[8px] font-medium text-gray-600 dark:text-gray-300 flex-shrink-0">
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="truncate">{member.name}</span>
                    <span className="text-[10px] text-gray-400 truncate">
                      @{member.login}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-gray-400">
          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to send
          &middot; Esc to cancel
          {mentions && projectId && " \u00b7 @ to mention"}
          {isConversation && " \u00b7 sends via Quo API (uses credits)"}
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-[10px] px-2 py-0.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!text.trim() || submitting}
            className="text-[10px] px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {submitting ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Short clock time for a message, with the date when it isn't today. */
function messageTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * A conversation's recent texts as chat bubbles: theirs on the left, your
 * team's on the right. Scrolled to the newest on open.
 */
function ThreadView({ messages, contactLabel }: { messages: ThreadMessage[]; contactLabel: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Scroll the box itself; scrollIntoView would also move the feed around it.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Incoming authors arrive as phone numbers; in a 1:1 thread the contact's
  // name is already known from the feed.
  const isOneToOne = !contactLabel.includes(",");
  const incomingName = (author: string) =>
    isOneToOne && /^\+?\d[\d\s()-]*$/.test(author) ? contactLabel : author;

  return (
    <div ref={boxRef} className="max-h-48 overflow-y-auto space-y-1.5 pr-0.5">
      {messages.map((m, i) => (
        <div key={i} className={`flex flex-col ${m.outgoing ? "items-end" : "items-start"}`}>
          <div
            className={`max-w-[85%] rounded-lg px-2 py-1 leading-snug whitespace-pre-wrap break-words ${
              m.outgoing
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
            }`}
          >
            {m.text}
          </div>
          <span className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
            {m.outgoing ? m.author : incomingName(m.author)} · {messageTime(m.timestamp)}
            {m.outgoing && m.status === "undelivered" && (
              <span className="text-red-500"> · not delivered</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
