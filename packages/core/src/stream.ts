import type { SqlExecutor } from "./storage.ts";

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly terms: readonly string[];
}

export class StreamError extends Error {
  constructor() {
    super("The theme is invalid.");
    this.name = "StreamError";
  }
}

export async function markRead(db: SqlExecutor, eventId: string, now: string): Promise<void> {
  await db.execute(
    `INSERT INTO read_state (event_id, read_at) VALUES (?, ?)
     ON CONFLICT(event_id) DO UPDATE SET read_at = excluded.read_at`,
    [eventId, now],
  );
}

export async function listReadIds(db: SqlExecutor): Promise<string[]> {
  const rows = await db.select<{ event_id: string }>(
    "SELECT event_id FROM read_state ORDER BY event_id",
  );
  return rows.map((row) => row.event_id);
}

export async function listUnreadIds(db: SqlExecutor, clubId: string): Promise<string[]> {
  const rows = await db.select<{ id: string }>(
    `SELECT events.id FROM events
     WHERE events.club_id = ?
       AND NOT EXISTS (SELECT 1 FROM read_state WHERE read_state.event_id = events.id)
     ORDER BY events.id`,
    [clubId],
  );
  return rows.map((row) => row.id);
}

export async function addBookmark(db: SqlExecutor, eventId: string, now: string): Promise<void> {
  await db.execute(
    `INSERT INTO bookmarks (event_id, created_at) VALUES (?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
    [eventId, now],
  );
}

export async function listBookmarkIds(db: SqlExecutor): Promise<string[]> {
  const rows = await db.select<{ event_id: string }>(
    "SELECT event_id FROM bookmarks ORDER BY created_at, event_id",
  );
  return rows.map((row) => row.event_id);
}

export async function saveTheme(
  db: SqlExecutor,
  theme: { readonly id: string; readonly name: string; readonly terms: readonly string[] },
): Promise<void> {
  const name = theme.name.trim();
  const terms = theme.terms.map((term) => term.trim()).filter((term) => term.length > 0);
  if (!isThemeId(theme.id) || name.length < 1 || name.length > 40 || hasControlCharacter(name)) {
    throw new StreamError();
  }
  if (terms.length < 1 || terms.some((term) => term.length > 40 || hasControlCharacter(term))) {
    throw new StreamError();
  }
  await db.execute(
    `INSERT INTO themes (id, name, terms) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, terms = excluded.terms`,
    [theme.id, name, JSON.stringify(terms)],
  );
}

export async function listThemes(db: SqlExecutor): Promise<Theme[]> {
  const rows = await db.select<{ id: string; name: string; terms: string }>(
    "SELECT id, name, terms FROM themes ORDER BY name, id",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    terms: parseTerms(row.terms),
  }));
}

export async function listThemeWeights(db: SqlExecutor): Promise<Record<string, number>> {
  const rows = await db.select<{ theme_id: string; weight: number }>(
    "SELECT theme_id, weight FROM theme_weights",
  );
  const weights: Record<string, number> = {};
  for (const row of rows) weights[row.theme_id] = row.weight;
  return weights;
}

export async function bumpThemeWeights(
  db: SqlExecutor,
  themeIds: readonly string[],
  now: string,
): Promise<void> {
  for (const themeId of themeIds) {
    if (!isThemeId(themeId)) continue;
    await db.execute(
      `INSERT INTO theme_weights (theme_id, weight, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(theme_id) DO UPDATE SET weight = weight + 1, updated_at = excluded.updated_at`,
      [themeId, now],
    );
  }
}

function parseTerms(stored: string): string[] {
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed) || parsed.some((term) => typeof term !== "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

function isThemeId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
