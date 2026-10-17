import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { publicKeyOf, signText, verifyQuiet } from "./invite.ts";
import type { SqlExecutor } from "./storage.ts";

/**
 * A club message is a signed human plaintext encrypted with the current club
 * content key. The event id is the SHA-256 of that ciphertext. The content
 * key is wrapped to each current member with X25519 and is rotated on removal.
 * Logs and the test transport carry the envelope, not the body.
 */

const WRAP_INFO = utf8ToBytes("shakespeare-wrap-v1");
const BODY_LIMIT = 2000;

export type MessageErrorCode = "origin" | "unverified" | "empty" | "forbidden";

const MESSAGES: Record<MessageErrorCode, string> = {
  origin: "The message origin is not allowed.",
  unverified: "The message could not be verified.",
  empty: "The message is empty.",
  forbidden: "That membership change is not allowed.",
};

export class MessageError extends Error {
  readonly code: MessageErrorCode;

  constructor(code: MessageErrorCode) {
    super(MESSAGES[code]);
    this.name = "MessageError";
    this.code = code;
  }
}

export interface PostedMessage {
  readonly id: string;
  readonly envelope: string;
}

export interface ReadableMessage {
  readonly id: string;
  readonly verified: boolean;
  readonly body?: string;
  readonly authorPublicKey?: string;
  readonly createdAt?: string;
  readonly origin?: "human" | "ai";
  readonly parentId?: string | null;
}

interface Wrap {
  readonly memberPublicKey: string;
  readonly wrappedKey: string;
}

interface StoredEvent {
  readonly id: string;
  readonly club_id: string;
  readonly author_public_key: string;
  readonly created_at: string;
  readonly ciphertext: string;
  readonly parent_id: string | null;
}

/** Records envelope bytes a hub would see. It has no decrypt operation. */
export class TestHub {
  private readonly chunks: Uint8Array[] = [];

  observe(bytes: Uint8Array): void {
    this.chunks.push(new Uint8Array(bytes));
  }

  recorded(): Uint8Array {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export async function postMessage(
  db: SqlExecutor,
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
  input: {
    readonly clubId: string;
    readonly body: string;
    readonly now: string;
    readonly origin: string;
    readonly parentId?: string | null;
  },
): Promise<PostedMessage> {
  if (input.origin !== "human" && input.origin !== "ai") throw new MessageError("origin");
  if (input.body.length === 0 || input.body.length > BODY_LIMIT) throw new MessageError("empty");
  if (publicKeyOf(author.privateKey) !== author.publicKey) throw new MessageError("unverified");
  const parentId = input.parentId ?? null;
  const members = await memberKeys(db, input.clubId);
  if (!members.includes(author.publicKey)) throw new MessageError("forbidden");

  const material = await clubKey(db, input.clubId, author, members);
  try {
    const payload = JSON.stringify({
      authorPublicKey: author.publicKey,
      body: input.body,
      clubId: input.clubId,
      createdAt: input.now,
      origin: input.origin,
      parentId,
    });
    const packed = JSON.stringify({
      payload,
      signature: signText(author.privateKey, payload),
    });
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(
      material.key,
      nonce,
      aad(input.clubId, author.publicKey, input.now, parentId),
    ).encrypt(utf8ToBytes(packed));
    const ciphertext = concat(nonce, sealed);
    const id = bytesToHex(sha256(ciphertext));
    const stored = bytesToHex(ciphertext);
    const envelope = envelopeJson({
      id,
      clubId: input.clubId,
      authorPublicKey: author.publicKey,
      createdAt: input.now,
      parentId,
      ciphertext: stored,
      wraps: material.wraps,
    });
    await withTransaction(db, async () => {
      await insertEvent(db, {
        id,
        clubId: input.clubId,
        authorPublicKey: author.publicKey,
        createdAt: input.now,
        ciphertext: stored,
        parentId,
        wraps: material.wraps,
      });
      await replaceClubWraps(db, input.clubId, material.wraps);
    });
    return { id, envelope };
  } finally {
    material.key.fill(0);
  }
}

export async function importEnvelope(db: SqlExecutor, envelope: string): Promise<void> {
  const parsed = parseEnvelope(envelope);
  const raw = hexToBytes(parsed.ciphertext);
  if (bytesToHex(sha256(raw)) !== parsed.id) throw new MessageError("unverified");
  const existing = await db.select<{ id: string }>("SELECT id FROM events WHERE id = ?", [parsed.id]);
  if (existing.length > 0) return;
  await withTransaction(db, async () => {
    await insertEvent(db, parsed);
  });
}

export async function readMessage(
  db: SqlExecutor,
  readerPrivateKey: Uint8Array,
  eventId: string,
): Promise<ReadableMessage> {
  const opened = await openEvent(db, readerPrivateKey, eventId);
  return {
    id: eventId,
    verified: true,
    body: opened.body,
    authorPublicKey: opened.authorPublicKey,
    createdAt: opened.createdAt,
    origin: opened.origin,
    parentId: opened.parentId,
  };
}

export async function listMessages(
  db: SqlExecutor,
  readerPrivateKey: Uint8Array,
  clubId: string,
): Promise<ReadableMessage[]> {
  const rows = await db.select<{ id: string; parent_id: string | null }>(
    "SELECT id, parent_id FROM events WHERE club_id = ? ORDER BY created_at, id",
    [clubId],
  );
  const messages: ReadableMessage[] = [];
  for (const row of rows) {
    try {
      messages.push(await readMessage(db, readerPrivateKey, row.id));
    } catch (error) {
      if (error instanceof MessageError) {
        messages.push({ id: row.id, verified: false, parentId: row.parent_id });
        continue;
      }
      throw error;
    }
  }
  return messages;
}

export async function removeMember(
  db: SqlExecutor,
  actor: { readonly publicKey: string; readonly privateKey: Uint8Array },
  clubId: string,
  memberPublicKey: string,
): Promise<void> {
  if (publicKeyOf(actor.privateKey) !== actor.publicKey) throw new MessageError("unverified");
  const members = await db.select<{ public_key: string; role: string }>(
    "SELECT public_key, role FROM memberships WHERE club_id = ?",
    [clubId],
  );
  const actorRow = members.find((member) => member.public_key === actor.publicKey);
  const target = members.find((member) => member.public_key === memberPublicKey);
  if (!actorRow || actorRow.role !== "creator" || !target || target.role === "creator") {
    throw new MessageError("forbidden");
  }
  const remaining = members
    .map((member) => member.public_key)
    .filter((publicKey) => publicKey !== memberPublicKey);
  const key = randomBytes(32);
  try {
    const wraps = wrapTo(key, remaining);
    await withTransaction(db, async () => {
      await db.execute("DELETE FROM memberships WHERE club_id = ? AND public_key = ?", [
        clubId,
        memberPublicKey,
      ]);
      await replaceClubWraps(db, clubId, wraps);
    });
  } finally {
    key.fill(0);
  }
}

async function openEvent(
  db: SqlExecutor,
  readerPrivateKey: Uint8Array,
  eventId: string,
): Promise<{ body: string; authorPublicKey: string; createdAt: string; parentId: string | null; origin: "human" | "ai" }> {
  let readerPublic = "";
  try {
    readerPublic = publicKeyOf(readerPrivateKey);
  } catch {
    throw new MessageError("unverified");
  }
  const events = await db.select<StoredEvent>(
    "SELECT id, club_id, author_public_key, created_at, ciphertext, parent_id FROM events WHERE id = ?",
    [eventId],
  );
  const event = events[0];
  if (!event) throw new MessageError("unverified");
  let raw: Uint8Array;
  try {
    raw = hexToBytes(event.ciphertext);
  } catch {
    throw new MessageError("unverified");
  }
  if (bytesToHex(sha256(raw)) !== event.id) throw new MessageError("unverified");
  const wraps = await db.select<{ wrapped_key: string }>(
    "SELECT wrapped_key FROM event_key_wraps WHERE event_id = ? AND member_public_key = ?",
    [eventId, readerPublic],
  );
  const wrap = wraps[0];
  if (!wrap) throw new MessageError("unverified");
  let contentKey: Uint8Array;
  try {
    contentKey = unwrapKey(wrap.wrapped_key, readerPrivateKey, hexToBytes(readerPublic));
  } catch {
    throw new MessageError("unverified");
  }
  try {
    if (raw.length < 25) throw new MessageError("unverified");
    const nonce = raw.subarray(0, 24);
    const sealed = raw.subarray(24);
    let packed: Uint8Array;
    try {
      packed = xchacha20poly1305(
        contentKey,
        nonce,
        aad(event.club_id, event.author_public_key, event.created_at, event.parent_id),
      ).decrypt(sealed);
    } catch {
      throw new MessageError("unverified");
    }
    return verifiedPlaintext(packed, event);
  } finally {
    contentKey.fill(0);
  }
}

function verifiedPlaintext(
  packedBytes: Uint8Array,
  event: StoredEvent,
): { body: string; authorPublicKey: string; createdAt: string; parentId: string | null; origin: "human" | "ai" } {
  let packed: unknown;
  try {
    packed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packedBytes)) as unknown;
  } catch {
    throw new MessageError("unverified");
  }
  if (!isRecord(packed) || typeof packed.payload !== "string" || typeof packed.signature !== "string") {
    throw new MessageError("unverified");
  }
  if (!verifyQuiet(packed.signature, packed.payload, event.author_public_key)) {
    throw new MessageError("unverified");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(packed.payload) as unknown;
  } catch {
    throw new MessageError("unverified");
  }
  if (
    !isRecord(claims) ||
    (claims.origin !== "human" && claims.origin !== "ai") ||
    typeof claims.body !== "string"
  ) {
    throw new MessageError("unverified");
  }
  if (
    claims.authorPublicKey !== event.author_public_key ||
    claims.clubId !== event.club_id ||
    claims.createdAt !== event.created_at ||
    (claims.parentId ?? null) !== event.parent_id
  ) {
    throw new MessageError("unverified");
  }
  return {
    body: claims.body,
    authorPublicKey: event.author_public_key,
    createdAt: event.created_at,
    parentId: event.parent_id,
    origin: claims.origin,
  };
}

async function clubKey(
  db: SqlExecutor,
  clubId: string,
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
  members: readonly string[],
): Promise<{ key: Uint8Array; wraps: Wrap[] }> {
  const existing = await db.select<{ member_public_key: string; wrapped_key: string }>(
    "SELECT member_public_key, wrapped_key FROM club_key_wraps WHERE club_id = ?",
    [clubId],
  );
  if (existing.length === 0) {
    const key = randomBytes(32);
    return { key, wraps: wrapTo(key, members) };
  }
  const own = existing.find((wrap) => wrap.member_public_key === author.publicKey);
  if (!own) throw new MessageError("unverified");
  const key = unwrapKey(own.wrapped_key, author.privateKey, hexToBytes(author.publicKey));
  const covered = new Set(existing.map((wrap) => wrap.member_public_key));
  const sameMembers =
    covered.size === members.length && members.every((member) => covered.has(member));
  if (sameMembers) {
    return {
      key,
      wraps: existing.map((wrap) => ({
        memberPublicKey: wrap.member_public_key,
        wrappedKey: wrap.wrapped_key,
      })),
    };
  }
  return { key, wraps: wrapTo(key, members) };
}

function wrapTo(contentKey: Uint8Array, members: readonly string[]): Wrap[] {
  return [...members]
    .sort()
    .map((memberPublicKey) => ({
      memberPublicKey,
      wrappedKey: wrapKey(contentKey, hexToBytes(memberPublicKey)),
    }));
}

function wrapKey(contentKey: Uint8Array, memberPublicKey: Uint8Array): string {
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, ed25519.utils.toMontgomery(memberPublicKey));
  const key = hkdf(sha256, shared, undefined, WRAP_INFO, 32);
  try {
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(key, nonce, memberPublicKey).encrypt(contentKey);
    return bytesToHex(concat(ephemeral.publicKey, nonce, sealed));
  } finally {
    ephemeral.secretKey.fill(0);
    shared.fill(0);
    key.fill(0);
  }
}

function unwrapKey(wrappedHex: string, memberPrivateKey: Uint8Array, memberPublicKey: Uint8Array): Uint8Array {
  const wrapped = hexToBytes(wrappedHex);
  if (wrapped.length < 57) throw new MessageError("unverified");
  const ephemeralPublic = wrapped.subarray(0, 32);
  const nonce = wrapped.subarray(32, 56);
  const sealed = wrapped.subarray(56);
  const scalar = ed25519.utils.toMontgomerySecret(memberPrivateKey);
  const shared = x25519.getSharedSecret(scalar, ephemeralPublic);
  const key = hkdf(sha256, shared, undefined, WRAP_INFO, 32);
  try {
    return xchacha20poly1305(key, nonce, memberPublicKey).decrypt(sealed);
  } finally {
    scalar.fill(0);
    shared.fill(0);
    key.fill(0);
  }
}

async function memberKeys(db: SqlExecutor, clubId: string): Promise<string[]> {
  const rows = await db.select<{ public_key: string }>(
    "SELECT public_key FROM memberships WHERE club_id = ? ORDER BY public_key",
    [clubId],
  );
  return rows.map((row) => row.public_key);
}

async function insertEvent(
  db: SqlExecutor,
  event: {
    readonly id: string;
    readonly clubId: string;
    readonly authorPublicKey: string;
    readonly createdAt: string;
    readonly ciphertext: string;
    readonly parentId: string | null;
    readonly wraps: readonly Wrap[];
  },
): Promise<void> {
  await db.execute(
    "INSERT INTO events (id, club_id, author_public_key, created_at, ciphertext, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
    [event.id, event.clubId, event.authorPublicKey, event.createdAt, event.ciphertext, event.parentId],
  );
  for (const wrap of event.wraps) {
    await db.execute(
      "INSERT INTO event_key_wraps (event_id, member_public_key, wrapped_key) VALUES (?, ?, ?)",
      [event.id, wrap.memberPublicKey, wrap.wrappedKey],
    );
  }
}

async function replaceClubWraps(db: SqlExecutor, clubId: string, wraps: readonly Wrap[]): Promise<void> {
  await db.execute("DELETE FROM club_key_wraps WHERE club_id = ?", [clubId]);
  for (const wrap of wraps) {
    await db.execute(
      "INSERT INTO club_key_wraps (club_id, member_public_key, wrapped_key) VALUES (?, ?, ?)",
      [clubId, wrap.memberPublicKey, wrap.wrappedKey],
    );
  }
}

function parseEnvelope(envelope: string): {
  id: string;
  clubId: string;
  authorPublicKey: string;
  createdAt: string;
  parentId: string | null;
  ciphertext: string;
  wraps: Wrap[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope) as unknown;
  } catch {
    throw new MessageError("unverified");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.wraps)) throw new MessageError("unverified");
  const { id, clubId, authorPublicKey, createdAt, ciphertext } = parsed;
  if (
    typeof id !== "string" ||
    typeof clubId !== "string" ||
    typeof authorPublicKey !== "string" ||
    typeof createdAt !== "string" ||
    typeof ciphertext !== "string"
  ) {
    throw new MessageError("unverified");
  }
  const parentId = parsed.parentId == null ? null : parsed.parentId;
  if (parentId !== null && typeof parentId !== "string") throw new MessageError("unverified");
  const wraps: Wrap[] = [];
  for (const wrap of parsed.wraps) {
    if (!isRecord(wrap) || typeof wrap.memberPublicKey !== "string" || typeof wrap.wrappedKey !== "string") {
      throw new MessageError("unverified");
    }
    wraps.push({ memberPublicKey: wrap.memberPublicKey, wrappedKey: wrap.wrappedKey });
  }
  return { id, clubId, authorPublicKey, createdAt, parentId, ciphertext, wraps };
}

function envelopeJson(event: {
  id: string;
  clubId: string;
  authorPublicKey: string;
  createdAt: string;
  parentId: string | null;
  ciphertext: string;
  wraps: readonly Wrap[];
}): string {
  return JSON.stringify({
    authorPublicKey: event.authorPublicKey,
    ciphertext: event.ciphertext,
    clubId: event.clubId,
    createdAt: event.createdAt,
    id: event.id,
    parentId: event.parentId,
    wraps: event.wraps.map((wrap) => ({
      memberPublicKey: wrap.memberPublicKey,
      wrappedKey: wrap.wrappedKey,
    })),
  });
}

function aad(clubId: string, authorPublicKey: string, createdAt: string, parentId: string | null): Uint8Array {
  return utf8ToBytes(`${clubId}|${authorPublicKey}|${createdAt}|${parentId ?? ""}`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTransaction(db: SqlExecutor, work: () => Promise<void>): Promise<void> {
  await db.execute("BEGIN");
  try {
    await work();
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // The original failure is the one to report.
    }
    throw error;
  }
}
