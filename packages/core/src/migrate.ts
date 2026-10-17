import type { Migration } from "./migrations.ts";
import type { SqlExecutor } from "./storage.ts";

export class UnknownSchemaVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Unknown schema version ${version}`);
    this.name = "UnknownSchemaVersionError";
    this.version = version;
  }
}

export interface MigrateOptions {
  /** Caller-supplied timestamp stored with each applied version. */
  readonly now: string;
}

interface VersionRow {
  readonly version: number;
}

interface TableNameRow {
  readonly name: string;
}

/**
 * Applies pending migrations in version order.
 * The runner does not log statement text or parameters.
 * Call it outside an existing transaction. A failed migration is rolled back.
 */
export async function migrate(
  db: SqlExecutor,
  migrations: readonly Migration[],
  options: MigrateOptions,
): Promise<number> {
  if (options.now.length === 0) {
    throw new Error("Migration timestamp is empty");
  }

  const ordered = orderedMigrations(migrations);
  const known = new Set(ordered.map((migration) => migration.version));
  const applied = await readAppliedVersions(db, known);

  let current = 0;
  for (const version of applied) {
    if (version > current) current = version;
  }

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    await applyMigration(db, migration, options.now);
    current = migration.version;
  }
  return current;
}

function orderedMigrations(migrations: readonly Migration[]): Migration[] {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Migration version ${String(migration.version)} is not a positive integer`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${String(migration.version)}`);
    }
    seen.add(migration.version);
  }
  return [...migrations].sort((left, right) => left.version - right.version);
}

async function readAppliedVersions(
  db: SqlExecutor,
  known: ReadonlySet<number>,
): Promise<Set<number>> {
  const tables = await db.select<TableNameRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (tables.length === 0) return new Set();

  const rows = await db.select<VersionRow>("SELECT version FROM schema_migrations");
  const applied = new Set<number>();
  for (const row of rows) {
    if (!known.has(row.version)) {
      throw new UnknownSchemaVersionError(row.version);
    }
    applied.add(row.version);
  }
  return applied;
}

async function applyMigration(db: SqlExecutor, migration: Migration, now: string): Promise<void> {
  await db.execute("BEGIN");
  try {
    for (const statement of migration.statements) {
      await db.execute(statement);
    }
    await db.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      migration.version,
      now,
    ]);
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // The statement error is the one to report.
    }
    throw error;
  }
}
