import { useEffect } from "react";

interface Props {
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "j / \u2193", description: "Move focus down" },
  { keys: "k / \u2191", description: "Move focus up" },
  { keys: "o", description: "Open in browser" },
  { keys: "r", description: "Reply to issue" },
  { keys: "s", description: "Change status" },
  { keys: "a", description: "Assign issue" },
  { keys: "e", description: "Mark as read" },
  { keys: "Shift + e", description: "Mark all as read" },
  { keys: "Escape", description: "Clear focus / close" },
  { keys: "?", description: "Toggle this help" },
];

export function KeyboardShortcutHelp({ onClose }: Props) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Use capture phase so this fires before the keyboard navigation hook
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 w-72 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-2">
          {SHORTCUTS.map(({ keys, description }) => (
            <div
              key={keys}
              className="flex items-center justify-between py-1.5 text-xs"
            >
              <span className="text-gray-600 dark:text-gray-400">
                {description}
              </span>
              <kbd className="ml-4 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono text-[10px] border border-gray-200 dark:border-gray-600 whitespace-nowrap">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
