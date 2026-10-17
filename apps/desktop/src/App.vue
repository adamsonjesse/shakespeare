<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import QRCode from "qrcode";
import { createSession } from "./session.ts";
import { createTauriHost } from "./storage.ts";
import {
  applyTheme,
  catchUpItems,
  excludeOrigin,
  RECENCY_HALF_LIFE_MS,
  textMatchesTheme,
  threadMessages,
  type Club,
  type Member,
  type ReadableMessage,
  parseManifest,
  type Theme,
} from "@shakespeare/core";

const session = createSession(createTauriHost());
const profiles = ref<string[]>([]);
const currentPublicKey = ref("");
const clubs = ref<Club[]>([]);
const selectedClubId = ref("");
const members = ref<Member[]>([]);
const messages = ref<ReadableMessage[]>([]);
const messageBody = ref("");
const themes = ref<Theme[]>([]);
const activeThemeId = ref("");
const themeName = ref("");
const themeTerms = ref("");
const readIds = ref<string[]>([]);
const bookmarkIds = ref<string[]>([]);
const catchUp = ref(false);
const replyParentId = ref("");
const hiddenOrigin = ref<"human" | "ai" | null>(null);
const offerPath = ref("");
const offerLabel = ref("notes");
const hubHost = ref("127.0.0.1");
const hubPort = ref("");
const clubName = ref("");
const inviteHours = ref(24);
const oneTime = ref(false);
const inviteLink = ref("");
const qrUrl = ref("");
const acceptText = ref("");
const status = ref("");
const error = ref("");
const busy = ref(false);

onMounted(() => {
  void run(async () => {
    profiles.value = [...(await session.listProfiles())];
  });
});

// Local tool bridge for post_message. It always signs origin ai. The composer
// does not call it, and a caller-supplied origin on the event is ignored.
globalThis.addEventListener("shakespeare-post-ai", (event) => {
  const detail = "detail" in event ? event.detail : undefined;
  const body =
    typeof detail === "object" &&
    detail !== null &&
    "body" in detail &&
    typeof detail.body === "string"
      ? detail.body
      : "";
  void run(async () => {
    rememberHub();
    await session.postToolMessage(selectedClubId.value, body, new Date().toISOString());
    await refreshClubs();
    status.value = "AI message posted.";
  });
});

watch(inviteLink, (link) => {
  void drawQr(link);
});

function shortKey(publicKey: string): string {
  return `${publicKey.slice(0, 8)}…${publicKey.slice(-4)}`;
}

function clubLabel(club: Club): string {
  return club.name.length > 0 ? club.name : club.id;
}

function roleLabel(role: Member["role"]): string {
  return role === "creator" ? "Creator" : "Member";
}

function expiresAfter(now: string, hours: number): string {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed) || !Number.isInteger(hours) || hours < 1 || hours > 24 * 365) {
    throw new Error("The invite expiry is invalid.");
  }
  return new Date(parsed + hours * 60 * 60 * 1000).toISOString();
}

async function drawQr(link: string): Promise<void> {
  if (link.length === 0) {
    qrUrl.value = "";
    return;
  }
  try {
    qrUrl.value = await QRCode.toDataURL(link, { margin: 1, width: 220 });
  } catch {
    qrUrl.value = "";
    error.value = "The invite QR could not be drawn.";
  }
}

const streamRows = computed(() => {
  const theme = themes.value.find((item) => item.id === activeThemeId.value);
  const terms = theme ? theme.terms : null;
  const filtered = excludeOrigin(applyTheme(messages.value, terms), hiddenOrigin.value);
  const read = new Set(readIds.value);
  const bookmarks = new Set(bookmarkIds.value);
  const items = filtered.map((message) => ({
    message,
    id: message.id,
    parentId: message.parentId ?? null,
    createdAt: message.createdAt ?? "",
    matchesTheme: terms !== null && message.body !== undefined && textMatchesTheme(message.body, terms),
    read: read.has(message.id),
    bookmarked: bookmarks.has(message.id),
  }));
  const now = new Date().toISOString();
  if (catchUp.value) {
    return catchUpItems(items, now, RECENCY_HALF_LIFE_MS).map((item) => ({
      item,
      indent: item.parentId === null ? 0 as const : 1 as const,
    }));
  }
  return threadMessages(items, now, RECENCY_HALF_LIFE_MS);
});

async function refreshClubs(): Promise<void> {
  clubs.value = await session.listClubs();
  if (currentPublicKey.value) {
    themes.value = await session.themes();
    readIds.value = await session.readIds();
    bookmarkIds.value = await session.bookmarkIds();
  } else {
    themes.value = [];
    readIds.value = [];
    bookmarkIds.value = [];
  }
  if (!clubs.value.some((club) => club.id === selectedClubId.value)) {
    selectedClubId.value = "";
    members.value = [];
    messages.value = [];
    replyParentId.value = "";
    return;
  }
  members.value = await session.listMembers(selectedClubId.value);
  messages.value = await session.messages(selectedClubId.value);
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (caught) {
    status.value = "";
    error.value = caught instanceof Error ? caught.message : "The request failed.";
  } finally {
    busy.value = false;
  }
}

function createProfile(): void {
  void run(async () => {
    const now = new Date().toISOString();
    currentPublicKey.value = await session.createProfile(now);
    profiles.value = [...(await session.listProfiles())];
    selectedClubId.value = "";
    inviteLink.value = "";
    members.value = [];
    messages.value = [];
    activeThemeId.value = "";
    replyParentId.value = "";
    catchUp.value = false;
    hiddenOrigin.value = null;
    await refreshClubs();
    status.value = "Profile ready.";
  });
}

function useProfile(publicKey: string): void {
  void run(async () => {
    const now = new Date().toISOString();
    await session.openProfile(publicKey, now);
    currentPublicKey.value = publicKey;
    inviteLink.value = "";
    acceptText.value = "";
    activeThemeId.value = "";
    replyParentId.value = "";
    catchUp.value = false;
    hiddenOrigin.value = null;
    await refreshClubs();
    status.value = "Profile open.";
  });
}

function createClub(): void {
  void run(async () => {
    const now = new Date().toISOString();
    const clubId = await session.createClub(clubName.value, now);
    clubName.value = "";
    selectedClubId.value = clubId;
    inviteLink.value = "";
    await refreshClubs();
    status.value = "Club created.";
  });
}

function selectClub(clubId: string): void {
  void run(async () => {
    selectedClubId.value = clubId;
    inviteLink.value = "";
    replyParentId.value = "";
    members.value = await session.listMembers(clubId);
    messages.value = await session.messages(clubId);
  });
}

function rememberHub(): void {
  const text = hubPort.value.trim();
  if (text.length === 0) {
    session.configureHub(null, null);
    return;
  }
  session.configureHub(hubHost.value.trim(), Number(text));
}

function syncHub(): void {
  void run(async () => {
    rememberHub();
    await session.syncHub(new Date().toISOString());
    await refreshClubs();
    status.value = "Hub synced.";
  });
}

function sendMessage(): void {
  void run(async () => {
    rememberHub();
    const now = new Date().toISOString();
    await session.sendMessage(selectedClubId.value, messageBody.value, now, replyParentId.value || null);
    messageBody.value = "";
    replyParentId.value = "";
    await refreshClubs();
    status.value = "Message sent.";
  });
}

function markMessageRead(eventId: string): void {
  void run(async () => {
    await session.markRead(eventId, new Date().toISOString());
    await refreshClubs();
    status.value = "Marked read.";
  });
}

function bookmarkMessage(eventId: string): void {
  void run(async () => {
    await session.bookmark(eventId, new Date().toISOString());
    await refreshClubs();
    status.value = "Bookmark saved.";
  });
}

function offerFolder(): void {
  void run(async () => {
    rememberHub();
    await session.offerFolder(selectedClubId.value, offerPath.value, offerLabel.value, new Date().toISOString());
    offerPath.value = "";
    await refreshClubs();
    status.value = "Folder offered.";
  });
}

function downloadFile(eventId: string, path: string, authorPublicKey: string): void {
  void run(async () => {
    await session.downloadShared(eventId, path, authorPublicKey, new Date().toISOString());
    status.value = "Download verified.";
  });
}

function saveTheme(): void {
  void run(async () => {
    const terms = themeTerms.value.split(",").map((term) => term.trim()).filter((term) => term.length > 0);
    await session.saveTheme(themeName.value, terms);
    themeName.value = "";
    themeTerms.value = "";
    await refreshClubs();
    status.value = "Theme saved.";
  });
}

function createInvite(): void {
  void run(async () => {
    const now = new Date().toISOString();
    inviteLink.value = await session.issueInvite({
      clubId: selectedClubId.value,
      expiresAt: expiresAfter(now, inviteHours.value),
      oneTime: oneTime.value,
    });
    status.value = "Invite ready.";
  });
}

function copyInvite(): void {
  void run(async () => {
    const clipboard = globalThis.navigator.clipboard;
    if (!clipboard) throw new Error("Select the invite link to copy it.");
    await clipboard.writeText(inviteLink.value);
    status.value = "Invite link copied.";
  });
}

function acceptInvite(): void {
  void run(async () => {
    const now = new Date().toISOString();
    const result = await session.acceptInvite(acceptText.value, now);
    acceptText.value = "";
    selectedClubId.value = result.clubId;
    await refreshClubs();
    status.value = result.deliveredLocally
      ? "Invite accepted. The inviter's profile on this device lists you as a member."
      : "Invite accepted on this profile. The inviter's profile is not on this device.";
  });
}
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-6 py-10 text-stone-900">
    <header class="flex flex-col gap-2">
      <p class="text-sm font-medium uppercase tracking-wide text-stone-500">
        Shakespeare
      </p>
      <h1 class="text-3xl font-semibold">
        Clubs
      </h1>
      <p class="text-stone-700">
        Create a profile, start a club, and accept an invite. Keys stay on this device.
      </p>
    </header>

    <section class="flex flex-col gap-3">
      <h2 class="text-lg font-semibold">
        Profiles
      </h2>
      <button
        type="button"
        data-testid="create-profile"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="createProfile"
      >
        Create profile
      </button>
      <ul class="flex flex-col gap-2">
        <li
          v-for="publicKey in profiles"
          :key="publicKey"
        >
          <button
            type="button"
            data-testid="profile-button"
            class="rounded border border-stone-300 px-3 py-2 text-left"
            :class="publicKey === currentPublicKey ? 'border-stone-900' : ''"
            :data-public-key="publicKey"
            :disabled="busy"
            @click="useProfile(publicKey)"
          >
            {{ shortKey(publicKey) }}
          </button>
        </li>
      </ul>
      <p
        v-if="currentPublicKey"
        data-testid="current-profile"
        class="break-all text-sm text-stone-600"
      >
        Open profile {{ currentPublicKey }}
      </p>
    </section>

    <section
      v-if="currentPublicKey"
      class="flex flex-col gap-3"
    >
      <h2 class="text-lg font-semibold">
        Your clubs
      </h2>
      <label
        class="flex flex-col gap-1 text-sm"
        for="club-name"
      >
        Club name
        <input
          id="club-name"
          v-model="clubName"
          data-testid="club-name"
          class="rounded border border-stone-300 px-3 py-2"
          type="text"
          maxlength="80"
        >
      </label>
      <button
        type="button"
        data-testid="create-club"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="createClub"
      >
        Create club
      </button>
      <ul
        data-testid="club-list"
        class="flex flex-col gap-2"
      >
        <li
          v-for="club in clubs"
          :key="club.id"
        >
          <button
            type="button"
            data-testid="club-button"
            class="rounded border border-stone-300 px-3 py-2"
            :data-club-id="club.id"
            :disabled="busy"
            @click="selectClub(club.id)"
          >
            {{ clubLabel(club) }}
          </button>
        </li>
      </ul>
    </section>

    <section
      v-if="selectedClubId"
      class="flex flex-col gap-4"
    >
      <h2 class="text-lg font-semibold">
        Members
      </h2>
      <ul data-testid="member-list">
        <li
          v-for="member in members"
          :key="member.publicKey"
          data-testid="member-row"
          class="break-all text-sm"
          :data-public-key="member.publicKey"
          :data-role="member.role"
        >
          {{ roleLabel(member.role) }} {{ shortKey(member.publicKey) }}
        </li>
      </ul>

      <h2 class="text-lg font-semibold">
        Messages
      </h2>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="show-stream"
          class="rounded border border-stone-300 px-3 py-2"
          :disabled="busy"
          @click="catchUp = false"
        >
          Stream
        </button>
        <button
          type="button"
          data-testid="show-catch-up"
          class="rounded border border-stone-300 px-3 py-2"
          :disabled="busy"
          @click="catchUp = true"
        >
          Catch-up
        </button>
        <button
          type="button"
          data-testid="filter-all"
          class="rounded border border-stone-300 px-3 py-2"
          :disabled="busy"
          @click="hiddenOrigin = null"
        >
          All
        </button>
        <button
          type="button"
          data-testid="filter-ai"
          class="rounded border border-stone-300 px-3 py-2"
          :disabled="busy"
          @click="hiddenOrigin = 'ai'"
        >
          Hide AI
        </button>
        <button
          type="button"
          data-testid="filter-human"
          class="rounded border border-stone-300 px-3 py-2"
          :disabled="busy"
          @click="hiddenOrigin = 'human'"
        >
          Hide human
        </button>
      </div>
      <div class="flex flex-col gap-2">
        <label
          class="flex flex-col gap-1 text-sm"
          for="theme-name"
        >
          Theme name
          <input
            id="theme-name"
            v-model="themeName"
            data-testid="theme-name"
            class="rounded border border-stone-300 px-3 py-2"
            type="text"
          >
        </label>
        <label
          class="flex flex-col gap-1 text-sm"
          for="theme-terms"
        >
          Theme terms
          <input
            id="theme-terms"
            v-model="themeTerms"
            data-testid="theme-terms"
            class="rounded border border-stone-300 px-3 py-2"
            type="text"
          >
        </label>
        <button
          type="button"
          data-testid="save-theme"
          class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
          :disabled="busy"
          @click="saveTheme"
        >
          Save theme
        </button>
        <ul class="flex flex-wrap gap-2">
          <li
            v-for="theme in themes"
            :key="theme.id"
          >
            <button
              type="button"
              data-testid="theme-button"
              class="rounded border border-stone-300 px-3 py-2"
              :data-theme-id="theme.id"
              :disabled="busy"
              @click="activeThemeId = theme.id"
            >
              {{ theme.name }}
            </button>
          </li>
        </ul>
        <button
          type="button"
          data-testid="clear-theme"
          class="w-fit rounded border border-stone-300 px-3 py-2"
          :disabled="busy"
          @click="activeThemeId = ''"
        >
          Show all
        </button>
      </div>
      <ul
        data-testid="message-list"
        class="flex flex-col gap-2"
        :data-mode="catchUp ? 'catch-up' : 'stream'"
      >
        <li
          v-for="row in streamRows"
          :key="row.item.id"
          data-testid="message-row"
          class="flex flex-col gap-2"
          :class="row.indent === 1 ? 'pl-6' : ''"
          :data-indent="row.indent"
          :data-read="row.item.read ? 'true' : 'false'"
          :data-bookmarked="row.item.bookmarked ? 'true' : 'false'"
          :data-origin="row.item.message.origin ?? ''"
        >
          <span
            v-if="row.item.message.origin === 'human'"
            data-testid="origin-badge"
          >Human</span>
          <span
            v-else-if="row.item.message.origin === 'ai'"
            data-testid="origin-badge"
          >AI</span>
          <template v-if="row.item.message.verified && parseManifest(row.item.message.body ?? '')">
            <p>{{ parseManifest(row.item.message.body ?? '')?.label }}</p>
            <ul class="flex flex-col gap-1">
              <li
                v-for="file in parseManifest(row.item.message.body ?? '')?.files ?? []"
                :key="file.path"
                data-testid="manifest-file"
                :data-path="file.path"
                :data-hash="file.hash"
              >
                {{ file.path }} ({{ file.size }})
                <button
                  type="button"
                  data-testid="download-file"
                  class="rounded border border-stone-300 px-3 py-2"
                  :disabled="busy"
                  @click="downloadFile(row.item.id, file.path, row.item.message.authorPublicKey ?? '')"
                >
                  Download
                </button>
              </li>
            </ul>
          </template>
          <span v-else-if="row.item.message.verified">{{ row.item.message.body }}</span>
          <span v-else>A message could not be verified.</span>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="mark-read"
              class="rounded border border-stone-300 px-3 py-2"
              :disabled="busy"
              @click="markMessageRead(row.item.id)"
            >
              Mark read
            </button>
            <button
              type="button"
              data-testid="bookmark"
              class="rounded border border-stone-300 px-3 py-2"
              :disabled="busy"
              @click="bookmarkMessage(row.item.id)"
            >
              Bookmark
            </button>
            <button
              type="button"
              data-testid="reply"
              class="rounded border border-stone-300 px-3 py-2"
              :disabled="busy"
              @click="replyParentId = row.item.id"
            >
              Reply
            </button>
          </div>
        </li>
      </ul>
      <p
        v-if="replyParentId"
        data-testid="replying"
        class="text-sm text-stone-600"
      >
        Replying
      </p>
      <button
        v-if="replyParentId"
        type="button"
        data-testid="cancel-reply"
        class="w-fit rounded border border-stone-300 px-3 py-2"
        :disabled="busy"
        @click="replyParentId = ''"
      >
        Cancel reply
      </button>
      <h2 class="text-lg font-semibold">
        Hub
      </h2>
      <label
        class="flex flex-col gap-1 text-sm"
        for="hub-host"
      >
        Hub address
        <input
          id="hub-host"
          v-model="hubHost"
          data-testid="hub-host"
          class="rounded border border-stone-300 px-3 py-2"
          type="text"
        >
      </label>
      <label
        class="flex flex-col gap-1 text-sm"
        for="hub-port"
      >
        Hub port
        <input
          id="hub-port"
          v-model="hubPort"
          data-testid="hub-port"
          class="rounded border border-stone-300 px-3 py-2"
          type="text"
        >
      </label>
      <button
        type="button"
        data-testid="hub-sync"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="syncHub"
      >
        Sync hub
      </button>
      <label
        class="flex flex-col gap-1 text-sm"
        for="offer-path"
      >
        Folder path
        <input
          id="offer-path"
          v-model="offerPath"
          data-testid="offer-path"
          class="rounded border border-stone-300 px-3 py-2"
          type="text"
        >
      </label>
      <label
        class="flex flex-col gap-1 text-sm"
        for="offer-label"
      >
        Folder label
        <input
          id="offer-label"
          v-model="offerLabel"
          data-testid="offer-label"
          class="rounded border border-stone-300 px-3 py-2"
          type="text"
        >
      </label>
      <button
        type="button"
        data-testid="offer-folder"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="offerFolder"
      >
        Offer folder
      </button>
      <label
        class="flex flex-col gap-1 text-sm"
        for="message-body"
      >
        Message
        <textarea
          id="message-body"
          v-model="messageBody"
          data-testid="message-body"
          class="min-h-20 rounded border border-stone-300 px-3 py-2"
        />
      </label>
      <button
        type="button"
        data-testid="send-message"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="sendMessage"
      >
        Send
      </button>

      <h2 class="text-lg font-semibold">
        Invite
      </h2>
      <label
        class="flex flex-col gap-1 text-sm"
        for="invite-hours"
      >
        Valid for hours
        <input
          id="invite-hours"
          v-model.number="inviteHours"
          data-testid="invite-hours"
          class="rounded border border-stone-300 px-3 py-2"
          type="number"
          min="1"
          max="8760"
        >
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input
          v-model="oneTime"
          data-testid="invite-once"
          type="checkbox"
        >
        One-time use
      </label>
      <button
        type="button"
        data-testid="create-invite"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="createInvite"
      >
        Create invite
      </button>
      <label
        v-if="inviteLink"
        class="flex flex-col gap-1 text-sm"
        for="invite-link"
      >
        Invite link
        <input
          id="invite-link"
          data-testid="invite-link"
          class="rounded border border-stone-300 px-3 py-2"
          type="text"
          readonly
          :value="inviteLink"
        >
      </label>
      <button
        v-if="inviteLink"
        type="button"
        data-testid="copy-invite"
        class="w-fit rounded border border-stone-300 px-3 py-2"
        :disabled="busy"
        @click="copyInvite"
      >
        Copy invite
      </button>
      <img
        v-if="qrUrl"
        data-testid="invite-qr"
        alt="QR code for the invite link"
        class="h-56 w-56"
        :src="qrUrl"
      >
      <p class="text-sm text-stone-600">
        Accepting on this device updates the inviter's profile here. Remote delivery comes later.
      </p>
    </section>

    <section
      v-if="currentPublicKey"
      class="flex flex-col gap-3"
    >
      <h2 class="text-lg font-semibold">
        Accept an invite
      </h2>
      <label
        class="flex flex-col gap-1 text-sm"
        for="accept-text"
      >
        Paste an invite link
        <textarea
          id="accept-text"
          v-model="acceptText"
          data-testid="accept-text"
          class="min-h-24 rounded border border-stone-300 px-3 py-2"
        />
      </label>
      <button
        type="button"
        data-testid="accept-invite"
        class="w-fit rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        :disabled="busy"
        @click="acceptInvite"
      >
        Accept invite
      </button>
    </section>

    <p
      v-if="status"
      data-testid="status"
      class="text-stone-800"
    >
      {{ status }}
    </p>
    <p
      v-if="error"
      data-testid="accept-error"
      role="alert"
      class="text-red-700"
    >
      {{ error }}
    </p>
  </main>
</template>
