import { toPlainSnippet } from "../utils/plainText";

/** An unsent reply whose box is closed, and the thread it belongs to. */
export interface DraftThread {
  threadKey: string;
  /** The subject as the feed labels it (`PROJ-142`, a contact). */
  label: string;
  title?: string;
  text: string;
  updatedAt: number;
}

interface Props {
  /** Newest first. */
  drafts: DraftThread[];
  onOpen: (threadKey: string) => void;
}

/**
 * Unsent replies, pinned above the feed so one is never more than a click
 * away, whatever the view or filters are hiding.
 */
export function DraftsStrip({ drafts, onOpen }: Props) {
  const single = drafts.length === 1 ? drafts[0] : null;

  return (
    <div className="flex items-center gap-1.5 min-w-0 px-3 py-1 text-[11px] bg-amber-50/70 dark:bg-amber-900/10 border-b border-amber-100 dark:border-amber-900/40">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0 text-amber-600 dark:text-amber-400">
        <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Zm-2.677 2.32L3.25 11.31a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.5-6.5Z" />
      </svg>
      <span className="flex-shrink-0 font-medium text-amber-700 dark:text-amber-400">
        {single ? "Draft" : `${drafts.length} drafts`}
      </span>
      {single ? (
        <button
          onClick={() => onOpen(single.threadKey)}
          title={`Continue your reply: ${toPlainSnippet(single.text)}`}
          className="flex items-center gap-1 min-w-0 text-left hover:underline"
        >
          <span className="flex-shrink-0 font-mono font-medium text-blue-600 dark:text-blue-400">
            {single.label}
          </span>
          <span className="truncate text-gray-500 dark:text-gray-400">
            {toPlainSnippet(single.text)}
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {drafts.map((d) => (
            <button
              key={d.threadKey}
              onClick={() => onOpen(d.threadKey)}
              title={`${d.title ? `${d.title}\n` : ""}Continue your reply: ${toPlainSnippet(d.text)}`}
              className="flex-shrink-0 rounded-full border border-amber-300 dark:border-amber-700 px-1.5 font-mono font-medium leading-4 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
