export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/** Version 1 creates the bookkeeping table and nothing else. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    ],
  },
];
