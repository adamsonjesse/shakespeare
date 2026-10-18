import { copyFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { importEnvelope, postMessage, readMessage, removeMember } from "./events.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { createInvite, signText } from "./invite.ts";
import { acceptInvite, applyAcceptance, createClub, serializeAcceptance } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { exchange, startHub } from "./relay-node.ts";
import { hubCreateMessage, hubSubmitMessage } from "./relay.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";
import { callTool } from "./tools.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-security-"));
  directories.push(dir);
  const path = join(dir, "club.sqlite");
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

function privateHex(identity: { privateKey: Uint8Array }): string {
  return Buffer.from(identity.privateKey).toString("hex");
}

describe("security properties", () => {
  it("rejects a tampered envelope", async () => {
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
      const parsed = JSON.parse(posted.envelope) as { ciphertext: string };
      parsed.ciphertext = `${parsed.ciphertext.slice(0, -1)}${parsed.ciphertext.endsWith("0") ? "1" : "0"}`;
      const tampered = JSON.stringify(parsed);
      await expect(importEnvelope(db.executor, tampered)).rejects.toMatchObject({ code: "unverified" });
      expect(tampered.includes(BODY)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does not let a non-member decrypt a copied database", async () => {
    const alice = await person();
    const cara = await person();
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
      expect(readFileSync(db.path).includes(Buffer.from(BODY))).toBe(false);
      expect(readFileSync(db.path).includes(Buffer.from(privateHex(alice)))).toBe(false);
      const copyPath = join(db.path, "..", "copied.sqlite");
      copyFileSync(db.path, copyPath);
      const copy = new DatabaseSync(copyPath);
      try {
        await expect(readMessage(openExecutor(copy), cara.privateKey, posted.id)).rejects.toMatchObject({
          code: "unverified",
        });
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  it("omits a removed member from the next key wrap", async () => {
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
      expect((await readMessage(bobDb.executor, bob.privateKey, first.id)).body).toBe(BODY);
      await importEnvelope(bobDb.executor, second.envelope);
      await expect(readMessage(bobDb.executor, bob.privateKey, second.id)).rejects.toMatchObject({
        code: "unverified",
      });
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });

  it("keeps the hub file free of message text", async () => {
    const alice = await person();
    const db = await temporaryDatabase();
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-security-hub-"));
    directories.push(dir);
    const hub = await startHub(dir, { now: () => NOW });
    try {
      await createClub(db.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      expect(
        await exchange(hub.port, {
          op: "create-club",
          clubId: "club-a",
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
        }),
      ).toEqual({ ok: true });
      const posted = await postMessage(db.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      expect(
        await exchange(hub.port, {
          op: "submit-envelope",
          envelope: posted.envelope,
          signature: signText(alice.privateKey, hubSubmitMessage(posted.envelope)),
        }),
      ).toEqual({ ok: true });
      const parsed = JSON.parse(posted.envelope) as { ciphertext: string };
      parsed.ciphertext = `${parsed.ciphertext.slice(0, -1)}${parsed.ciphertext.endsWith("0") ? "1" : "0"}`;
      const rejected = await exchange(hub.port, {
        op: "submit-envelope",
        envelope: JSON.stringify(parsed),
        signature: signText(alice.privateKey, hubSubmitMessage(JSON.stringify(parsed))),
      });
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected).includes(BODY)).toBe(false);
      const stored = readFileSync(hub.file);
      expect(stored.includes(Buffer.from(BODY))).toBe(false);
      expect(stored.includes(Buffer.from(privateHex(alice)))).toBe(false);
    } finally {
      await hub.close();
      db.close();
    }
  });

  it("refuses an MCP origin override", async () => {
    const alice = await person();
    const db = await temporaryDatabase();
    try {
      await createClub(db.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const result = await callTool(
        { db: db.executor, author: alice, now: () => NOW },
        "post_message",
        { clubId: "club-a", body: BODY, now: NOW, origin: "human", privateKey: privateHex(alice) },
      );
      expect(result).toMatchObject({ origin: "ai" });
      expect(JSON.stringify(result).includes(BODY)).toBe(false);
      expect(JSON.stringify(result).includes(privateHex(alice))).toBe(false);
      const posted = result as { id: string };
      expect(await readMessage(db.executor, alice.privateKey, posted.id)).toMatchObject({
        origin: "ai",
        body: BODY,
      });
      const audit = await db.executor.select<{ tool: string; result_code: string }>(
        "SELECT tool, result_code FROM audit_log",
      );
      expect(audit).toEqual([{ tool: "post_message", result_code: "ok" }]);
      expect(JSON.stringify(audit).includes(BODY)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects an invite whose signature does not match", async () => {
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
      expect(token.includes(privateHex(alice))).toBe(false);
      const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { signature: string };
      decoded.signature = `${decoded.signature.slice(0, -1)}${decoded.signature.endsWith("0") ? "1" : "0"}`;
      const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      await expect(acceptInvite(bobDb.executor, bob, tampered, NOW)).rejects.toMatchObject({
        code: "bad-signature",
      });
      expect(await bobDb.executor.select("SELECT public_key FROM memberships")).toEqual([]);
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });
});
