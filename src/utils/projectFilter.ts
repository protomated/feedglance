import type { ActivityItem } from "../types/activity";
import type { EventKind } from "../types/event";

/**
 * Project-filter key helpers.
 *
 * Project chips used to be keyed by bare project key (`PRTSITE`, or for Nifty a
 * full project name like `Editorial - Articles`). That key is only unique within
 * one account: two providers name their projects on entirely different schemes,
 * and nothing stops two accounts from sharing a short name.
 *
 * The practical failure: selecting YouTrack chips and then adding a Nifty
 * account silently hid every Nifty event, because a filter of YouTrack short
 * names could never match a Nifty project name. The filter looked like it was
 * off — no Nifty chip was lit — while dropping all of that account's events.
 *
 * Keys are therefore scoped by account (`{accountId}::{projectKey}`) so a
 * selection only ever constrains the account it was made in. Events from an
 * account with no chips selected are unfiltered, which is what makes adding a
 * new account non-destructive.
 */

/** Separator chosen to not collide with provider project keys or account IDs. */
const SEP = "::";

/** Bare project key for an activity, unique only within its own account. */
export function resolveProjectKey(activity: ActivityItem): string {
  const t = activity.target;
  if (!t) return "unknown";
  const p = t.project ?? t.issue?.project ?? t.article?.project;
  return p?.shortName ?? p?.id ?? "unknown";
}

/** Human-readable project name for an activity. */
export function resolveProjectName(activity: ActivityItem): string {
  const t = activity.target;
  if (!t) return "unknown";
  const p = t.project ?? t.issue?.project ?? t.article?.project;
  return p?.name ?? p?.shortName ?? p?.id ?? "unknown";
}

/** Build the account-scoped key a chip is stored under. */
export function scopedProjectKey(accountId: string | undefined, projectKey: string): string {
  return `${accountId ?? ""}${SEP}${projectKey}`;
}

/** The scoped key for an activity, used when filtering. */
export function activityProjectKey(activity: ActivityItem): string {
  return scopedProjectKey(activity.accountId, resolveProjectKey(activity));
}

/** Account ID a scoped key belongs to, or "" for a legacy unscoped key. */
export function accountIdOfScopedKey(key: string): string {
  const i = key.indexOf(SEP);
  return i === -1 ? "" : key.slice(0, i);
}

/** Bare project key from a scoped key; returns it unchanged if unscoped. */
export function projectKeyOfScopedKey(key: string): string {
  const i = key.indexOf(SEP);
  return i === -1 ? key : key.slice(i + SEP.length);
}

/**
 * Does this activity pass the project filter?
 *
 * Selections are per-account: an account with no chips selected is unfiltered,
 * so chips chosen for one account never suppress another's events.
 */
export function passesProjectFilter(
  activity: ActivityItem,
  selectedProjects: Set<string>,
): boolean {
  if (selectedProjects.size === 0) return true;

  const accountId = activity.accountId ?? "";
  let accountHasSelection = false;
  for (const key of selectedProjects) {
    if (accountIdOfScopedKey(key) === accountId) {
      accountHasSelection = true;
      break;
    }
  }
  if (!accountHasSelection) return true;

  return selectedProjects.has(activityProjectKey(activity));
}

/**
 * Does this activity pass the event-kind filter?
 *
 * Keyed on `kind` rather than the legacy `category.id`, which cannot express
 * the distinction: assignments, status changes and uncategorized updates all
 * collapse into `CustomFieldCategory`, so a category-based filter could never
 * separate "assigned to me" from "someone moved a deadline".
 *
 * Shared by the feed and the unread badge, which must agree exactly — when they
 * drifted, the tray counted events the feed was not showing.
 *
 * An activity with no `kind` predates the field (restored from cache); it is
 * kept rather than hidden, since silently dropping cached events looks like
 * data loss.
 */
export function passesKindFilter(
  activity: ActivityItem,
  selectedKinds: Set<EventKind>,
): boolean {
  if (selectedKinds.size === 0) return true;
  if (!activity.kind) return true;
  return selectedKinds.has(activity.kind);
}

/**
 * Upgrade legacy unscoped keys to account-scoped ones.
 *
 * Stored selections predating scoping are bare project keys. Dropping them
 * would silently reset the user's filters; keeping them unscoped would keep
 * hiding other accounts' events. Each is bound to the accounts that actually
 * have a project by that key, which reproduces the intended selection.
 *
 * A key matching no known account is discarded — it refers to a project or
 * account that no longer exists, and leaving it in would filter against a
 * project nothing can match.
 */
export function migrateLegacyProjectKeys(
  stored: string[],
  knownKeysByAccount: Map<string, Set<string>>,
): Set<string> {
  const out = new Set<string>();
  for (const key of stored) {
    if (key.includes(SEP)) {
      out.add(key);
      continue;
    }
    for (const [accountId, keys] of knownKeysByAccount) {
      if (keys.has(key)) out.add(scopedProjectKey(accountId, key));
    }
  }
  return out;
}
