# Milestone 0: Foundation and tooling

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** none
**Blocks:** every later milestone

## Outcome

A developer can clone the repo, install dependencies, launch the desktop shell, and run the test command. The mobile project is present and syncs against the same Vue source. No club feature is implemented yet.

## Scope

- pnpm workspace at the repo root.
- `apps/desktop`: Tauri 2, Vue 3, TypeScript strict, TailwindCSS, Vite.
- `apps/mobile`: Capacitor project pointed at the same Vue source.
- `packages/core`: shared TypeScript for domain types and a storage interface. No UI and no Node-only database driver.
- Local SQLite behind that interface, with a versioned migration runner. The Tauri shell provides the first implementation.
- GitHub Actions for typecheck, lint, unit tests, and the desktop build.
- Root README with the commands this milestone chooses.
- `.gitignore` for dependencies, build output, local databases, and logs.
- One real unit test for the migration runner, plus a harness that later milestones extend.

## Exclusions

- Clubs, keys, messages, ranking, files, relays, and MCP.
- A second JavaScript package manager. Rust and Cargo exist only inside the Tauri app.
- A signed iOS or Android build. Device SDKs are not required in CI.
- Rewriting `WORKFLOW.md` or the milestone plans, except to record the chosen commands in the README.
- Electron. Switching shells needs the user to say so.

## Invariants

- `packages/core` imports nothing from Tauri, Capacitor, or a Node SQLite package.
- The desktop process binds no remote interface in this milestone.
- No secrets are committed. Local database files stay ignored.

## Data model

Migration version 1 creates the migration bookkeeping table only. Feature tables start in the milestone that owns them.

## Test strategy

Write the migration test first. Assert that version 1 applies on an empty temporary database and that an unknown version fails. Run the workspace test command and see the missing-runner failure before implementing it. The desktop build is a separate CI job, not a substitute for that test.

## Acceptance checks

- `pnpm dev` launches the desktop window on the development machine.
- `pnpm test` passes from the repo root.
- Typecheck and lint pass.
- `cap sync` (or the documented equivalent) updates the Capacitor project from the shared web build.
- CI is green on a pull-free push to `main`.
- README lists the commands above and points agents at `WORKFLOW.md`.

## Rollback

Revert the scaffold commit. There is no user data to preserve.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "pnpm or Cargo" left the package manager undecided. Two workspaces would split the shared TypeScript core.
- A Node SQLite driver inside `packages/core` would block the Capacitor shell from using the same logic.
- "Mobile project can be synced and built" fails on a laptop without Xcode or the Android SDK, and CI would go red for a reason outside the product.
- The workflow and this plan are already committed. Treating them as deliverables of this milestone invites a needless rewrite.
- An empty test that asserts `true` would make CI green without proving the harness runs.

### Revisions applied

- pnpm is the package manager. Cargo stays inside `apps/desktop`.
- Persistence is an interface in `packages/core`. Tauri implements it.
- Mobile acceptance is Capacitor sync against the shared web build. A device build is out of scope.
- This milestone adds the README and records commands. It does not replace the workflow.
- The first test must fail because the migration runner is absent, then pass because version 1 applies.
