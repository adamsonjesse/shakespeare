# Milestone 5: Voluntary file sharing

**Status:** completed
**Index:** [WORK_PLAN.md](../planned/WORK_PLAN.md)
**Depends on:** [Milestone 2](../completed/milestone-02-signed-events.md) and [Milestone 3](../completed/milestone-03-stream-ranking.md)
**Blocks:** [Milestone 6](../completed/milestone-06-hybrid-transport.md), [Milestone 8](../planned/milestone-08-mcp-cli.md), and [Milestone 9](../planned/milestone-09-mobile.md)

## Outcome

Profile A offers a folder. Profile B sees the offer, downloads one chosen file or the whole folder, and checks the bytes against the manifest. Nothing is transferred until B asks. B can then seed what B downloaded.

## Scope

- Pure manifest builder: relative path, size, and hash for each file, plus a folder hash. Hashes are BLAKE3 or the hash the chosen library already uses. Paths reject absolute paths and `..` segments.
- The chat event contains the manifest and a short label inside the encrypted body. It does not contain file bytes.
- Explicit download action in the stream. Receiving or decrypting the event does not enqueue a download.
- Content-addressed blob store on disk, ignored by git. Fetch by hash, verify, then write the requested paths under a download directory the user chose.
- Resume by skipping hashes already present and verified.
- Seed only blobs this profile has verified.
- Transport for this milestone: two local peers using the library selected for the product path (Iroh if the dependency builds on the dev machine). The milestone 2 test transport is not used for file bytes.
- Tests for manifest creation, path rejection, hash mismatch, and selective download against the local two-peer setup.

## Exclusions

- Automatic pin or mirror on a hub. The hub does not exist yet.
- Image previews that upload bytes to a third party.
- Syncing the download directory into SQLite.
- Sharing a file with a non-member. The manifest event is club-encrypted, so a non-member never sees the hashes.

## Invariants

- No code path on receive starts a transfer.
- A hash mismatch deletes or refuses the partial file and does not mark it seeded.
- The manifest's names and paths are encrypted with the event. The blob store is addressed by hash and is not a world-readable directory listing.
- Only requested paths are written.

## Data model

The manifest lives in the encrypted event body. Local tables: `blob_index` (hash, size, path on disk, verified time) and `download_requests` (event id, selected paths, state). Do not store file bytes in SQLite.

## Test strategy

Fail first on path canonicalization, manifest hash stability, and a selective download that fetches one file from a three-file folder. Then a two-peer test that transfers only the selected hash and fails closed on a flipped byte. Assert the unselected file is absent from B's download directory and from B's blob index.

## Acceptance checks

- A shares a folder of at least two files. B sees the names and sizes after decrypt, and B's disk does not yet contain the bytes.
- B downloads one file. The bytes match. The other file is absent.
- B downloads the rest and can seed the first file back to a third profile that has the manifest.
- A corrupted blob is rejected.
- Desktop check: offer, selective download, and a failed hash shown as an error rather than a finished file.

## Rollback

Delete ignored blob fixtures and revert the manifest event type. Text events stay valid.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- A mock blob store can pass while the app still auto-downloads on message receipt.
- Hashes in an unencrypted event would show filenames to the relay and to non-members.
- Hub pinning in this milestone creates a mirror, which the product forbids.
- Choosing the transport library here can reopen the Nostr-or-Matrix question. That decision stays with the user.

### Revisions applied

- The two-peer test asserts the unselected file never lands on disk. Receive does not enqueue work.
- Manifests stay inside the encrypted event.
- No hub pin in this milestone.
- Use Iroh, or the equivalent already named by the architecture note, for the local two-peer transfer. Do not adopt a new message protocol in this milestone.
