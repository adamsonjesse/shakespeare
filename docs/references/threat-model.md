# Threat model

This note describes the prototype as it is. It is not a third-party audit.

## Actually has

- The hub stores ciphertext envelopes and voluntary file bytes. It does not store message text. Test: `keeps the hub file free of message text` in `packages/core/src/security.test.ts`.
- A tampered envelope is rejected on import and on hub submit. Tests: `rejects a tampered envelope` and `keeps the hub file free of message text` in `packages/core/src/security.test.ts`.
- A non-member who has only a copied database file cannot decrypt a message, and that file does not contain the message text or the private key. Test: `does not let a non-member decrypt a copied database` in `packages/core/src/security.test.ts`. The same failure for a stranger's key is also in `delivers a human message that survives restart and rejects tampering` in `packages/core/src/events.test.ts`.
- Origin is signed inside the encrypted payload. A loopback tool call cannot force `human`. Test: `refuses an MCP origin override` in `packages/core/src/security.test.ts`. The audit row has no body column. The same rule is in `signs post_message as ai when the caller passes human` in `packages/core/src/tools.test.ts`.
- Removing a member rotates the club content key. The next envelope has no wrap for that member. Messages from before the removal stay readable to someone who already had them. Test: `omits a removed member from the next key wrap` in `packages/core/src/security.test.ts`.
- An invite token does not contain the inviter's private key. A token with a flipped signature is rejected and adds no member. Test: `rejects an invite whose signature does not match` in `packages/core/src/security.test.ts`. Field tampering is also in `accepts a valid invite and rejects expiry, tampering, and malformed tokens` in `packages/core/src/identity.test.ts`.
- The desktop profile database does not contain the private key. Test: `keeps saved private keys out of every profile database` in `apps/desktop/src/session.test.ts`.
- The Android app does not register push. Test: `keeps the shared stream inside the Capacitor app and omits push` in `apps/desktop/src/mobile-shell.test.ts`.

## Hub operator

The hub process listens on `127.0.0.1` only. An operator can read `hub.sqlite`, the membership list, public keys, and seeded blobs. They cannot decrypt a message body from that file. A modified envelope fails the ciphertext hash check.

## Malicious member

A member can decrypt messages wrapped for them, screenshot them, and post as themselves. They cannot read a message sent after they are removed. They cannot make a tool post verify as `human`.

## Stolen device

Copying the database file without the private key does not reveal message text. A person who can read the desktop OS keychain entry, or the Android key file under the app files directory, can decrypt that profile's clubs. The app does not claim otherwise.

## Tampered envelope

Changing ciphertext without updating the event id makes import and hub submit fail. The event id is the SHA-256 of the ciphertext bytes.

## Malicious MCP client on loopback

The tool server binds to `127.0.0.1`. A process that can call it can post, read, and download as that local profile, and every post is tagged `ai`. It cannot export the private key through the tool list, and it cannot relabel a post as `human`. Tests: `lists club tools and no key export or origin argument` in `packages/core/src/tools.test.ts`, and `refuses an MCP origin override` in `packages/core/src/security.test.ts`. A program that can already read the key file or the OS keychain is outside this boundary.

## Non-member with a copied database

The copied SQLite file holds ciphertext. Opening it with a different private key does not decrypt the message.

## Not claimed

- Full forward secrecy. There is no double ratchet. A member can still read messages from before a removal.
- Protection from a member who screenshots or copies plaintext.
- Protection after the private key leaves the device.
- A third-party audit. These tests are the project's own checks.
