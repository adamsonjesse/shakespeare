import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { postMessage } from "./events.ts";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { signText } from "./invite.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import {
  hubCatchUpMessage,
  hubCreateMessage,
  hubMemberMessage,
  hubSeedMessage,
  hubSubmitMessage,
} from "./relay.ts";
import { backupHub, exchange, restoreHub, startHub } from "./relay-node.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const BODY = "hello club";
const LIMIT = "The hub limit was reached.";
const directories: string[] = [];
const cli = fileURLToPath(new URL("./hub-cli.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function person(): Promise<{ publicKey: string; privateKey: Uint8Array }> {
  return generateIdentity(new MemoryKeyStore());
}

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-limits-"));
  directories.push(dir);
  return dir;
}

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
  const dir = await directory();
  const db = new DatabaseSync(join(dir, "club.sqlite"));
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

function envelopesOf(file: string): string[] {
  const db = new DatabaseSync(file);
  try {
    const rows = db.prepare("SELECT envelope FROM hub_envelopes ORDER BY event_id").all() as { envelope: string }[];
    return rows.map((row) => row.envelope);
  } finally {
    db.close();
  }
}

describe("hub limits", () => {
  it("refuses member 26 when the cap is 25 and keeps the earlier members", async () => {
    const people = await Promise.all(Array.from({ length: 26 }, () => person()));
    const creator = people[0];
    if (creator === undefined) throw new Error("missing creator");
    const dir = await directory();
    const hub = await startHub(dir, {});
    try {
      expect(
        await exchange(hub.port, {
          op: "create-club",
          clubId: "club-a",
          creatorPublicKey: creator.publicKey,
          signature: signText(creator.privateKey, hubCreateMessage("club-a", creator.publicKey)),
        }),
      ).toEqual({ ok: true });
      for (const member of people.slice(1, 25)) {
        expect(
          await exchange(hub.port, {
            op: "add-member",
            clubId: "club-a",
            memberPublicKey: member.publicKey,
            creatorPublicKey: creator.publicKey,
            signature: signText(creator.privateKey, hubMemberMessage("club-a", member.publicKey)),
          }),
        ).toEqual({ ok: true });
      }
      const extra = people[25];
      if (extra === undefined) throw new Error("missing extra member");
      expect(
        await exchange(hub.port, {
          op: "add-member",
          clubId: "club-a",
          memberPublicKey: extra.publicKey,
          creatorPublicKey: creator.publicKey,
          signature: signText(creator.privateKey, hubMemberMessage("club-a", extra.publicKey)),
        }),
      ).toEqual({ ok: false, error: LIMIT });
      const again = people[1];
      if (again === undefined) throw new Error("missing member");
      expect(
        await exchange(hub.port, {
          op: "add-member",
          clubId: "club-a",
          memberPublicKey: again.publicKey,
          creatorPublicKey: creator.publicKey,
          signature: signText(creator.privateKey, hubMemberMessage("club-a", again.publicKey)),
        }),
      ).toEqual({ ok: true });
      const admin = hub.admin("club-a");
      expect(admin.memberCount).toBe(25);
      expect(admin.members).toHaveLength(25);
      expect(admin.members.some((member) => member.publicKey === extra.publicKey)).toBe(false);
      expect(JSON.stringify(admin).includes(BODY)).toBe(false);
    } finally {
      await hub.close();
    }
    const db = new DatabaseSync(join(dir, "hub.sqlite"));
    try {
      expect(db.prepare("SELECT max_members, max_blob_bytes FROM hub_limits WHERE club_id = ?").all("club-a")).toEqual([
        { max_members: 25, max_blob_bytes: 10 * 1024 * 1024 * 1024 },
      ]);
      expect(db.prepare("SELECT member_count, blob_bytes FROM hub_usage WHERE club_id = ?").all("club-a")).toEqual([
        { member_count: 25, blob_bytes: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("refuses the next seeded blob past the byte cap and keeps the earlier blob", async () => {
    const alice = await person();
    const dir = await directory();
    const hub = await startHub(dir, { limits: { maxBlobBytes: 4 } });
    const first = utf8ToBytes("abcd");
    const second = utf8ToBytes("ZZ");
    const firstHash = bytesToHex(blake3(first));
    const secondHash = bytesToHex(blake3(second));
    try {
      expect(
        await exchange(hub.port, {
          op: "create-club",
          clubId: "club-a",
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
        }),
      ).toEqual({ ok: true });
      const seed = (hash: string, bytes: Uint8Array) =>
        exchange(hub.port, {
          op: "seed-blob",
          clubId: "club-a",
          memberPublicKey: alice.publicKey,
          hash,
          bytes: Buffer.from(bytes).toString("base64"),
          signature: signText(alice.privateKey, hubSeedMessage("club-a", hash)),
        });
      expect(await seed(firstHash, first)).toEqual({ ok: true });
      expect(await seed(secondHash, second)).toEqual({ ok: false, error: LIMIT });
      expect(await seed(firstHash, first)).toEqual({ ok: true });
      expect(hub.admin("club-a").blobBytes).toBe(4);
      expect(hub.admin("club-a").blobs).toEqual([{ hash: firstHash, size: 4 }]);
      const stored = await readFile(hub.file);
      expect(stored.includes(Buffer.from(first))).toBe(true);
      expect(stored.includes(Buffer.from(second))).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it("does not let club B read club A's envelope", async () => {
    const alice = await person();
    const bob = await person();
    const client = await temporaryDatabase();
    const dir = await directory();
    const hub = await startHub(dir, { now: () => NOW });
    const seeded = utf8ToBytes("blob-a");
    const hash = bytesToHex(blake3(seeded));
    try {
      await createClub(client.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const posted = await postMessage(client.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
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
          op: "create-club",
          clubId: "club-b",
          creatorPublicKey: bob.publicKey,
          signature: signText(bob.privateKey, hubCreateMessage("club-b", bob.publicKey)),
        }),
      ).toEqual({ ok: true });
      expect(
        await exchange(hub.port, {
          op: "submit-envelope",
          envelope: posted.envelope,
          signature: signText(alice.privateKey, hubSubmitMessage(posted.envelope)),
        }),
      ).toEqual({ ok: true });
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
      expect(
        await exchange(hub.port, {
          op: "catch-up",
          clubId: "club-a",
          memberPublicKey: bob.publicKey,
          afterEventId: null,
          now: NOW,
          signature: signText(bob.privateKey, hubCatchUpMessage("club-a", null, NOW)),
        }),
      ).toEqual({ ok: false, error: "The request is not allowed." });
      const own = await exchange(hub.port, {
        op: "catch-up",
        clubId: "club-a",
        memberPublicKey: alice.publicKey,
        afterEventId: null,
        now: NOW,
        signature: signText(alice.privateKey, hubCatchUpMessage("club-a", null, NOW)),
      });
      expect(own).toEqual({ ok: true, envelopes: [posted.envelope] });
      const other = hub.admin("club-b");
      const otherText = JSON.stringify(other);
      expect(other.envelopes).toEqual([]);
      expect(other.blobs).toEqual([]);
      expect(otherText.includes(posted.envelope)).toBe(false);
      expect(otherText.includes(posted.id)).toBe(false);
      expect(otherText.includes(hash)).toBe(false);
      expect(otherText.includes(BODY)).toBe(false);
      const mine = hub.admin("club-a");
      expect(mine.envelopes).toEqual([{ eventId: posted.id, size: Buffer.byteLength(posted.envelope) }]);
      expect(mine.blobs).toEqual([{ hash, size: seeded.byteLength }]);
      expect(JSON.stringify(mine).includes(BODY)).toBe(false);
      expect(JSON.stringify(mine).includes(posted.envelope)).toBe(false);
    } finally {
      await hub.close();
      client.close();
    }
  });

  it("keeps the cap that was stored when the club was created", async () => {
    const alice = await person();
    const bob = await person();
    const dir = await directory();
    const first = await startHub(dir, { limits: { maxMembers: 1, maxBlobBytes: 100 } });
    try {
      expect(
        await exchange(first.port, {
          op: "create-club",
          clubId: "club-a",
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubCreateMessage("club-a", alice.publicKey)),
        }),
      ).toEqual({ ok: true });
    } finally {
      await first.close();
    }
    const second = await startHub(dir, { limits: { maxMembers: 100, maxBlobBytes: 100 } });
    try {
      expect(
        await exchange(second.port, {
          op: "add-member",
          clubId: "club-a",
          memberPublicKey: bob.publicKey,
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubMemberMessage("club-a", bob.publicKey)),
        }),
      ).toEqual({ ok: false, error: LIMIT });
      expect(second.admin("club-a").memberCount).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("restores envelope bytes without copying a client file", async () => {
    const alice = await person();
    const client = await temporaryDatabase();
    const dir = await directory();
    const hub = await startHub(dir, { now: () => NOW });
    const seeded = utf8ToBytes("blob-a");
    const hash = bytesToHex(blake3(seeded));
    let envelope = "";
    try {
      await createClub(client.executor, {
        clubId: "club-a",
        name: "Alpha",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const posted = await postMessage(client.executor, alice, {
        clubId: "club-a",
        body: BODY,
        now: NOW,
        origin: "human",
      });
      envelope = posted.envelope;
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
          op: "submit-envelope",
          envelope: posted.envelope,
          signature: signText(alice.privateKey, hubSubmitMessage(posted.envelope)),
        }),
      ).toEqual({ ok: true });
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
    } finally {
      await hub.close();
      client.close();
    }
    const marker = "client-private-key-marker";
    writeFileSync(join(dir, "client.sqlite"), marker);
    const backup = await directory();
    backupHub(dir, backup);
    expect((await readdir(backup)).sort()).toEqual(["blobs", "hub.sqlite"]);
    expect((await readFile(join(backup, "hub.sqlite"), "utf8")).includes(marker)).toBe(false);
    expect((await readFile(join(backup, "hub.sqlite"))).includes(Buffer.from(BODY))).toBe(false);
    const restored = await directory();
    restoreHub(backup, restored);
    expect(envelopesOf(join(restored, "hub.sqlite"))).toEqual([envelope]);
    const again = await startHub(restored, { now: () => NOW });
    try {
      expect(
        await exchange(again.port, {
          op: "catch-up",
          clubId: "club-a",
          memberPublicKey: alice.publicKey,
          afterEventId: null,
          now: NOW,
          signature: signText(alice.privateKey, hubCatchUpMessage("club-a", null, NOW)),
        }),
      ).toEqual({ ok: true, envelopes: [envelope] });
      expect(again.admin("club-a").blobs).toEqual([{ hash, size: seeded.byteLength }]);
      expect(JSON.stringify(again.admin("club-a")).includes(BODY)).toBe(false);
    } finally {
      await again.close();
    }
  });

  it("applies caps from the hub command", async () => {
    const alice = await person();
    const bob = await person();
    const dir = await directory();
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, dir, "0", "1", "100"], {
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
      expect(
        await exchange(port, {
          op: "add-member",
          clubId: "club-a",
          memberPublicKey: bob.publicKey,
          creatorPublicKey: alice.publicKey,
          signature: signText(alice.privateKey, hubMemberMessage("club-a", bob.publicKey)),
        }),
      ).toEqual({ ok: false, error: LIMIT });
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
  });

  it("assigns a legacy blob to the only club and does not show it for another club", async () => {
    const alice = await person();
    const dir = await directory();
    const seeded = utf8ToBytes("legacy");
    const hash = bytesToHex(blake3(seeded));
    const created = new DatabaseSync(join(dir, "hub.sqlite"));
    created.exec(`
      CREATE TABLE hub_members (
        club_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (club_id, public_key)
      );
      CREATE TABLE hub_blobs (
        hash TEXT PRIMARY KEY NOT NULL,
        bytes BLOB NOT NULL,
        size INTEGER NOT NULL
      );
    `);
    created.prepare("INSERT INTO hub_members (club_id, public_key, role) VALUES (?, ?, 'creator')").run(
      "club-a",
      alice.publicKey,
    );
    created.prepare("INSERT INTO hub_blobs (hash, bytes, size) VALUES (?, ?, ?)").run(hash, seeded, seeded.byteLength);
    created.close();
    const hub = await startHub(dir, {});
    try {
      expect(hub.admin("club-a").blobs).toEqual([{ hash, size: seeded.byteLength }]);
      expect(hub.admin("club-b").blobs).toEqual([]);
      expect(JSON.stringify(hub.admin("club-a")).includes("legacy")).toBe(false);
    } finally {
      await hub.close();
    }
  });
});
