import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { postMessage } from "./events.ts";
import { buildManifest, manifestText, type BlobStore, type OutputStore } from "./files.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";
import { toolFailureMessage } from "./tools.ts";
import { startToolServer } from "./tools-node.ts";

/**
 * Posts an AI-tagged message, reads it back, and downloads one file.
 * Uses a temporary profile and no provider API key.
 */

const NOW = "2026-10-17T12:00:00.000Z";
const NOTE = "ai note";

async function main(): Promise<void> {
const dir = await mkdtemp(join(tmpdir(), "shakespeare-example-tools-"));
const db = new DatabaseSync(join(dir, "club.sqlite"));
let server: Awaited<ReturnType<typeof startToolServer>> | undefined;
let failed = "";

try {
  db.exec("PRAGMA foreign_keys = ON");
  const executor: SqlExecutor = {
    async execute(sql: string, params: readonly SqlValue[] = []) {
      db.prepare(sql).run(...params);
    },
    async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
      return db.prepare(sql).all(...params) as Row[];
    },
  };
  await migrate(executor, MIGRATIONS, { now: NOW });
  const alice = await generateIdentity(new MemoryKeyStore());
  await createClub(executor, {
    clubId: "club-a",
    name: "Alpha",
    creatorPublicKey: alice.publicKey,
    now: NOW,
  });
  const bytes = utf8ToBytes("alpha-bytes");
  const manifest = buildManifest([{ path: "notes/a.txt", bytes }], "notes");
  const library = new Map(manifest.files.map((file) => [file.hash, bytes]));
  const output = new MemoryOutput();
  const offer = await postMessage(executor, alice, {
    clubId: "club-a",
    body: manifestText(manifest),
    now: NOW,
    origin: "human",
  });
  const listening = await startToolServer({
    context: {
      db: executor,
      author: alice,
      now: () => NOW,
      blobs: new MemoryBlobs(),
      output,
      fetchHash: async (hash) => {
        const found = library.get(hash);
        if (!found) throw new Error("missing blob");
        return found;
      },
    },
  });
  server = listening;
  if (listening.host !== "127.0.0.1") failed = "The server did not bind to loopback.\n";
  const listed = await rpc(listening.port, "tools/list", {});
  const tools = toolList(listed);
  if (tools.length !== 9) failed = "The tool list was incomplete.\n";
  if (tools.some((tool) => tool.name.includes("export") || tool.name.includes("private"))) {
    failed = "The tool list exports a key.\n";
  }
  if (tools.some((tool) => Object.prototype.hasOwnProperty.call(tool.properties, "origin"))) {
    failed = "A tool accepts an origin argument.\n";
  }
  const posted = await rpc(listening.port, "tools/call", {
    name: "post_message",
    arguments: { clubId: "club-a", body: NOTE, now: "2026-10-17T12:01:00.000Z" },
  });
  const postedOrigin = recordField(posted, "origin");
  if (postedOrigin !== "ai") failed = "The post was not tagged AI.\n";
  const read = await rpc(listening.port, "tools/call", {
    name: "read_stream",
    arguments: { clubId: "club-a" },
  });
  const ai = messages(read).find((message) => message.origin === "ai" && message.body === NOTE);
  if (!ai) failed = "The stream did not include the AI message.\n";
  await rpc(listening.port, "tools/call", {
    name: "request_download",
    arguments: { eventId: offer.id, paths: ["notes/a.txt"], now: NOW },
  });
  const downloaded = output.read("notes/a.txt");
  if (!downloaded || Buffer.from(downloaded).toString() !== "alpha-bytes") {
    failed = "The requested file was not downloaded.\n";
  }
  const audit = JSON.stringify(db.prepare("SELECT tool, event_ids, result_code FROM audit_log").all());
  if (audit.includes(NOTE) || audit.includes(Buffer.from(alice.privateKey).toString("hex"))) {
    failed = "The audit log contained message text.\n";
  }
  if (!failed && ai && server) {
    process.stdout.write(
      `${JSON.stringify({ listen: listening.host, origin: ai.origin, body: ai.body, path: "notes/a.txt" })}\n`,
    );
  }
} catch (error) {
  failed = `${toolFailureMessage(error)}\n`;
} finally {
  if (server) await server.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
}

if (failed) {
  process.stderr.write(failed);
  process.exit(1);
}
}

interface RpcResult {
  readonly result?: unknown;
}

async function rpc(port: number, method: string, params: unknown): Promise<RpcResult> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as RpcResult;
}

function toolList(payload: RpcResult): { name: string; properties: Record<string, unknown> }[] {
  const result = payload.result;
  if (!result || typeof result !== "object" || !("tools" in result) || !Array.isArray(result.tools)) return [];
  return result.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || !("name" in tool) || typeof tool.name !== "string") return [];
    const schema = "inputSchema" in tool ? tool.inputSchema : undefined;
    const properties =
      schema && typeof schema === "object" && "properties" in schema && schema.properties && typeof schema.properties === "object"
        ? schema.properties
        : {};
    return [{ name: tool.name, properties: properties as Record<string, unknown> }];
  });
}

function recordField(payload: RpcResult, key: string): unknown {
  if (!payload.result || typeof payload.result !== "object" || !(key in payload.result)) return undefined;
  return (payload.result as Record<string, unknown>)[key];
}

function messages(payload: RpcResult): { origin?: string; body?: string }[] {
  const result = payload.result;
  if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages)) return [];
  return result.messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const origin = "origin" in message && typeof message.origin === "string" ? message.origin : undefined;
    const body = "body" in message && typeof message.body === "string" ? message.body : undefined;
    return [{ origin, body }];
  });
}

class MemoryBlobs implements BlobStore {
  private readonly files = new Map<string, Uint8Array>();

  async read(hash: string): Promise<Uint8Array | null> {
    const found = this.files.get(hash);
    return found ? new Uint8Array(found) : null;
  }

  async write(hash: string, bytes: Uint8Array): Promise<void> {
    this.files.set(hash, new Uint8Array(bytes));
  }

  async remove(hash: string): Promise<void> {
    this.files.delete(hash);
  }
}

class MemoryOutput implements OutputStore {
  private readonly files = new Map<string, Uint8Array>();

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(bytes));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  read(path: string): Uint8Array | undefined {
    const found = this.files.get(path);
    return found ? new Uint8Array(found) : undefined;
  }
}

await main();
