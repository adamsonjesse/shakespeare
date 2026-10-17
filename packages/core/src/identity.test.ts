import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateIdentity, loadIdentity, MemoryKeyStore } from "./identity.ts";
import { createInvite, inviteLink, type InviteClaims } from "./invite.ts";
import {
  acceptInvite,
  applyAcceptance,
  createClub,
  listMembers,
  MembershipError,
  serializeAcceptance,
} from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";
import { TestLoopback } from "./test-loopback.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const LATER = "2026-10-18T00:00:00.000Z";
const EARLIER = "2026-10-16T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
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
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-identity-"));
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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeToken(token: string): Record<string, unknown> {
  const payload = token.startsWith("shakespeare://invite#")
    ? token.slice("shakespeare://invite#".length)
    : token;
  const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function encodeToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function person(): Promise<{ publicKey: string; privateKey: Uint8Array }> {
  return generateIdentity(new MemoryKeyStore());
}

describe("identity", () => {
  it("stores a private key that derives the same public key", async () => {
    const store = new MemoryKeyStore();
    const created = await generateIdentity(store);
    const loaded = await loadIdentity(store, created.publicKey);
    expect(loaded.publicKey).toBe(created.publicKey);
    expect(hex(loaded.privateKey)).toBe(hex(created.privateKey));
    expect(created.publicKey).toMatch(/^[0-9a-f]{64}$/);

    const other = await generateIdentity(new MemoryKeyStore());
    expect(other.publicKey).not.toBe(created.publicKey);
  });
});

describe("invites", () => {
  it("accepts a valid invite and rejects expiry, tampering, and malformed tokens", async () => {
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
      await createClub(aliceDb.executor, {
        clubId: "club-b",
        name: "Beta",
        creatorPublicKey: alice.publicKey,
        now: NOW,
      });
      const claims: InviteClaims = {
        clubId: "club-a",
        inviterPublicKey: alice.publicKey,
        expiresAt: LATER,
        oneTime: false,
      };
      const token = await createInvite(alice.privateKey, claims);
      expect(inviteLink(token)).toBe(`shakespeare://invite#${token}`);
      expect(decodeToken(token).clubId).toBe("club-a");

      await acceptInvite(bobDb.executor, bob, inviteLink(token), NOW);
      expect(await membershipSet(bobDb.executor, "club-a")).toEqual(
        sortedMembers([
          { publicKey: alice.publicKey, role: "creator" },
          { publicKey: bob.publicKey, role: "member" },
        ]),
      );
      expect(await membershipSet(bobDb.executor, "club-b")).toEqual([]);

      const expired = await createInvite(alice.privateKey, { ...claims, expiresAt: NOW });
      const atExpiry = await temporaryDatabase();
      const beforeExpiry = await temporaryDatabase();
      const afterExpiry = await temporaryDatabase();
      try {
        await expect(acceptInvite(atExpiry.executor, bob, expired, NOW)).rejects.toMatchObject({
          code: "expired",
        });
        expect(await membershipSet(atExpiry.executor, "club-a")).toEqual([]);
        await acceptInvite(beforeExpiry.executor, bob, expired, EARLIER);
        expect(await membershipSet(beforeExpiry.executor, "club-a")).toEqual(
          sortedMembers([
            { publicKey: alice.publicKey, role: "creator" },
            { publicKey: bob.publicKey, role: "member" },
          ]),
        );
        const alreadyOver = await createInvite(alice.privateKey, { ...claims, expiresAt: EARLIER });
        await expect(acceptInvite(afterExpiry.executor, bob, alreadyOver, NOW)).rejects.toMatchObject({
          code: "expired",
        });
        expect(await membershipSet(afterExpiry.executor, "club-a")).toEqual([]);
      } finally {
        atExpiry.close();
        beforeExpiry.close();
        afterExpiry.close();
      }

      for (const field of ["clubId", "expiresAt", "inviterPublicKey", "oneTime"] as const) {
        const edited = decodeToken(token);
        if (field === "clubId") edited.clubId = "club-b";
        if (field === "expiresAt") edited.expiresAt = "2026-10-19T00:00:00.000Z";
        if (field === "inviterPublicKey") edited.inviterPublicKey = bob.publicKey;
        if (field === "oneTime") edited.oneTime = true;
        await expect(acceptInvite(bobDb.executor, bob, encodeToken(edited), NOW)).rejects.toMatchObject({
          code: "bad-signature",
        });
      }

      await expect(acceptInvite(bobDb.executor, bob, "", NOW)).rejects.toMatchObject({
        code: "malformed",
      });
      await expect(acceptInvite(bobDb.executor, bob, encodeToken({ clubId: "club-a" }), NOW)).rejects.toMatchObject({
        code: "malformed",
      });
      await expect(acceptInvite(bobDb.executor, bob, hex(alice.privateKey), NOW)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof MembershipError &&
          error.code === "malformed" &&
          !error.message.includes(hex(alice.privateKey)),
      );
      expect(await membershipSet(bobDb.executor, "club-b")).toEqual([]);
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });

  it("lets the creator keep only the first acceptance of a one-time invite", async () => {
    const alice = await person();
    const bob = await person();
    const cara = await person();
    const aliceDb = await temporaryDatabase();
    const bobDb = await temporaryDatabase();
    const caraDb = await temporaryDatabase();
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
        expiresAt: LATER,
        oneTime: true,
      });
      const first = await acceptInvite(bobDb.executor, bob, token, NOW);
      await expect(acceptInvite(bobDb.executor, bob, token, NOW)).rejects.toMatchObject({ code: "used" });

      const transport = new TestLoopback();
      transport.send(alice.publicKey, serializeAcceptance(first));
      const second = await acceptInvite(caraDb.executor, cara, token, NOW);
      transport.send(alice.publicKey, serializeAcceptance(second));
      const deliveries = transport.receive(alice.publicKey);
      expect(deliveries).toHaveLength(2);
      const firstDelivery = deliveries[0];
      const secondDelivery = deliveries[1];
      if (firstDelivery === undefined || secondDelivery === undefined) {
        throw new Error("missing delivery");
      }
      await applyAcceptance(aliceDb.executor, firstDelivery, NOW);
      await expect(applyAcceptance(aliceDb.executor, secondDelivery, NOW)).rejects.toMatchObject({
        code: "used",
      });
      expect(await membershipSet(aliceDb.executor, "club-a")).toEqual(
        sortedMembers([
          { publicKey: alice.publicKey, role: "creator" },
          { publicKey: bob.publicKey, role: "member" },
        ]),
      );
      expect(await membershipSet(bobDb.executor, "club-a")).toEqual(
        sortedMembers([
          { publicKey: alice.publicKey, role: "creator" },
          { publicKey: bob.publicKey, role: "member" },
        ]),
      );
    } finally {
      aliceDb.close();
      bobDb.close();
      caraDb.close();
    }
  });

  it("keeps private key bytes out of the invite, the database, and logs", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(" "));
      });
    }
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
        expiresAt: LATER,
        oneTime: false,
      });
      const acceptance = await acceptInvite(bobDb.executor, bob, token, NOW);
      const transport = new TestLoopback();
      const envelope = serializeAcceptance(acceptance);
      transport.send(alice.publicKey, envelope);
      const delivered = transport.receive(alice.publicKey)[0];
      if (delivered === undefined) throw new Error("missing delivery");
      await applyAcceptance(aliceDb.executor, delivered, NOW);

      aliceDb.close();
      bobDb.close();
      const secretHex = hex(alice.privateKey);
      const secretBytes = Buffer.from(alice.privateKey);
      for (const text of [token, envelope, ...logs]) {
        expect(text.includes(secretHex)).toBe(false);
      }
      for (const path of [aliceDb.path, bobDb.path]) {
        const bytes = readFileSync(path);
        expect(bytes.includes(secretBytes)).toBe(false);
        expect(bytes.includes(Buffer.from(secretHex))).toBe(false);
      }
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });
});

function sortedMembers(
  members: { publicKey: string; role: string }[],
): { publicKey: string; role: string }[] {
  return [...members].sort((left, right) => (left.publicKey < right.publicKey ? -1 : 1));
}

async function membershipSet(
  db: SqlExecutor,
  clubId: string,
): Promise<{ publicKey: string; role: string }[]> {
  const members = await listMembers(db, clubId);
  return sortedMembers(members.map((member) => ({ publicKey: member.publicKey, role: member.role })));
}
