import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Account, ProviderKind, UserInfo } from "../types/youtrack";
import {
  getAccounts,
  saveAccount,
  removeAccount as removeAccountFromStore,
  saveAllAccounts,
} from "../services/credentials";
import { generateAccountId, inferProvider, labelForAccount } from "../utils/account";

/**
 * Validate credentials for any provider and return normalized user info.
 *
 * YouTrack returns a full profile; Nifty's provider-agnostic `validate_provider`
 * returns only a user ID, so the remaining fields are filled from what we have.
 * Both paths must produce a `UserInfo` because the whole UI renders one.
 */
async function validateAccount(
  provider: ProviderKind,
  url: string,
  token: string,
): Promise<UserInfo> {
  if (provider === "youtrack") {
    return invoke<UserInfo>("validate_connection", { url, token });
  }
  const id = await invoke<string>("validate_provider", {
    provider,
    url,
    token,
  });
  return { id, login: id, fullName: "", email: "", avatarUrl: "" };
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface AuthState {
  /** All configured accounts. */
  accounts: Account[];
  /** Per-account connection status keyed by account ID. */
  connectionStatuses: Record<string, ConnectionStatus>;
  /** Per-account error messages. */
  errors: Record<string, string | null>;
  /** Per-account consecutive failure counts. */
  consecutiveFailures: Record<string, number>;

  // Derived convenience getters
  /** True if at least one account exists. */
  hasAccounts: boolean;
  /** The "worst" connection status across all accounts (for backward compat). */
  connectionStatus: ConnectionStatus;
  /** First account's credentials (backward compat shim). */
  credentials: { url: string; token: string } | null;
  /** First account's user info (backward compat shim). */
  user: UserInfo | null;

  // Actions
  initialize: () => Promise<void>;
  addAccount: (url: string, token: string, provider?: ProviderKind) => Promise<Account>;
  removeAccount: (accountId: string) => Promise<void>;
  updateToken: (accountId: string, newToken: string) => Promise<void>;
  /** Set a user-chosen display name. An empty value restores the default. */
  renameAccount: (accountId: string, label: string) => Promise<void>;
  checkHealth: (accountId?: string) => Promise<boolean>;
  /** @deprecated Use addAccount. Kept for Onboarding backward compat during transition. */
  connect: (url: string, token: string, provider?: ProviderKind) => Promise<UserInfo>;
  /** @deprecated Use removeAccount for each. Clears all accounts. */
  disconnect: () => Promise<void>;

  /** Get an account by ID. */
  getAccount: (accountId: string) => Account | undefined;
  /** Get credentials for a specific account. */
  getAccountCredentials: (accountId: string) => { url: string; token: string } | null;
  /**
   * Credentials plus the provider tag, for quick actions.
   *
   * Falls back to the first account so single-account callers that pass no ID
   * keep working, matching getAccountCredentials' legacy behaviour.
   */
  getActionAccount: (
    accountId?: string,
  ) => { url: string; token: string; provider: ProviderKind } | null;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accounts: [],
  connectionStatuses: {},
  errors: {},
  consecutiveFailures: {},

  // Derived values (recomputed on set calls)
  hasAccounts: false,
  connectionStatus: "disconnected",
  credentials: null,
  user: null,

  initialize: async () => {
    const rawAccounts = await getAccounts();
    if (rawAccounts.length === 0) {
      set({
        accounts: [],
        hasAccounts: false,
        connectionStatus: "disconnected",
        credentials: null,
        user: null,
      });
      return;
    }

    // Set connecting state for all accounts
    const statuses: Record<string, ConnectionStatus> = {};
    for (const a of rawAccounts) {
      statuses[a.id || a.url] = "connecting";
    }
    set({ connectionStatuses: statuses });

    // Validate each account
    const validAccounts: Account[] = [];
    const newStatuses: Record<string, ConnectionStatus> = {};
    const newErrors: Record<string, string | null> = {};

    for (const raw of rawAccounts) {
      // Accounts saved before multi-provider support carry no tag, and ones
      // added through the pre-picker Settings form carry a wrong one. Infer
      // from the token rather than trusting the stored value.
      const provider: ProviderKind = inferProvider(raw);
      const retagged = provider !== (raw.provider ?? "youtrack");
      // A corrected provider changes the ID's derivation (Nifty hashes the
      // token, YouTrack the URL), so the stored ID is stale and must be
      // regenerated or the account would keep its YouTrack-derived identity.
      const id =
        retagged || !raw.id
          ? await generateAccountId(raw.url, provider, raw.token)
          : raw.id;
      try {
        const user = await validateAccount(provider, raw.url, raw.token);
        validAccounts.push({
          id,
          url: raw.url,
          token: raw.token,
          user,
          provider,
          label:
            raw.label || labelForAccount(raw.url, provider, user.fullName || user.login),
        });
        newStatuses[id] = "connected";
        newErrors[id] = null;
      } catch (e) {
        // Keep the account even if validation fails — the user may be offline,
        // and dropping it would silently lose their configuration.
        validAccounts.push({
          id,
          url: raw.url,
          token: raw.token,
          user: raw.user,
          provider,
          label: raw.label || labelForAccount(raw.url, provider, raw.user?.fullName),
        });
        newStatuses[id] = "error";
        newErrors[id] = e instanceof Error ? e.message : String(e);
      }
    }

    // Save migrated/updated accounts
    await saveAllAccounts(validAccounts);

    const first = validAccounts[0];
    const overallStatus = deriveOverallStatus(newStatuses);

    set({
      accounts: validAccounts,
      connectionStatuses: newStatuses,
      errors: newErrors,
      consecutiveFailures: {},
      hasAccounts: validAccounts.length > 0,
      connectionStatus: overallStatus,
      credentials: first ? { url: first.url, token: first.token } : null,
      user: first?.user ?? null,
    });
  },

  addAccount: async (url: string, token: string, provider: ProviderKind = "youtrack") => {
    const statuses = { ...get().connectionStatuses };
    const id = await generateAccountId(url, provider, token);

    // Check for duplicate
    if (get().accounts.some((a) => a.id === id)) {
      throw new Error(
        provider === "nifty"
          ? "This Nifty workspace is already connected."
          : "This YouTrack instance is already connected.",
      );
    }

    statuses[id] = "connecting";
    set({ connectionStatuses: statuses });

    const user = await validateAccount(provider, url, token);

    const account: Account = {
      id,
      url,
      token,
      user,
      provider,
      label: labelForAccount(url, provider, user.fullName || user.login),
    };

    await saveAccount(account);

    const accounts = [...get().accounts, account];
    const newStatuses = { ...get().connectionStatuses, [id]: "connected" as ConnectionStatus };
    const newErrors = { ...get().errors, [id]: null };
    const first = accounts[0];

    set({
      accounts,
      connectionStatuses: newStatuses,
      errors: newErrors,
      hasAccounts: true,
      connectionStatus: deriveOverallStatus(newStatuses),
      credentials: first ? { url: first.url, token: first.token } : null,
      user: first?.user ?? null,
    });

    return account;
  },

  removeAccount: async (accountId: string) => {
    await removeAccountFromStore(accountId);
    await invoke("remove_account", { accountId });

    const accounts = get().accounts.filter((a) => a.id !== accountId);
    const statuses = { ...get().connectionStatuses };
    const errors = { ...get().errors };
    const failures = { ...get().consecutiveFailures };
    delete statuses[accountId];
    delete errors[accountId];
    delete failures[accountId];

    const first = accounts[0];

    set({
      accounts,
      connectionStatuses: statuses,
      errors,
      consecutiveFailures: failures,
      hasAccounts: accounts.length > 0,
      connectionStatus: accounts.length > 0 ? deriveOverallStatus(statuses) : "disconnected",
      credentials: first ? { url: first.url, token: first.token } : null,
      user: first?.user ?? null,
    });
  },

  updateToken: async (accountId: string, newToken: string) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");

    const user = await validateAccount(
      account.provider ?? "youtrack",
      account.url,
      newToken,
    );

    const updated: Account = { ...account, token: newToken, user };
    await saveAccount(updated);

    const accounts = get().accounts.map((a) => (a.id === accountId ? updated : a));
    const newStatuses = { ...get().connectionStatuses, [accountId]: "connected" as ConnectionStatus };
    const first = accounts[0];

    set({
      accounts,
      connectionStatuses: newStatuses,
      errors: { ...get().errors, [accountId]: null },
      consecutiveFailures: { ...get().consecutiveFailures, [accountId]: 0 },
      connectionStatus: deriveOverallStatus(newStatuses),
      credentials: first ? { url: first.url, token: first.token } : null,
      user: first?.user ?? null,
    });
  },

  renameAccount: async (accountId: string, label: string) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");

    const trimmed = label.trim();
    const updated: Account = {
      ...account,
      // Clearing the name falls back to the derived default rather than
      // leaving the row blank.
      label:
        trimmed ||
        labelForAccount(
          account.url,
          account.provider,
          account.user?.fullName || account.user?.login,
        ),
    };
    await saveAccount(updated);

    set({
      accounts: get().accounts.map((a) => (a.id === accountId ? updated : a)),
    });
  },

  checkHealth: async (accountId?: string) => {
    const { accounts } = get();
    if (accounts.length === 0) return false;

    // If no accountId, check all accounts
    const toCheck = accountId
      ? accounts.filter((a) => a.id === accountId)
      : accounts;

    let allOk = true;
    const newStatuses = { ...get().connectionStatuses };
    const newErrors = { ...get().errors };
    const newFailures = { ...get().consecutiveFailures };

    for (const account of toCheck) {
      try {
        // `check_connection` is YouTrack-only; other providers validate through
        // the shared provider path.
        let ok: boolean;
        if ((account.provider ?? "youtrack") === "youtrack") {
          ok = await invoke<boolean>("check_connection", {
            url: account.url,
            token: account.token,
          });
        } else {
          ok = await validateAccount(account.provider!, account.url, account.token)
            .then(() => true)
            .catch(() => false);
        }
        if (ok) {
          newStatuses[account.id] = "connected";
          newErrors[account.id] = null;
          newFailures[account.id] = 0;
        } else {
          const f = (newFailures[account.id] || 0) + 1;
          newStatuses[account.id] = "error";
          newErrors[account.id] = "Connection check failed";
          newFailures[account.id] = f;
          allOk = false;
        }
      } catch (e) {
        const f = (newFailures[account.id] || 0) + 1;
        newStatuses[account.id] = "error";
        newErrors[account.id] = e instanceof Error ? e.message : String(e);
        newFailures[account.id] = f;
        allOk = false;
      }
    }

    set({
      connectionStatuses: newStatuses,
      errors: newErrors,
      consecutiveFailures: newFailures,
      connectionStatus: deriveOverallStatus(newStatuses),
    });

    return allOk;
  },

  // Backward-compat shim: delegates to addAccount
  connect: async (url: string, token: string, provider: ProviderKind = "youtrack") => {
    const account = await get().addAccount(url, token, provider);
    return account.user;
  },

  // Backward-compat shim: removes all accounts
  disconnect: async () => {
    const { accounts } = get();
    for (const a of accounts) {
      await removeAccountFromStore(a.id);
      await invoke("remove_account", { accountId: a.id });
    }
    set({
      accounts: [],
      connectionStatuses: {},
      errors: {},
      consecutiveFailures: {},
      hasAccounts: false,
      connectionStatus: "disconnected",
      credentials: null,
      user: null,
    });
  },

  getAccount: (accountId: string) => {
    return get().accounts.find((a) => a.id === accountId);
  },

  getAccountCredentials: (accountId: string) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return null;
    return { url: account.url, token: account.token };
  },

  getActionAccount: (accountId?: string) => {
    const { accounts } = get();
    const account = accountId
      ? accounts.find((a) => a.id === accountId)
      : accounts[0];
    if (!account) return null;
    return {
      url: account.url,
      token: account.token,
      provider: account.provider ?? "youtrack",
    };
  },
}));

/** Derive an overall connection status from per-account statuses. */
function deriveOverallStatus(statuses: Record<string, ConnectionStatus>): ConnectionStatus {
  const values = Object.values(statuses);
  if (values.length === 0) return "disconnected";
  if (values.every((s) => s === "connected")) return "connected";
  if (values.some((s) => s === "connecting")) return "connecting";
  if (values.some((s) => s === "error")) return "error";
  return "disconnected";
}
