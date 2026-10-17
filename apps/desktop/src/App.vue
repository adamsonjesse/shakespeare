<script setup lang="ts">
import { onMounted, ref } from "vue";
import { openLocalDatabase } from "./storage.ts";

const status = ref("Opening the local database…");
const error = ref("");

onMounted(async () => {
  try {
    const version = await openLocalDatabase(new Date().toISOString());
    status.value = `Database ready. Schema version ${version}.`;
  } catch (caught) {
    status.value = "";
    error.value = caught instanceof Error ? caught.message : "The database could not be opened.";
  }
});
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 px-6">
    <p class="text-sm font-medium uppercase tracking-wide text-stone-500">
      Shakespeare
    </p>
    <h1 class="text-3xl font-semibold text-stone-900">
      Desktop shell
    </h1>
    <p class="text-stone-700">
      No club is loaded. Identity, messages, and files arrive in later milestones.
    </p>
    <p
      v-if="status"
      data-testid="db-status"
      class="text-stone-900"
    >
      {{ status }}
    </p>
    <p
      v-if="error"
      role="alert"
      class="text-red-700"
    >
      {{ error }}
    </p>
  </main>
</template>
