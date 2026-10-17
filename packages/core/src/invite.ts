import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { MembershipError } from "./membership-error.ts";

/**
 * An invite token is base64url JSON: clubId, expiresAt, inviterPublicKey,
 * oneTime, and a hex Ed25519 signature. The signature covers the canonical
 * JSON of those four claims with the keys in that order. The link form is
 * `shakespeare://invite#` plus the token. Expiry is exclusive.
 */
export interface InviteClaims {
  readonly clubId: string;
  readonly inviterPublicKey: string;
  readonly expiresAt: string;
  readonly oneTime: boolean;
}

export interface SignedInvite extends InviteClaims {
  readonly signature: string;
}

export const INVITE_LINK_PREFIX = "shakespeare://invite#";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PUBLIC_KEY = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const CLUB_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export async function createInvite(privateKey: Uint8Array, claims: InviteClaims): Promise<string> {
  assertClaims(claims);
  if (publicKeyOf(privateKey) !== claims.inviterPublicKey) {
    throw new MembershipError("bad-signature");
  }
  const signature = bytesToHex(ed25519.sign(utf8(canonicalInvite(claims)), privateKey));
  return encodeToken({
    clubId: claims.clubId,
    expiresAt: claims.expiresAt,
    inviterPublicKey: claims.inviterPublicKey,
    oneTime: claims.oneTime,
    signature,
  });
}

export function inviteLink(token: string): string {
  return `${INVITE_LINK_PREFIX}${token}`;
}

export function readInvite(token: string): SignedInvite {
  const parsed = decodeToken(token);
  if (!isRecord(parsed)) throw new MembershipError("malformed");
  const clubId = parsed.clubId;
  const expiresAt = parsed.expiresAt;
  const inviterPublicKey = parsed.inviterPublicKey;
  const oneTime = parsed.oneTime;
  const signature = parsed.signature;
  if (!isClubId(clubId) || !isTimestamp(expiresAt) || !isPublicKey(inviterPublicKey)) {
    throw new MembershipError("malformed");
  }
  if (typeof oneTime !== "boolean" || !isSignature(signature)) {
    throw new MembershipError("malformed");
  }
  const claims: InviteClaims = { clubId, expiresAt, inviterPublicKey, oneTime };
  if (!verifyQuiet(signature, canonicalInvite(claims), inviterPublicKey)) {
    throw new MembershipError("bad-signature");
  }
  return { ...claims, signature };
}

export function canonicalInvite(claims: InviteClaims): string {
  return JSON.stringify({
    clubId: claims.clubId,
    expiresAt: claims.expiresAt,
    inviterPublicKey: claims.inviterPublicKey,
    oneTime: claims.oneTime,
  });
}

export function assertTimestamp(value: string): void {
  if (!isTimestamp(value)) throw new MembershipError("malformed");
}

export function isExpired(now: string, expiresAt: string): boolean {
  assertTimestamp(now);
  assertTimestamp(expiresAt);
  return now >= expiresAt;
}

export function publicKeyOf(privateKey: Uint8Array): string {
  try {
    return bytesToHex(ed25519.getPublicKey(privateKey));
  } catch {
    throw new MembershipError("malformed");
  }
}

export function signText(privateKey: Uint8Array, message: string): string {
  try {
    return bytesToHex(ed25519.sign(utf8(message), privateKey));
  } catch {
    throw new MembershipError("malformed");
  }
}

export function verifyQuiet(signature: string, message: string, publicKey: string): boolean {
  if (!isSignature(signature) || !isPublicKey(publicKey)) return false;
  try {
    return ed25519.verify(hexToBytes(signature), utf8(message), hexToBytes(publicKey));
  } catch {
    return false;
  }
}

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY.test(value);
}

export function isClubId(value: unknown): value is string {
  return typeof value === "string" && CLUB_ID.test(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value);
}

function isSignature(value: unknown): value is string {
  return typeof value === "string" && SIGNATURE.test(value);
}

function assertClaims(claims: InviteClaims): void {
  if (
    !isClubId(claims.clubId) ||
    !isTimestamp(claims.expiresAt) ||
    !isPublicKey(claims.inviterPublicKey) ||
    typeof claims.oneTime !== "boolean"
  ) {
    throw new MembershipError("malformed");
  }
}

function decodeToken(token: string): unknown {
  const trimmed = token.trim();
  const payload = trimmed.startsWith(INVITE_LINK_PREFIX)
    ? trimmed.slice(INVITE_LINK_PREFIX.length)
    : trimmed;
  if (payload.length === 0 || payload.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new MembershipError("malformed");
  }
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof MembershipError) throw error;
    throw new MembershipError("malformed");
  }
}

function encodeToken(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
