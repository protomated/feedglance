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
