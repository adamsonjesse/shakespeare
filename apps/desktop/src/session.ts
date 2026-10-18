import {
  addBookmark,
  applyAcceptance,
  buildManifest,
  downloadSelected,
  FileShareError,
  manifestText,
  parseManifest,
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
  bumpThemeWeights,
  listThemeWeights,
  matchingThemeIds,
  MessageError,
  postMessage,
  readMessage,
  readRelayResponse,
  readWeightDelta,
  RelayError,
  runPostMessageCli,
  signedWeightFetch,
  signedWeightPublish,
  saveTheme as storeTheme,
  prepareAcceptance,
  readInvite,
  serializeAcceptance,
  enqueueOutbox,
  flushOutbox,
  settleLocalOutbox,
  syncWithHub,
  type Club,
  type Identity,
  type KeyStore,
  type Member,
  type ReadableMessage,
  type RelayResponse,
  type SqlExecutor,
  type Theme,
} from "@shakespeare/core";

/** One active SQLite connection. Opening a profile replaces the previous one. */
export interface ProfileHost {
  listProfiles(): Promise<readonly string[]>;
  openProfile(publicKey: string): Promise<SqlExecutor>;
  savePrivateKey(publicKey: string, privateKey: Uint8Array): Promise<void>;
  loadPrivateKey(publicKey: string): Promise<Uint8Array | null>;
  readFolder(path: string): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>;
  readBlob(publicKey: string, hash: string): Promise<Uint8Array | null>;
  writeBlob(publicKey: string, hash: string, bytes: Uint8Array): Promise<void>;
  removeBlob(publicKey: string, hash: string): Promise<void>;
  writeOutput(publicKey: string, path: string, bytes: Uint8Array): Promise<void>;
  removeOutput(publicKey: string, path: string): Promise<void>;
  relayExchange(host: string, port: number, request: string): Promise<string>;
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
  markRead(eventId: string, now: string, startedAt?: string | null): Promise<void>;
  bookmark(eventId: string, now: string): Promise<void>;
  themeWeights(): Promise<Record<string, number>>;
  setAssist(enabled: boolean): void;
  readIds(): Promise<string[]>;
  bookmarkIds(): Promise<string[]>;
  saveTheme(name: string, terms: readonly string[]): Promise<void>;
  themes(): Promise<Theme[]>;
  offerFolder(clubId: string, folderPath: string, label: string, now: string): Promise<void>;
  downloadShared(eventId: string, path: string, seederPublicKey: string, now: string): Promise<void>;
  configureHub(host: string | null, port: number | null): void;
  syncHub(now: string): Promise<void>;
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
  let hubAddress: { host: string; port: number } | null = null;
  let assist = false;

  async function learnFromBody(body: string, now: string): Promise<void> {
    const active = requireOpen();
    const themes = await listThemes(active.database);
    await bumpThemeWeights(active.database, matchingThemeIds(body, themes), now);
  }

  async function learnFromEvent(eventId: string, now: string): Promise<void> {
    const active = requireOpen();
    try {
      const message = await readMessage(active.database, active.identity.privateKey, eventId);
      if (message.body) await learnFromBody(message.body, now);
    } catch (error) {
      if (!(error instanceof MessageError)) throw error;
    }
  }

  async function callHub(request: unknown): Promise<RelayResponse> {
    if (!hubAddress) throw new RelayError("unreachable");
    let raw = "";
    try {
      raw = await host.relayExchange(hubAddress.host, hubAddress.port, JSON.stringify(request));
    } catch {
      throw new RelayError("unreachable");
    }
    try {
      return readRelayResponse(JSON.parse(raw) as unknown);
    } catch {
      throw new RelayError("forbidden");
    }
  }

  async function publish(
    clubId: string,
    now: string,
    posted: { readonly id: string; readonly envelope: string },
  ): Promise<void> {
    await fanOut(requireOpen().identity.publicKey, clubId, now, posted.envelope);
    const active = requireOpen();
    await enqueueOutbox(active.database, {
      id: posted.id,
      clubId,
      envelope: posted.envelope,
      now,
    });
    if (!hubAddress) {
      await settleLocalOutbox(active.database);
      return;
    }
    try {
      await flushOutbox(active.database, active.identity, (request) => callHub(request));
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== "unreachable") throw error;
    }
  }

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
      if (parentId) await learnFromEvent(parentId, now);
      await publish(clubId, now, posted);
    },

    async postToolMessage(clubId: string, body: string, now: string): Promise<void> {
      const active = requireOpen();
      const posted = await runPostMessageCli(active.database, active.identity, {
        clubId,
        body,
        now,
        origin: "human",
      });
      await publish(clubId, now, posted);
    },

    async messages(clubId: string): Promise<ReadableMessage[]> {
      const active = requireOpen();
      return selectMessageList(active.database, active.identity.privateKey, clubId);
    },

    async markRead(eventId: string, now: string, startedAt: string | null = null): Promise<void> {
      await storeRead(requireOpen().database, eventId, now);
      if (startedAt && readWeightDelta(startedAt, now) > 0) await learnFromEvent(eventId, now);
    },

    async bookmark(eventId: string, now: string): Promise<void> {
      await addBookmark(requireOpen().database, eventId, now);
      await learnFromEvent(eventId, now);
    },

    async themeWeights(): Promise<Record<string, number>> {
      return listThemeWeights(requireOpen().database);
    },

    setAssist(enabled: boolean): void {
      assist = enabled;
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

    async offerFolder(clubId: string, folderPath: string, label: string, now: string): Promise<void> {
      const active = requireOpen();
      const folder = await host.readFolder(folderPath);
      const manifest = buildManifest(folder, label);
      for (const file of manifest.files) {
        const source = folder.find((entry) => entry.path === file.path);
        if (!source) throw new FileShareError("missing");
        await host.writeBlob(active.identity.publicKey, file.hash, source.bytes);
      }
      const posted = await postMessage(active.database, active.identity, {
        clubId,
        body: manifestText(manifest),
        now,
        origin: "human",
      });
      await publish(clubId, now, posted);
    },

    configureHub(hostName: string | null, port: number | null): void {
      if (hostName === null || port === null) {
        hubAddress = null;
        return;
      }
      // 10.0.2.2 is the Android emulator's alias for the host loopback.
      // The hub process still listens only on 127.0.0.1.
      if (
        (hostName !== "127.0.0.1" && hostName !== "10.0.2.2") ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new RelayError("forbidden");
      }
      hubAddress = { host: hostName, port };
    },

    async syncHub(now: string): Promise<void> {
      const active = requireOpen();
      if (!hubAddress) throw new RelayError("unreachable");
      await syncWithHub({
        db: active.database,
        author: active.identity,
        now,
        call: (request) => callHub(request),
      });
      if (!assist) return;
      const weights = await listThemeWeights(active.database);
      const rows = Object.entries(weights).map(([themeId, weight]) => ({ themeId, weight }));
      const published = await callHub(signedWeightPublish(active.identity, rows));
      if (!published.ok) throw new RelayError("forbidden");
      const fetched = await callHub(signedWeightFetch(active.identity));
      if (!fetched.ok) throw new RelayError("forbidden");
    },

    async downloadShared(eventId: string, path: string, seederPublicKey: string, now: string): Promise<void> {
      const active = requireOpen();
      const listed = await active.database.select<{ club_id: string }>(
        "SELECT club_id FROM events WHERE id = ?",
        [eventId],
      );
      const clubId = listed[0]?.club_id;
      if (!clubId) throw new FileShareError("missing");
      const clubMessages = await selectMessageList(active.database, active.identity.privateKey, clubId);
      const message = clubMessages.find((entry) => entry.id === eventId);
      const manifest = message?.body ? parseManifest(message.body) : null;
      if (!manifest || !message) throw new FileShareError("missing");
      const reader = active.identity.publicKey;
      await downloadSelected({
        manifest,
        paths: [path],
        fetchHash: async (hash) => {
          const bytes = await host.readBlob(seederPublicKey, hash);
          if (!bytes) throw new FileShareError("absent");
          return bytes;
        },
        blobs: {
          read: (hash) => host.readBlob(reader, hash),
          write: (hash, bytes) => host.writeBlob(reader, hash, bytes),
          remove: (hash) => host.removeBlob(reader, hash),
        },
        output: {
          write: (relative, bytes) => host.writeOutput(reader, relative, bytes),
          remove: (relative) => host.removeOutput(reader, relative),
        },
        db: active.database,
        eventId,
        now,
      });
    },
  };
}
