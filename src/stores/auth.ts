import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Account, UserInfo } from "../types/youtrack";
import {
  getAccounts,
  saveAccount,
  removeAccount as removeAccountFromStore,
  saveAllAccounts,
} from "../services/credentials";
import { generateAccountId, labelFromUrl } from "../utils/account";

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
  addAccount: (url: string, token: string) => Promise<Account>;
  removeAccount: (accountId: string) => Promise<void>;
  updateToken: (accountId: string, newToken: string) => Promise<void>;
  checkHealth: (accountId?: string) => Promise<boolean>;
  /** @deprecated Use addAccount. Kept for Onboarding backward compat during transition. */
  connect: (url: string, token: string) => Promise<UserInfo>;
  /** @deprecated Use removeAccount for each. Clears all accounts. */
  disconnect: () => Promise<void>;

  /** Get an account by ID. */
  getAccount: (accountId: string) => Account | undefined;
  /** Get credentials for a specific account. */
  getAccountCredentials: (accountId: string) => { url: string; token: string } | null;
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
      try {
        const user = await invoke<UserInfo>("validate_connection", {
          url: raw.url,
          token: raw.token,
        });
        const id = raw.id || (await generateAccountId(raw.url));
        const account: Account = {
          id,
          url: raw.url,
          token: raw.token,
          user,
          label: raw.label || labelFromUrl(raw.url),
        };
        validAccounts.push(account);
        newStatuses[id] = "connected";
        newErrors[id] = null;
      } catch (e) {
        const id = raw.id || (await generateAccountId(raw.url));
        // Keep the account even if validation fails
        const account: Account = {
          id,
          url: raw.url,
          token: raw.token,
          user: raw.user,
          label: raw.label || labelFromUrl(raw.url),
        };
        validAccounts.push(account);
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

  addAccount: async (url: string, token: string) => {
    const statuses = { ...get().connectionStatuses };
    const id = await generateAccountId(url);

    // Check for duplicate
    if (get().accounts.some((a) => a.id === id)) {
      throw new Error("This YouTrack instance is already connected.");
    }

    statuses[id] = "connecting";
    set({ connectionStatuses: statuses });

    const user = await invoke<UserInfo>("validate_connection", { url, token });

    const account: Account = {
      id,
      url,
      token,
      user,
      label: labelFromUrl(url),
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

    const user = await invoke<UserInfo>("validate_connection", {
      url: account.url,
      token: newToken,
    });

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
        const ok = await invoke<boolean>("check_connection", {
          url: account.url,
          token: account.token,
        });
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
  connect: async (url: string, token: string) => {
    const account = await get().addAccount(url, token);
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
