# Milestone 3: Single stream, ranking, and filters

**Status:** completed
**Index:** [WORK_PLAN.md](../planned/WORK_PLAN.md)
**Depends on:** [Milestone 2](../completed/milestone-02-signed-events.md)
**Blocks:** [Milestone 4](../planned/milestone-04-ai-tagging.md), [Milestone 5](../planned/milestone-05-voluntary-files.md), and [Milestone 7](../planned/milestone-07-learned-ranking.md)

## Outcome

One club shows one scrolling list of messages, newest interest first among unread items. The person can filter that list, mark items read, bookmark them, and reply one level deep. The score is deterministic.

## Scope

- Vue stream: one list, a composer, and no channel sidebar.
- Saved filters, called themes: a name plus match terms. Applying a filter hides non-matching decrypted text. Filters are local.
- Pure ranking function in `packages/core`. Inputs are the event time, the injected now, whether the text matches the active theme, and a fixed recency half-life. No `Date.now()` inside the function.
- Unread catch-up view: unread items ordered by that score.
- Read state and bookmarks in SQLite, local to the profile.
- Replies: an event may set `parent_id`. The UI indents a reply once. A reply to a reply is stored but shown at that same single indent in this milestone.
- Sending uses the milestone 2 store and test transport.

## Exclusions

- Learned weights, embeddings, and hub ranking. Those are milestone 7.
- Channel sidebars, threads that look like Slack, and multiple streams.
- AI badges. Those are milestone 4. Human text still carries `origin: "human"`.
- File manifests.

## Invariants

- The same inputs always produce the same order.
- Ranking runs on decrypted local data. It does not send text to a hub.
- Marking read on one profile does not mark read on another.
- A filter cannot reveal ciphertext the profile cannot decrypt.

## Data model

New migration: `read_state` (event id, read time), `bookmarks` (event id, created time), `themes` (id, name, terms). Terms are local plaintext because they are the user's own filter definitions.

## Test strategy

Fail first on the pure function: a matching unread item outranks an older non-matching item when recency is equal; a much newer non-matching item can outrank a stale match; empty input returns an empty list. Then a store test that mark-read removes an item from the catch-up query. UI checks cover the list, one filter, mark read, bookmark, and a reply indent.

## Acceptance checks

- Sending a message shows it in the stream after decrypt.
- Saving a theme and applying it changes the visible list.
- Catch-up order matches the pure function for a fixed clock.
- Bookmark and mark-read survive restart.
- A reply is visibly nested one level under its parent.
- Desktop check: compose, filter, mark read, bookmark, reply. One failure path: the composer rejects an empty body.

## Rollback

Revert the UI and the new tables. Existing events remain readable.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "Feels like WhatsApp" is not a test. Agents will either gold-plate a chat clone or skip the check.
- "Multi-layer threads" can expand into arbitrary Slack-style channels.
- A ranker that calls the clock itself cannot be tested without sleeps.
- Building learned ranking here duplicates milestone 7 and invites a model dependency.

### Revisions applied

- Acceptance is a single list, composer, local theme filter, catch-up order, bookmark, and one-level reply.
- Deeper replies store a parent id and render at one indent. No channel sidebar.
- The score function takes `now` as an argument.
- Weights stay fixed. Learning is milestone 7.
