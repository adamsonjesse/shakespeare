/**
 * Milestone 3 ranker. Recency is a half-life decay from the injected clock.
 * A theme match doubles that score. The function does not read the clock or
 * a database, and it never sees ciphertext.
 */

export const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
const MATCH_WEIGHT = 2;

export interface RankInput {
  readonly id: string;
  readonly createdAt: string;
  readonly matchesTheme: boolean;
}

export interface ThreadItem extends RankInput {
  readonly parentId: string | null;
  readonly read: boolean;
}

export interface ThreadRow<T extends ThreadItem> {
  readonly item: T;
  readonly indent: 0 | 1;
}

export function rankItems<T extends RankInput>(
  items: readonly T[],
  now: string,
  halfLifeMs: number,
): T[] {
  return [...items].sort((left, right) => compareRank(left, right, now, halfLifeMs));
}

export function catchUpItems<T extends ThreadItem>(
  items: readonly T[],
  now: string,
  halfLifeMs: number,
): T[] {
  return rankItems(
    items.filter((item) => !item.read),
    now,
    halfLifeMs,
  );
}

export function threadMessages<T extends ThreadItem>(
  items: readonly T[],
  now: string,
  halfLifeMs: number,
): ThreadRow<T>[] {
  const present = new Set(items.map((item) => item.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    if (item.parentId !== null && present.has(item.parentId)) {
      const list = children.get(item.parentId) ?? [];
      list.push(item);
      children.set(item.parentId, list);
    } else {
      roots.push(item);
    }
  }
  for (const list of children.values()) {
    list.sort(byTimeThenId);
  }
  const ordered = [
    ...rankItems(roots.filter((item) => !item.read), now, halfLifeMs),
    ...rankItems(roots.filter((item) => item.read), now, halfLifeMs),
  ];
  const rows: ThreadRow<T>[] = [];
  const visit = (item: T, indent: 0 | 1): void => {
    rows.push({ item, indent });
    for (const child of children.get(item.id) ?? []) visit(child, 1);
  };
  for (const root of ordered) visit(root, 0);
  return rows;
}

export function textMatchesTheme(body: string, terms: readonly string[]): boolean {
  const haystack = body.toLowerCase();
  return terms.some((term) => {
    const needle = term.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

export function applyTheme<T extends { readonly verified: boolean; readonly body?: string }>(
  messages: readonly T[],
  terms: readonly string[] | null,
): T[] {
  if (terms === null) return [...messages];
  return messages.filter(
    (message) => message.verified && message.body !== undefined && textMatchesTheme(message.body, terms),
  );
}

function compareRank(left: RankInput, right: RankInput, now: string, halfLifeMs: number): number {
  const delta = score(right, now, halfLifeMs) - score(left, now, halfLifeMs);
  if (delta !== 0) return delta;
  return byTimeThenId(left, right);
}

function score(item: RankInput, now: string, halfLifeMs: number): number {
  const created = Date.parse(item.createdAt);
  const current = Date.parse(now);
  const age = Number.isFinite(created) && Number.isFinite(current) ? Math.max(0, current - created) : Number.POSITIVE_INFINITY;
  const recency = halfLifeMs > 0 && Number.isFinite(age) ? 0.5 ** (age / halfLifeMs) : 0;
  return recency * (item.matchesTheme ? MATCH_WEIGHT : 1);
}

function byTimeThenId(left: RankInput, right: RankInput): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}
