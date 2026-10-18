import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  encodeFrame,
  handleDirectRequest,
  handleHubRequest,
  MAX_FRAME,
  readRelayResponse,
  RelayError,
  type HubDb,
  type RelayResponse,
} from "./relay.ts";
import type { SqlExecutor } from "./storage.ts";

const SCHEMA = `
PRAGMA journal_mode = DELETE;
CREATE TABLE IF NOT EXISTS hub_members (
  club_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('creator', 'member')),
  PRIMARY KEY (club_id, public_key)
);
CREATE TABLE IF NOT EXISTS hub_envelopes (
  event_id TEXT PRIMARY KEY NOT NULL,
  club_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  envelope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_blobs (
  club_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (club_id, hash)
);
CREATE TABLE IF NOT EXISTS hub_limits (
  club_id TEXT PRIMARY KEY NOT NULL,
  max_members INTEGER NOT NULL,
  max_blob_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_usage (
  club_id TEXT PRIMARY KEY NOT NULL,
  member_count INTEGER NOT NULL,
  blob_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS published_weights (
  public_key TEXT NOT NULL,
  theme_id TEXT NOT NULL,
  weight INTEGER NOT NULL,
  PRIMARY KEY (public_key, theme_id)
);
`;

/** Example caps from the business note. They are not a price. */
export const EXAMPLE_MAX_MEMBERS = 25;
export const EXAMPLE_MAX_BLOB_BYTES = 10 * 1024 * 1024 * 1024;

export interface HubAdmin {
  readonly clubId: string;
  readonly memberCount: number;
  readonly blobBytes: number;
  readonly members: readonly { readonly publicKey: string; readonly role: "creator" | "member" }[];
  readonly envelopes: readonly { readonly eventId: string; readonly size: number }[];
  readonly blobs: readonly { readonly hash: string; readonly size: number }[];
}

export async function startHub(
  directory: string,
  options: {
    readonly port?: number;
    readonly now?: () => string;
    readonly limits?: { readonly maxMembers?: number; readonly maxBlobBytes?: number };
  } = {},
): Promise<{
  readonly port: number;
  readonly file: string;
  admin: (clubId: string) => HubAdmin;
  close: () => Promise<void>;
}> {
  const limits = resolveLimits(options.limits);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "hub.sqlite");
  const db = new DatabaseSync(file);
  try {
    migrateHub(db, directory, limits);
    const hub = hubDb(db, directory, limits);
    const now = options.now ?? (() => new Date().toISOString());
    const listener = await listenRelay(options.port ?? 0, async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return JSON.stringify({ ok: false, error: "The request is not allowed." });
      }
      return JSON.stringify(await handleHubRequest(hub, parsed, now()));
    });
    let closed = false;
    return {
      port: listener.port,
      file,
      admin: (clubId: string) => readAdmin(db, clubId),
      close: async () => {
        if (closed) return;
        closed = true;
        await listener.close();
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function startDirectPeer(
  db: SqlExecutor,
): Promise<{ readonly port: number; close: () => Promise<void> }> {
  return listenRelay(0, async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return JSON.stringify({ ok: false, error: "The request is not allowed." });
    }
    return JSON.stringify(await handleDirectRequest(db, parsed));
  });
}

export function exchange(port: number, request: unknown): Promise<RelayResponse> {
  const frame = Buffer.from(encodeFrame(JSON.stringify(request)));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new RelayError("unreachable"));
    };
    socket.setTimeout(5000, fail);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > MAX_FRAME || buffer.length < 4 + length) {
        if (length > MAX_FRAME) fail();
        return;
      }
      const text = buffer.subarray(4, 4 + length).toString("utf8");
      settled = true;
      socket.end();
      try {
        resolve(readRelayResponse(JSON.parse(text) as unknown));
      } catch {
        reject(new RelayError("forbidden"));
      }
    });
  });
}

function hubDb(
  db: DatabaseSync,
  directory: string,
  defaults: { readonly maxMembers: number; readonly maxBlobBytes: number },
): HubDb {
  const rememberClub = (clubId: string): void => {
    const existing = db.prepare("SELECT club_id FROM hub_limits WHERE club_id = ?").all(clubId);
    if (existing.length > 0) return;
    db.prepare("INSERT INTO hub_limits (club_id, max_members, max_blob_bytes) VALUES (?, ?, ?)").run(
      clubId,
      defaults.maxMembers,
      defaults.maxBlobBytes,
    );
    db.prepare("INSERT INTO hub_usage (club_id, member_count, blob_bytes) VALUES (?, 0, 0)").run(clubId);
  };
  const storedLimits = (clubId: string): { maxMembers: number; maxBlobBytes: number } => {
    rememberClub(clubId);
    const rows = db.prepare("SELECT max_members, max_blob_bytes FROM hub_limits WHERE club_id = ?").all(clubId) as {
      max_members: number;
      max_blob_bytes: number;
    }[];
    const row = rows[0];
    if (row === undefined) throw new RelayError("forbidden");
    return { maxMembers: row.max_members, maxBlobBytes: row.max_blob_bytes };
  };
  const refreshUsage = (clubId: string): void => {
    db.prepare(
      `UPDATE hub_usage
       SET member_count = (SELECT COUNT(*) FROM hub_members WHERE club_id = ?),
           blob_bytes = (SELECT COALESCE(SUM(size), 0) FROM hub_blobs WHERE club_id = ?)
       WHERE club_id = ?`,
    ).run(clubId, clubId, clubId);
  };
  return {
    async getCreator(clubId: string): Promise<string | null> {
      const rows = db.prepare(
        "SELECT public_key FROM hub_members WHERE club_id = ? AND role = 'creator'",
      ).all(clubId) as { public_key: string }[];
      return rows[0]?.public_key ?? null;
    },
    async listMemberKeys(clubId: string): Promise<readonly string[]> {
      const rows = db.prepare("SELECT public_key FROM hub_members WHERE club_id = ?").all(clubId) as {
        public_key: string;
      }[];
      return rows.map((row) => row.public_key);
    },
    async addMember(clubId, publicKey, role): Promise<"added" | "exists" | "limit"> {
      const present = db.prepare(
        "SELECT public_key FROM hub_members WHERE club_id = ? AND public_key = ?",
      ).all(clubId, publicKey);
      if (present.length > 0) {
        rememberClub(clubId);
        return "exists";
      }
      db.exec("BEGIN");
      try {
        const limits = storedLimits(clubId);
        const counts = db.prepare("SELECT COUNT(*) AS n FROM hub_members WHERE club_id = ?").all(clubId) as {
          n: number;
        }[];
        if ((counts[0]?.n ?? 0) >= limits.maxMembers) {
          db.exec("COMMIT");
          return "limit";
        }
        db.prepare("INSERT INTO hub_members (club_id, public_key, role) VALUES (?, ?, ?)").run(clubId, publicKey, role);
        refreshUsage(clubId);
        db.exec("COMMIT");
        return "added";
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async saveEnvelope(input): Promise<void> {
      db.prepare(
        "INSERT OR IGNORE INTO hub_envelopes (event_id, club_id, received_at, envelope) VALUES (?, ?, ?, ?)",
      ).run(input.eventId, input.clubId, input.receivedAt, input.envelope);
    },
    async listEnvelopes(clubId: string) {
      const rows = db.prepare(
        "SELECT event_id, envelope FROM hub_envelopes WHERE club_id = ? ORDER BY received_at, event_id",
      ).all(clubId) as { event_id: string; envelope: string }[];
      return rows.map((row) => ({ eventId: row.event_id, envelope: row.envelope }));
    },
    async saveBlob(clubId, hash, bytes): Promise<"saved" | "exists" | "limit"> {
      const present = db.prepare("SELECT hash FROM hub_blobs WHERE club_id = ? AND hash = ?").all(clubId, hash);
      if (present.length > 0) return "exists";
      const limits = storedLimits(clubId);
      const sums = db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM hub_blobs WHERE club_id = ?").all(clubId) as {
        n: number;
      }[];
      if ((sums[0]?.n ?? 0) + bytes.byteLength > limits.maxBlobBytes) return "limit";
      const path = blobPath(directory, clubId, hash);
      mkdirSync(dirname(path), { recursive: true });
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO hub_blobs (club_id, hash, bytes, size) VALUES (?, ?, ?, ?)").run(
          clubId,
          hash,
          bytes,
          bytes.byteLength,
        );
        refreshUsage(clubId);
        writeFileSync(path, bytes);
        db.exec("COMMIT");
        return "saved";
      } catch (error) {
        db.exec("ROLLBACK");
        rmSync(path, { force: true });
        throw error;
      }
    },
    async replaceWeights(publicKey, weights): Promise<void> {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM published_weights WHERE public_key = ?").run(publicKey);
        const insert = db.prepare(
          "INSERT INTO published_weights (public_key, theme_id, weight) VALUES (?, ?, ?)",
        );
        for (const row of weights) insert.run(publicKey, row.themeId, row.weight);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async listWeights(publicKey: string) {
      const rows = db.prepare(
        "SELECT theme_id, weight FROM published_weights WHERE public_key = ? ORDER BY theme_id",
      ).all(publicKey) as { theme_id: string; weight: number }[];
      return rows.map((row) => ({ themeId: row.theme_id, weight: row.weight }));
    },
  };
}

export function backupHub(sourceDirectory: string, destinationDirectory: string): void {
  copyHubFiles(sourceDirectory, destinationDirectory, "The backup folder is not empty.");
}

export function restoreHub(backupDirectory: string, destinationDirectory: string): void {
  copyHubFiles(backupDirectory, destinationDirectory, "The restore folder is not empty.");
}

function copyHubFiles(sourceDirectory: string, destinationDirectory: string, occupied: string): void {
  mkdirSync(destinationDirectory, { recursive: true });
  if (readdirSync(destinationDirectory).length > 0) throw new Error(occupied);
  const database = join(sourceDirectory, "hub.sqlite");
  if (!existsSync(database)) throw new Error("The hub file is missing.");
  copyFileSync(database, join(destinationDirectory, "hub.sqlite"));
  const blobs = join(sourceDirectory, "blobs");
  if (existsSync(blobs)) cpSync(blobs, join(destinationDirectory, "blobs"), { recursive: true });
}

function resolveLimits(
  input: { readonly maxMembers?: number; readonly maxBlobBytes?: number } | undefined,
): { maxMembers: number; maxBlobBytes: number } {
  const maxMembers = input?.maxMembers ?? EXAMPLE_MAX_MEMBERS;
  const maxBlobBytes = input?.maxBlobBytes ?? EXAMPLE_MAX_BLOB_BYTES;
  if (!isCap(maxMembers) || !isCap(maxBlobBytes)) throw new RelayError("forbidden");
  return { maxMembers, maxBlobBytes };
}

function isCap(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function migrateHub(
  db: DatabaseSync,
  directory: string,
  defaults: { readonly maxMembers: number; readonly maxBlobBytes: number },
): void {
  if (tableColumns(db, "hub_blobs").length > 0 && !tableColumns(db, "hub_blobs").includes("club_id")) {
    db.exec("ALTER TABLE hub_blobs RENAME TO hub_blobs_legacy");
  }
  db.exec(SCHEMA);
  if (tableColumns(db, "hub_blobs_legacy").length > 0) {
    const clubs = db.prepare("SELECT DISTINCT club_id FROM hub_members").all() as { club_id: string }[];
    const only = clubs.length === 1 ? clubs[0] : undefined;
    if (only !== undefined) {
      const rows = db.prepare("SELECT hash, bytes, size FROM hub_blobs_legacy").all() as {
        hash: string;
        bytes: Uint8Array;
        size: number;
      }[];
      const insert = db.prepare("INSERT INTO hub_blobs (club_id, hash, bytes, size) VALUES (?, ?, ?, ?)");
      for (const row of rows) {
        const bytes = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array();
        insert.run(only.club_id, row.hash, bytes, row.size);
        const path = blobPath(directory, only.club_id, row.hash);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      db.exec("DROP TABLE hub_blobs_legacy");
    }
  }
  const clubs = db.prepare("SELECT DISTINCT club_id FROM hub_members").all() as { club_id: string }[];
  const refresh = db.prepare(
    `UPDATE hub_usage
     SET member_count = (SELECT COUNT(*) FROM hub_members WHERE club_id = ?),
         blob_bytes = (SELECT COALESCE(SUM(size), 0) FROM hub_blobs WHERE club_id = ?)
     WHERE club_id = ?`,
  );
  for (const club of clubs) {
    if (db.prepare("SELECT club_id FROM hub_limits WHERE club_id = ?").all(club.club_id).length === 0) {
      db.prepare("INSERT INTO hub_limits (club_id, max_members, max_blob_bytes) VALUES (?, ?, ?)").run(
        club.club_id,
        defaults.maxMembers,
        defaults.maxBlobBytes,
      );
    }
    if (db.prepare("SELECT club_id FROM hub_usage WHERE club_id = ?").all(club.club_id).length === 0) {
      db.prepare("INSERT INTO hub_usage (club_id, member_count, blob_bytes) VALUES (?, 0, 0)").run(club.club_id);
    }
    refresh.run(club.club_id, club.club_id, club.club_id);
  }
}

function tableColumns(db: DatabaseSync, table: "hub_blobs" | "hub_blobs_legacy"): string[] {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(table).length === 0) return [];
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return info.map((row) => row.name);
}

function readAdmin(db: DatabaseSync, clubId: string): HubAdmin {
  const usage = db.prepare("SELECT member_count, blob_bytes FROM hub_usage WHERE club_id = ?").all(clubId) as {
    member_count: number;
    blob_bytes: number;
  }[];
  const members = db.prepare(
    "SELECT public_key, role FROM hub_members WHERE club_id = ? ORDER BY public_key",
  ).all(clubId) as { public_key: string; role: string }[];
  const envelopes = db.prepare(
    "SELECT event_id, length(envelope) AS size FROM hub_envelopes WHERE club_id = ? ORDER BY event_id",
  ).all(clubId) as { event_id: string; size: number }[];
  const blobs = db.prepare("SELECT hash, size FROM hub_blobs WHERE club_id = ? ORDER BY hash").all(clubId) as {
    hash: string;
    size: number;
  }[];
  return {
    clubId,
    memberCount: usage[0]?.member_count ?? 0,
    blobBytes: usage[0]?.blob_bytes ?? 0,
    members: members.map((member) => ({
      publicKey: member.public_key,
      role: member.role === "creator" ? "creator" : "member",
    })),
    envelopes: envelopes.map((envelope) => ({ eventId: envelope.event_id, size: envelope.size })),
    blobs: blobs.map((blob) => ({ hash: blob.hash, size: blob.size })),
  };
}

function blobPath(directory: string, clubId: string, hash: string): string {
  return join(directory, "blobs", Buffer.from(clubId, "utf8").toString("hex"), hash);
}

function listenRelay(
  port: number,
  onRequest: (raw: string) => Promise<string>,
): Promise<{ readonly port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    let working = false;
    const pump = (): void => {
      if (working || buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      working = true;
      void onRequest(body)
        .then((response) => {
          socket.write(Buffer.from(encodeFrame(response)), () => {
            working = false;
            socket.end();
          });
        })
        .catch(() => {
          socket.destroy();
        });
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME + 4) {
        socket.destroy();
        return;
      }
      pump();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new RelayError("unreachable"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            for (const socket of sockets) socket.destroy();
            server.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}
