export function EmptyState({ loading }: { loading: boolean }) {
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
        <p className="text-sm text-gray-500 dark:text-gray-400">
          All caught up!
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Notifications will appear here.
        </p>
      </div>
    </div>
  );
}
