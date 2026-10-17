import { blake3 } from "@noble/hashes/blake3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { importEnvelope } from "./events.ts";
import { isClubId, isPublicKey, isTimestamp, signText, verifyQuiet } from "./invite.ts";
import { listClubs, listMembers } from "./membership.ts";
import { assistPayload, type AssistWeight } from "./rank.ts";
import type { SqlExecutor } from "./storage.ts";

/**
 * Club events move on a local framed channel. The hub stores opaque envelopes
 * and voluntarily seeded blobs. It does not decrypt message bodies.
 */

export const MAX_FRAME = 1_048_576;
const MAX_BLOB = 256 * 1024;
const SKEW_MS = 10 * 60 * 1000;

const RELAY_MESSAGES = {
  proof: "That membership proof is not valid.",
  rejected: "The hub rejected that envelope.",
  forbidden: "The request is not allowed.",
  unreachable: "The hub is not reachable.",
  hash: "The file hash did not match.",
} as const;

export type RelayErrorCode = keyof typeof RELAY_MESSAGES;

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode) {
    super(RELAY_MESSAGES[code]);
    this.name = "RelayError";
    this.code = code;
  }
}

export type RelayResponse =
  | { readonly ok: true; readonly envelopes?: readonly string[]; readonly weights?: readonly AssistWeight[] }
  | { readonly ok: false; readonly error: string };

export interface HubDb {
  getCreator(clubId: string): Promise<string | null>;
  listMemberKeys(clubId: string): Promise<readonly string[]>;
  addMember(clubId: string, publicKey: string, role: "creator" | "member"): Promise<void>;
  saveEnvelope(input: {
    readonly eventId: string;
    readonly clubId: string;
    readonly receivedAt: string;
    readonly envelope: string;
  }): Promise<void>;
  listEnvelopes(clubId: string): Promise<readonly { readonly eventId: string; readonly envelope: string }[]>;
  saveBlob(hash: string, bytes: Uint8Array): Promise<void>;
  replaceWeights(publicKey: string, weights: readonly AssistWeight[]): Promise<void>;
  listWeights(publicKey: string): Promise<readonly AssistWeight[]>;
}

export function hubCreateMessage(clubId: string, creatorPublicKey: string): string {
  return `shakespeare-hub-v1\ncreate\n${clubId}\n${creatorPublicKey}`;
}

export function hubMemberMessage(clubId: string, memberPublicKey: string): string {
  return `shakespeare-hub-v1\nmember\n${clubId}\n${memberPublicKey}`;
}

export function hubSubmitMessage(envelope: string): string {
  return `shakespeare-hub-v1\nsubmit\n${envelope}`;
}

export function hubCatchUpMessage(clubId: string, afterEventId: string | null, now: string): string {
  return `shakespeare-hub-v1\ncatch-up\n${clubId}\n${afterEventId ?? ""}\n${now}`;
}

export function hubSeedMessage(clubId: string, hash: string): string {
  return `shakespeare-hub-v1\nseed\n${clubId}\n${hash}`;
}

export function hubWeightsMessage(publicKey: string, weights: readonly AssistWeight[]): string {
  const body = weights.map((row) => `${row.themeId} ${row.weight}`).join("\n");
  return `shakespeare-hub-v1\nweights\n${publicKey}\n${body}`;
}

export function hubFetchWeightsMessage(publicKey: string): string {
  return `shakespeare-hub-v1\nfetch-weights\n${publicKey}`;
}

export function signedWeightPublish(
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
  weights: readonly { readonly themeId: string; readonly weight: number; readonly body?: string }[],
): { readonly op: "publish-weights"; readonly publicKey: string; readonly weights: AssistWeight[]; readonly signature: string } {
  const payload = assistPayload(author.publicKey, weights);
  return {
    ...payload,
    signature: signText(author.privateKey, hubWeightsMessage(author.publicKey, payload.weights)),
  };
}

export function signedWeightFetch(
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
): { readonly op: "fetch-weights"; readonly publicKey: string; readonly signature: string } {
  return {
    op: "fetch-weights",
    publicKey: author.publicKey,
    signature: signText(author.privateKey, hubFetchWeightsMessage(author.publicKey)),
  };
}

export function encodeFrame(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  if (body.length > MAX_FRAME) throw new RelayError("forbidden");
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

export function readRelayResponse(value: unknown): RelayResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return forbiddenResponse();
  if (value.ok) {
    const response: { ok: true; envelopes?: readonly string[]; weights?: readonly AssistWeight[] } = { ok: true };
    if (value.envelopes !== undefined) {
      if (!Array.isArray(value.envelopes) || value.envelopes.some((entry) => typeof entry !== "string")) {
        return forbiddenResponse();
      }
      response.envelopes = value.envelopes;
    }
    if (value.weights !== undefined) {
      if (!Array.isArray(value.weights)) return forbiddenResponse();
      const weights: AssistWeight[] = [];
      for (const row of value.weights) {
        if (!isRecord(row) || typeof row.themeId !== "string" || typeof row.weight !== "number") return forbiddenResponse();
        if (Object.keys(row).some((key) => key !== "themeId" && key !== "weight")) return forbiddenResponse();
        weights.push({ themeId: row.themeId, weight: row.weight });
      }
      response.weights = weights;
    }
    return response;
  }
  if (typeof value.error !== "string" || !allowedError(value.error)) return forbiddenResponse();
  return { ok: false, error: value.error };
}

export async function handleHubRequest(db: HubDb, request: unknown, now: string): Promise<RelayResponse> {
  if (!isRecord(request) || typeof request.op !== "string") return forbiddenResponse();
  if (request.op === "create-club") return createClub(db, request);
  if (request.op === "add-member") return addMember(db, request);
  if (request.op === "submit-envelope") return submitEnvelope(db, request, now);
  if (request.op === "catch-up") return catchUp(db, request, now);
  if (request.op === "seed-blob") return seedBlob(db, request);
  if (request.op === "publish-weights") return publishWeights(db, request);
  if (request.op === "fetch-weights") return fetchWeights(db, request);
  return forbiddenResponse();
}

export async function handleDirectRequest(db: SqlExecutor, request: unknown): Promise<RelayResponse> {
  if (!isRecord(request) || request.op !== "deliver") return forbiddenResponse();
  const envelope = request.envelope;
  const signature = request.signature;
  if (typeof envelope !== "string" || typeof signature !== "string") return rejectedResponse();
  const opened = opaqueEnvelope(envelope);
  if (!opened || !verifyQuiet(signature, hubSubmitMessage(envelope), opened.authorPublicKey)) {
    return rejectedResponse();
  }
  const members = await db.select<{ public_key: string }>(
    "SELECT public_key FROM memberships WHERE club_id = ? AND public_key = ?",
    [opened.clubId, opened.authorPublicKey],
  );
  if (members.length === 0) return rejectedResponse();
  try {
    await importEnvelope(db, envelope);
  } catch {
    return rejectedResponse();
  }
  return { ok: true };
}

export async function enqueueOutbox(
  db: SqlExecutor,
  row: { readonly id: string; readonly clubId: string; readonly envelope: string; readonly now: string },
): Promise<void> {
  await db.execute(
    "INSERT OR IGNORE INTO outbox (id, club_id, envelope, created_at, state) VALUES (?, ?, ?, ?, 'pending')",
    [row.id, row.clubId, row.envelope, row.now],
  );
}

export async function listPendingOutbox(
  db: SqlExecutor,
): Promise<{ readonly id: string; readonly envelope: string }[]> {
  return db.select<{ id: string; envelope: string }>(
    "SELECT id, envelope FROM outbox WHERE state = 'pending' ORDER BY created_at, id",
  );
}

export async function settleLocalOutbox(db: SqlExecutor): Promise<void> {
  await db.execute("UPDATE outbox SET state = 'sent' WHERE state = 'pending'");
}

export async function flushOutbox(
  db: SqlExecutor,
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
  call: (request: unknown) => Promise<RelayResponse>,
): Promise<void> {
  const pending = await listPendingOutbox(db);
  for (const row of pending) {
    const response = await call({
      op: "submit-envelope",
      envelope: row.envelope,
      signature: signText(author.privateKey, hubSubmitMessage(row.envelope)),
    });
    assertOk(response);
    await db.execute("UPDATE outbox SET state = 'sent' WHERE id = ?", [row.id]);
  }
}

export async function syncWithHub(input: {
  readonly db: SqlExecutor;
  readonly author: { readonly publicKey: string; readonly privateKey: Uint8Array };
  readonly now: string;
  readonly call: (request: unknown) => Promise<RelayResponse>;
}): Promise<void> {
  const clubs = await listClubs(input.db);
  for (const club of clubs) {
    const members = await listMembers(input.db, club.id);
    const self = members.find((member) => member.publicKey === input.author.publicKey);
    if (self?.role !== "creator") continue;
    assertOk(
      await input.call({
        op: "create-club",
        clubId: club.id,
        creatorPublicKey: input.author.publicKey,
        signature: signText(input.author.privateKey, hubCreateMessage(club.id, input.author.publicKey)),
      }),
    );
    for (const member of members) {
      if (member.publicKey === input.author.publicKey) continue;
      assertOk(
        await input.call({
          op: "add-member",
          clubId: club.id,
          memberPublicKey: member.publicKey,
          creatorPublicKey: input.author.publicKey,
          signature: signText(input.author.privateKey, hubMemberMessage(club.id, member.publicKey)),
        }),
      );
    }
  }
  await flushOutbox(input.db, input.author, input.call);
  for (const club of clubs) {
    const members = await listMembers(input.db, club.id);
    if (!members.some((member) => member.publicKey === input.author.publicKey)) continue;
    const latest = await input.db.select<{ id: string }>(
      "SELECT id FROM events WHERE club_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      [club.id],
    );
    const afterEventId = latest[0]?.id ?? null;
    const response = await input.call({
      op: "catch-up",
      clubId: club.id,
      memberPublicKey: input.author.publicKey,
      afterEventId,
      now: input.now,
      signature: signText(
        input.author.privateKey,
        hubCatchUpMessage(club.id, afterEventId, input.now),
      ),
    });
    assertOk(response);
    for (const envelope of response.envelopes ?? []) {
      await importEnvelope(input.db, envelope);
    }
  }
}

async function createClub(db: HubDb, request: Record<string, unknown>): Promise<RelayResponse> {
  const clubId = request.clubId;
  const creatorPublicKey = request.creatorPublicKey;
  const signature = request.signature;
  if (!isClubId(clubId) || !isPublicKey(creatorPublicKey) || typeof signature !== "string") {
    return proofResponse();
  }
  if (!verifyQuiet(signature, hubCreateMessage(clubId, creatorPublicKey), creatorPublicKey)) return proofResponse();
  const existing = await db.getCreator(clubId);
  if (existing !== null && existing !== creatorPublicKey) return proofResponse();
  await db.addMember(clubId, creatorPublicKey, "creator");
  return { ok: true };
}

async function addMember(db: HubDb, request: Record<string, unknown>): Promise<RelayResponse> {
  const clubId = request.clubId;
  const memberPublicKey = request.memberPublicKey;
  const creatorPublicKey = request.creatorPublicKey;
  const signature = request.signature;
  if (
    !isClubId(clubId) ||
    !isPublicKey(memberPublicKey) ||
    !isPublicKey(creatorPublicKey) ||
    typeof signature !== "string"
  ) {
    return proofResponse();
  }
  const creator = await db.getCreator(clubId);
  if (creator === null || creator !== creatorPublicKey) return proofResponse();
  if (!verifyQuiet(signature, hubMemberMessage(clubId, memberPublicKey), creator)) return proofResponse();
  await db.addMember(clubId, memberPublicKey, memberPublicKey === creator ? "creator" : "member");
  return { ok: true };
}

async function submitEnvelope(
  db: HubDb,
  request: Record<string, unknown>,
  now: string,
): Promise<RelayResponse> {
  const envelope = request.envelope;
  const signature = request.signature;
  if (typeof envelope !== "string" || typeof signature !== "string") return rejectedResponse();
  const opened = opaqueEnvelope(envelope);
  if (!opened || !verifyQuiet(signature, hubSubmitMessage(envelope), opened.authorPublicKey)) {
    return rejectedResponse();
  }
  const members = await db.listMemberKeys(opened.clubId);
  if (!members.includes(opened.authorPublicKey)) return rejectedResponse();
  await db.saveEnvelope({ eventId: opened.id, clubId: opened.clubId, receivedAt: now, envelope });
  return { ok: true };
}

async function catchUp(db: HubDb, request: Record<string, unknown>, hubNow: string): Promise<RelayResponse> {
  const clubId = request.clubId;
  const memberPublicKey = request.memberPublicKey;
  const afterEventId = request.afterEventId;
  const now = request.now;
  const signature = request.signature;
  if (
    !isClubId(clubId) ||
    !isPublicKey(memberPublicKey) ||
    (afterEventId !== null && typeof afterEventId !== "string") ||
    typeof now !== "string" ||
    typeof signature !== "string" ||
    !withinWindow(now, hubNow)
  ) {
    return forbiddenResponse();
  }
  if (!verifyQuiet(signature, hubCatchUpMessage(clubId, afterEventId, now), memberPublicKey)) {
    return forbiddenResponse();
  }
  const members = await db.listMemberKeys(clubId);
  if (!members.includes(memberPublicKey)) return forbiddenResponse();
  const rows = await db.listEnvelopes(clubId);
  const anchor = typeof afterEventId === "string" ? rows.findIndex((row) => row.eventId === afterEventId) : -1;
  const selected = anchor >= 0 ? rows.slice(anchor + 1) : rows;
  return { ok: true, envelopes: selected.map((row) => row.envelope) };
}

async function publishWeights(db: HubDb, request: Record<string, unknown>): Promise<RelayResponse> {
  const publicKey = request.publicKey;
  const signature = request.signature;
  if (!isPublicKey(publicKey) || typeof signature !== "string" || !Array.isArray(request.weights)) {
    return forbiddenResponse();
  }
  const rows = request.weights.filter(isRecord).map((row) => ({
    themeId: typeof row.themeId === "string" ? row.themeId : "",
    weight: typeof row.weight === "number" ? row.weight : Number.NaN,
  }));
  const weights = assistPayload(publicKey, rows).weights;
  if (!verifyQuiet(signature, hubWeightsMessage(publicKey, weights), publicKey)) return forbiddenResponse();
  await db.replaceWeights(publicKey, weights);
  return { ok: true };
}

async function fetchWeights(db: HubDb, request: Record<string, unknown>): Promise<RelayResponse> {
  const publicKey = request.publicKey;
  const signature = request.signature;
  if (!isPublicKey(publicKey) || typeof signature !== "string") return forbiddenResponse();
  if (!verifyQuiet(signature, hubFetchWeightsMessage(publicKey), publicKey)) return forbiddenResponse();
  return { ok: true, weights: await db.listWeights(publicKey) };
}

async function seedBlob(db: HubDb, request: Record<string, unknown>): Promise<RelayResponse> {
  const clubId = request.clubId;
  const memberPublicKey = request.memberPublicKey;
  const hash = request.hash;
  const encoded = request.bytes;
  const signature = request.signature;
  if (
    !isClubId(clubId) ||
    !isPublicKey(memberPublicKey) ||
    typeof hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    typeof encoded !== "string" ||
    typeof signature !== "string" ||
    !verifyQuiet(signature, hubSeedMessage(clubId, hash), memberPublicKey)
  ) {
    return forbiddenResponse();
  }
  const members = await db.listMemberKeys(clubId);
  if (!members.includes(memberPublicKey)) return forbiddenResponse();
  const bytes = decodeBase64(encoded);
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_BLOB) return forbiddenResponse();
  if (bytesToHex(blake3(bytes)) !== hash) return { ok: false, error: RELAY_MESSAGES.hash };
  await db.saveBlob(hash, bytes);
  return { ok: true };
}

function opaqueEnvelope(envelope: string): { id: string; clubId: string; authorPublicKey: string } | null {
  if (envelope.length === 0 || envelope.length > 200_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { id, clubId, authorPublicKey, ciphertext } = parsed;
  if (
    typeof id !== "string" ||
    typeof clubId !== "string" ||
    typeof authorPublicKey !== "string" ||
    typeof ciphertext !== "string" ||
    !/^[0-9a-f]{64}$/.test(id) ||
    !isClubId(clubId) ||
    !isPublicKey(authorPublicKey) ||
    !/^[0-9a-f]+$/.test(ciphertext) ||
    ciphertext.length % 2 !== 0
  ) {
    return null;
  }
  try {
    if (bytesToHex(sha256(hexToBytes(ciphertext))) !== id) return null;
  } catch {
    return null;
  }
  return { id, clubId, authorPublicKey };
}

function withinWindow(requestNow: string, hubNow: string): boolean {
  if (!isTimestamp(requestNow) || !isTimestamp(hubNow)) return false;
  return Math.abs(Date.parse(requestNow) - Date.parse(hubNow)) <= SKEW_MS;
}

function assertOk(
  response: RelayResponse,
): asserts response is { readonly ok: true; readonly envelopes?: readonly string[]; readonly weights?: readonly AssistWeight[] } {
  if (response.ok) return;
  if (response.error === RELAY_MESSAGES.proof) throw new RelayError("proof");
  if (response.error === RELAY_MESSAGES.rejected) throw new RelayError("rejected");
  if (response.error === RELAY_MESSAGES.hash) throw new RelayError("hash");
  if (response.error === RELAY_MESSAGES.unreachable) throw new RelayError("unreachable");
  throw new RelayError("forbidden");
}

function proofResponse(): RelayResponse {
  return { ok: false, error: RELAY_MESSAGES.proof };
}

function rejectedResponse(): RelayResponse {
  return { ok: false, error: RELAY_MESSAGES.rejected };
}

function forbiddenResponse(): RelayResponse {
  return { ok: false, error: RELAY_MESSAGES.forbidden };
}

function allowedError(error: string): boolean {
  return (
    error === RELAY_MESSAGES.proof ||
    error === RELAY_MESSAGES.rejected ||
    error === RELAY_MESSAGES.forbidden ||
    error === RELAY_MESSAGES.unreachable ||
    error === RELAY_MESSAGES.hash
  );
}

function decodeBase64(input: string): Uint8Array | null {
  if (input.length === 0 || input.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const cleaned = input.replace(/=+$/u, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
