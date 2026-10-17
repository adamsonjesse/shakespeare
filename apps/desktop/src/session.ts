import {
  addBookmark,
  applyAcceptance,
  commitInvitee,
  createClub as insertClub,
  createInvite,
  generateIdentity,
  importEnvelope,
  inviteLink,
  listClubs as selectClubs,
  listMembers as selectMembers,
  listBookmarkIds,
  listMessages as selectMessageList,
  listReadIds,
  listThemes,
  loadIdentity,
  markRead as storeRead,
  MembershipError,
  migrate,
  MIGRATIONS,
  postMessage,
  runPostMessageCli,
  saveTheme as storeTheme,
  prepareAcceptance,
  readInvite,
  serializeAcceptance,
  type Club,
  type Identity,
  type KeyStore,
  type Member,
  type ReadableMessage,
  type SqlExecutor,
  type Theme,
} from "@shakespeare/core";

/** One active SQLite connection. Opening a profile replaces the previous one. */
export interface ProfileHost {
  listProfiles(): Promise<readonly string[]>;
  openProfile(publicKey: string): Promise<SqlExecutor>;
  savePrivateKey(publicKey: string, privateKey: Uint8Array): Promise<void>;
  loadPrivateKey(publicKey: string): Promise<Uint8Array | null>;
}

export interface Session {
  createProfile(now: string): Promise<string>;
  openProfile(publicKey: string, now: string): Promise<void>;
  listProfiles(): Promise<readonly string[]>;
  currentPublicKey(): string | null;
  createClub(name: string, now: string): Promise<string>;
  listClubs(): Promise<Club[]>;
  listMembers(clubId: string): Promise<Member[]>;
  issueInvite(input: { clubId: string; expiresAt: string; oneTime: boolean }): Promise<string>;
  acceptInvite(pasted: string, now: string): Promise<{ deliveredLocally: boolean; clubId: string }>;
  sendMessage(clubId: string, body: string, now: string, parentId?: string | null): Promise<void>;
  postToolMessage(clubId: string, body: string, now: string): Promise<void>;
  messages(clubId: string): Promise<ReadableMessage[]>;
  markRead(eventId: string, now: string): Promise<void>;
  bookmark(eventId: string, now: string): Promise<void>;
  readIds(): Promise<string[]>;
  bookmarkIds(): Promise<string[]>;
  saveTheme(name: string, terms: readonly string[]): Promise<void>;
  themes(): Promise<Theme[]>;
}

/**
 * Profiles on this device deliver an acceptance by opening the inviter's
 * database. That is local file delivery, not the product network.
 */
export function createSession(host: ProfileHost): Session {
  const keys: KeyStore = {
    save: (publicKey, privateKey) => host.savePrivateKey(publicKey, privateKey),
    load: (publicKey) => host.loadPrivateKey(publicKey),
  };
  let current: Identity | null = null;
  let database: SqlExecutor | null = null;

  async function openDatabase(publicKey: string, now: string): Promise<SqlExecutor> {
    const opened = await host.openProfile(publicKey);
    await migrate(opened, MIGRATIONS, { now });
    return opened;
  }

  function adopt(identity: Identity, opened: SqlExecutor): void {
    if (current && current.privateKey !== identity.privateKey) {
      current.privateKey.fill(0);
    }
    current = identity;
    database = opened;
  }

  function requireOpen(): { identity: Identity; database: SqlExecutor } {
    if (!current || !database) throw new Error("No profile is open.");
    return { identity: current, database };
  }

  async function fanOut(sender: string, clubId: string, now: string, envelope: string): Promise<void> {
    const active = requireOpen();
    const members = await selectMembers(active.database, clubId);
    const profiles = await host.listProfiles();
    for (const member of members) {
      if (member.publicKey === sender || !profiles.includes(member.publicKey)) continue;
      try {
        const other = await openDatabase(member.publicKey, now);
        await importEnvelope(other, envelope);
      } catch (error) {
        database = await openDatabase(sender, now);
        throw error;
      }
    }
    database = await openDatabase(sender, now);
  }

  return {
    async createProfile(now: string): Promise<string> {
      const identity = await generateIdentity(keys);
      adopt(identity, await openDatabase(identity.publicKey, now));
      return identity.publicKey;
    },

    async openProfile(publicKey: string, now: string): Promise<void> {
      const identity = await loadIdentity(keys, publicKey);
      adopt(identity, await openDatabase(publicKey, now));
    },

    listProfiles(): Promise<readonly string[]> {
      return host.listProfiles();
    },

    currentPublicKey(): string | null {
      return current?.publicKey ?? null;
    },

    async createClub(name: string, now: string): Promise<string> {
      const active = requireOpen();
      const clubId = crypto.randomUUID();
      await insertClub(active.database, {
        clubId,
        name,
        creatorPublicKey: active.identity.publicKey,
        now,
      });
      return clubId;
    },

    async listClubs(): Promise<Club[]> {
      return selectClubs(requireOpen().database);
    },

    async listMembers(clubId: string): Promise<Member[]> {
      return selectMembers(requireOpen().database, clubId);
    },

    async issueInvite(input: { clubId: string; expiresAt: string; oneTime: boolean }): Promise<string> {
      const active = requireOpen();
      const clubs = await selectClubs(active.database);
      const club = clubs.find((item) => item.id === input.clubId);
      if (!club || club.creatorPublicKey !== active.identity.publicKey) {
        throw new MembershipError("wrong-club");
      }
      const token = await createInvite(active.identity.privateKey, {
        clubId: input.clubId,
        inviterPublicKey: active.identity.publicKey,
        expiresAt: input.expiresAt,
        oneTime: input.oneTime,
      });
      return inviteLink(token);
    },

    async acceptInvite(pasted: string, now: string): Promise<{ deliveredLocally: boolean; clubId: string }> {
      const active = requireOpen();
      const invite = readInvite(pasted);
      const acceptance = prepareAcceptance(
        { publicKey: active.identity.publicKey, privateKey: active.identity.privateKey },
        pasted,
        now,
      );
      const profiles = await host.listProfiles();
      const deliveredLocally =
        profiles.includes(invite.inviterPublicKey) && invite.inviterPublicKey !== active.identity.publicKey;
      if (deliveredLocally) {
        try {
          const creator = await openDatabase(invite.inviterPublicKey, now);
          await applyAcceptance(creator, serializeAcceptance(acceptance), now);
        } catch (error) {
          database = await openDatabase(active.identity.publicKey, now);
          throw error;
        }
        database = await openDatabase(active.identity.publicKey, now);
      }
      if (!database) throw new Error("No profile is open.");
      await commitInvitee(database, acceptance, now);
      return { deliveredLocally, clubId: acceptance.clubId };
    },

    async sendMessage(
      clubId: string,
      body: string,
      now: string,
      parentId: string | null = null,
    ): Promise<void> {
      const active = requireOpen();
      const posted = await postMessage(active.database, active.identity, {
        clubId,
        body,
        now,
        origin: "human",
        parentId,
      });
      await fanOut(active.identity.publicKey, clubId, now, posted.envelope);
    },

    async postToolMessage(clubId: string, body: string, now: string): Promise<void> {
      const active = requireOpen();
      const posted = await runPostMessageCli(active.database, active.identity, {
        clubId,
        body,
        now,
        origin: "human",
      });
      await fanOut(active.identity.publicKey, clubId, now, posted.envelope);
    },

    async messages(clubId: string): Promise<ReadableMessage[]> {
      const active = requireOpen();
      return selectMessageList(active.database, active.identity.privateKey, clubId);
    },

    async markRead(eventId: string, now: string): Promise<void> {
      await storeRead(requireOpen().database, eventId, now);
    },

    async bookmark(eventId: string, now: string): Promise<void> {
      await addBookmark(requireOpen().database, eventId, now);
    },

    async readIds(): Promise<string[]> {
      return listReadIds(requireOpen().database);
    },

    async bookmarkIds(): Promise<string[]> {
      return listBookmarkIds(requireOpen().database);
    },

    async saveTheme(name: string, terms: readonly string[]): Promise<void> {
      await storeTheme(requireOpen().database, { id: crypto.randomUUID(), name, terms });
    },

    async themes(): Promise<Theme[]> {
      return listThemes(requireOpen().database);
    },
  };
}
