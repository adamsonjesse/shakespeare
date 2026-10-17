import { mkdtemp, rm } from "node:fs/promises";
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
      expect(version).toBe(1);
      const rows = await executor.select<{ version: number; applied_at: string }>(
        "SELECT version, applied_at FROM schema_migrations",
      );
      expect(rows).toEqual([{ version: 1, applied_at: NOW }]);
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
        "SELECT version FROM schema_migrations",
      );
      expect(rows).toEqual([{ version: 1 }]);
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
});
