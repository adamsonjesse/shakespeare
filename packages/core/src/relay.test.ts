import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { importEnvelope, postMessage, readMessage } from "./events.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { signText } from "./invite.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import {
  enqueueOutbox,
  hubCatchUpMessage,
  hubCreateMessage,
  hubMemberMessage,
  hubSeedMessage,
  hubSubmitMessage,
  listPendingOutbox,
  signedWeightFetch,
  signedWeightPublish,
} from "./relay.ts";
import { exchange, startDirectPeer, startHub } from "./relay-node.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const BODY = "hello club";
const directories: string[] = [];
const cli = fileURLToPath(new URL("./hub-cli.ts", import.meta.url));

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
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-relay-"));
  directories.push(dir);
  const path = join(dir, "client.sqlite");
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

async function clubOf(
  alice: { publicKey: string; privateKey: Uint8Array },
  bob: { publicKey: string; privateKey: Uint8Array },
): Promise<{ aliceDb: Awaited<ReturnType<typeof temporaryDatabase>>; bobDb: Awaited<ReturnType<typeof temporaryDatabase>> }> {
  const aliceDb = await temporaryDatabase();
  const bobDb = await temporaryDatabase();
  await createClub(aliceDb.executor, {
    clubId: "club-a",
    name: "Alpha",
    creatorPublicKey: alice.publicKey,
    now: NOW,
  });
  await createClub(bobDb.executor, {
    clubId: "club-a",
    name: "Alpha",
    creatorPublicKey: alice.publicKey,
    now: NOW,
  });
  await aliceDb.executor.execute(
    "INSERT INTO memberships (club_id, public_key, role, joined_at) VALUES (?, ?, 'member', ?)",
    ["club-a", bob.publicKey, NOW],
  );
  await bobDb.executor.execute(
    "INSERT INTO memberships (club_id, public_key, role, joined_at) VALUES (?, ?, 'member', ?)",
    ["club-a", bob.publicKey, NOW],
  );
  return { aliceDb, bobDb };
}

describe("hybrid transport", () => {
  it("delivers directly while the hub process is stopped", async () => {
    const alice = await person();
    const bob = await person();
    const { aliceDb, bobDb } = await clubOf(alice, bob);
    const peer = await startDirectPeer(bobDb.executor);
    try {
      const posted = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      const response = await exchange(peer.port, {
        op: "deliver",
        envelope: posted.envelope,
        signature: signText(alice.privateKey, hubSubmitMessage(posted.envelope)),
      });
      expect(response).toEqual({ ok: true });
      const opened = await readMessage(bobDb.executor, bob.privateKey, posted.id);
      expect(opened).toMatchObject({ verified: true, body: BODY, origin: "human" });
    } finally {
      await peer.close();
      aliceDb.close();
      bobDb.close();
    }
  });

  it("stores an offline send on the hub and hands it over after restart", async () => {
    const alice = await person();
    const bob = await person();
    const { aliceDb, bobDb } = await clubOf(alice, bob);
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-hub-"));
    directories.push(dir);
    const hub = await startHub(dir, { now: () => NOW });
    try {
      expect(
        await exchange(hub.port, {
          op: "create-club",
          clubId: "club-a",
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
        }),
      ).toEqual({ ok: true });
      expect(
        await exchange(hub.port, {
          op: "add-member",
          clubId: "club-a",
          memberPublicKey: bob.publicKey,
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubMemberMessage("club-a", bob.publicKey)),
        }),
      ).toEqual({ ok: true });

      const posted = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      await enqueueOutbox(aliceDb.executor, {
        id: posted.id,
        clubId: "club-a",
        envelope: posted.envelope,
        now: NOW,
      });
      aliceDb.close();

      const reopened = new DatabaseSync(aliceDb.path);
      try {
        const executor = openExecutor(reopened);
        const pending = await listPendingOutbox(executor);
        expect(pending.map((row) => row.id)).toEqual([posted.id]);
        const stored = pending[0];
        if (!stored) throw new Error("missing outbox row");
        expect(
          await exchange(hub.port, {
            op: "submit-envelope",
            envelope: stored.envelope,
            signature: signText(alice.privateKey, hubSubmitMessage(stored.envelope)),
          }),
        ).toEqual({ ok: true });
      } finally {
        reopened.close();
      }

      const caught = await exchange(hub.port, {
        op: "catch-up",
        clubId: "club-a",
        memberPublicKey: bob.publicKey,
        afterEventId: null,
        now: NOW,
        signature: signText(bob.privateKey, hubCatchUpMessage("club-a", null, NOW)),
      });
      expect(caught.ok).toBe(true);
      if (!caught.ok) return;
      expect(caught.envelopes).toHaveLength(1);
      const envelope = caught.envelopes?.[0];
      if (!envelope) throw new Error("missing envelope");
      expect(envelope.includes(BODY)).toBe(false);
      await importEnvelope(bobDb.executor, envelope);
      expect(await readMessage(bobDb.executor, bob.privateKey, posted.id)).toMatchObject({ body: BODY });
      expect(readFileSync(hub.file).includes(Buffer.from(BODY))).toBe(false);
    } finally {
      await hub.close();
      aliceDb.close();
      bobDb.close();
    }
  });

  it("rejects a non-member submit and a non-member catch-up", async () => {
    const alice = await person();
    const bob = await person();
    const cara = await person();
    const { aliceDb, bobDb } = await clubOf(alice, bob);
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-hub-"));
    directories.push(dir);
    const hub = await startHub(dir, { now: () => NOW });
    try {
      await exchange(hub.port, {
        op: "create-club",
        clubId: "club-a",
        creatorPublicKey: alice.publicKey,
        signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
      });
      const posted = await postMessage(aliceDb.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      const forged = await exchange(hub.port, {
        op: "submit-envelope",
        envelope: posted.envelope,
        signature: signText(cara.privateKey, hubSubmitMessage(posted.envelope)),
      });
      expect(forged).toEqual({ ok: false, error: "The hub rejected that envelope." });
      const sneaky = await exchange(hub.port, {
        op: "catch-up",
        clubId: "club-a",
        memberPublicKey: cara.publicKey,
        afterEventId: null,
        now: NOW,
        signature: signText(cara.privateKey, hubCatchUpMessage("club-a", null, NOW)),
      });
      expect(sneaky).toEqual({ ok: false, error: "The request is not allowed." });
      expect(JSON.stringify(sneaky).includes(BODY)).toBe(false);
      const selfAdd = await exchange(hub.port, {
        op: "add-member",
        clubId: "club-a",
        memberPublicKey: cara.publicKey,
        creatorPublicKey: cara.publicKey,
        signature: signText(cara.privateKey, hubMemberMessage("club-a", cara.publicKey)),
      });
      expect(selfAdd).toEqual({ ok: false, error: "That membership proof is not valid." });
    } finally {
      await hub.close();
      aliceDb.close();
      bobDb.close();
    }
  });

  it("stores a seeded blob and does not fetch any other file", async () => {
    const alice = await person();
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-hub-"));
    directories.push(dir);
    const hub = await startHub(dir, { now: () => NOW });
    const seeded = utf8ToBytes("beta-bytes");
    const other = utf8ToBytes("gamma-secret-bytes");
    const hash = bytesToHex(blake3(seeded));
    try {
      await exchange(hub.port, {
        op: "create-club",
        clubId: "club-a",
        creatorPublicKey: alice.publicKey,
        signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
      });
      expect(
        await exchange(hub.port, {
          op: "seed-blob",
          clubId: "club-a",
          memberPublicKey: alice.publicKey,
          hash,
          bytes: Buffer.from(seeded).toString("base64"),
          signature: signText(alice.privateKey, hubSeedMessage("club-a", hash)),
        }),
      ).toEqual({ ok: true });
      const file = readFileSync(hub.file);
      expect(file.includes(Buffer.from(other))).toBe(false);
      expect(file.includes(Buffer.from(seeded))).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it("accepts a second local process on the documented hub command", async () => {
    const alice = await person();
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-hub-cli-"));
    directories.push(dir);
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, dir, "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const port = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("hub did not listen")), 15000);
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const match = /listening 127\.0\.0\.1 (\d+)/.exec(text);
        const found = match?.[1];
        if (found) {
          clearTimeout(timer);
          resolve(Number(found));
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`hub exited ${code ?? "null"}`));
      });
    });
    try {
      expect(
        await exchange(port, {
          op: "create-club",
          clubId: "club-a",
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
        }),
      ).toEqual({ ok: true });
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
  });

  it("stores a published theme weight and not the message fixture", async () => {
    const alice = await person();
    const bob = await person();
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-hub-weights-"));
    directories.push(dir);
    const hub = await startHub(dir, { now: () => NOW });
    try {
      const request = signedWeightPublish(alice, [{ themeId: "theme-a", weight: 1, body: BODY }]);
      expect(JSON.stringify(request).includes(BODY)).toBe(false);
      expect(await exchange(hub.port, request)).toEqual({ ok: true });
      const fetched = await exchange(hub.port, signedWeightFetch(alice));
      expect(fetched).toEqual({ ok: true, weights: [{ themeId: "theme-a", weight: 1 }] });
      const other = await exchange(hub.port, signedWeightFetch(bob));
      expect(other).toEqual({ ok: true, weights: [] });
      expect(readFileSync(hub.file).includes(Buffer.from(BODY))).toBe(false);
    } finally {
      await hub.close();
    }
  });
});
