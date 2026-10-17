import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { postMessage } from "./events.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { addBookmark, listBookmarkIds, listThemes, listUnreadIds, markRead, saveTheme } from "./stream.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const LATER = "2026-10-17T01:00:00.000Z";
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

async function temporaryDatabase(): Promise<{ executor: SqlExecutor; path: string; close: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-stream-"));
  directories.push(dir);
  const path = join(dir, "test.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const executor = openExecutor(db);
  await migrate(executor, MIGRATIONS, { now: NOW });
  let closed = false;
  return {
    executor,
    path,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

describe("stream store", () => {
  it("removes a marked-read event from the unread catch-up query", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const db = await temporaryDatabase();
    try {
      await createClub(db.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const posted = await postMessage(db.executor, alice, {
        clubId: "club-a",
        body: "hello club",
        now: NOW,
        origin: "human",
      });
      await markRead(db.executor, posted.id, LATER);
      expect(await listUnreadIds(db.executor, "club-a")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps a bookmark after the database is reopened", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const db = await temporaryDatabase();
    const path = db.path;
    let postedId = "";
    try {
      await createClub(db.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const posted = await postMessage(db.executor, alice, {
        clubId: "club-a",
        body: "hello club",
        now: NOW,
        origin: "human",
      });
      postedId = posted.id;
      await addBookmark(db.executor, posted.id, LATER);
    } finally {
      db.close();
    }
    const reopened = new DatabaseSync(path);
    try {
      expect(await listBookmarkIds(openExecutor(reopened))).toEqual([postedId]);
    } finally {
      reopened.close();
    }
  });

  it("does not mark the same event read in another profile database", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const bob = await generateIdentity(new MemoryKeyStore());
    const aliceDb = await temporaryDatabase();
    const bobDb = await temporaryDatabase();
    try {
      await createClub(aliceDb.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const posted = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: "hello club",
        now: NOW,
        origin: "human",
      });
      await markRead(aliceDb.executor, posted.id, LATER);
      await createClub(bobDb.executor, {
        clubId: "club-b",
        name: "Beta",
        creatorPublicKey: bob.publicKey,
        now: NOW,
      });
      const other = await postMessage(bobDb.executor, bob, {
        clubId: "club-b",
        body: "other club",
        now: NOW,
        origin: "human",
      });
      expect(await listUnreadIds(bobDb.executor, "club-b")).toEqual([other.id]);
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });

  it("keeps a saved theme after the database is reopened", async () => {
    const db = await temporaryDatabase();
    const path = db.path;
    try {
      await saveTheme(db.executor, { id: "theme-1", name: "Focus", terms: [" runway ", ""] });
    } finally {
      db.close();
    }
    const reopened = new DatabaseSync(path);
    try {
      expect(await listThemes(openExecutor(reopened))).toEqual([
        { id: "theme-1", name: "Focus", terms: ["runway"] },
      ]);
    } finally {
      reopened.close();
    }
  });
});
