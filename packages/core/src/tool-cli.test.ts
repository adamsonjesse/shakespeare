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

const NOW = "2026-10-17T00:00:00.000Z";
const directories: string[] = [];
const root = fileURLToPath(new URL("../../../", import.meta.url));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tool cli", () => {
  it("prints an AI post and not the private key", async () => {
    const alice = await generateIdentity(new MemoryKeyStore());
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-tool-cli-"));
    directories.push(dir);
    const file = join(dir, "club.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    const executor: SqlExecutor = {
      async execute(sql: string, params: readonly SqlValue[] = []) {
        db.prepare(sql).run(...params);
      },
      async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
        return db.prepare(sql).all(...params) as Row[];
      },
    };
    await migrate(executor, MIGRATIONS, { now: NOW });
    await createClub(executor, {
      clubId: "club-a",
      name: "Alpha",
      creatorPublicKey: alice.publicKey,
      now: NOW,
    });
    db.close();
    const privateHex = Buffer.from(alice.privateKey).toString("hex");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "packages/core/src/tool-cli.ts",
        file,
        "post_message",
        JSON.stringify({ clubId: "club-a", body: "ai note", now: NOW, origin: "human" }),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SHAKESPEARE_PRIVATE_KEY: privateHex, NODE_NO_WARNINGS: "1" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"origin\":\"ai\"");
    expect(result.stdout).not.toContain(privateHex);
    expect(result.stderr).not.toContain(privateHex);
  });
});
