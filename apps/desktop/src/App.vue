<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import QRCode from "qrcode";
import { createSession } from "./session.ts";
import { createTauriHost } from "./storage.ts";
import type { Club, Member } from "@shakespeare/core";

const session = createSession(createTauriHost());
const profiles = ref<string[]>([]);
const currentPublicKey = ref("");
const clubs = ref<Club[]>([]);
const selectedClubId = ref("");
const members = ref<Member[]>([]);
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

async function refreshClubs(): Promise<void> {
  clubs.value = await session.listClubs();
  if (!clubs.value.some((club) => club.id === selectedClubId.value)) {
    selectedClubId.value = "";
    members.value = [];
    return;
  }
  members.value = await session.listMembers(selectedClubId.value);
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
    members.value = await session.listMembers(clubId);
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
