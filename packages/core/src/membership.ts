import {
  isClubId,
  isExpired,
  isPublicKey,
  isTimestamp,
  publicKeyOf,
  readInvite,
  signText,
  verifyQuiet,
  type InviteClaims,
  type SignedInvite,
} from "./invite.ts";
import { MembershipError } from "./membership-error.ts";
import type { SqlExecutor } from "./storage.ts";

export type { InviteClaims };
export { MembershipError };
export type { MembershipErrorCode } from "./membership-error.ts";

export type MemberRole = "creator" | "member";

export interface Member {
  readonly publicKey: string;
  readonly role: MemberRole;
  readonly joinedAt: string;
}

export interface Club {
  readonly id: string;
  readonly name: string;
  readonly creatorPublicKey: string;
  readonly createdAt: string;
}

export interface CreateClubInput {
  readonly clubId: string;
  readonly name: string;
  readonly creatorPublicKey: string;
  readonly now: string;
}

/**
 * Signed proof that a member accepted one invite. The member signature covers
 * the token, so the creator can check the invite again without trusting the body.
 */
export interface Acceptance {
  readonly token: string;
  readonly acceptedAt: string;
  readonly clubId: string;
  readonly inviteSignature: string;
  readonly memberPublicKey: string;
  readonly signature: string;
}

interface ClubRow {
  readonly id: string;
  readonly name: string;
  readonly creator_public_key: string;
  readonly created_at: string;
}

interface MemberRow {
  readonly public_key: string;
  readonly role: string;
  readonly joined_at: string;
}

export async function createClub(db: SqlExecutor, input: CreateClubInput): Promise<void> {
  const name = input.name.trim();
  if (name.length === 0) throw new MembershipError("empty-name");
  if (name.length > 80 || hasControlCharacter(name)) throw new MembershipError("malformed");
  if (!isClubId(input.clubId) || !isPublicKey(input.creatorPublicKey) || !isTimestamp(input.now)) {
    throw new MembershipError("malformed");
  }
  await withTransaction(db, async () => {
    const existing = await db.select<{ id: string }>("SELECT id FROM clubs WHERE id = ?", [
      input.clubId,
    ]);
    if (existing.length > 0) throw new MembershipError("exists");
    await db.execute(
      "INSERT INTO clubs (id, name, creator_public_key, created_at) VALUES (?, ?, ?, ?)",
      [input.clubId, name, input.creatorPublicKey, input.now],
    );
    await db.execute(
      "INSERT INTO memberships (club_id, public_key, role, joined_at) VALUES (?, ?, 'creator', ?)",
      [input.clubId, input.creatorPublicKey, input.now],
    );
  });
}

export async function listClubs(db: SqlExecutor): Promise<Club[]> {
  const rows = await db.select<ClubRow>(
    "SELECT id, name, creator_public_key, created_at FROM clubs ORDER BY created_at, id",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    creatorPublicKey: row.creator_public_key,
    createdAt: row.created_at,
  }));
}

export async function listMembers(db: SqlExecutor, clubId: string): Promise<Member[]> {
  const rows = await db.select<MemberRow>(
    "SELECT public_key, role, joined_at FROM memberships WHERE club_id = ? ORDER BY public_key",
    [clubId],
  );
  return rows.map((row) => ({
    publicKey: row.public_key,
    role: memberRole(row.role),
    joinedAt: row.joined_at,
  }));
}

export function prepareAcceptance(
  accepter: { readonly publicKey: string; readonly privateKey: Uint8Array },
  token: string,
  now: string,
): Acceptance {
  if (!isTimestamp(now) || !isPublicKey(accepter.publicKey)) throw new MembershipError("malformed");
  const invite = readInvite(token);
  if (isExpired(now, invite.expiresAt)) throw new MembershipError("expired");
  if (publicKeyOf(accepter.privateKey) !== accepter.publicKey) {
    throw new MembershipError("bad-signature");
  }
  if (accepter.publicKey === invite.inviterPublicKey) throw new MembershipError("already-member");
  const accepted: Acceptance = {
    token: token.trim(),
    acceptedAt: now,
    clubId: invite.clubId,
    inviteSignature: invite.signature,
    memberPublicKey: accepter.publicKey,
    signature: "",
  };
  return {
    ...accepted,
    signature: signText(accepter.privateKey, canonicalAcceptance(accepted)),
  };
}

export async function commitInvitee(
  db: SqlExecutor,
  acceptance: Acceptance,
  now: string,
): Promise<void> {
  const invite = verifiedInvite(acceptance, now);
  await withTransaction(db, async () => {
    const clubs = await db.select<{ creator_public_key: string }>(
      "SELECT creator_public_key FROM clubs WHERE id = ?",
      [invite.clubId],
    );
    const club = clubs[0];
    if (!club) {
      await db.execute(
        "INSERT INTO clubs (id, name, creator_public_key, created_at) VALUES (?, ?, ?, ?)",
        [invite.clubId, "", invite.inviterPublicKey, acceptance.acceptedAt],
      );
      await db.execute(
        "INSERT INTO memberships (club_id, public_key, role, joined_at) VALUES (?, ?, 'creator', ?)",
        [invite.clubId, invite.inviterPublicKey, acceptance.acceptedAt],
      );
    } else if (club.creator_public_key !== invite.inviterPublicKey) {
      throw new MembershipError("wrong-club");
    }
    await insertMember(db, invite, acceptance);
  });
}

export async function acceptInvite(
  db: SqlExecutor,
  accepter: { readonly publicKey: string; readonly privateKey: Uint8Array },
  token: string,
  now: string,
): Promise<Acceptance> {
  const acceptance = prepareAcceptance(accepter, token, now);
  await commitInvitee(db, acceptance, now);
  return acceptance;
}

export function serializeAcceptance(acceptance: Acceptance): string {
  return JSON.stringify({
    acceptedAt: acceptance.acceptedAt,
    clubId: acceptance.clubId,
    inviteSignature: acceptance.inviteSignature,
    memberPublicKey: acceptance.memberPublicKey,
    signature: acceptance.signature,
    token: acceptance.token,
  });
}

export async function applyAcceptance(
  db: SqlExecutor,
  envelope: string,
  now: string,
): Promise<void> {
  const acceptance = readAcceptance(envelope);
  const invite = verifiedInvite(acceptance, now);
  await withTransaction(db, async () => {
    const clubs = await db.select<{ creator_public_key: string }>(
      "SELECT creator_public_key FROM clubs WHERE id = ?",
      [invite.clubId],
    );
    const club = clubs[0];
    if (!club || club.creator_public_key !== invite.inviterPublicKey) {
      throw new MembershipError("wrong-club");
    }
    await insertMember(db, invite, acceptance);
  });
}

function verifiedInvite(acceptance: Acceptance, now: string): SignedInvite {
  if (!isTimestamp(now) || !isTimestamp(acceptance.acceptedAt)) {
    throw new MembershipError("malformed");
  }
  if (acceptance.acceptedAt > now) throw new MembershipError("malformed");
  const invite = readInvite(acceptance.token);
  if (
    acceptance.clubId !== invite.clubId ||
    acceptance.inviteSignature !== invite.signature ||
    !verifyQuiet(acceptance.signature, canonicalAcceptance(acceptance), acceptance.memberPublicKey)
  ) {
    throw new MembershipError("bad-signature");
  }
  if (isExpired(now, invite.expiresAt) || isExpired(acceptance.acceptedAt, invite.expiresAt)) {
    throw new MembershipError("expired");
  }
  return invite;
}

async function insertMember(
  db: SqlExecutor,
  invite: SignedInvite,
  acceptance: Acceptance,
): Promise<void> {
  if (invite.oneTime) {
    const used = await db.select<{ signature: string }>(
      "SELECT signature FROM used_invites WHERE club_id = ? AND signature = ?",
      [invite.clubId, invite.signature],
    );
    if (used.length > 0) throw new MembershipError("used");
  }
  const existing = await db.select<{ public_key: string }>(
    "SELECT public_key FROM memberships WHERE club_id = ? AND public_key = ?",
    [invite.clubId, acceptance.memberPublicKey],
  );
  if (existing.length > 0) throw new MembershipError(invite.oneTime ? "used" : "already-member");
  await db.execute(
    "INSERT INTO memberships (club_id, public_key, role, joined_at) VALUES (?, ?, 'member', ?)",
    [invite.clubId, acceptance.memberPublicKey, acceptance.acceptedAt],
  );
  if (invite.oneTime) {
    await db.execute("INSERT INTO used_invites (club_id, signature) VALUES (?, ?)", [
      invite.clubId,
      invite.signature,
    ]);
  }
}

function readAcceptance(envelope: string): Acceptance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope) as unknown;
  } catch {
    throw new MembershipError("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MembershipError("malformed");
  }
  const record = parsed as Record<string, unknown>;
  const token = record.token;
  const acceptedAt = record.acceptedAt;
  const clubId = record.clubId;
  const inviteSignature = record.inviteSignature;
  const memberPublicKey = record.memberPublicKey;
  const signature = record.signature;
  if (
    typeof token !== "string" ||
    !isTimestamp(acceptedAt) ||
    !isClubId(clubId) ||
    typeof inviteSignature !== "string" ||
    !isPublicKey(memberPublicKey) ||
    typeof signature !== "string"
  ) {
    throw new MembershipError("malformed");
  }
  return { token, acceptedAt, clubId, inviteSignature, memberPublicKey, signature };
}

function canonicalAcceptance(acceptance: Acceptance): string {
  return JSON.stringify({
    acceptedAt: acceptance.acceptedAt,
    clubId: acceptance.clubId,
    inviteSignature: acceptance.inviteSignature,
    memberPublicKey: acceptance.memberPublicKey,
    token: acceptance.token,
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) <= 31) return true;
  }
  return false;
}

function memberRole(role: string): MemberRole {
  if (role === "creator" || role === "member") return role;
  throw new MembershipError("malformed");
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
