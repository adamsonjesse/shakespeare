# Architecture Deep Dive: Desktop, Mobile, Optional Web + Torrent-Style File Sharing

**Date:** October 16, 2026
**Context:** Concrete architecture for the open-source, hybrid-decentralized, AI-native productivity club app. Desktop + mobile + optional web that can connect to the official hub. User preferences (not mandatory): Electron, Node, TypeScript, Vue, TailwindCSS, PostgreSQL or SQLite with local sync. Critical requirement: share large folders torrent-style — data is only transferred to peers who voluntarily download it, never mirrored to everyone.

## 1. High-Level Architecture Principles

- **Local-first.** The device is the primary source of truth for the user’s view. Messages, rankings, filters, themes, and local metadata live in a local database. The app works offline and syncs when possible.
- **Hybrid transport.** Prefer direct peer connections. Fall back to optional always-on relays (the official hub or self-hosted) for store-and-forward, discovery bootstrap, and catch-up when peers are offline.
- **Content-addressed voluntary downloads for files and large folders.** Messages and small metadata can be replicated more aggressively (signed events). Large files and folders are never pushed to all members. They are content-addressed; only peers who explicitly request them download the pieces. Any peer who has already downloaded a piece can seed it to others (classic torrent behavior).
- **Shared core in TypeScript.** Business logic, ranking, MCP surface, protocol handling, and UI components are written once in TypeScript and reused across desktop, mobile, and web.
- **Thin native shells.** Desktop and mobile are primarily native shells around the shared TypeScript core + web UI.

This keeps the original vision (simple stream, auto-filters, personalized ranking, multi-layer threads, full MCP/CLI agent parity) while adding sovereignty and efficient large-file sharing.

## 2. Recommended Tech Stack

| Layer | Recommended | Why | User Preference Fit |
|-------|-------------|-----|---------------------|
| **Frontend** | Vue 3 + TypeScript + TailwindCSS | Excellent DX, reactive, works everywhere, strong component model | Direct match |
| **Desktop** | **Tauri 2** (preferred) or Electron | Tauri: tiny binaries, low memory, native webview, Rust backend for performance-sensitive work. Electron: pure Node/TS if team wants zero Rust. | Electron is fine; Tauri is lighter and better for P2P |
| **Mobile** | Capacitor (Vue) or Tauri mobile | Capacitor gives one codebase for iOS/Android/web with native plugins. Tauri has mobile support. | Vue + TS works with both |
| **Local database** | **SQLite** (with CRDT/sync layer) | Perfect for local-first. Small, fast, runs everywhere. Add a CRDT layer (e.g. sql_crdt, SQLite-Sync, or custom) for multi-device and peer sync. | Strong match for “SQLite is enough with local data sync” |
| **Backend / Hub** | Node/TypeScript or Rust (if Tauri) + PostgreSQL (optional) | Hub needs multi-tenant reliability, search, backups. Postgres is fine for the official service; clients stay on SQLite. | Postgres for hub is reasonable |
| **P2P / File layer** | **Iroh** (preferred) or libp2p + content addressing | Excellent NAT traversal, hole punching with relay fallback, content-addressed blobs (BLAKE3), voluntary downloads, folder collections. Quiet/OrbitDB style also possible. | Works with Node or Rust |
| **Real-time messaging** | Nostr-style signed events or Matrix-compatible rooms + gossip/pubsub | Signed events for durability and agent identity. Optional relays for offline delivery. | Flexible |
| **AI / MCP** | TypeScript MCP server + CLI | Any AI can connect and act as a full user. Runs locally or against the hub. | Direct fit |

**Why not pure Electron + Node for everything?** Electron works and matches the preference list. Tauri is recommended as the default for new work because it produces dramatically smaller apps and lower memory use, which matters for a chat app that may run in the background and do P2P. The frontend remains Vue + TS + Tailwind either way. If the team strongly prefers pure JavaScript, Electron is a perfectly acceptable choice.

## 3. Data Model: Messages vs Files

### Messages, threads, rankings, themes
- Stored locally in SQLite.
- Represented as signed events (Nostr-style or custom).
- Synced via gossip, direct peer connections, or relays when online.
- CRDT or last-write-wins with vector clocks / hybrid logical clocks for conflict-free multi-device and multi-peer merge.
- Ranking algorithm, filters, and read status are local (or lightly shared) so each user sees their own interest-ranked view.

### Large folders and files (torrent-style)
- Never automatically replicated to all members.
- Each file (or folder collection) is content-addressed (BLAKE3 or CID).
- A message or event in the chat contains only a **manifest**: name, size, hash(es), optional thumbnail/preview, and a short description.
- Any member who wants the data explicitly requests it. Their client then:
  1. Discovers peers who have the content (DHT, known relays, or direct announcement).
  2. Downloads only the pieces they need.
  3. Verifies the hash.
  4. Can optionally seed the content to others who request it later.
- Folders are represented as a collection of path → hash pairs (Iroh collections or UnixFS-style). Users can download the whole folder or select individual files.
- The official hub (or any always-on peer) can optionally pin/seed popular or recently requested content, but this is opt-in and not mandatory mirroring.

This is exactly the torrent model applied to a chat: the chat contains the magnet/link/manifest; the actual bytes only move to people who ask for them.

## 4. Desktop App

**Recommended:** Tauri 2 + Vue 3 + TypeScript + TailwindCSS + local SQLite + Iroh (or libp2p).

- Shared Vue UI runs in the system webview.
- Rust (or Node via sidecar if preferred) handles P2P networking, content-addressed storage, and low-level file I/O.
- Local SQLite holds the user’s message history, ranking state, bookmarks, themes, and download cache metadata.
- Background operation possible for seeding and catching up.
- Electron alternative: same Vue + TS frontend, Node for P2P (WebTorrent, Iroh JS bindings, or libp2p), SQLite via better-sqlite3.

Both approaches work. Tauri is lighter; Electron matches the stated preference more closely and has a larger pure-JS ecosystem.

## 5. Mobile App

**Recommended:** Capacitor + same Vue 3 + TypeScript + TailwindCSS codebase, or Tauri mobile.

- One shared frontend.
- Native plugins for file system, background downloads, notifications, and (where possible) P2P.
- Local SQLite on device.
- Background constraints on iOS/Android mean the app relies more heavily on relays for catch-up when the app is suspended. Direct P2P works well while the app is open or in limited background modes.
- Large folder downloads are user-initiated and can continue in the background where the OS allows.

The web UI is reused; native shells handle platform-specific concerns.

## 6. Optional Web App + Official Hub

The web app is a first-class client that talks to the official hub (or any self-hosted relay).

- Same Vue + TS + Tailwind frontend (or a lighter version).
- Authenticates with the user’s keypair or hub session.
- Can participate in real-time chat via WebSocket to the relay.
- For files: the web app can request content-addressed blobs. The hub can serve them (if it has them pinned) or coordinate P2P via WebRTC / WebTransport where possible.
- Ideal for quick access, onboarding, and users who do not want to install a native app.
- The hub itself is a multi-tenant service: Node/TS or Rust, PostgreSQL for tenant metadata and search indexes, object storage for pinned content, and the relay process for signed events.

The web app is optional. Desktop and mobile remain the primary rich clients with full local-first and P2P capabilities.

## 7. Sync and Offline Behavior

- **Local writes first.** Every action (send message, mark read, bookmark, set theme) is written to local SQLite immediately.
- **Sync engine.** When online, the client pushes local signed events and pulls missing ones. CRDT or deterministic merge resolves conflicts.
- **Catch-up.** On reconnect, the client asks relays or online peers for events since the last known point, then re-ranks the unread list locally.
- **Files.** Only downloaded when the user requests them. Partial downloads and resume are supported via content-addressed pieces.

## 8. MCP / AI Integration

- A local MCP server (TypeScript) exposes the full set of human actions against the local SQLite and P2P layer: read messages, post, reply, mark read, create filters, bookmark, request file downloads, etc.
- The same MCP surface can be pointed at the hub for users who prefer the hosted path.
- Any AI (Claude, GPT, Grok, etc.) using the user’s subscription can connect and act as a full participant.
- Agents that need to share large research folders do so the same way humans do: they post a content-addressed manifest; other agents or humans download only what they want.

## 9. Summary Recommendation

| Component | Choice | Notes |
|-----------|--------|-------|
| UI | Vue 3 + TypeScript + TailwindCSS | Shared across all platforms |
| Desktop | Tauri 2 (preferred) or Electron | Both viable; Tauri lighter |
| Mobile | Capacitor (Vue) or Tauri | Shared codebase |
| Local data | SQLite + CRDT/sync layer | Sufficient; Postgres only on hub |
| Messaging | Signed events + optional relays | Nostr-style or Matrix-compatible |
| Large files/folders | Content-addressed (Iroh or equivalent) + voluntary download only | Torrent-style; never auto-mirrored |
| Hub | Multi-tenant relay + storage + Postgres | Optional reliable seed |
| AI | TypeScript MCP server + CLI | Full agent parity |

This architecture respects the user’s preferred technologies while delivering the critical torrent-style large-folder sharing, local-first behavior, hybrid decentralization, and AI-native capabilities. The official hub remains an optional convenience layer rather than a mandatory central server. Self-hosting stays fully possible.
