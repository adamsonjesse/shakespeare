import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { SqlExecutor } from "./storage.ts";

/**
 * A folder offer is a manifest inside an encrypted event. File bytes live in
 * a content-addressed blob store. A download fetches only the hashes the
 * member selected.
 */

const FILE_MESSAGES = {
  path: "That path is not allowed.",
  hash: "The file hash did not match.",
  missing: "That file is not in the manifest.",
  absent: "The file is missing.",
} as const;

export class FileShareError extends Error {
  constructor(kind: keyof typeof FILE_MESSAGES) {
    super(FILE_MESSAGES[kind]);
    this.name = "FileShareError";
  }
}

export interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly hash: string;
}

export interface FolderManifest {
  readonly label: string;
  readonly files: readonly ManifestFile[];
  readonly folderHash: string;
}

export interface BlobStore {
  read(hash: string): Promise<Uint8Array | null>;
  write(hash: string, bytes: Uint8Array): Promise<void>;
  remove(hash: string): Promise<void>;
}

export interface OutputStore {
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export function assertSharePath(path: string): string {
  if (path.length < 1 || path.length > 200 || hasControlCharacter(path)) throw new FileShareError("path");
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) throw new FileShareError("path");
  if (path.includes("\\")) throw new FileShareError("path");
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new FileShareError("path");
  }
  return segments.join("/");
}

export function buildManifest(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  label: string,
): FolderManifest {
  const name = label.trim();
  if (name.length < 1 || name.length > 80 || hasControlCharacter(name)) throw new FileShareError("path");
  const listed = files.map((file) => {
    const path = assertSharePath(file.path);
    return { path, size: file.bytes.byteLength, hash: bytesToHex(blake3(file.bytes)) };
  });
  listed.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const canonical = listed.map((file) => `${file.path}\n${file.size}\n${file.hash}\n`).join("");
  return { label: name, files: listed, folderHash: bytesToHex(blake3(utf8ToBytes(canonical))) };
}

export function manifestText(manifest: FolderManifest): string {
  return JSON.stringify({
    files: manifest.files,
    folderHash: manifest.folderHash,
    label: manifest.label,
  });
}

export function parseManifest(body: string): FolderManifest | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { files?: unknown; folderHash?: unknown; label?: unknown };
    if (!Array.isArray(record.files) || typeof record.folderHash !== "string" || typeof record.label !== "string") {
      return null;
    }
    const files: ManifestFile[] = [];
    for (const entry of record.files) {
      if (!entry || typeof entry !== "object") return null;
      const file = entry as { path?: unknown; size?: unknown; hash?: unknown };
      if (typeof file.path !== "string" || typeof file.size !== "number" || typeof file.hash !== "string") return null;
      files.push({ path: file.path, size: file.size, hash: file.hash });
    }
    return { label: record.label, files, folderHash: record.folderHash };
  } catch {
    return null;
  }
}

export async function downloadSelected(input: {
  readonly manifest: FolderManifest;
  readonly paths: readonly string[];
  readonly fetchHash: (hash: string) => Promise<Uint8Array>;
  readonly blobs: BlobStore;
  readonly output: OutputStore;
  readonly db?: SqlExecutor;
  readonly eventId?: string;
  readonly now?: string;
}): Promise<void> {
  for (const path of input.paths) {
    const file = input.manifest.files.find((entry) => entry.path === path);
    if (!file) throw new FileShareError("missing");
    if (input.db && input.eventId) {
      await input.db.execute(
        `INSERT INTO download_requests (event_id, path, state) VALUES (?, ?, 'requested')
         ON CONFLICT(event_id, path) DO UPDATE SET state = 'requested'`,
        [input.eventId, path],
      );
    }
    let bytes = await verifiedLocal(input.blobs, file.hash);
    if (!bytes) {
      bytes = await input.fetchHash(file.hash);
      if (bytesToHex(blake3(bytes)) !== file.hash) {
        await input.output.remove(path);
        await input.blobs.remove(file.hash);
        if (input.db && input.eventId) {
          await input.db.execute(
            "UPDATE download_requests SET state = 'rejected' WHERE event_id = ? AND path = ?",
            [input.eventId, path],
          );
        }
        throw new FileShareError("hash");
      }
    }
    await input.blobs.write(file.hash, bytes);
    await input.output.write(path, bytes);
    if (input.db && input.eventId && input.now) {
      await input.db.execute(
        `INSERT INTO blob_index (hash, size, path, verified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET size = excluded.size, path = excluded.path, verified_at = excluded.verified_at`,
        [file.hash, bytes.byteLength, file.hash, input.now],
      );
      await input.db.execute(
        "UPDATE download_requests SET state = 'verified' WHERE event_id = ? AND path = ?",
        [input.eventId, path],
      );
    }
  }
}

async function verifiedLocal(blobs: BlobStore, hash: string): Promise<Uint8Array | null> {
  const stored = await blobs.read(hash);
  if (!stored) return null;
  if (bytesToHex(blake3(stored)) !== hash) return null;
  return stored;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
