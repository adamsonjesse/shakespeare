# Milestone 4: Human and AI tagging

**Status:** completed
**Index:** [WORK_PLAN.md](../planned/WORK_PLAN.md)
**Depends on:** [Milestone 3](../completed/milestone-03-stream-ranking.md)
**Blocks:** [Milestone 8](../planned/milestone-08-mcp-cli.md)

## Outcome

The same identity key can post as the human or as the user's AI. The stream shows which is which. An external process can post one AI-tagged message through a minimal MCP tool. It cannot label that message as human.

## Scope

- Accept `origin: "ai"` in the signed plaintext from milestone 2.
- Reject an event with a missing or unknown origin. Do not default a missing origin to `human`.
- Stream badge or label that renders the origin after decrypt. Do not trust a label outside the signature.
- Local filter can include or exclude `ai` and `human`.
- One MCP tool, `post_message`, running locally. It signs with the user identity, forces `origin` to `ai`, and submits through the same send path as the composer.
- A CLI entry that calls the same function, so the test does not need a live model.

## Exclusions

- A second keypair for the AI. Buzz-style separate agent keys are a different product decision and are not this requirement.
- The rest of the MCP surface: read, filter, bookmark, download, themes. Those are milestone 8.
- Letting the model choose the origin value.
- Hub-side moderation of tags. The hub still cannot read the body.

## Invariants

- The origin is inside the signed plaintext. A peer cannot flip a badge without breaking the signature.
- `post_message` always writes `ai`, even if the caller passes `human`.
- The composer writes `human` and has no control that switches the signed origin to `ai`.
- Logs still exclude plaintext.

## Data model

No new plaintext column. Origin remains inside the encrypted signed event. A local index may store the decrypted origin for filtering after verification. That index is derivative and is rebuilt from verified events.

## Test strategy

Fail first on: human composer events verify as `human`; MCP posts verify as `ai`; a caller-supplied `human` origin on the MCP tool is ignored or rejected; a tampered origin byte fails verification; a theme can hide `ai` events. Use the CLI or an in-process tool call. Do not call a live model provider.

## Acceptance checks

- A composed message shows as human.
- An MCP or CLI post shows as AI and uses the same public key as the human posts.
- The AI filter changes the list.
- A forged origin does not display as a successful message.
- Desktop check: both labels are visible, and the AI filter hides the AI row.

## Rollback

Stop the MCP process and revert the origin allow-list to `human` only. Existing `human` events remain valid.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- A tag stored only in the UI, or in unsigned metadata, can be spoofed by a peer or stripped by a relay.
- Defaulting missing tags to human hides unlabeled AI text.
- Building the full MCP server here makes milestone 8 a rewrite and widens this milestone into file downloads and ranking.
- A separate AI key contradicts the confirmed single-identity requirement.

### Revisions applied

- Origin stays inside the signed plaintext introduced in milestone 2.
- Missing origin is an invalid event.
- This milestone ships one forced-`ai` post tool and the badge. Milestone 8 extends the tool list.
- One keypair. The tag, not a second identity, distinguishes the author.
