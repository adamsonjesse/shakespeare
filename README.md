# Shakespeare

Desktop and mobile shell for an invite-only, end-to-end encrypted club app.
The milestone index is [docs/planned/WORK_PLAN.md](docs/planned/WORK_PLAN.md).
Agents follow [WORKFLOW.md](WORKFLOW.md).

The app currently launches a desktop shell, syncs that same Vue app into
Capacitor, and applies schema version 1 to a local SQLite file. Clubs,
messages, and files are later milestones.

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
- `packages/core` — Shared types, the storage interface, and the migration runner.

`packages/core` does not import Tauri, Capacitor, or a Node SQLite driver.
The desktop shell keeps one SQLite connection in the OS app-data directory.
That file is not part of the repository.
