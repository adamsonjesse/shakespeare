import { mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
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
  hash TEXT PRIMARY KEY NOT NULL,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL
);
`;

export async function startHub(
  directory: string,
  options: { readonly port?: number; readonly now?: () => string } = {},
): Promise<{ readonly port: number; readonly file: string; close: () => Promise<void> }> {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "hub.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    const hub = hubDb(db);
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

function hubDb(db: DatabaseSync): HubDb {
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
    async addMember(clubId: string, publicKey: string, role: "creator" | "member"): Promise<void> {
      db.prepare(
        "INSERT OR IGNORE INTO hub_members (club_id, public_key, role) VALUES (?, ?, ?)",
      ).run(clubId, publicKey, role);
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
    async saveBlob(hash: string, bytes: Uint8Array): Promise<void> {
      db.prepare("INSERT OR REPLACE INTO hub_blobs (hash, bytes, size) VALUES (?, ?, ?)").run(
        hash,
        bytes,
        bytes.byteLength,
      );
    },
  };
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
