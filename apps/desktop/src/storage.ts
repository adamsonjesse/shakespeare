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
    async readFolder(path: string): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]> {
      const files = await invoke<{ path: string; bytes: number[] }[]>("read_share_folder", { path });
      return files.map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }));
    },
    async readBlob(publicKey: string, hash: string): Promise<Uint8Array | null> {
      const bytes = await invoke<number[] | null>("read_profile_blob", { publicKey, hash });
      return bytes === null ? null : Uint8Array.from(bytes);
    },
    async writeBlob(publicKey: string, hash: string, bytes: Uint8Array): Promise<void> {
      await invoke("write_profile_blob", { publicKey, hash, bytes: [...bytes] });
    },
    async removeBlob(publicKey: string, hash: string): Promise<void> {
      await invoke("remove_profile_blob", { publicKey, hash });
    },
    async writeOutput(publicKey: string, path: string, bytes: Uint8Array): Promise<void> {
      await invoke("write_download", { publicKey, relativePath: path, bytes: [...bytes] });
    },
    async removeOutput(publicKey: string, path: string): Promise<void> {
      await invoke("remove_download", { publicKey, relativePath: path });
    },
    async relayExchange(host: string, port: number, request: string): Promise<string> {
      return invoke<string>("relay_exchange", { host, port, request });
    },
  };
}
