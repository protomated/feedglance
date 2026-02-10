import { load } from "@tauri-apps/plugin-store";
import type { Credentials } from "../types/youtrack";

const STORE_NAME = "credentials.json";
const KEY_URL = "youtrack_url";
const KEY_TOKEN = "youtrack_token";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_NAME);
  }
  return storeInstance;
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const store = await getStore();
  await store.set(KEY_URL, credentials.url);
  await store.set(KEY_TOKEN, credentials.token);
  await store.save();
}

export async function getCredentials(): Promise<Credentials | null> {
  const store = await getStore();
  const url = await store.get<string>(KEY_URL);
  const token = await store.get<string>(KEY_TOKEN);

  if (!url || !token) {
    return null;
  }

  return { url, token };
}

export async function clearCredentials(): Promise<void> {
  const store = await getStore();
  await store.delete(KEY_URL);
  await store.delete(KEY_TOKEN);
  await store.save();
  storeInstance = null;
}
