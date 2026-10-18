# Shakespeare

Desktop and mobile shell for an invite-only, end-to-end encrypted club app.
The milestone index is [docs/planned/WORK_PLAN.md](docs/planned/WORK_PLAN.md).
Agents follow [WORKFLOW.md](WORKFLOW.md).

Security notes for this prototype:

- [Threat model](docs/references/threat-model.md)
- [Key management](docs/references/key-management.md)
- [Self-host the hub](docs/references/self-host.md)
- [Invites, tags, and downloads](docs/references/user-notes.md)

The desktop app creates a local profile, stores that profile's private key in
the OS keychain, and keeps a separate SQLite file per profile. A profile can
create a club, copy an invite link, and show a QR code for the same link.
Another profile on the same device can accept the invite and show up as a
member. Two members of a club can send a short text message. The body is
encrypted in that profile's SQLite file and still decrypts after a restart.
The club opens as one stream: local themes filter it, unread items can be
sorted into a catch-up list, and a reply sits one level under its parent.
Read marks and bookmarks stay on that profile. A composed message is tagged
Human. A local post tool tags the same identity as AI, and the stream can
hide either tag. A member can offer a folder. Another member sees the names
and sizes only, then downloads the files they choose. A bad hash is rejected.
Two profiles on one computer exchange club events directly. A local hub can
hold ciphertext while the other person is offline. Run it with
`pnpm hub -- <directory> <port>`, then point the desktop hub fields at
`127.0.0.1` and that port. The hub stores envelopes and blobs a member
explicitly seeds. It does not read message bodies. Bookmarking, replying, or
reading a message for at least two seconds raises the weight of themes that
match it, and catch-up uses those weights. Publishing weights to the hub is
off unless the member opts in, and that publish contains theme ids and
numbers only. A loopback tool server and a matching CLI can post, read,
reply, mark read, bookmark, save themes, list members, and request one
download. Posts and replies are tagged AI. Neither one exports a private
key. `pnpm example:tools` runs that path on a temporary profile with no
provider key. `pnpm tools -- <database> <tool> <json>` calls the same tools.
Set `SHAKESPEARE_PRIVATE_KEY` to the profile's hex private key. The command
does not print it.

## Prerequisites

- Node.js 24 or newer
- pnpm 10.18.2
- Rust stable, with Cargo
- WebView2 on Windows

`pnpm cap:sync` copies the web build into the Android project. It does not
need the Android SDK. A signed device build is out of scope. On macOS, add
the iOS project with `pnpm --filter @shakespeare/mobile exec cap add ios`.

## Commands

Run these from the repository root after `pnpm install`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Launch the desktop window |
| `pnpm test` | Run the Vitest suite |
| `pnpm typecheck` | Typecheck core, desktop, and mobile |
| `pnpm lint` | Lint TypeScript and Vue |
| `pnpm build:web` | Build the shared Vue app |
| `pnpm cap:sync` | Rebuild the web app and update the Capacitor Android project |
| `pnpm build:desktop` | Build the desktop bundle |
| `pnpm hub -- <directory> <port>` | Run the local store-and-forward hub |
| `pnpm tools -- <database> <tool> <json>` | Call one local club tool |
| `pnpm example:tools` | Post, read, and download against a temporary profile |

## Layout

- `apps/desktop` — Tauri 2, Vue 3, TypeScript, and Tailwind. This is the Vue source.
- `apps/mobile` — Capacitor Android shell for the same Vue app. Profile data stays in the app sandbox. Push is not registered.
- `packages/core` — Shared types, identity, invites, encrypted messages, the storage interface, and the migration runner.

`packages/core` does not import Tauri, Capacitor, or a Node SQLite driver.
Each desktop profile uses one SQLite file under the OS app-data directory at
`profiles/{public key}/club.sqlite`. The private key is stored in the OS
keychain under the service `app.shakespeare.desktop`. Those files are not
part of the repository.
