# Work Plan: AI-Native Decentralized Club Productivity App

**Project name (working):** ClubOS / Buzz-style AI-native club
**Date:** October 16, 2026
**Goal:** Build a production-quality open-source prototype of an AI-native, fully end-to-end encrypted, hybrid-decentralized productivity club app for startups and investing clubs.

**Confirmed requirements:**
- Full E2EE for messages and files
- Single identity per user that is a human/AI combo; content is explicitly tagged as human-generated or AI-generated
- Invite-only clubs
- Optional hub can assist with ranking if it adds value
- Both core experiences in scope: personalized single-stream ranking + filters, and torrent-style voluntary large-folder sharing
- Desktop: Tauri 2 + Vue 3 + TypeScript + TailwindCSS
- Mobile: Capacitor + same Vue frontend
- Local-first: SQLite on clients
- Content-addressed voluntary downloads for large files/folders (never auto-mirrored)
- Hybrid transport (direct P2P preferred, optional relays)
- Full MCP/CLI so any AI subscription can act as a full participant

**Development style:** Test-driven where practical, milestone-based commits, each milestone leaves the repo in a working, reviewable state.

---

## Milestone 0: Project Foundation & Tooling

**Commit goal:** Clean monorepo scaffold, CI, linting, testing harness, and documentation that any agent can pick up.

**Deliverables:**
- Monorepo structure (pnpm or Cargo workspace as appropriate)
- Tauri 2 desktop app skeleton with Vue 3 + TypeScript + TailwindCSS + Vite
- Capacitor mobile skeleton pointing at the same Vue source
- Shared TypeScript packages for core logic
- SQLite setup (local) with migration system
- Basic CI (typecheck, lint, unit tests, build desktop)
- `WORKFLOW.md` and this plan committed
- README with local development instructions
- Initial test suite (even if mostly empty) and TDD conventions documented

**Definition of done:**
- `pnpm dev` (or equivalent) launches desktop app
- Mobile project can be synced and built
- CI green on empty/placeholder tests
- All contributors/agents can follow WORKFLOW.md

---

## Milestone 1: Identity, Keys & Invite-Only Clubs

**Commit goal:** Cryptographic identity, invite system, and basic club membership that is E2EE-ready.

**Deliverables:**
- Keypair generation and secure storage (user identity)
- Invite links / QR codes that create club membership
- Club creation and membership list (local + sync-ready)
- Basic presence / membership events
- Tests for key generation, invite acceptance, and membership state

**Definition of done:**
- User can create a club and generate an invite
- Second client can accept invite and appear as a member
- All identity material is local and not sent in plaintext

---

## Milestone 2: Signed Event Model & Local Message Store

**Commit goal:** Durable, signed, content-addressable message events stored locally in SQLite with full E2EE.

**Deliverables:**
- Event schema (signed, encrypted payload)
- Local SQLite schema for events, threads, read status, bookmarks
- Encryption/decryption layer (libsodium or equivalent)
- Basic send/receive of encrypted text messages between two clients (via temporary relay or direct if possible)
- Tests covering encryption round-trip, event signing, and local persistence

**Definition of done:**
- Two clients can exchange encrypted messages
- Messages survive app restart
- Tampering is detectable

---

## Milestone 3: Single Stream UI + Basic Ranking & Filters

**Commit goal:** The core UX — one stream, quick filters that act like channels, and an initial interest-ranking of unread items.

**Deliverables:**
- Single chronological/ranked stream view (Vue)
- Filter system (saved “themes of interest” / virtual channels)
- Basic local ranking algorithm (recency + simple interest signals)
- Read/unread status
- Multi-layer threads (at least one level of nesting)
- Bookmarks
- Catch-up view (unread ranked by predicted interest)
- Tests for ranking function and filter application

**Definition of done:**
- User can send messages, apply filters, see ranked unread, and mark items read
- Ranking is deterministic and testable
- UI feels like a simple WhatsApp-style stream with power-user filters

---

## Milestone 4: Human vs AI Content Tagging & Split Identity

**Commit goal:** Single identity that can act as both human and AI, with clear tagging of all content.

**Deliverables:**
- Content metadata that tags origin (human | AI)
- UI distinction between human and AI-generated messages/threads
- MCP/CLI surface that lets an external AI post as the user’s AI half
- Local agent identity handling (same key, different content type)
- Tests for tagging integrity and MCP post path

**Definition of done:**
- An external AI (via MCP) can post messages that are visibly tagged as AI
- Human posts are tagged as human
- Ranking and filters can treat the two differently if desired

---

## Milestone 5: Content-Addressed Voluntary File & Folder Sharing

**Commit goal:** Torrent-style large folder sharing — only voluntary downloaders receive the data.

**Deliverables:**
- Content-addressed blob storage (Iroh or equivalent)
- Folder manifest format (path → hash collection)
- Chat messages that contain only the manifest + metadata/preview
- Explicit download UI (select files or whole folder)
- Seeding of already-downloaded content
- Resume and integrity verification
- Tests for manifest creation, hash verification, and selective download logic

**Definition of done:**
- User A shares a folder; User B sees the offer and can download only what they want
- No automatic mirroring to all members
- Downloaded content is verified and can be re-seeded

---

## Milestone 6: Hybrid Transport & Optional Hub

**Commit goal:** Reliable offline delivery and catch-up via optional relays, plus direct P2P when possible.

**Deliverables:**
- Relay client for store-and-forward of signed events
- Direct peer connection path (Iroh preferred)
- Official hub skeleton (multi-tenant, can run locally for development)
- Invite-only enforcement at the relay level
- Catch-up on reconnect
- Tests for offline send → reconnect delivery

**Definition of done:**
- Messages sent while peer is offline are delivered when they come back online (via hub or another peer)
- Direct P2P works when both are online
- Self-hosted hub is possible

---

## Milestone 7: Personalized Ranking Improvements & Hub Assistance

**Commit goal:** Learning ranking that improves with usage, with optional hub-side assistance.

**Deliverables:**
- Local ranking that learns from user actions (reads, bookmarks, replies, filters)
- Optional hub-side embedding or ranking assist (opt-in, still E2EE-respecting or on metadata only)
- Themes of interest that can be trained
- Evaluation harness for ranking quality
- Tests for ranking updates based on simulated user behavior

**Definition of done:**
- Ranking visibly improves after simulated usage
- Hub assist is optional and clearly documented
- Local ranking remains functional without the hub

---

## Milestone 8: Full MCP/CLI Agent Parity

**Commit goal:** Any AI can do everything a human can do through the MCP/CLI interface.

**Deliverables:**
- Complete MCP server covering: read stream, post, reply, mark read, create filters, bookmark, request downloads, manage themes, etc.
- CLI equivalent
- Documentation and example agent scripts
- Permission model that respects E2EE and user control
- Tests for every major MCP action

**Definition of done:**
- An external AI can fully participate in a club (read, post as AI-tagged, filter, download files, etc.)
- Actions are auditable and tagged

---

## Milestone 9: Mobile App Completion & Polish

**Commit goal:** Capacitor mobile app that delivers the core experience.

**Deliverables:**
- Capacitor project fully wired to shared Vue code
- Mobile-specific UI adjustments
- Background catch-up via relays
- File download handling on mobile
- Push notification skeleton (optional)
- Basic mobile tests or manual test checklist

**Definition of done:**
- Mobile app can join a club, read ranked stream, post, and download a shared folder
- Offline behavior is acceptable

---

## Milestone 10: Security Hardening, E2EE Audit & Documentation

**Commit goal:** Security review of the E2EE implementation and complete developer documentation.

**Deliverables:**
- Threat model document
- E2EE implementation review (or checklist)
- Key management documentation
- Self-hosting guide for the hub
- User-facing documentation for invites, AI tagging, and file sharing
- Final integration test suite

**Definition of done:**
- Known E2EE properties are documented and tested
- A new developer can self-host and run a club from the docs

---

## Milestone 11: Official Hub Business Features (Optional but Planned)

**Commit goal:** Multi-tenant hub with free tier limits and paid upgrade path scaffolding.

**Deliverables:**
- Tenant isolation
- Storage and member limits matching the free tier design
- Basic admin dashboard
- Backup/restore hooks
- Usage metrics for future pricing

**Definition of done:**
- Multiple clubs can run on one hub instance with isolation
- Free tier limits are enforced

---

## Cross-Cutting Practices (Apply to Every Milestone)

- Agent mode selection, validation, and publication live in [WORKFLOW.md](../../WORKFLOW.md). PAVER is the default for milestone work.
- Write tests first for core logic (ranking, crypto, sync, manifests, MCP actions), as WORKFLOW.md describes.
- Each verified PAVER milestone ends with a clean commit and a push to `origin/main`. Work stays on `main`; do not open a feature branch unless the user asks.
- Keep this plan in `docs/planned/` until a milestone starts, then follow the folder moves in WORKFLOW.md.
- Adversarial review of the plan before implementation (see WORKFLOW.md).
- Update this plan if scope changes.
- Keep the single-stream UX simple even as power features are added.

---

## Suggested Order & Dependencies

0 → 1 → 2 → 3 → 4 (parallel with 5 after 2) → 6 → 7 → 8 → 9 → 10 → 11

Milestones 3, 4, and 5 can partially overlap once the event model exists. Milestone 8 depends on 3–5. Mobile (9) can start earlier but finishes late.

This plan is intentionally comprehensive. Each milestone is sized to be a meaningful, reviewable commit (or short series of commits) that leaves the project in a better, working state.