import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { postMessage, readMessage } from "./events.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { signText, verifyQuiet } from "./invite.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { runPostMessageCli } from "./post-tool.ts";
import { excludeOrigin } from "./rank.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";

const NOW = "2026-10-17T00:00:00.000Z";
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
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-ai-"));
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

describe("AI tagging", () => {
  it("signs a tool post as ai even when the caller says human", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const db = await temporaryDatabase();
    try {
      await createClub(db.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const human = await postMessage(db.executor, alice, {
        clubId: "club-a",
        body: "hello club",
        now: NOW,
        origin: "human",
      });
      const ai = await runPostMessageCli(db.executor, alice, {
        clubId: "club-a",
        body: "ai note",
        now: "2026-10-17T01:00:00.000Z",
        origin: "human",
      });
      expect(ai.origin).toBe("ai");
      expect(JSON.stringify(ai)).not.toContain(Buffer.from(alice.privateKey).toString("hex"));
      expect(await readMessage(db.executor, alice.privateKey, human.id)).toMatchObject({
        origin: "human",
        authorPublicKey: alice.publicKey,
      });
      expect(await readMessage(db.executor, alice.privateKey, ai.id)).toMatchObject({
        origin: "ai",
        body: "ai note",
        authorPublicKey: alice.publicKey,
      });
    } finally {
      db.close();
    }
  });

  it("rejects a missing or unknown origin without writing a row", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const db = await temporaryDatabase();
    try {
      await createClub(db.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      await expect(
        postMessage(db.executor, alice, {
          clubId: "club-a",
          body: "hello club",
          now: NOW,
          origin: "",
        }),
      ).rejects.toMatchObject({ code: "origin" });
      expect(await db.executor.select("SELECT id FROM events")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not treat a flipped origin as a valid signature", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const signed = JSON.stringify({
      authorPublicKey: alice.publicKey,
      body: "hello club",
      clubId: "club-a",
      createdAt: NOW,
      origin: "human",
      parentId: null,
    });
    const flipped = signed.replace("\"origin\":\"human\"", "\"origin\":\"ai\"");
    expect(verifyQuiet(signText(alice.privateKey, signed), flipped, alice.publicKey)).toBe(false);
  });

  it("hides AI events when the AI origin is excluded", () => {
    const messages = [
      { id: "h", verified: true, origin: "human" as const, body: "hello club" },
      { id: "a", verified: true, origin: "ai" as const, body: "ai note" },
    ];
    expect(excludeOrigin(messages, "ai").map((message) => message.id)).toEqual(["h"]);
    expect(excludeOrigin(messages, null).map((message) => message.id)).toEqual(["h", "a"]);
  });
});
