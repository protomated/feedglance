/**
 * Provider-agnostic quick actions (Epic 3).
 *
 * Mirrors the `ActionSource` trait in `src-tauri/src/provider/actions.rs`. The
 * feed components call these instead of invoking YouTrack-specific commands, so
 * reply/status/assign work identically on every provider.
 *
 * Note the ID contract: `itemId` must be the provider-native ID
 * (`NormalizedEvent.subject.id`), never the human-facing `displayId`. YouTrack
 * happens to accept `PROJ-123` in commands, but Nifty needs its opaque task ID.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Account, ProviderKind } from "../types/youtrack";

export interface StatusOption {
  id: string;
  name: string;
  isResolved: boolean;
}

export interface AssigneeOption {
  id: string;
  login: string;
  name: string;
  avatarUrl: string;
}

/** Credentials plus the provider tag, as every action command expects them. */
function argsFor(account: Pick<Account, "url" | "token" | "provider">) {
  return {
    provider: (account.provider ?? "youtrack") as ProviderKind,
    url: account.url,
    token: account.token,
  };
}

export async function postComment(
  account: Pick<Account, "url" | "token" | "provider">,
  itemId: string,
  text: string,
): Promise<void> {
  await invoke("post_item_comment", { ...argsFor(account), itemId, text });
}

export async function fetchStatuses(
  account: Pick<Account, "url" | "token" | "provider">,
  projectId: string,
): Promise<StatusOption[]> {
  return invoke<StatusOption[]>("get_item_statuses", {
    ...argsFor(account),
    projectId,
  });
}

export async function setStatus(
  account: Pick<Account, "url" | "token" | "provider">,
  itemId: string,
  statusId: string,
): Promise<void> {
  await invoke("set_item_status", { ...argsFor(account), itemId, statusId });
}

export async function fetchAssignees(
  account: Pick<Account, "url" | "token" | "provider">,
  projectId: string,
): Promise<AssigneeOption[]> {
  return invoke<AssigneeOption[]>("get_item_assignees", {
    ...argsFor(account),
    projectId,
  });
}

export async function assignItem(
  account: Pick<Account, "url" | "token" | "provider">,
  itemId: string,
  assigneeId: string,
): Promise<void> {
  await invoke("assign_item", { ...argsFor(account), itemId, assigneeId });
}

export interface ItemDetails {
  title?: string | null;
  /** Raw Markdown source; flatten with `toPlainSnippet` before display. */
  description?: string | null;
  state?: string | null;
  priority?: string | null;
  assignee?: string | null;
}

/**
 * In-flight and settled detail lookups, keyed by provider host + item.
 *
 * Holding the promise (not the result) lets a hover prefetch and the reply box
 * opening a moment later share one request. Session-scoped on purpose: the
 * snippet is context, not a source of truth, so a stale description until the
 * next launch is acceptable and saves Nifty's shared rate limit.
 */
const detailsCache = new Map<string, Promise<ItemDetails>>();

export function fetchItemDetails(
  account: Pick<Account, "url" | "token" | "provider">,
  itemId: string,
): Promise<ItemDetails> {
  const key = `${account.provider ?? "youtrack"}:${account.url}:${itemId}`;
  let pending = detailsCache.get(key);
  if (!pending) {
    pending = invoke<ItemDetails>("get_item_details", { ...argsFor(account), itemId });
    // Drop failures so a later open can retry instead of caching the error.
    pending.catch(() => detailsCache.delete(key));
    detailsCache.set(key, pending);
  }
  return pending;
}
