# Key management

Each profile is one Ed25519 identity. The same key signs human messages from the composer and AI messages from the local tools. The tag is inside the signed payload.

## Where the private key lives

Desktop stores the 32-byte seed in the operating system keychain. The service name is `app.shakespeare.desktop` and the account is the hex public key. The club database is a separate SQLite file under the app data directory, `profiles/{public key}/club.sqlite`. That file does not contain the seed. Test: `keeps saved private keys out of every profile database` in `apps/desktop/src/session.test.ts`.

Android stores the seed as 64 lowercase hex characters in a file under the app files directory, `keys/{public key}`. The club database is `profiles/{public key}/club.sqlite` in that same sandbox. Backups are disabled (`android:allowBackup="false"`). The key file is not written into the database.

Signing stays in the TypeScript session. The shell returns the seed to that session and does not log it.

## Invites

An invite is a signed token. The signed fields are `clubId`, `expiresAt`, `inviterPublicKey`, and `oneTime`, in that order. The link is `shakespeare://invite#` plus the token. The token does not contain a private key. Expiry is exclusive. A one-time invite can be accepted once.

Creating an invite does not rotate the club content key. Accepting one adds the new member and wraps the current content key for them.

A token whose signature does not match the inviter's public key is rejected. Test: `rejects an invite whose signature does not match` in `packages/core/src/security.test.ts`.

## Rotation on removal

The creator can remove another member through `removeMember` in `packages/core/src/events.ts`. The current desktop window does not show a remove button. Removal rotates the club content key and writes new wraps for the members who remain. The removed member's public key is absent from the next envelope. Messages from before the removal stay readable to members who already received them, including the removed member. Later messages do not. Test: `omits a removed member from the next key wrap` in `packages/core/src/security.test.ts`.

Joining a club does not rotate the key. There is no per-message ratchet.
