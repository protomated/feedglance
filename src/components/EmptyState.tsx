interface EmptyStateProps {
  loading: boolean;
  readCount?: number;
  onShowRead?: () => void;
}

export function EmptyState({ loading, readCount = 0, onShowRead }: EmptyStateProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-gray-400 dark:text-gray-500 animate-pulse">
          Loading notifications...
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="text-center">
        <svg
          className="mx-auto mb-3 text-green-500 dark:text-green-400"
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
          All caught up!
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          No unread notifications.
        </p>
        {readCount > 0 && onShowRead && (
          <button
            onClick={onShowRead}
            className="mt-4 px-4 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700/60 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors"
          >
            Show read activity ({readCount})
          </button>
        )}
      </div>
    </div>
  );
}
