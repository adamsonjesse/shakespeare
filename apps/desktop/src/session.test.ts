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
  folders: Map<string, { path: string; bytes: Uint8Array }[]>;
  blobs: Map<string, Uint8Array>;
  outputs: Map<string, Uint8Array>;
  blobReads: string[];
  relay: { up: boolean; calls: string[] };
  close: () => void;
} {
  const store = new MemoryKeyStore();
  const paths = new Map<string, string>();
  const secrets: Uint8Array[] = [];
  const folders = new Map<string, { path: string; bytes: Uint8Array }[]>();
  const blobs = new Map<string, Uint8Array>();
  const outputs = new Map<string, Uint8Array>();
  const blobReads: string[] = [];
  const relay = { up: false, calls: [] as string[] };
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
    async readFolder(path: string) {
      return (folders.get(path) ?? []).map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) }));
    },
    async readBlob(publicKey: string, hash: string) {
      blobReads.push(hash);
      const found = blobs.get(`${publicKey}/${hash}`);
      return found ? new Uint8Array(found) : null;
    },
    async writeBlob(publicKey: string, hash: string, bytes: Uint8Array) {
      blobs.set(`${publicKey}/${hash}`, new Uint8Array(bytes));
    },
    async removeBlob(publicKey: string, hash: string) {
      blobs.delete(`${publicKey}/${hash}`);
    },
    async writeOutput(publicKey: string, path: string, bytes: Uint8Array) {
      outputs.set(`${publicKey}/${path}`, new Uint8Array(bytes));
    },
    async removeOutput(publicKey: string, path: string) {
      outputs.delete(`${publicKey}/${path}`);
    },
    async relayExchange(_host: string, _port: number, request: string) {
      relay.calls.push(request);
      if (!relay.up) throw new Error("The hub is not reachable.");
      const body = JSON.parse(request) as { op?: string };
      if (body.op === "catch-up") return JSON.stringify({ ok: true, envelopes: [] });
      return JSON.stringify({ ok: true });
    },
  };
  return {
    host,
    paths,
    secrets,
    folders,
    blobs,
    outputs,
    blobReads,
    relay,
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

  it("keeps a reply, bookmark, and read mark on the profile that set them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-stream-"));
    directories.push(dir);
    const { host, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      await session.sendMessage(clubId, "hello club", NOW);
      const first = (await session.messages(clubId))[0];
      if (!first) throw new Error("missing message");
      await session.sendMessage(clubId, "a reply", LATER, first.id);
      await session.bookmark(first.id, LATER);
      await session.markRead(first.id, LATER);
      await session.saveTheme("Focus", ["runway"]);
      const messages = await session.messages(clubId);
      expect(messages[1]?.parentId).toBe(first.id);
      expect(messages[1]?.body).toBe("a reply");
      expect(await session.bookmarkIds()).toEqual([first.id]);
      expect(await session.readIds()).toEqual([first.id]);
      expect(await session.themes()).toEqual([{ id: expect.any(String), name: "Focus", terms: ["runway"] }]);
      await session.openProfile(alice, LATER);
      expect(await session.bookmarkIds()).toEqual([first.id]);
      expect(await session.readIds()).toEqual([first.id]);
      expect((await session.themes()).map((theme) => theme.name)).toEqual(["Focus"]);
    } finally {
      close();
    }
  });

  it("offers a folder and downloads only the selected file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-files-"));
    directories.push(dir);
    const { host, folders, blobs, outputs, blobReads, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      const link = await session.issueInvite({ clubId, expiresAt: LATER, oneTime: false });
      const bob = await session.createProfile(NOW);
      await session.acceptInvite(link, NOW);
      await session.openProfile(alice, NOW);
      folders.set(join(dir, "offer"), [
        { path: "a.txt", bytes: Uint8Array.from([1, 2, 3]) },
        { path: "b.txt", bytes: Uint8Array.from([4, 5, 6]) },
      ]);
      await session.offerFolder(clubId, join(dir, "offer"), "notes", NOW);
      await session.openProfile(bob, NOW);
      const messages = await session.messages(clubId);
      const offer = messages.find((message) => message.body?.includes("notes"));
      if (!offer?.body) throw new Error("missing offer");
      expect(offer.body.includes("a.txt")).toBe(true);
      expect(outputs.size).toBe(0);
      await session.downloadShared(offer.id, "b.txt", alice, LATER);
      expect([...outputs.keys()]).toEqual([`${bob}/b.txt`]);
      expect([...blobs.keys()].filter((key) => key.startsWith(`${bob}/`))).toHaveLength(1);
      expect(blobReads.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("keeps a hub send pending while the hub is down and flushes it after sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-hub-"));
    directories.push(dir);
    const { host, paths, relay, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      session.configureHub("10.0.2.2", 8787);
      expect(() => session.configureHub("192.168.1.20", 8787)).toThrow(/not allowed/);
      session.configureHub("127.0.0.1", 8787);
      await session.sendMessage(clubId, "hello club", NOW);
      close();
      const path = paths.get(alice);
      if (!path) throw new Error("missing profile");
      const pending = new DatabaseSync(path);
      try {
        const rows = pending.prepare("SELECT state FROM outbox").all() as { state: string }[];
        expect(rows).toEqual([{ state: "pending" }]);
      } finally {
        pending.close();
      }
      await session.openProfile(alice, LATER);
      relay.up = true;
      await session.syncHub(LATER);
      close();
      const flushed = new DatabaseSync(path);
      try {
        const rows = flushed.prepare("SELECT state FROM outbox").all() as { state: string }[];
        expect(rows).toEqual([{ state: "sent" }]);
      } finally {
        flushed.close();
      }
      expect(relay.calls.some((call) => call.includes("submit-envelope"))).toBe(true);
      expect(relay.calls.some((call) => call.includes("hello club"))).toBe(false);
    } finally {
      close();
    }
  });

  it("raises a theme weight after a bookmark and leaves another profile unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-session-rank-"));
    directories.push(dir);
    const { host, close } = createHost(dir);
    try {
      const session = createSession(host);
      const alice = await session.createProfile(NOW);
      const clubId = await session.createClub("Alpha", NOW);
      await session.saveTheme("Alpha", ["alpha"]);
      const theme = (await session.themes())[0];
      if (!theme) throw new Error("missing theme");
      await session.sendMessage(clubId, "alpha note", NOW);
      const message = (await session.messages(clubId))[0];
      if (!message) throw new Error("missing message");
      await session.bookmark(message.id, NOW);
      expect(await session.themeWeights()).toEqual({ [theme.id]: 1 });
      await session.createProfile(LATER);
      expect(await session.themeWeights()).toEqual({});
      await session.openProfile(alice, LATER);
      expect(await session.themeWeights()).toEqual({ [theme.id]: 1 });
    } finally {
      close();
    }
  });
});
