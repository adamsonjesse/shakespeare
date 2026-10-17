import { invoke } from "@tauri-apps/api/core";
import { bytesToHex, hexToBytes, type SqlExecutor, type SqlValue } from "@shakespeare/core";
import type { ProfileHost } from "./session.ts";

function createExecutor(): SqlExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
      await invoke("db_execute", { sql, params: [...params] });
    },
    async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
      return invoke<Row[]>("db_select", { sql, params: [...params] });
    },
  };
}

/** Tauri host. Private key bytes cross into the OS keychain and are not written to SQLite. */
export function createTauriHost(): ProfileHost {
  return {
    async listProfiles(): Promise<readonly string[]> {
      return invoke<string[]>("profile_list");
    },
    async openProfile(publicKey: string): Promise<SqlExecutor> {
      await invoke("profile_open", { publicKey });
      return createExecutor();
    },
    async savePrivateKey(publicKey: string, privateKey: Uint8Array): Promise<void> {
      await invoke("keystore_save", { publicKey, privateKey: bytesToHex(privateKey) });
    },
    async loadPrivateKey(publicKey: string): Promise<Uint8Array | null> {
      const stored = await invoke<string | null>("keystore_load", { publicKey });
      return stored === null ? null : hexToBytes(stored);
    },
  };
}
