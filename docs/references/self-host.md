# Self-host the hub

The hub is a local store-and-forward process for ciphertext. It is not a public service, and this repository has no deploy, database server, or billing step.

## Start it

From the repository root, after `pnpm install`:

```text
pnpm hub -- <directory> <port>
```

Example:

```text
pnpm hub -- ./hub-data 8787
```

The process prints `listening 127.0.0.1` and the port. It accepts connections only on `127.0.0.1`. The directory is the one you named. It contains `hub.sqlite`. Seeded blobs are also written under `blobs/`.

Leave that process running while members sync.

## Caps

A club gets its caps when it is first created on the hub. The examples are 25 members and 10 GB of seeded blobs. Those numbers are examples, not a price. The next member or the next seeded blob past the cap is refused. Members and blobs already stored stay. Starting the process again with different numbers does not change a club that already has caps.

To choose other caps for clubs this process creates, pass both numbers:

```text
pnpm hub -- ./hub-data 8787 25 10737418240
```

The last two numbers are the member cap and the blob-byte cap.

## Backup

Stop the hub process. Copy `hub.sqlite` into an empty folder you name. If `blobs/` is present, copy that directory too. Leave every other file in the hub directory behind. The copy does not include a profile database or a private key.

To restore, put those copied items in a new empty directory and start the hub on that directory. The stored envelopes match the copy.

## Connect two profiles on this computer

1. Start the desktop app with `pnpm dev`.
2. Choose Create profile. That profile is A.
3. Enter a club name and choose Create club. The new club opens.
4. Set Hub address to `127.0.0.1` and Hub port to the port you chose, then choose Sync hub.
5. Choose Create invite and copy the invite link.
6. Choose Create profile again. That profile is B. Paste the link into Paste an invite link and choose Accept invite.
7. Click A's profile button, click the club, and choose Sync hub again so the hub learns about B.
8. Type a message and choose Send.
9. Click B's profile button, click the club, set the same Hub address and Hub port, and choose Sync hub. Choose Stream if Catch-up is showing. The message appears.

An Android emulator on the same computer uses hub host `10.0.2.2` and that same port. The hub process still listens on `127.0.0.1`.

## What the hub file holds

`hub.sqlite` stores club ids, member public keys, opaque envelopes, optional seeded blobs, and theme weights only when a member turns on "Publish theme weights". It does not store message text or private keys.

After the two profiles exchange a message, search `hub.sqlite` for a word from that message. The word is not in the file. Test: `keeps the hub file free of message text` in `packages/core/src/security.test.ts`.

The default assist checkbox is off. Leave it off unless you intend to publish theme ids and integer weights.

## Stop it

Stop the `pnpm hub` process. The directory you named remains on disk until you delete it. Deleting it removes the stored envelopes and seeded blobs. It does not delete a member's profile or private key.
