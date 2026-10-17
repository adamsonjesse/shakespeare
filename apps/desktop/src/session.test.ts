import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryKeyStore, type SqlExecutor, type SqlValue } from "@shakespeare/core";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, type ProfileHost } from "./session.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const LATER = "2026-10-18T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createHost(dir: string): {
  host: ProfileHost;
  paths: Map<string, string>;
  secrets: Uint8Array[];
  close: () => void;
} {
  const store = new MemoryKeyStore();
  const paths = new Map<string, string>();
  const secrets: Uint8Array[] = [];
  let current: DatabaseSync | null = null;
  const host: ProfileHost = {
    async listProfiles() {
      return [...paths.keys()];
    },
    async openProfile(publicKey: string): Promise<SqlExecutor> {
      if (current) current.close();
      let path = paths.get(publicKey);
      if (!path) {
        path = join(dir, `${publicKey}.db`);
        paths.set(publicKey, path);
      }
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys = ON");
      current = db;
      return {
        async execute(sql: string, params: readonly SqlValue[] = []) {
          db.prepare(sql).run(...params);
        },
        async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
          return db.prepare(sql).all(...params) as Row[];
        },
      };
    },
    async savePrivateKey(publicKey: string, privateKey: Uint8Array) {
      secrets.push(new Uint8Array(privateKey));
      await store.save(publicKey, privateKey);
    },
    loadPrivateKey: (publicKey: string) => store.load(publicKey),
  };
  return {
    host,
    paths,
    secrets,
    close: () => {
      current?.close();
      current = null;
    },
  };
}

describe("local profiles", () => {
  it("shows the accepting profile as a member and rejects a reused one-time invite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-"));
    directories.push(dir);
    const { host, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      const reusable = await session.issueInvite({ clubId, expiresAt: LATER, oneTime: false });
      const bob = await session.createProfile(NOW);
      const accepted = await session.acceptInvite(reusable, NOW);
      expect(accepted.deliveredLocally).toBe(true);
      expect((await session.listMembers(clubId)).map((member) => member.publicKey).sort()).toEqual(
        [alice, bob].sort(),
      );

      await session.openProfile(alice, NOW);
      expect((await session.listMembers(clubId)).map((member) => member.role).sort()).toEqual([
        "creator",
        "member",
      ]);

      const once = await session.issueInvite({ clubId, expiresAt: LATER, oneTime: true });
      const cara = await session.createProfile(NOW);
      await session.acceptInvite(once, NOW);
      const dylan = await session.createProfile(NOW);
      await expect(session.acceptInvite(once, NOW)).rejects.toMatchObject({ code: "used" });
      expect(await session.listMembers(clubId)).toEqual([]);

      await session.openProfile(alice, NOW);
      const members = await session.listMembers(clubId);
      expect(members.map((member) => member.publicKey).sort()).toEqual([alice, bob, cara].sort());
      expect(members.some((member) => member.publicKey === dylan)).toBe(false);

      await session.openProfile(bob, NOW);
      await expect(session.acceptInvite(`${reusable}tampered`, NOW)).rejects.toMatchObject({
        code: "malformed",
      });
      expect((await session.listMembers(clubId)).map((member) => member.publicKey).sort()).toEqual(
        [alice, bob].sort(),
      );
    } finally {
      close();
    }
  });

  it("keeps saved private keys out of every profile database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-secret-"));
    directories.push(dir);
    const { host, paths, secrets, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      const link = await session.issueInvite({ clubId, expiresAt: LATER, oneTime: false });
      await session.createProfile(NOW);
      await session.acceptInvite(link, NOW);
      await session.openProfile(alice, NOW);
      expect(secrets.length).toBeGreaterThan(0);
    } finally {
      close();
    }
    for (const path of paths.values()) {
      const bytes = readFileSync(path);
      for (const secret of secrets) {
        const hex = Buffer.from([...secret].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
        expect(bytes.includes(hex)).toBe(false);
      }
    }
  });

  it("delivers a human message to the other local profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-message-"));
    directories.push(dir);
    const { host, paths, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      const link = await session.issueInvite({ clubId, expiresAt: LATER, oneTime: false });
      const bob = await session.createProfile(NOW);
      await session.acceptInvite(link, NOW);
      await session.openProfile(alice, NOW);
      await session.sendMessage(clubId, "hello club", NOW);
      await session.openProfile(bob, NOW);
      const messages = await session.messages(clubId);
      expect(messages.map((message) => message.body)).toEqual(["hello club"]);
      expect(messages[0]?.authorPublicKey).toBe(alice);
      expect(session.currentPublicKey()).toBe(bob);
    } finally {
      close();
    }
    for (const path of paths.values()) {
      expect(readFileSync(path).includes(Buffer.from("hello club"))).toBe(false);
    }
  });
});
