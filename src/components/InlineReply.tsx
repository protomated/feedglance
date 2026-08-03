import { useState, useRef, useEffect, useCallback } from "react";
import { useAuthStore } from "../stores/auth";
import { fetchAssignees, postComment, type AssigneeOption } from "../services/actions";
import { useNotificationStore } from "../stores/notifications";
import { showToast } from "./Toast";


interface Props {
  issueId: string;
  activityId?: string;
  projectId?: string;
  accountId?: string;
  isRead?: boolean;
  onClose: () => void;
}

export function InlineReply({ issueId, activityId, projectId, accountId, isRead, onClose }: Props) {
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
      showToast("success", `Comment posted on ${issueId}`);
      if (activityId && !isRead) {
        await markRead(activityId, accountId);
      }
      onClose();
      await refresh();
    } catch (e) {
      showToast("error", `Failed to comment: ${e instanceof Error ? e.message : String(e)}`);
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

  return (
    <div className="relative px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={`Reply to ${issueId}...`}
        rows={3}
        disabled={submitting}
        className="w-full text-xs bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400 disabled:opacity-50"
      />

      {/* @mention dropdown */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute left-3 right-3 bottom-full mb-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg overflow-hidden"
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

      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-gray-400">
          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to send
          &middot; Esc to cancel
          {projectId && " \u00b7 @ to mention"}
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
