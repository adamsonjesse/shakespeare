# Work plan

**Project name (working):** ClubOS / Buzz-style AI-native club
**Reviewed:** 2026-10-16
**Goal:** Build a production-quality open-source prototype of an AI-native, fully end-to-end encrypted, hybrid-decentralized productivity club app for startups and investing clubs.

This file is the index. Each milestone has its own plan beside it. Procedure, publication, and folder moves live in [WORKFLOW.md](../../WORKFLOW.md).

The split below is a same-agent adversarial review of the original milestone list. It is not an independent review. Revised decisions are in each milestone file under "Adversarial self-review."

## Confirmed requirements

- Full end-to-end encryption for messages and files.
- One identity per user, usable by the human and by an AI. Content is tagged `human` or `ai`.
- Invite-only clubs.
- Optional hub ranking assist only when it adds value and does not see plaintext.
- Two core experiences: a personalized single stream with filters, and torrent-style voluntary folder sharing.
- Desktop: Tauri 2, Vue 3, TypeScript, TailwindCSS.
- Mobile: Capacitor, same Vue frontend.
- Local-first SQLite on clients.
- Content-addressed voluntary downloads. No silent mirroring.
- Hybrid transport: direct peer connections preferred, optional relays.
- MCP and CLI so any AI subscription can act as a participant.
- Work stays on `main`. Each verified milestone is committed and pushed.

## Trunk order

Build one milestone at a time on `main`. Do not open a feature branch unless the user asks.

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

The original list allowed milestones 4 and 5 to overlap after milestone 2. That overlap is dropped for the default order. Both can be interleaved only when the user asks, because they would share `main`. Milestone 9's shell begins in milestone 0. Its completion still waits until the stream, file sharing, and relay exist.

## Milestones

| # | Plan | Status | Depends on |
| --- | --- | --- | --- |
| 0 | [Foundation and tooling](../completed/milestone-00-foundation.md) | completed | none |
| 1 | [Identity and invites](../completed/milestone-01-identity-invites.md) | completed | 0 |
| 2 | [Signed events and local store](../completed/milestone-02-signed-events.md) | completed | 1 |
| 3 | [Single stream, ranking, filters](../completed/milestone-03-stream-ranking.md) | completed | 2 |
| 4 | [Human and AI tagging](../completed/milestone-04-ai-tagging.md) | completed | 3 |
| 5 | [Voluntary file sharing](../completed/milestone-05-voluntary-files.md) | completed | 2, 3 |
| 6 | [Hybrid transport and hub skeleton](../completed/milestone-06-hybrid-transport.md) | completed | 2, 5 |
| 7 | [Learned ranking](../completed/milestone-07-learned-ranking.md) | completed | 3, 6 |
| 8 | [MCP and CLI parity](../completed/milestone-08-mcp-cli.md) | completed | 4, 5, 7 |
| 9 | [Mobile completion](../completed/milestone-09-mobile.md) | completed | 0, 5, 6, 8 |
| 10 | [Security hardening and docs](milestone-10-security-docs.md) | planned | 6, 8, 9 |
| 11 | [Hub limits](milestone-11-hub-limits.md) | planned | 6, 10 |

Milestone 11 is planned and optional. Do not start it from an earlier milestone.

## References

These inform a plan. They do not authorize a stack change.

- [Architecture deep dive](../references/architecture-deep-dive.md)
- [Decentralized pivot analysis](../references/decentralized-pivot-analysis.md)
- [Business model analysis](../references/business-model-analysis.md)
- [Product exploration](../references/ultimate-ai-native-chat-productivity-app-plan.md)

When a reference disagrees with a milestone plan, follow the milestone plan and ask before switching stack or scope. The known disagreement is protocol: the pivot note recommends considering Nostr or Matrix, and these plans keep the signed-event plus optional-relay design already chosen here.
