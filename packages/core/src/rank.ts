/**
 * Milestone 3 ranker. Recency is a half-life decay from the injected clock.
 * A theme match doubles that score. The function does not read the clock or
 * a database, and it never sees ciphertext.
 */

export const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
export const READ_DWELL_MS = 2000;
const MATCH_WEIGHT = 2;
const THEME_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RankInput {
  readonly id: string;
  readonly createdAt: string;
  readonly matchesTheme: boolean;
  readonly themeIds?: readonly string[];
}

export type ThemeWeights = Readonly<Record<string, number>>;

export interface AssistWeight {
  readonly themeId: string;
  readonly weight: number;
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
  weights: ThemeWeights = {},
): T[] {
  return [...items].sort((left, right) => compareRank(left, right, now, halfLifeMs, weights));
}

export function catchUpItems<T extends ThreadItem>(
  items: readonly T[],
  now: string,
  halfLifeMs: number,
  weights: ThemeWeights = {},
): T[] {
  return rankItems(
    items.filter((item) => !item.read),
    now,
    halfLifeMs,
    weights,
  );
}

export function readWeightDelta(startedAt: string, now: string): number {
  const elapsed = Date.parse(now) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < READ_DWELL_MS) return 0;
  return 1;
}

export function matchingThemeIds(
  body: string,
  themes: readonly { readonly id: string; readonly terms: readonly string[] }[],
): string[] {
  return themes.filter((theme) => textMatchesTheme(body, theme.terms)).map((theme) => theme.id);
}

export function assistPayload(
  publicKey: string,
  weights: readonly { readonly themeId: string; readonly weight: number; readonly body?: string }[],
): { readonly op: "publish-weights"; readonly publicKey: string; readonly weights: AssistWeight[] } {
  return { op: "publish-weights", publicKey, weights: normalizeWeights(weights) };
}

export function mergeWeights(
  local: ThemeWeights,
  remote: readonly { readonly themeId: string; readonly weight: number; readonly body?: string }[],
  enabled: boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [themeId, weight] of Object.entries(local)) {
    if (THEME_ID.test(themeId) && typeof weight === "number" && Number.isInteger(weight) && weight > 0) {
      out[themeId] = weight;
    }
  }
  if (!enabled) return out;
  for (const row of normalizeWeights(remote)) {
    out[row.themeId] = Math.max(out[row.themeId] ?? 0, row.weight);
  }
  return out;
}

export function threadMessages<T extends ThreadItem>(
  items: readonly T[],
  now: string,
  halfLifeMs: number,
  weights: ThemeWeights = {},
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
    ...rankItems(roots.filter((item) => !item.read), now, halfLifeMs, weights),
    ...rankItems(roots.filter((item) => item.read), now, halfLifeMs, weights),
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

export function excludeOrigin<T extends { readonly verified: boolean; readonly origin?: "human" | "ai" }>(
  messages: readonly T[],
  origin: "human" | "ai" | null,
): T[] {
  if (origin === null) return [...messages];
  return messages.filter((message) => message.verified && message.origin !== origin);
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

function compareRank(
  left: RankInput,
  right: RankInput,
  now: string,
  halfLifeMs: number,
  weights: ThemeWeights,
): number {
  const delta = score(right, now, halfLifeMs, weights) - score(left, now, halfLifeMs, weights);
  if (delta !== 0) return delta;
  return byTimeThenId(left, right);
}

function score(item: RankInput, now: string, halfLifeMs: number, weights: ThemeWeights): number {
  const created = Date.parse(item.createdAt);
  const current = Date.parse(now);
  const age = Number.isFinite(created) && Number.isFinite(current) ? Math.max(0, current - created) : Number.POSITIVE_INFINITY;
  const recency = halfLifeMs > 0 && Number.isFinite(age) ? 0.5 ** (age / halfLifeMs) : 0;
  return recency * (item.matchesTheme ? MATCH_WEIGHT : 1) * (1 + themeWeight(item, weights));
}

function themeWeight(item: RankInput, weights: ThemeWeights): number {
  let total = 0;
  for (const themeId of item.themeIds ?? []) {
    const weight = weights[themeId];
    if (typeof weight === "number" && Number.isInteger(weight) && weight > 0) total += weight;
  }
  return total;
}

function normalizeWeights(
  weights: readonly { readonly themeId: string; readonly weight: number; readonly body?: string }[],
): AssistWeight[] {
  const rows: AssistWeight[] = [];
  for (const row of weights) {
    if (!THEME_ID.test(row.themeId) || !Number.isInteger(row.weight) || row.weight < 0 || row.weight > 1000) continue;
    rows.push({ themeId: row.themeId, weight: row.weight });
  }
  rows.sort((left, right) => (left.themeId < right.themeId ? -1 : left.themeId > right.themeId ? 1 : 0));
  return rows;
}

function byTimeThenId(left: RankInput, right: RankInput): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}
