import { registerPlugin } from "@capacitor/core";
import { bytesToHex, hexToBytes, type SqlExecutor, type SqlValue } from "@shakespeare/core";
import type { ProfileHost } from "./session.ts";

interface ShakespeareBridge {
  profileList(): Promise<{ profiles: string[] }>;
  profileOpen(options: { publicKey: string }): Promise<void>;
  dbExecute(options: { sql: string; params: SqlValue[] }): Promise<void>;
  dbSelect(options: { sql: string; params: SqlValue[] }): Promise<{ rows: Record<string, SqlValue>[] }>;
  keystoreSave(options: { publicKey: string; privateKey: string }): Promise<void>;
  keystoreLoad(options: { publicKey: string }): Promise<{ privateKey: string | null }>;
  readShareFolder(options: { path: string }): Promise<{ files: { path: string; bytes: number[] }[] }>;
  readProfileBlob(options: { publicKey: string; hash: string }): Promise<{ bytes: number[] | null }>;
  writeProfileBlob(options: { publicKey: string; hash: string; bytes: number[] }): Promise<void>;
  removeProfileBlob(options: { publicKey: string; hash: string }): Promise<void>;
  writeDownload(options: { publicKey: string; relativePath: string; bytes: number[] }): Promise<void>;
  removeDownload(options: { publicKey: string; relativePath: string }): Promise<void>;
  relayExchange(options: { host: string; port: number; request: string }): Promise<{ response: string }>;
}

const bridge = registerPlugin<ShakespeareBridge>("Shakespeare");

/**
 * Capacitor host. The private key is a sandbox file outside the club database.
 * Folder reads stay inside the app files directory.
 */
export function createMobileHost(): ProfileHost {
  return {
    async listProfiles() {
      const listed = await bridge.profileList();
      return listed.profiles;
    },
    async openProfile(publicKey: string): Promise<SqlExecutor> {
      await bridge.profileOpen({ publicKey });
      return {
        async execute(sql: string, params: readonly SqlValue[] = []) {
          await bridge.dbExecute({ sql, params: [...params] });
        },
        async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
          const selected = await bridge.dbSelect({ sql, params: [...params] });
          return selected.rows as Row[];
        },
      };
    },
    async savePrivateKey(publicKey: string, privateKey: Uint8Array) {
      await bridge.keystoreSave({ publicKey, privateKey: bytesToHex(privateKey) });
    },
    async loadPrivateKey(publicKey: string) {
      const stored = await bridge.keystoreLoad({ publicKey });
      return stored.privateKey === null ? null : hexToBytes(stored.privateKey);
    },
    async readFolder(path: string) {
      const folder = await bridge.readShareFolder({ path });
      return folder.files.map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }));
    },
    async readBlob(publicKey: string, hash: string) {
      const blob = await bridge.readProfileBlob({ publicKey, hash });
      return blob.bytes === null ? null : Uint8Array.from(blob.bytes);
    },
    async writeBlob(publicKey: string, hash: string, bytes: Uint8Array) {
      await bridge.writeProfileBlob({ publicKey, hash, bytes: [...bytes] });
    },
    async removeBlob(publicKey: string, hash: string) {
      await bridge.removeProfileBlob({ publicKey, hash });
    },
    async writeOutput(publicKey: string, path: string, bytes: Uint8Array) {
      await bridge.writeDownload({ publicKey, relativePath: path, bytes: [...bytes] });
    },
    async removeOutput(publicKey: string, path: string) {
      await bridge.removeDownload({ publicKey, relativePath: path });
    },
    async relayExchange(host: string, port: number, request: string) {
      const exchanged = await bridge.relayExchange({ host, port, request });
      return exchanged.response;
    },
  };
}
