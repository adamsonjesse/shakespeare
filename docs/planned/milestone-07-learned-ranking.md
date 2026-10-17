# Milestone 7: Learned ranking

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 3](milestone-03-stream-ranking.md) and [Milestone 6](milestone-06-hybrid-transport.md)
**Blocks:** [Milestone 8](milestone-08-mcp-cli.md)

## Outcome

Local ranking changes after the person reads, bookmarks, replies, and applies themes. A fixed fixture ends in a different, expected order. The app still ranks with the hub stopped. Any hub assist uses an explicit opt-in metadata signal and never receives message text.

## Scope

- Extend the pure ranker so a local weight per theme increases on bookmark, reply, and a read that lasts past a short injected threshold. Recency still matters.
- Weights live in SQLite on the client.
- An evaluation fixture: scripted actions and the expected before/after order. No snapshot that only checks "the list changed."
- Optional hub assist, off by default. The only payload allowed is a theme id and a numeric weight the client chooses to publish. The hub may return those weights to the same user's other devices. It does not receive event bodies, file bytes, or embeddings.
- A test that stands up the hub from milestone 6, runs a ranking update, and searches the hub database for the plaintext fixture.

## Exclusions

- Embeddings of message text, on device or on the hub.
- A model download or a hosted inference API.
- Training across club members. Weights are per profile.
- Changing the milestone 3 score when the new weights are empty. Empty weights must reproduce the milestone 3 order.

## Invariants

- The ranker is still a pure function of its inputs, including the weight table and the injected clock.
- Hub assist off is the default, and catch-up still works.
- The hub request body is limited to theme ids and weights. A test fails if a message body field is serializable on that request.
- One user's weights are not applied to another user's stream.

## Data model

New client table: `theme_weights` (theme id, weight, updated time). Hub table, only if assist is enabled: `published_weights` (public key, theme id, weight). No event body column.

## Test strategy

Characterize milestone 3 order first with empty weights. Then fail on the fixture where bookmarking theme A lifts an equally recent A item above a B item. Then the hub-off test and the hub-database plaintext search.

## Acceptance checks

- The fixture's after-order matches the expected ids.
- With the hub process stopped, the same local order is produced.
- Enabling assist does not change the order unless the client publishes weights.
- The hub database and the assist request do not contain the plaintext fixture.
- Desktop check: bookmark an item, reopen catch-up, and see that theme move up. Confirm the order matches the fixture's rule, not a visual impression alone.

## Rollback

Drop `theme_weights`. Empty weights restore the milestone 3 order. Disable the assist flag.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "Optional hub-side embedding" cannot be reconciled with end-to-end encryption. An embedding of the body is the body, compressed.
- "Visibly improves" will be reported from one screenshot.
- A hub that must be online for ranking violates the local-first requirement.
- Publishing raw event text as a "theme signal" would launder plaintext into the relay.

### Revisions applied

- No embeddings and no plaintext leave the device for ranking.
- The behavior check is a named fixture with an expected order.
- Local weights are the product. Hub assist is off by default and carries theme ids and weights only.
- The assist request has an allowlist. The test rejects any other field.
