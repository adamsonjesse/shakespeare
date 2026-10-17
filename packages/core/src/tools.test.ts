import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { postMessage, readMessage } from "./events.ts";
import { buildManifest, manifestText, type BlobStore, type OutputStore } from "./files.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { listBookmarkIds, listReadIds, listThemeWeights, listThemes } from "./stream.ts";
import { callTool, toolCatalog, type ToolContext } from "./tools.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const BODY = "hello club";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function openExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []) {
      db.prepare(sql).run(...params);
    },
    async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
      return db.prepare(sql).all(...params) as Row[];
    },
  };
}

async function temporaryDatabase(): Promise<{ executor: SqlExecutor; close: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-tools-"));
  directories.push(dir);
  const db = new DatabaseSync(join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  const executor = openExecutor(db);
  await migrate(executor, MIGRATIONS, { now: NOW });
  let closed = false;
  return {
    executor,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

async function clubContext(): Promise<{
  ctx: ToolContext;
  close: () => void;
  privateHex: string;
}> {
  const alice = await generateIdentity(new MemoryKeyStore());
  const db = await temporaryDatabase();
  await createClub(db.executor, {
    clubId: "club-a",
    name: "Alpha",
    creatorPublicKey: alice.publicKey,
    now: NOW,
  });
  return {
    ctx: { db: db.executor, author: alice, now: () => NOW },
    close: db.close,
    privateHex: Buffer.from(alice.privateKey).toString("hex"),
  };
}

describe("club tools", () => {
  it("signs post_message as ai when the caller passes human", async () => {
    const fixture = await clubContext();
    try {
      const result = await callTool(fixture.ctx, "post_message", {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
        privateKey: fixture.privateHex,
      });
      expect(result).toMatchObject({ origin: "ai" });
      expect(JSON.stringify(result)).not.toContain(fixture.privateHex);
      expect(JSON.stringify(result)).not.toContain(BODY);
      const posted = result as { id: string };
      expect(await readMessage(fixture.ctx.db, fixture.ctx.author.privateKey, posted.id)).toMatchObject({
        origin: "ai",
        body: BODY,
      });
      const audit = await fixture.ctx.db.select<{ tool: string; event_ids: string; result_code: string }>(
        "SELECT tool, event_ids, result_code FROM audit_log",
      );
      expect(audit).toEqual([{ tool: "post_message", event_ids: JSON.stringify([posted.id]), result_code: "ok" }]);
      expect(JSON.stringify(audit)).not.toContain(BODY);
      expect(JSON.stringify(audit)).not.toContain(fixture.privateHex);
      const columns = await fixture.ctx.db.select<{ name: string }>("PRAGMA table_info(audit_log)");
      expect(columns.map((column) => column.name)).not.toContain("body");
    } finally {
      fixture.close();
    }
  });

  it("lists club tools and no key export or origin argument", () => {
    const names = toolCatalog().map((tool) => tool.name);
    expect(names).toEqual([
      "post_message",
      "read_stream",
      "reply",
      "mark_read",
      "bookmark",
      "save_theme",
      "list_themes",
      "request_download",
      "list_members",
    ]);
    expect(names.join(" ")).not.toMatch(/export|private/);
    expect(toolCatalog().every((tool) => !tool.inputKeys.includes("origin"))).toBe(true);
  });

  it("signs a reply as ai and does not let the caller choose human", async () => {
    const fixture = await clubContext();
    try {
      const parent = await postMessage(fixture.ctx.db, fixture.ctx.author, {
        clubId: "club-a",
        body: "parent note",
        now: NOW,
        origin: "human",
      });
      const result = await callTool(fixture.ctx, "reply", {
        clubId: "club-a",
        body: "ai reply",
        parentId: parent.id,
        now: "2026-10-17T01:00:00.000Z",
        origin: "human",
      });
      expect(result).toMatchObject({ origin: "ai" });
      const posted = result as { id: string };
      expect(await readMessage(fixture.ctx.db, fixture.ctx.author.privateKey, posted.id)).toMatchObject({
        origin: "ai",
        body: "ai reply",
        parentId: parent.id,
      });
    } finally {
      fixture.close();
    }
  });

  it("reads a filtered stream without creating a download", async () => {
    const fixture = await clubContext();
    const fetched: string[] = [];
    fixture.ctx = {
      ...fixture.ctx,
      fetchHash: async (hash) => {
        fetched.push(hash);
        return utf8ToBytes("nope");
      },
    };
    try {
      const bytes = utf8ToBytes("alpha-bytes");
      const manifest = buildManifest([{ path: "notes/a.txt", bytes }], "notes");
      await postMessage(fixture.ctx.db, fixture.ctx.author, {
        clubId: "club-a",
        body: manifestText(manifest),
        now: NOW,
        origin: "human",
      });
      await callTool(fixture.ctx, "post_message", {
        clubId: "club-a",
        body: "beta note",
        now: "2026-10-17T01:00:00.000Z",
      });
      await callTool(fixture.ctx, "save_theme", { id: "theme-a", name: "Alpha", terms: ["notes"] });
      const filtered = await callTool(fixture.ctx, "read_stream", {
        clubId: "club-a",
        themeId: "theme-a",
        hide: "ai",
      });
      expect(filtered).toMatchObject({
        messages: [{ origin: "human", files: [{ path: "notes/a.txt" }] }],
      });
      expect(fetched).toEqual([]);
      expect(await fixture.ctx.db.select("SELECT event_id FROM download_requests")).toEqual([]);
      const hidden = await callTool(fixture.ctx, "read_stream", { clubId: "club-a", hide: "human" });
      expect(hidden).toMatchObject({ messages: [{ origin: "ai", body: "beta note" }] });
    } finally {
      fixture.close();
    }
  });

  it("marks a message read and bookmarks it on the same tables the UI uses", async () => {
    const fixture = await clubContext();
    try {
      await callTool(fixture.ctx, "save_theme", { id: "theme-a", name: "Alpha", terms: ["alpha"] });
      const posted = (await callTool(fixture.ctx, "post_message", {
        clubId: "club-a",
        body: "alpha note",
        now: NOW,
      })) as { id: string };
      await callTool(fixture.ctx, "mark_read", {
        eventId: posted.id,
        startedAt: "2026-10-17T00:00:01.999Z",
        now: "2026-10-17T00:00:03.000Z",
      });
      expect(await listReadIds(fixture.ctx.db)).toEqual([posted.id]);
      expect(await listThemeWeights(fixture.ctx.db)).toEqual({});
      await callTool(fixture.ctx, "bookmark", { eventId: posted.id, now: "2026-10-17T00:00:04.000Z" });
      expect(await listBookmarkIds(fixture.ctx.db)).toEqual([posted.id]);
      expect(await listThemeWeights(fixture.ctx.db)).toEqual({ "theme-a": 1 });
      expect(await listThemes(fixture.ctx.db)).toEqual([{ id: "theme-a", name: "Alpha", terms: ["alpha"] }]);
      expect(await callTool(fixture.ctx, "list_themes", {})).toEqual({
        themes: [{ id: "theme-a", name: "Alpha", terms: ["alpha"] }],
      });
    } finally {
      fixture.close();
    }
  });

  it("downloads only the requested manifest path", async () => {
    const fixture = await clubContext();
    const alpha = utf8ToBytes("alpha-bytes");
    const beta = utf8ToBytes("beta-bytes");
    const manifest = buildManifest(
      [
        { path: "notes/a.txt", bytes: alpha },
        { path: "notes/b.txt", bytes: beta },
      ],
      "notes",
    );
    const library = new Map(manifest.files.map((file, index) => [file.hash, index === 0 ? alpha : beta]));
    const output = new MemoryOutput();
    fixture.ctx = {
      ...fixture.ctx,
      blobs: new MemoryBlobs(),
      output,
      fetchHash: async (hash) => {
        const bytes = library.get(hash);
        if (!bytes) throw new Error("missing blob");
        return bytes;
      },
    };
    try {
      const offer = await postMessage(fixture.ctx.db, fixture.ctx.author, {
        clubId: "club-a",
        body: manifestText(manifest),
        now: NOW,
        origin: "human",
      });
      await callTool(fixture.ctx, "read_stream", { clubId: "club-a" });
      expect(await fixture.ctx.db.select("SELECT path FROM download_requests")).toEqual([]);
      await callTool(fixture.ctx, "request_download", { eventId: offer.id, paths: ["notes/b.txt"], now: NOW });
      expect(output.paths()).toEqual(["notes/b.txt"]);
      expect(output.read("notes/b.txt")).toEqual(beta);
      expect(await fixture.ctx.db.select("SELECT path, state FROM download_requests")).toEqual([
        { path: "notes/b.txt", state: "verified" },
      ]);
    } finally {
      fixture.close();
    }
  });

  it("lists members without returning a private key", async () => {
    const fixture = await clubContext();
    try {
      const result = await callTool(fixture.ctx, "list_members", { clubId: "club-a" });
      expect(result).toEqual({
        members: [{ publicKey: fixture.ctx.author.publicKey, role: "creator", joinedAt: NOW }],
      });
      expect(JSON.stringify(result)).not.toContain(fixture.privateHex);
    } finally {
      fixture.close();
    }
  });
});

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

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  read(path: string): Uint8Array | undefined {
    const found = this.files.get(path);
    return found ? new Uint8Array(found) : undefined;
  }
}
