# Milestone 10: Security hardening and documentation

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 6](../completed/milestone-06-hybrid-transport.md), [Milestone 8](milestone-08-mcp-cli.md), and [Milestone 9](milestone-09-mobile.md)
**Blocks:** [Milestone 11](milestone-11-hub-limits.md)

## Outcome

A new developer can run a club from the docs, and the repo states the end-to-end encryption properties the prototype actually has. Tests cover those properties. This milestone is a review and a hardening pass, not a claim that an outside auditor signed off.

## Scope

- Threat model in `docs/references/` covering: hub operator, malicious member, stolen device, tampered envelope, malicious MCP client on loopback, and a non-member with a copied database file.
- Document the real properties: hub and non-members cannot read bodies; origin is signed; removed members do not get new content-key wraps; old messages remain readable to prior members; invites carry no private keys; logs and notifications omit bodies.
- Document what is not claimed: full forward secrecy, protection from a member who screenshots plaintext, and a third-party audit.
- Key management doc: where the private key lives, how an invite works, and how to rotate on removal.
- Self-host guide for the milestone 6 hub. Local command, data directory, and the checks that the hub file has no plaintext.
- User-facing notes for invites, AI tags, and voluntary downloads.
- Integration tests that encode the properties above, reusing fixtures from milestones 1, 2, 5, 6, and 8.
- Fix any defect those tests uncover. Add a regression test before the fix.

## Exclusions

- Hiring an auditor or publishing a formal audit report.
- New product features, including paid limits.
- Rewriting the protocol.
- A guide that describes Postgres, billing, or a public deploy this repo does not have.

## Invariants

- The docs match the code. If a test disproves a sentence in the threat model, change the sentence or the code in this milestone. Do not leave the contradiction.
- Hardening does not weaken a check to stay green.
- The self-host guide uses the local hub only.

## Data model

No new product tables unless a hardening fix requires one. A migration, if needed, follows the versioned runner and is tested on a copy of the previous schema.

## Test strategy

Add or extend integration tests for: tamper rejection, non-member decrypt failure, removed-member wrap absence, hub dump without the plaintext fixture, MCP origin override refusal, and invite signature failure. Run the full workspace test command. Treat a documentation claim without a test or an explicit "not claimed" label as a failed review.

## Acceptance checks

- Threat model, key management, self-host guide, and user notes are linked from the README.
- The integration tests pass.
- A developer following only the self-host guide can start the hub and connect two local clients.
- Every property in the "actually has" list is either tested or pointed at an existing test by name.
- Desktop and mobile checks from earlier milestones are not repeated in full. Re-run only a flow whose code changed.

## Rollback

Docs can revert independently. A security fix does not revert unless the fix itself breaks a prior acceptance check, in which case the milestone stays open.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "E2EE audit" will be reported as if a third party reviewed it.
- A self-host guide written before the hub exists, or written against the business tier, will document software that is not there.
- Hardening can turn into a protocol rewrite.
- Properties that are only prose will drift from the code.

### Revisions applied

- The milestone says what an outside audit is not.
- The guide documents the milestone 6 hub. Milestone 11 updates it if limits change the operator steps.
- Scope is tests, docs, and defects those tests find.
- Each claimed property needs a test name or a "not claimed" label.
