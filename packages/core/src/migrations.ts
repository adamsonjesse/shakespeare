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
  {
    version: 2,
    statements: [
      `CREATE TABLE clubs (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        creator_public_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE memberships (
        club_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('creator', 'member')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (club_id, public_key),
        FOREIGN KEY (club_id) REFERENCES clubs (id)
      )`,
      `CREATE TABLE used_invites (
        club_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        PRIMARY KEY (club_id, signature),
        FOREIGN KEY (club_id) REFERENCES clubs (id)
      )`,
    ],
  },
];
