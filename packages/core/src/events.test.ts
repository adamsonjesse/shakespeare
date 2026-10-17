import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { importEnvelope, postMessage, readMessage, removeMember, TestHub } from "./events.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { createInvite } from "./invite.ts";
import { acceptInvite, applyAcceptance, createClub, serializeAcceptance } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";
import { TestLoopback } from "./test-loopback.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const LATER = "2026-10-17T01:00:00.000Z";
const BODY = "hello club";
const NEXT = "second secret";
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
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-events-"));
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

async function person(): Promise<{ publicKey: string; privateKey: Uint8Array }> {
  return generateIdentity(new MemoryKeyStore());
}

describe("signed events", () => {
  it("delivers a human message that survives restart and rejects tampering", async () => {
    const alice = await person();
    const bob = await person();
    const cara = await person();
    const aliceDb = await temporaryDatabase();
    const bobDb = await temporaryDatabase();
    try {
      await createClub(aliceDb.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const token = await createInvite(alice.privateKey, {
        clubId: "club-a",
        inviterPublicKey: alice.publicKey,
        expiresAt: "2026-10-18T00:00:00.000Z",
        oneTime: false,
      });
      const acceptance = await acceptInvite(bobDb.executor, bob, token, NOW);
      await applyAcceptance(aliceDb.executor, serializeAcceptance(acceptance), NOW);

      await expect(
        postMessage(aliceDb.executor, alice, {
          clubId: "club-a",
          body: BODY,
          now: NOW,
          origin: "bot",
        }),
      ).rejects.toMatchObject({ code: "origin" });
      expect(await aliceDb.executor.select("SELECT id FROM events")).toEqual([]);

      const hub = new TestHub();
      const posted = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      hub.observe(new TextEncoder().encode(posted.envelope));
      const transport = new TestLoopback();
      transport.send(bob.publicKey, posted.envelope);
      const delivered = transport.receive(bob.publicKey)[0];
      if (delivered === undefined) throw new Error("missing delivery");
      expect(delivered.includes(BODY)).toBe(false);
      expect(Buffer.from(hub.recorded()).includes(Buffer.from(BODY))).toBe(false);

      const stored = await aliceDb.executor.select<{ id: string; ciphertext: string }>(
        "SELECT id, ciphertext FROM events",
      );
      expect(stored).toHaveLength(1);
      const row = stored[0];
      if (row === undefined) throw new Error("missing event");
      expect(row.id).toBe(bytesToHex(sha256(hexToBytes(row.ciphertext))));
      expect(row.id).not.toBe(bytesToHex(sha256(new TextEncoder().encode(BODY))));

      await importEnvelope(bobDb.executor, delivered);
      const opened = await readMessage(bobDb.executor, bob.privateKey, posted.id);
      expect(opened).toMatchObject({ verified: true, body: BODY, origin: "human", authorPublicKey: alice.publicKey });
      await expect(readMessage(bobDb.executor, cara.privateKey, posted.id)).rejects.toMatchObject({
        code: "unverified",
      });

      const flipped = row.ciphertext.slice(0, -1) + (row.ciphertext.endsWith("0") ? "1" : "0");
      await aliceDb.executor.execute("UPDATE events SET ciphertext = ? WHERE id = ?", [flipped, row.id]);
      await expect(readMessage(aliceDb.executor, alice.privateKey, posted.id)).rejects.toMatchObject({
        code: "unverified",
      });
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });

  it("keeps the plaintext out of the database and decrypts it after reopening", async () => {
    const alice = await person();
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
        body: BODY,
        now: NOW,
        origin: "human",
      });
      db.close();
      const reopened = new DatabaseSync(db.path);
      try {
        const executor = openExecutor(reopened);
        const read = await readMessage(executor, alice.privateKey, posted.id);
        expect(read.body).toBe(BODY);
      } finally {
        reopened.close();
      }
      expect(readFileSync(db.path).includes(Buffer.from(BODY))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rotates the club key so a removed member cannot read a later message", async () => {
    const alice = await person();
    const bob = await person();
    const aliceDb = await temporaryDatabase();
    const bobDb = await temporaryDatabase();
    try {
      await createClub(aliceDb.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const token = await createInvite(alice.privateKey, {
        clubId: "club-a",
        inviterPublicKey: alice.publicKey,
        expiresAt: "2026-10-18T00:00:00.000Z",
        oneTime: false,
      });
      const acceptance = await acceptInvite(bobDb.executor, bob, token, NOW);
      await applyAcceptance(aliceDb.executor, serializeAcceptance(acceptance), NOW);
      const first = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      await importEnvelope(bobDb.executor, first.envelope);
      await removeMember(aliceDb.executor, alice, "club-a", bob.publicKey);
      const second = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: NEXT,
        now: LATER,
        origin: "human",
      });
      expect(second.envelope.includes(bob.publicKey)).toBe(false);
      expect(second.envelope.includes(NEXT)).toBe(false);
      await importEnvelope(bobDb.executor, second.envelope);
      expect((await readMessage(bobDb.executor, bob.privateKey, first.id)).body).toBe(BODY);
      await expect(readMessage(bobDb.executor, bob.privateKey, second.id)).rejects.toMatchObject({
        code: "unverified",
      });
      expect((await readMessage(aliceDb.executor, alice.privateKey, second.id)).body).toBe(NEXT);
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });
});
