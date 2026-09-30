import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import type { Account } from "../types/youtrack";

const STORE_NAME = "credentials.json";

// New multi-account key
const KEY_ACCOUNTS = "accounts";

// Legacy single-account keys (for migration)
const LEGACY_KEY_URL = "youtrack_url";
const LEGACY_KEY_TOKEN = "youtrack_token";

/**
 * An account as persisted in `credentials.json`.
 *
 * The token normally lives in the OS credential store (see `secrets.rs`) and is
 * absent here. It is present only for accounts saved by builds before the
 * keychain move — migrated on their next save — or when the credential store
 * is unavailable (Linux without a Secret Service), where it is the fallback.
 */
type StoredAccount = Omit<Account, "token"> & { token?: string };

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

/** Tokens known to be in the keychain, so unchanged ones aren't rewritten on every save. */
const keychainTokens = new Map<string, string>();

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

async function readToken(stored: StoredAccount): Promise<string> {
  if (stored.token) return stored.token;
  try {
    const token = await invoke<string | null>("secret_get", { accountId: stored.id });
    if (token) {
      keychainTokens.set(stored.id, token);
      return token;
    }
  } catch (e) {
    console.warn(`Could not read token for ${stored.id} from the keychain:`, e);
  }
  // No token anywhere: the account loads, fails validation, and the user is
  // asked to update its token.
  return "";
}

/**
 * Move each account's token into the keychain and return what to persist.
 * An account whose token can't be written keeps it in the file instead.
 */
async function toStored(accounts: Account[]): Promise<StoredAccount[]> {
  const stored: StoredAccount[] = [];
  for (const account of accounts) {
    const { token, ...rest } = account;
    // A legacy account has no ID until the auth store derives one; there is
    // nothing stable to key its keychain entry on yet.
    if (!account.id || !token) {
      stored.push(account.id ? rest : account);
      continue;
    }
    if (keychainTokens.get(account.id) === token) {
      stored.push(rest);
      continue;
    }
    try {
      await invoke("secret_set", { accountId: account.id, token });
      keychainTokens.set(account.id, token);
      stored.push(rest);
    } catch (e) {
      console.warn(`Keychain unavailable, keeping token for ${account.id} in credentials.json:`, e);
      stored.push(account);
    }
  }
  return stored;
}

async function deleteToken(accountId: string): Promise<void> {
  keychainTokens.delete(accountId);
  try {
    await invoke("secret_delete", { accountId });
  } catch (e) {
    console.warn(`Could not delete keychain token for ${accountId}:`, e);
  }
}

/** Persist the full accounts list, dropping keychain tokens of accounts no longer in it. */
async function writeAccounts(accounts: Account[]): Promise<void> {
  const store = await getStore();
  const previous = (await store.get<StoredAccount[]>(KEY_ACCOUNTS)) ?? [];
  await store.set(KEY_ACCOUNTS, await toStored(accounts));
  await store.save();

  // After the save, so a crash between the two leaves an orphaned keychain
  // entry rather than an account without its token. Covers removal and the
  // ID change the auth store makes when it re-tags an account's provider.
  const kept = new Set(accounts.map((a) => a.id));
  for (const old of previous) {
    if (old.id && !kept.has(old.id)) await deleteToken(old.id);
  }
}

/**
 * Get all stored accounts with their tokens, migrating from legacy
 * single-account format if needed.
 */
export async function getAccounts(): Promise<Account[]> {
  const store = await getStore();
  const accounts = await store.get<StoredAccount[]>(KEY_ACCOUNTS);
  if (accounts && accounts.length > 0) {
    return Promise.all(accounts.map(async (a) => ({ ...a, token: await readToken(a) })));
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
  const accounts = await getAccounts();
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    accounts[idx] = account;
  } else {
    accounts.push(account);
  }
  await writeAccounts(accounts);

  // Clean up legacy keys if they still exist
  await cleanupLegacyKeys(await getStore());
}

/** Remove an account by id, including its keychain token. */
export async function removeAccount(accountId: string): Promise<void> {
  const accounts = await getAccounts();
  await writeAccounts(accounts.filter((a) => a.id !== accountId));
  await deleteToken(accountId);
}

/** Save the full accounts array (used during migration/initialization). */
export async function saveAllAccounts(accounts: Account[]): Promise<void> {
  await writeAccounts(accounts);
  await cleanupLegacyKeys(await getStore());
}

async function cleanupLegacyKeys(store: Awaited<ReturnType<typeof load>>) {
  try {
    await store.delete(LEGACY_KEY_URL);
    await store.delete(LEGACY_KEY_TOKEN);
  } catch {
    // Ignore — keys may not exist
  }
}
