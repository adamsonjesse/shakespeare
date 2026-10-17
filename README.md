# Shakespeare

Desktop and mobile shell for an invite-only, end-to-end encrypted club app.
The milestone index is [docs/planned/WORK_PLAN.md](docs/planned/WORK_PLAN.md).
Agents follow [WORKFLOW.md](WORKFLOW.md).

The desktop app creates a local profile, stores that profile's private key in
the OS keychain, and keeps a separate SQLite file per profile. A profile can
create a club, copy an invite link, and show a QR code for the same link.
Another profile on the same device can accept the invite and show up as a
member. Messages and files are later milestones.

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

## Layout

- `apps/desktop` — Tauri 2, Vue 3, TypeScript, and Tailwind. This is the Vue source.
- `apps/mobile` — Capacitor project. Its web assets come from `apps/desktop`.
- `packages/core` — Shared types, identity and invite rules, the storage interface, and the migration runner.

`packages/core` does not import Tauri, Capacitor, or a Node SQLite driver.
Each desktop profile uses one SQLite file under the OS app-data directory at
`profiles/{public key}/club.sqlite`. The private key is stored in the OS
keychain under the service `app.shakespeare.desktop`. Those files are not
part of the repository.
