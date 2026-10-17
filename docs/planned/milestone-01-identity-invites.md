# Milestone 1: Identity and invites

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 0](milestone-00-foundation.md)
**Blocks:** [Milestone 2](milestone-02-signed-events.md)

## Outcome

A person can create a club on one profile, produce an invite, and accept that invite from a second local profile. The second profile shows up as a member. Private keys never leave the device.

## Scope

- Generate an identity keypair and store the private key in the platform keystore (Tauri stronghold or the OS keychain). The public key is the member id.
- Create a club record: id, name, creator public key, created time.
- Invite payload: club id, inviter public key, expiry, and a signature over those fields. Optional one-time use.
- Accept an invite by pasting the payload or opening the link form. Show a QR rendering of the same payload. Camera scanning is optional and is not an acceptance check.
- Membership list stored locally, with a role of creator or member.
- A test transport, in memory or on loopback, that carries invite and membership records between two profiles. It is a harness, not the product network.
- Minimal UI: create club, copy invite, accept invite, show members.

## Exclusions

- Iroh, relays, and any production peer connection. Those are milestone 6.
- Message encryption. That is milestone 2.
- Account passwords, email invites, and a hosted invite service.
- Putting a private key, a seed phrase, or a club content key inside the invite.

## Invariants

- Private keys are not written to SQLite in plaintext, not logged, and not placed in the invite.
- A malformed, expired, or badly signed invite is rejected.
- Accepting an invite does not grant access to another club.
- The test transport is clearly named as a test double and is not the default when the real transport arrives.

## Data model

Add club and membership tables in a new migration. Membership rows store public keys and roles, not private keys. Keystore location stays outside the database file.

## Test strategy

Fail first on: key generation produces a stable public key; a valid invite accepts; an expired invite rejects; a tampered signature rejects; two profiles end with the same membership set after the test transport exchanges the acceptance. Use a temporary data directory per profile.

## Acceptance checks

- Profile A creates a club and exports an invite.
- Profile B accepts it and appears in A's membership list after the test exchange.
- An expired or edited invite does not create a membership.
- Logs and the database file contain no private-key bytes from the fixture.

## Rollback

Revert the migration and the keystore calls. Test profiles are disposable.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- The original "second client appears as a member" check needs a network, but the network milestone is later. Implementing Iroh here would swallow milestone 6.
- An invite that carries a club secret would break end-to-end encryption before messages exist.
- QR scanning adds a camera dependency that the definition of done does not actually need.
- "Sync-ready presence" can be mistaken for a presence protocol.

### Revisions applied

- Two profiles prove membership through a named test transport. Milestone 6 replaces that transport.
- The invite is a signed, expiring capability. It contains no key material.
- Paste or link acceptance is required. QR display is required. Camera scan is not.
- Presence in this milestone is the membership row plus a local timestamp. It is not a network presence protocol.
