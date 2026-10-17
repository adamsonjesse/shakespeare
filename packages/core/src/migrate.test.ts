import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, UnknownSchemaVersionError } from "./migrate.ts";
import { MIGRATIONS, type Migration } from "./migrations.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";

const NOW = "2026-10-17T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
  const dir = await mkdtemp(join(tmpdir(), "shakespeare-migrate-"));
  directories.push(dir);
  const db = new DatabaseSync(join(dir, "test.db"));
  return {
    executor: openExecutor(db),
    close: () => {
      db.close();
    },
  };
}

describe("migrate", () => {
  it("applies version 1 on an empty database", async () => {
    const { executor, close } = await temporaryDatabase();
    try {
      const version = await migrate(executor, MIGRATIONS, { now: NOW });
      expect(version).toBe(5);
      const rows = await executor.select<{ version: number; applied_at: string }>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      );
      expect(rows).toEqual([
        { version: 1, applied_at: NOW },
        { version: 2, applied_at: NOW },
        { version: 3, applied_at: NOW },
        { version: 4, applied_at: NOW },
        { version: 5, applied_at: NOW },
      ]);
    } finally {
      close();
    }
  });

  it("does not record version 1 twice", async () => {
    const { executor, close } = await temporaryDatabase();
    try {
      await migrate(executor, MIGRATIONS, { now: NOW });
      await migrate(executor, MIGRATIONS, { now: NOW });
      const rows = await executor.select<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    } finally {
      close();
    }
  });

  it("rejects an unknown schema version without applying version 1", async () => {
    const { executor, close } = await temporaryDatabase();
    try {
      await executor.execute(
        `CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY NOT NULL,
          applied_at TEXT NOT NULL
        )`,
      );
      await executor.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        99,
        NOW,
      ]);
      await expect(migrate(executor, MIGRATIONS, { now: NOW })).rejects.toBeInstanceOf(
        UnknownSchemaVersionError,
      );
      const rows = await executor.select<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(rows).toEqual([{ version: 99 }]);
    } finally {
      close();
    }
  });

  it("rolls back a migration whose statement fails", async () => {
    const { executor, close } = await temporaryDatabase();
    try {
      const broken: readonly Migration[] = [
        {
          version: 1,
          statements: [
            `CREATE TABLE schema_migrations (
              version INTEGER PRIMARY KEY NOT NULL,
              applied_at TEXT NOT NULL
            )`,
            "CREATE TABLE half_applied (id INTEGER NOT NULL)",
            "NOT VALID SQL",
          ],
        },
      ];
      await expect(migrate(executor, broken, { now: NOW })).rejects.toThrow(/syntax/i);
      const tables = await executor.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      expect(tables).toEqual([]);
    } finally {
      close();
    }
  });

  it("migrates a version 1 database to version 2 and keeps the version 1 row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-migrate-v1-"));
    directories.push(dir);
    const original = join(dir, "v1.db");
    const created = new DatabaseSync(original);
    await migrate(
      openExecutor(created),
      MIGRATIONS.filter((migration) => migration.version === 1),
      { now: NOW },
    );
    created.close();

    const copy = join(dir, "copy.db");
    await copyFile(original, copy);
    const copied = new DatabaseSync(copy);
    try {
      const upgraded = openExecutor(copied);
      const version = await migrate(upgraded, MIGRATIONS, { now: "2026-10-18T00:00:00.000Z" });
      expect(version).toBe(5);
      const rows = await upgraded.select<{ version: number; applied_at: string }>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      );
      expect(rows).toEqual([
        { version: 1, applied_at: NOW },
        { version: 2, applied_at: "2026-10-18T00:00:00.000Z" },
        { version: 3, applied_at: "2026-10-18T00:00:00.000Z" },
        { version: 4, applied_at: "2026-10-18T00:00:00.000Z" },
        { version: 5, applied_at: "2026-10-18T00:00:00.000Z" },
      ]);
      const tables = await upgraded.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      expect(tables.map((table) => table.name)).toEqual([
        "blob_index",
        "bookmarks",
        "club_key_wraps",
        "clubs",
        "download_requests",
        "event_key_wraps",
        "events",
        "memberships",
        "read_state",
        "schema_migrations",
        "themes",
        "used_invites",
      ]);
    } finally {
      copied.close();
    }
  });

  it("migrates a version 2 database to version 3 and keeps earlier rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-migrate-v2-"));
    directories.push(dir);
    const original = join(dir, "v2.db");
    const created = new DatabaseSync(original);
    await migrate(
      openExecutor(created),
      MIGRATIONS.filter((migration) => migration.version <= 2),
      { now: NOW },
    );
    created.close();

    const copy = join(dir, "copy.db");
    await copyFile(original, copy);
    const copied = new DatabaseSync(copy);
    try {
      const upgraded = openExecutor(copied);
      const version = await migrate(upgraded, MIGRATIONS, { now: "2026-10-18T00:00:00.000Z" });
      expect(version).toBe(5);
      const rows = await upgraded.select<{ version: number; applied_at: string }>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      );
      expect(rows).toEqual([
        { version: 1, applied_at: NOW },
        { version: 2, applied_at: NOW },
        { version: 3, applied_at: "2026-10-18T00:00:00.000Z" },
        { version: 4, applied_at: "2026-10-18T00:00:00.000Z" },
        { version: 5, applied_at: "2026-10-18T00:00:00.000Z" },
      ]);
      const tables = await upgraded.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      expect(tables.map((table) => table.name)).toEqual([
        "blob_index",
        "bookmarks",
        "club_key_wraps",
        "clubs",
        "download_requests",
        "event_key_wraps",
        "events",
        "memberships",
        "read_state",
        "schema_migrations",
        "themes",
        "used_invites",
      ]);
    } finally {
      copied.close();
    }
  });

  it("migrates a version 3 database to version 4 and keeps earlier rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shakespeare-migrate-v3-"));
    directories.push(dir);
    const original = join(dir, "v3.db");
    const created = new DatabaseSync(original);
    await migrate(
      openExecutor(created),
      MIGRATIONS.filter((migration) => migration.version <= 3),
      { now: NOW },
    );
    created.close();

    const copy = join(dir, "copy.db");
    await copyFile(original, copy);
    const copied = new DatabaseSync(copy);
    try {
      const upgraded = openExecutor(copied);
      const version = await migrate(upgraded, MIGRATIONS, { now: "2026-10-18T00:00:00.000Z" });
      expect(version).toBe(5);
      const rows = await upgraded.select<{ version: number; applied_at: string }>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      );
      expect(rows).toEqual([
        { version: 1, applied_at: NOW },
        { version: 2, applied_at: NOW },
        { version: 3, applied_at: NOW },
        { version: 4, applied_at: "2026-10-18T00:00:00.000Z" },
        { version: 5, applied_at: "2026-10-18T00:00:00.000Z" },
      ]);
      const tables = await upgraded.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      expect(tables.map((table) => table.name)).toEqual([
        "blob_index",
        "bookmarks",
        "club_key_wraps",
        "clubs",
        "download_requests",
        "event_key_wraps",
        "events",
        "memberships",
        "read_state",
        "schema_migrations",
        "themes",
        "used_invites",
      ]);
    } finally {
      copied.close();
    }
  });
});
