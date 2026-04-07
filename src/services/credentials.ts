import { load } from "@tauri-apps/plugin-store";
import type { Account, Credentials } from "../types/youtrack";

const STORE_NAME = "credentials.json";

// New multi-account key
const KEY_ACCOUNTS = "accounts";

// Legacy single-account keys (for migration)
const LEGACY_KEY_URL = "youtrack_url";
const LEGACY_KEY_TOKEN = "youtrack_token";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

/**
 * Get all stored accounts, migrating from legacy single-account format if needed.
 */
export async function getAccounts(): Promise<Account[]> {
  const store = await getStore();
  const accounts = await store.get<Account[]>(KEY_ACCOUNTS);
  if (accounts && accounts.length > 0) {
    return accounts;
  }

  // Attempt legacy migration
  const legacyUrl = await store.get<string>(LEGACY_KEY_URL);
  const legacyToken = await store.get<string>(LEGACY_KEY_TOKEN);
  if (legacyUrl && legacyToken) {
    // We can't generate the full Account here (no user info),
    // so return a partial that the auth store will complete on validation.
    // For migration, we store it as a minimal account; the auth store
    // will fill in user info and save it back.
    return [{ id: "", url: legacyUrl, token: legacyToken, user: null as any }];
  }

  return [];
}

/** Save an account (upsert by id). */
export async function saveAccount(account: Account): Promise<void> {
  const store = await getStore();
  const accounts = (await store.get<Account[]>(KEY_ACCOUNTS)) ?? [];
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    accounts[idx] = account;
  } else {
    accounts.push(account);
  }
  await store.set(KEY_ACCOUNTS, accounts);
  await store.save();

  // Clean up legacy keys if they still exist
  await cleanupLegacyKeys(store);
}

/** Remove an account by id. */
export async function removeAccount(accountId: string): Promise<void> {
  const store = await getStore();
  const accounts = (await store.get<Account[]>(KEY_ACCOUNTS)) ?? [];
  const filtered = accounts.filter((a) => a.id !== accountId);
  await store.set(KEY_ACCOUNTS, filtered);
  await store.save();
}

/** Save the full accounts array (used during migration/initialization). */
export async function saveAllAccounts(accounts: Account[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY_ACCOUNTS, accounts);
  await store.save();
  await cleanupLegacyKeys(store);
}

// --- Backward-compatible shims (used during transition) ---

/** @deprecated Use getAccounts() instead. Returns first account's credentials. */
export async function getCredentials(): Promise<Credentials | null> {
  const accounts = await getAccounts();
  if (accounts.length === 0) return null;
  const first = accounts[0];
  return { url: first.url, token: first.token };
}

/** @deprecated Use saveAccount() instead. */
export async function saveCredentials(credentials: Credentials): Promise<void> {
  // This is only called from legacy code paths; for now, update the first account's token
  const store = await getStore();
  const accounts = (await store.get<Account[]>(KEY_ACCOUNTS)) ?? [];
  if (accounts.length > 0) {
    accounts[0].url = credentials.url;
    accounts[0].token = credentials.token;
    await store.set(KEY_ACCOUNTS, accounts);
    await store.save();
  } else {
    // Fallback to legacy keys
    await store.set(LEGACY_KEY_URL, credentials.url);
    await store.set(LEGACY_KEY_TOKEN, credentials.token);
    await store.save();
  }
}

/** @deprecated Use removeAccount() for individual accounts. */
export async function clearCredentials(): Promise<void> {
  const store = await getStore();
  await store.delete(KEY_ACCOUNTS);
  await store.delete(LEGACY_KEY_URL);
  await store.delete(LEGACY_KEY_TOKEN);
  await store.save();
  storeInstance = null;
}

async function cleanupLegacyKeys(store: Awaited<ReturnType<typeof load>>) {
  try {
    await store.delete(LEGACY_KEY_URL);
    await store.delete(LEGACY_KEY_TOKEN);
  } catch {
    // Ignore — keys may not exist
  }
}
