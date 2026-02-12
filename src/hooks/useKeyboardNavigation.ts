import { useCallback, useEffect, useState } from "react";
import type { ActivityItem } from "../types/activity";

export interface KeyboardActions {
  onOpenInBrowser: (activityId: string) => void;
  onReply: (activityId: string) => void;
  onStatus: (activityId: string) => void;
  onAssign: (activityId: string) => void;
  onMarkRead: (activityId: string) => void;
  onMarkAllRead: () => void;
  onToggleHelp: () => void;
}

interface UseKeyboardNavigationReturn {
  focusedIndex: number;
  focusedActivityId: string | null;
  /** Call when the flat activity list changes so the index stays in bounds. */
  setFlatActivities: (activities: ActivityItem[]) => void;
}

/**
 * Hook that provides keyboard navigation for the notification feed.
 *
 * Keybindings:
 *   j / ArrowDown  — move focus down
 *   k / ArrowUp    — move focus up
 *   o              — open focused item in browser
 *   r              — reply to focused item
 *   s              — change status of focused item
 *   a              — assign focused item
 *   e              — mark focused item as read
 *   Shift+e        — mark all as read
 *   ?              — toggle shortcut help overlay
 *   Escape         — clear focus
 */
export function useKeyboardNavigation(
  actions: KeyboardActions,
): UseKeyboardNavigationReturn {
  const [flatActivities, setFlatActivities] = useState<ActivityItem[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const focusedActivityId =
    focusedIndex >= 0 && focusedIndex < flatActivities.length
      ? flatActivities[focusedIndex].id
      : null;

  // Keep index in bounds when the list shrinks
  useEffect(() => {
    if (focusedIndex >= flatActivities.length) {
      setFocusedIndex(Math.max(flatActivities.length - 1, -1));
    }
  }, [flatActivities.length, focusedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't capture keys when user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const len = flatActivities.length;
      if (len === 0 && e.key !== "?" && !(e.key === "E" && e.shiftKey)) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, len - 1));
          break;

        case "k":
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          break;

        case "Escape":
          e.preventDefault();
          setFocusedIndex(-1);
          break;

        case "o": {
          if (focusedActivityId) {
            e.preventDefault();
            actions.onOpenInBrowser(focusedActivityId);
          }
          break;
        }

        case "r": {
          if (focusedActivityId) {
            e.preventDefault();
            actions.onReply(focusedActivityId);
          }
          break;
        }

        case "s": {
          if (focusedActivityId) {
            e.preventDefault();
            actions.onStatus(focusedActivityId);
          }
          break;
        }

        case "a": {
          if (focusedActivityId) {
            e.preventDefault();
            actions.onAssign(focusedActivityId);
          }
          break;
        }

        case "e": {
          e.preventDefault();
          if (focusedActivityId) {
            actions.onMarkRead(focusedActivityId);
          }
          break;
        }

        case "E": {
          if (e.shiftKey) {
            e.preventDefault();
            actions.onMarkAllRead();
          }
          break;
        }

        case "?": {
          e.preventDefault();
          actions.onToggleHelp();
          break;
        }

        default:
          break;
      }
    },
    [flatActivities, focusedActivityId, actions],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Scroll the focused element into view
  useEffect(() => {
    if (focusedActivityId) {
      const el = document.querySelector(`[data-activity-id="${focusedActivityId}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedActivityId]);

  return {
    focusedIndex,
    focusedActivityId,
    setFlatActivities,
  };
}
