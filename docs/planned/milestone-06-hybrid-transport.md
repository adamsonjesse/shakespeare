# Milestone 6: Hybrid transport and hub skeleton

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 2](../completed/milestone-02-signed-events.md) and [Milestone 5](../completed/milestone-05-voluntary-files.md)
**Blocks:** [Milestone 7](milestone-07-learned-ranking.md), [Milestone 9](milestone-09-mobile.md), [Milestone 10](milestone-10-security-docs.md), and [Milestone 11](milestone-11-hub-limits.md)

## Outcome

When both peers are online they exchange events directly. When the recipient is offline, a local hub process accepts the ciphertext and hands it over after reconnect. A developer can run that hub on the same machine. It stores no message bodies.

## Scope

- Replace the milestone 1 test transport for club events with two paths: direct peer connection, and a store-and-forward relay.
- Direct path uses the same peer library as milestone 5.
- Hub process for local development. SQLite stores member public keys, opaque event envelopes, and blob hashes the members have already asked the hub to hold. No Postgres.
- Invite-only at the relay: reject envelopes whose author public key is not a current member.
- Catch-up: the client sends the last event id it verified, and the hub returns later envelopes for that club.
- Outbox: events written locally while offline are sent when a direct peer or the hub is reachable.
- A local README section, or a doc under `docs/`, with the one command that runs the hub. Do not deploy it.

## Exclusions

- Paid tiers, member caps, and admin dashboards. Those are milestone 11.
- Postgres, Docker, and a public hostname.
- Reading or re-encrypting event bodies on the hub.
- Pinning every file in a club. The hub may store a blob only after a member uploads it as part of an explicit seed. It does not fetch files on its own.
- Switching the message format to Nostr or Matrix.

## Invariants

- A hub database dump does not contain the plaintext fixture.
- A non-member public key cannot submit an envelope or read another club's envelopes.
- Direct delivery does not require the hub process to be running.
- Offline send survives a client restart before the recipient returns.
- Key material is not uploaded.

## Data model

Hub database, separate from the client database: `hub_members` (club id, public key), `hub_envelopes` (event id, club id, received time, ciphertext bytes), `hub_blobs` (hash, bytes, size). Client outbox stays in the client database.

## Test strategy

Fail first on three cases: both peers up and the hub stopped, direct delivery works; recipient stopped, sender stores on the hub, recipient fetches after restart; non-member post is rejected. Assert the plaintext fixture is absent from the hub file. Use temporary directories.

## Acceptance checks

- Direct exchange works with the hub process not running.
- An offline recipient receives the message after reconnect through the hub.
- A non-member is rejected by the hub.
- The hub file does not contain the plaintext fixture.
- Self-host check: a second machine or a second local process can point at that hub using the documented command. No public deploy.

## Rollback

Stop the hub process and revert clients to the test transport only if the direct path is broken. Do not delete a person's client database as part of rollback. Test hub files are disposable.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- The original "official hub skeleton" plus the architecture note can pull Postgres, multi-tenant billing, and deployment into this milestone.
- A relay that can decrypt, or that receives plaintext "for search," breaks the hub invariant.
- Catch-up that trusts the hub's ordering without verifying signatures will display forged events.
- File sharing plus a helpful hub will silently mirror folders unless seeding stays explicit.
- The pivot note says not to invent a protocol. Changing protocols here is a product decision, not an implementation detail.

### Revisions applied

- The hub is a local SQLite process. Postgres, billing, and deploy stay out.
- The hub stores envelopes and voluntarily seeded blobs only. Clients verify signatures before display.
- The hub does not download files by itself.
- The event format stays as milestone 2 defined it.
