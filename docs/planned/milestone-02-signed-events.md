# Milestone 2: Signed events and local store

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 1](milestone-01-identity-invites.md)
**Blocks:** [Milestone 3](milestone-03-stream-ranking.md) and [Milestone 5](milestone-05-voluntary-files.md)

## Outcome

Two profiles in one club can exchange a short text message. After a restart, the message is still there and still decrypts. A changed ciphertext is rejected. The hub, if a test double stands in for one, cannot read the text.

## Scope

- Canonical event inside the signed plaintext: id inputs, club id, author public key, created time, `origin: "human"`, and a text body.
- Sign the canonical plaintext with the author key. Encrypt that signed event with a club content key.
- Wrap the club content key to each current member's public key. Store wraps with the event envelope.
- Event id is the hash of the ciphertext envelope, not the hash of the plaintext.
- SQLite tables for events and an outbox. Threads, read state, and bookmarks wait for milestone 3, but the event row has nullable `parent_id` so later replies do not require a crypto-format change.
- Decrypt and verify before the UI or any log sees the body.
- Send and receive over the milestone 1 test transport. Payloads on that transport are envelopes only.
- Crypto library: a pure TypeScript implementation that unit tests can run without Tauri (`@noble/curves` and `@noble/ciphers`, or an equivalent that runs in the test process). Do not require the webview for round-trip tests.
- Member removal rotates the club content key. Later events use the new key. The removed member does not receive the new wrap. Older events stay decryptable by members who already had them.

## Exclusions

- Nostr, Matrix, or a Buzz fork. The pivot note prefers an existing protocol. These plans stay on this event model until the user changes them.
- Forward secrecy beyond the removal rotation above. Do not claim a double ratchet.
- File blobs, ranking, and AI origin. `origin` accepts only `human` in this milestone. `ai` arrives in milestone 4.
- A production relay.

## Invariants

- The test transport and any log line see ciphertext, public keys, event ids, and timestamps. They do not see the body.
- Tampered ciphertext or a bad author signature does not decrypt into a displayed message.
- A non-member who has the envelope still cannot decrypt it.
- Plaintext is not used as a content address.

## Data model

New migration: `events` (id, club id, author public key, created time, ciphertext, parent id nullable) and `event_key_wraps` (event id, member public key, wrapped key). Do not add a plaintext body column.

## Test strategy

Fail first on round-trip decrypt, tamper detection, non-member rejection, restart persistence, and removal rotation. Inject the clock. Use two temporary profiles and the test transport. Search the transport log fixture for the known plaintext and assert it is absent.

## Acceptance checks

- Profile A sends "hello club". Profile B decrypts that exact string.
- Restarting B's store still decrypts it.
- Flipping one ciphertext byte makes verification fail.
- After A removes B, a new message is not wrapped to B. B can still decrypt the earlier message.
- The plaintext fixture does not appear in the envelope bytes.

## Rollback

Revert the migration and ignore any dev database. Test profiles are disposable. Do not point tests at a person's live database.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "Content-addressable" plus encryption is unsafe if the address is a hash of the plaintext. That hash leaks the text to anyone who can guess it.
- Group encryption is easy to overbuild. A custom ratchet does not belong in this milestone, and a single shared key with no removal story lets a removed member read new messages.
- The original two-client exchange "via temporary relay" duplicates milestone 6 if the relay becomes real.
- Adding `origin` later would change the signed bytes and break verification of old events.
- libsodium-in-the-webview is a poor place for the first tests.

### Revisions applied

- Event ids hash the ciphertext envelope.
- Version 1 is a club content key wrapped to current members, with tested rotation on removal. It does not claim a full ratchet.
- The milestone 1 test transport carries envelopes. Milestone 6 replaces it.
- `origin` is part of the signed plaintext now, restricted to `human`.
- Crypto tests run in the workspace test process, not in the webview.
