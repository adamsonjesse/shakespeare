# Milestone 11: Hub limits

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 6](../completed/milestone-06-hybrid-transport.md) and [Milestone 10](milestone-10-security-docs.md)
**Blocks:** none

This milestone is optional. Do not start it while an earlier plan is in `docs/in-progress/`, and do not pull its work forward.

## Outcome

One local hub process can host two clubs that cannot read each other's envelopes. A configurable free-tier cap refuses a new member or a new blob past the cap. Backup and restore recreate the ciphertext store. No payment is collected.

## Scope

- Tenant key on hub rows is the club id. Queries for envelopes, members, and blobs require it. A test uses two clubs and shows club B's admin path cannot fetch club A's envelope bytes.
- Limit configuration: `max_members` and `max_blob_bytes`. Example defaults, labeled as examples from the business note and not as a price: 25 members and 10 GB.
- Refuse the next member and the next seeded blob when the cap is reached. Existing members and existing blobs stay.
- Admin view, local only: counts of members and stored bytes per club. The view shows ids, sizes, and public keys. It does not decrypt and it has no body field.
- Backup writes the hub SQLite file and blob directory to a folder the operator names. Restore is tested onto an empty directory, then the envelope bytes are compared.
- Usage counters for those same limits, so a later price can be attached without inventing a schema here.
- Update the self-host guide if the operator must set the caps.

## Exclusions

- Stripe or any other payment provider.
- A public signup site.
- Postgres, unless a test in this milestone shows SQLite cannot isolate the two clubs or cannot restore cleanly. A switch has to be named in the milestone report and needs a migration from the SQLite hub. Do not add Postgres first.
- Pricing pages, custom domains, and multi-region replication.
- Decrypting for the admin, for search, or for "support."

## Invariants

- Club isolation holds for envelopes and blobs.
- Caps do not delete existing data.
- The admin view and the backup file contain ciphertext and metadata only. The plaintext fixture is still absent.
- The client database is not part of the hub backup.

## Data model

Hub migrations add club id where a row could otherwise be global, plus `hub_limits` (club id, max members, max blob bytes) and `hub_usage` (club id, member count, blob bytes). Defaults are inserted only when a club is created on the hub.

## Test strategy

Fail first on: club B cannot read club A's envelope through the hub API; member 26 is refused when the cap is 25; a blob past the byte cap is refused; restore onto an empty directory matches envelope bytes; admin output lacks the plaintext fixture. Use temporary hub directories. Do not use a live operator database.

## Acceptance checks

- Two clubs on one hub process, isolation test passing.
- Both caps refuse the next unit and leave prior data in place.
- Restore reproduces the envelope bytes.
- Admin output has counts and no message body.
- Self-host guide matches the commands that just ran.
- No payment call exists in the diff.

## Rollback

Revert the hub migrations on a copy. Keep the milestone 6 hub behavior as the fallback. Do not run a destructive downgrade on a hub directory that holds the only copy of a club's envelopes.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- The business note's prices are examples. Implementing checkout would invent a company the plan does not have.
- "Tenant isolation" without a cross-club test will be a shared table with a comment.
- An admin dashboard that decrypts "just for moderation" breaks the hub invariant.
- Introducing Postgres because the architecture note mentions it widens this milestone before there is a failure.
- Backup of the client keystore would copy private keys into the hub operator's folder.

### Revisions applied

- Caps are configuration. Example numbers are labeled examples. No payment provider.
- Isolation is a cross-club fetch test, not a schema comment.
- The admin view is counts and public metadata.
- SQLite stays unless this milestone's own tests show it cannot do the job.
- Hub backup excludes client keystores and client databases.
