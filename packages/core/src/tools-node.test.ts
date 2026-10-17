import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity, MemoryKeyStore } from "./identity.ts";
import { createClub } from "./membership.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";
import type { ToolContext } from "./tools.ts";
import { startToolServer } from "./tools-node.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const directories: string[] = [];
const root = fileURLToPath(new URL("../../../", import.meta.url));

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

async function clubContext(): Promise<{ ctx: ToolContext; close: () => void; privateHex: string }> {
  const alice = await generateIdentity(new MemoryKeyStore());
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-tool-server-"));
  directories.push(dir);
  const db = new DatabaseSync(join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  const executor = openExecutor(db);
  await migrate(executor, MIGRATIONS, { now: NOW });
  await createClub(executor, {
    clubId: "club-a",
    name: "Alpha",
    creatorPublicKey: alice.publicKey,
    now: NOW,
  });
  let closed = false;
  return {
    ctx: { db: executor, author: alice, now: () => NOW },
    privateHex: Buffer.from(alice.privateKey).toString("hex"),
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

describe("loopback tool server", () => {
  it("refuses a non-loopback bind", async () => {
    const fixture = await clubContext();
    try {
      await expect(startToolServer({ host: "0.0.0.0", context: fixture.ctx })).rejects.toThrow(/not allowed/);
    } finally {
      fixture.close();
    }
  });

  it("answers tools on 127.0.0.1 and forces an AI post", async () => {
    const fixture = await clubContext();
    const server = await startToolServer({ context: fixture.ctx });
    try {
      expect(server.host).toBe("127.0.0.1");
      const listed = await rpc(server.port, "tools/list", {});
      expect(JSON.stringify(listed)).not.toContain("\"origin\"");
      expect(JSON.stringify(listed)).not.toContain("export");
      const posted = await rpc(server.port, "tools/call", {
        name: "post_message",
        arguments: { clubId: "club-a", body: "ai note", now: NOW, origin: "human" },
      });
      expect(posted.result).toMatchObject({ origin: "ai" });
      expect(JSON.stringify(posted)).not.toContain(fixture.privateHex);
      expect(JSON.stringify(posted)).not.toContain("ai note");
    } finally {
      await server.close();
      fixture.close();
    }
  });

  it("runs the example script against a temporary profile", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "packages/core/src/example-club-tools.ts"],
      { cwd: root, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"listen\":\"127.0.0.1\"");
    expect(result.stdout).toContain("\"origin\":\"ai\"");
    expect(result.stderr).toBe("");
  });
});

async function rpc(port: number, method: string, params: unknown): Promise<{ result?: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: unknown };
}
