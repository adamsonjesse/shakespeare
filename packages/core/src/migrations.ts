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
  {
    version: 3,
    statements: [
      `CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        club_id TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        parent_id TEXT,
        FOREIGN KEY (club_id) REFERENCES clubs (id)
      )`,
      `CREATE TABLE event_key_wraps (
        event_id TEXT NOT NULL,
        member_public_key TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        PRIMARY KEY (event_id, member_public_key),
        FOREIGN KEY (event_id) REFERENCES events (id)
      )`,
      `CREATE TABLE club_key_wraps (
        club_id TEXT NOT NULL,
        member_public_key TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        PRIMARY KEY (club_id, member_public_key),
        FOREIGN KEY (club_id) REFERENCES clubs (id)
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE read_state (
        event_id TEXT PRIMARY KEY NOT NULL,
        read_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events (id)
      )`,
      `CREATE TABLE bookmarks (
        event_id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events (id)
      )`,
      `CREATE TABLE themes (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        terms TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 5,
    statements: [
      `CREATE TABLE blob_index (
        hash TEXT PRIMARY KEY NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        verified_at TEXT NOT NULL
      )`,
      `CREATE TABLE download_requests (
        event_id TEXT NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('requested', 'verified', 'rejected')),
        PRIMARY KEY (event_id, path)
      )`,
    ],
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE outbox (
        id TEXT PRIMARY KEY NOT NULL,
        club_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
        FOREIGN KEY (club_id) REFERENCES clubs (id)
      )`,
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE TABLE theme_weights (
        theme_id TEXT PRIMARY KEY NOT NULL,
        weight INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (theme_id) REFERENCES themes (id)
      )`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT NOT NULL,
        tool TEXT NOT NULL,
        public_key TEXT NOT NULL,
        event_ids TEXT NOT NULL,
        result_code TEXT NOT NULL
      )`,
    ],
  },
];
