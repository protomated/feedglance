import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Credentials, UserInfo } from "../types/youtrack";
import {
  saveCredentials,
  getCredentials,
  clearCredentials,
} from "../services/credentials";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface AuthState {
  credentials: Credentials | null;
  user: UserInfo | null;
  connectionStatus: ConnectionStatus;
  error: string | null;
  consecutiveFailures: number;

  // Actions
  initialize: () => Promise<void>;
  connect: (url: string, token: string) => Promise<UserInfo>;
  disconnect: () => Promise<void>;
  checkHealth: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  credentials: null,
  user: null,
  connectionStatus: "disconnected",
  error: null,
  consecutiveFailures: 0,

  initialize: async () => {
    const credentials = await getCredentials();
    if (!credentials) {
      set({ connectionStatus: "disconnected" });
      return;
    }

    set({ credentials, connectionStatus: "connecting" });

    try {
      const user = await invoke<UserInfo>("validate_connection", {
        url: credentials.url,
        token: credentials.token,
      });
      set({ user, connectionStatus: "connected", error: null, consecutiveFailures: 0 });
    } catch (e) {
      set({
        connectionStatus: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  connect: async (url: string, token: string) => {
    set({ connectionStatus: "connecting", error: null });

    try {
      const user = await invoke<UserInfo>("validate_connection", { url, token });
      const credentials = { url, token };
      await saveCredentials(credentials);
      set({
        credentials,
        user,
        connectionStatus: "connected",
        error: null,
        consecutiveFailures: 0,
      });
      return user;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      set({ connectionStatus: "error", error: errorMsg });
      throw new Error(errorMsg);
    }
  },

  disconnect: async () => {
    await clearCredentials();
    set({
      credentials: null,
      user: null,
      connectionStatus: "disconnected",
      error: null,
      consecutiveFailures: 0,
    });
  },

  checkHealth: async () => {
    const { credentials } = get();
    if (!credentials) return false;

    try {
      const ok = await invoke<boolean>("check_connection", {
        url: credentials.url,
        token: credentials.token,
      });
      if (ok) {
        set({ connectionStatus: "connected", error: null, consecutiveFailures: 0 });
      } else {
        const failures = get().consecutiveFailures + 1;
        set({
          connectionStatus: "error",
          consecutiveFailures: failures,
          error: "Connection check failed",
        });
      }
      return ok;
    } catch (e) {
      const failures = get().consecutiveFailures + 1;
      set({
        connectionStatus: "error",
        consecutiveFailures: failures,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  },
}));
