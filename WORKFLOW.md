# Shakespeare workflow

Adopted 2026-10-16. This is the shared instruction source for
[AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md). Current user instructions
take precedence. These rules govern new work. They do not claim that the app
described in the plan is already built.

## Document responsibilities

- This file owns development procedure, the PAVER / PAIR / QUICK modes,
  engineering standards, validation, standing PAVER commit and push authority,
  and the invariants every milestone must keep.
- [docs/planned/WORK_PLAN.md](docs/planned/WORK_PLAN.md) is the milestone
  index: order, status, and links. Each milestone has its own plan file beside
  that index. Update the index when the work diverges from the plan.
- `docs/references/` holds research and architecture notes:
  `architecture-deep-dive.md`, `business-model-analysis.md`,
  `decentralized-pivot-analysis.md`, and
  `ultimate-ai-native-chat-productivity-app-plan.md`. They inform a plan.
  They do not authorize building the backlog. When a reference disagrees
  with `WORK_PLAN.md`, follow `WORK_PLAN.md` and ask before switching stack
  or scope.
- `README.md`, once Milestone 0 adds it, is the human runbook for how to
  install and run the app. Until that file exists, do not invent a runbook
  to hold a status note.
- AGENTS.md and CLAUDE.md are entrypoints. When a decision changes, update
  the owning document and both entrypoints in the same change.
- Reading these files does not authorize building Milestone 0 or any later
  milestone.

Keep the root small: README (when it exists), AGENTS, CLAUDE, this file, and
a license if one is added. Product direction already lives under `docs/`.
Do not copy the milestone list into this file.

## Plan folders

Milestone work is tracked by moving its plan file. `docs/planned/WORK_PLAN.md`
stays the index and is updated in the same change as a move.

| Folder | When the plan file belongs there |
| --- | --- |
| `docs/planned/` | The milestone has not started |
| `docs/in-progress/` | Work on that milestone has started and is not verified yet |
| `docs/completed/` | The milestone is verified, committed, and pushed |

- The first commit of a milestone moves its plan from `docs/planned/` to
  `docs/in-progress/` and sets the index status.
- The commit that closes the verified milestone moves that plan from
  `docs/in-progress/` to `docs/completed/` and sets the index status.
- A milestone that starts and finishes in one commit moves its plan straight
  from `docs/planned/` to `docs/completed/` in that commit.
- Do not leave a finished plan in `docs/in-progress/`.
- Do not start a second milestone while one plan is in `docs/in-progress/`
  unless the user asks. Work happens on `main`, so overlapping milestones
  share one branch.
- Leave research notes in `docs/references/`. They do not move through these
  folders.

## Choosing a workflow: PAVER, PAIR, QUICK

Honor the user's selected mode. An explicit mode persists through the task
and its follow-up until the user switches it. With no mode selected, use
PAVER for milestone work and for anything that touches crypto, identity, the
event model, sync, ranking, file transfer, or MCP behavior. Use a
proportionate edit for something trivial. Asking for PAVER turns verification
and milestone publication on for that task. Do not silently escalate PAIR or
QUICK.

| Mode | Intended work | Validation and publication |
| --- | --- | --- |
| PAVER | Autonomous features, refactors, and migrations | Required checks, then an automatic commit and push to `origin/main` |
| PAVER continuous | An explicit multi-milestone objective | PAVER for every milestone; one persistent Goal; continue inside scope and limits |
| PAIR | A small diff the user inspects | User inspection. No automated execution or publication unless asked |
| QUICK | A tiny edit such as wording, spacing, or a label | Read, edit, summarize. The user checks the result |

Crypto, keys, encryption, invite membership, sync, ranking, voluntary file
transfer, and MCP actions stay on PAVER even when the diff looks small. If
PAIR or QUICK was selected and the edit reaches one of those, stop and agree
on a PAVER scope.

### PAVER continuous

Use it only when the user asks. Record the milestone range, the UTC start,
any deadline, the acceptance checks, and any user changes that must be
preserved. Create a persistent Goal when the runtime supports one. Prose in
this file is not a continuation engine. Do not invent a token budget. If
Goals are unavailable, say so.

Run Plan, Adversarial review, Execute, Verify, and Report for each milestone.
After the required checks pass, record the evidence, commit and push under the
standing policy, then take the next eligible milestone in
`docs/planned/WORK_PLAN.md`. A milestone report is a checkpoint. Preserve the
same objective and the original clock across turns, compaction, and
checkpoints.

Never skip a dependency, weaken an acceptance check, invent evidence, or
shrink the objective quietly. Ordinary difficulty is not a blocker. Continuous
mode adds no extra delegation or spending. It does not authorize a release,
a package publish, or a hosted hub.

Stop on completion, an explicit interruption, the stated deadline, or a real
blocker that leaves no useful authorized work. Check the clock before a long
operation and leave a runnable checkpoint. A deadline does not make unfinished
work done.

### PAIR: Pick, Apply, Inspect together, Refine

1. **Pick.** Name one small visible change and what the user should observe.
   The user's request can supply this.
2. **Apply.** Read the relevant code and make a focused diff. Leave unrelated
   work alone. Split a medium feature into small cycles.
3. **Inspect together.** Summarize the change and the manual checks, then
   wait. Do not claim the user verified anything until they say so.
4. **Refine.** Adjust from feedback. Commit or push only at a checkpoint the
   user approved. Liking the look does not authorize publication.

PAIR is edit-only: no tests, builds, typechecks, linters, installs, launches,
or automated browser use. Read-only source and Git inspection are allowed.
Do not run checks as a hidden convenience.

Report automated validation as **NOT RUN - edit-only mode**. Manual results
are user-reported and are separate from the automated gates. No plan document
is required for each cycle.

### QUICK

QUICK is the old PAIR quick. It is a mode name. For a precise tiny request,
read the relevant code, apply the smallest coherent edit, and say what the
user should see. Skip a planning document and wait for feedback. Every PAIR
edit-only, manual-check, and checkpoint rule applies. If the edit turns out
medium or consequential, stop and agree on a PAIR slice or a PAVER scope.

While PAIR or QUICK is selected, those rules override the automatic testing
and commit rules below. A check or a commit the user explicitly requests is
authorized only for that scope. It does not switch the mode.

## PAVER: the development loop

Use **Plan, Adversarially review, Execute, Verify, Report** for behavior,
architecture, multi-file work, research, migration, or anything else that is
not trivial. A one-line documentation fix can be a direct edit, a
proportionate check, and a short closeout. An explicit PAVER request uses the
full loop. Scale ceremony to risk.

1. **Plan.** Read the current instructions, Git state, the relevant section
   of `docs/planned/WORK_PLAN.md`, related references, and the code and tests
   that will change. State the user-facing outcome, the files to create or
   modify, data-model or protocol changes, how E2EE and tagging stay intact,
   the test strategy, exclusions, risks, and rollback. Name assumptions
   before expensive work. The work plan is a proposal, not permission to
   build every milestone.
2. **Adversarially review.** Challenge the plan before coding. Use the
   checklist below. Address must-fix items before proceeding. Note
   nice-to-have items for later. A second pass by the same agent is a
   self-review. Call it that. Use a separate agent only when the user asks,
   and never call a self-review independent.
3. **Execute.** Move the milestone plan into `docs/in-progress/` when work
   starts. Implement the smallest coherent slice of that milestone. Prefer a
   failing test first for crypto, ranking, manifests, sync rules, and MCP
   actions. Write the minimum code that makes that test pass. Preserve
   existing behavior unless the plan explicitly changes it. Add or update
   types, schemas, and docs with the change.
4. **Verify.** Run the checks for the boundary you changed. Read exit codes
   and artifacts. Fix failures inside the milestone and rerun the affected
   checks. Re-read the diff for scope and new risk. Do not weaken a check,
   delete a failing case, or redefine success so the suite goes green.
5. **Report.** Record what shipped, how it was tested, deviations from the
   plan and why, remaining limits, and the next recommended step. Mark each
   relevant check `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`, and explain the
   last three. Close a finished milestone with the Git procedure below.
   Report the commit hash and the real push result.

### Adversarial review checklist

- Does this plan satisfy the milestone definition of done?
- Where can E2EE be accidentally weakened?
- Can AI-generated content be mis-tagged or spoofed?
- Are there race conditions in sync or file download?
- What happens offline? What happens with a malicious peer?
- Is the ranking deterministic and testable?
- Does the voluntary download model still hold (no silent mirroring)?
- Are there simpler ways to achieve the same result?
- What tests are missing that would catch the most likely bugs?

A milestone is one reviewable outcome with its required checks done. A
documentation milestone can be complete with no runtime change. A negative
experiment can be a completed finding. Unresolved required validation is not
a completed implementation.

When an error is found, trace what depended on it. Correct the source, rerun
the affected work, and update the dependent record. Preserve the original
failed evidence. Do not report a correction only in chat.

If you are blocked, stop and describe the blocker. Do not guess at a solution
that weakens E2EE, tagging, invite-only membership, or the voluntary download
model.

## Reasoning effort by phase

At the start of a user-requested run, record a UTC timestamp and carry it
across compaction. At closeout, report elapsed wall time. If the clock started
late, label the interval you actually measured.

When the runtime exposes usage, report it by model and reasoning setting,
including authorized child-agent usage when that number is supplied. Otherwise
say the counts are unavailable. Never infer tokens from text length, and never
inspect unrelated session logs or credentials to fill the gap. Timing must not
require a pinned model, a new service, or a background daemon.

Use the coding model the user's client already selected. Do not hardcode a
model name or version in this repository. Honor an explicit user choice. This
applies to Grok, Claude, Codex, and any other agent.

| PAVER phase | Default effort | What deserves the reasoning |
| --- | --- | --- |
| Plan | High | Trace behavior, scope, invariants, acceptance checks, and rollback before coding |
| Adversarial review | High; extra-high for keys, encryption, sync, or data loss | Concrete failure cases and trust boundaries |
| Execute | Medium | A settled design. Low only for a mechanical edit. High when the design is still open or the bug is unexplained |
| Verify | Medium for a known check; high for a surprise | Whether the evidence actually proves the acceptance check |
| Report | Low | Changed behavior, check labels, commit, push, and the next action |

Map these levels onto the controls the active client actually has. When a
session cannot change effort per phase, use the available setting and apply
the review depth described here. Do not claim an invisible setting changed.
Do not install a model switcher or interrupt the user to change settings on
every phase. Record a real escalation and any proof gap. Leave private
reasoning out of the report.

After one failed hypothesis, inspect the evidence before retrying. After
repeated failure, reframe the problem. Maximum reasoning is for an unresolved
high-consequence problem, not for every edit or status line.

## Invariants

These hold for every mode.

- Messages and file contents are end-to-end encrypted.
- The hub, when used, cannot read message contents. Optional hub ranking
  assist uses metadata only, stays opt-in, and the local ranker still works
  with the hub absent.
- One identity can act as human and AI. AI-generated content is always tagged.
  Human content is tagged as human. Agents act through the user's identity.
- Invite-only means a user cannot join a club without a valid invite.
- Large files and folders are content-addressed. A chat message carries the
  manifest, not the bytes. Members receive file bytes only when they request
  them. No silent mirroring.
- Key material stays on the device unless the user explicitly exports it.
- Never log plaintext message content or private keys.

## Standing product decisions

Confirmed in `docs/planned/WORK_PLAN.md` on 2026-10-16. Build only the
milestone the user has asked for.

- Desktop shell: Tauri 2. The architecture note also describes Electron as a
  viable alternative. Switching shells requires the user to say so.
- UI: Vue 3 Composition API with `<script setup>`, TypeScript strict mode,
  TailwindCSS. Avoid large custom CSS unless the component needs it.
- Mobile: Capacitor, sharing the Vue source. Mobile checks start once that
  shell exists.
- Local data: SQLite on the client, with a migration system. Do not add a
  second local database. PostgreSQL belongs only to the optional hub, and
  only in the hub milestone that introduces it.
- Shared core in TypeScript. P2P and content-addressed storage follow the
  work plan (Iroh or an equivalent chosen in that milestone).
- Package manager and test command are chosen in Milestone 0. Later
  milestones use that command. Do not add a second test runner.
- There is no hosted deploy target, Mac mini copy, or bot routine in this
  repository. Do not invent one.

### Next milestone

Milestone 9, mobile completion, is the next eligible milestone.
Its plan is [docs/planned/milestone-09-mobile.md](docs/planned/milestone-09-mobile.md).
It has not started. The order is in `docs/planned/WORK_PLAN.md`.
Do not start Milestone 9, or any later milestone, unless the user asks.

## Engineering rules

- Prefer explicit, readable code over clever abstractions.
- Validate at the boundary. Unknown data stays unknown until it is narrowed.
- Version any persisted shape change. Test the migration on a copy of the old
  shape. Preserve the original file on failure.
- Document non-obvious protocol or crypto decisions in a short comment or a
  design note next to the code.
- Keep changes focused on the current milestone. Record discovered debt in
  `docs/planned/WORK_PLAN.md`. Do not widen a small task into a cleanup of
  the app.
- A new runtime, package, or datastore beyond the standing decisions is a
  scope change and needs the user's yes.
- Prefer deterministic tests. Avoid flaky timing-dependent tests.

## Test-driven development

Apply this inside PAVER. PAIR and QUICK stay edit-only unless the user asks
for a check.

1. In Plan, state the observable behavior, the independent expected outcome,
   the malformed and hostile cases, and the proof layer: unit, integration,
   or a real screen.
2. In Execute, write the smallest behavioral test first for crypto, ranking,
   manifests, sync rules, and MCP actions. Run it and see the intended
   assertion fail. A missing import or a broken fixture is a harness failure,
   not a behavioral red. Record the actual failure.
3. Implement the minimum change that goes green, then refactor while the
   suite stays green. Add a regression test before fixing a defect you found
   along the way.
4. For behavior that already exists, characterize it first. A passing first
   run is legitimate. Do not preserve a known bug as the contract.
5. Verify at the lowest useful layer, then run the repository test command.
   Milestone 0 is the milestone that creates that command. A later behavior
   milestone is not complete until the command exists and has been run.
6. Report the command, the red or characterization result, the green checks,
   and the remaining gaps.

Required coverage once the relevant code exists:

- Crypto and E2EE: round-trip encryption and decryption, tamper detection,
  and correct human versus AI tagging.
- Ranking: scores change with simulated user behavior, and the function is
  deterministic.
- File sharing: only requested content is transferred, and hashes match.
- MCP: each major action has a test once Milestone 8 starts. Earlier
  milestones test the actions they introduce.

Do not add ceremonial tests for prose. Do not point a test at a person's
live database.

## Validation

These gates apply to PAVER. PAIR and QUICK stay edit-only unless the user
asks for a check. Run commands from the repository root.

| Change | Required checks |
| --- | --- |
| Documentation only | Read the linked paths, confirm the instructions agree, and run `git diff --check` |
| Behavior before the test harness exists | Milestone 0 creates the harness and is complete on its own definition of done. Later behavior is not done without that command |
| Unit or integration behavior | A failing behavioral test first, then the repository test command |
| Visible layout or interaction | The test command when behavior changed, plus the desktop check below. Add the mobile check once the Capacitor shell exists |
| Desktop build | The desktop app builds. `pnpm dev` or the command Milestone 0 documents must launch it when that milestone is in scope |

### Desktop and mobile checks

Choose the smallest check that exercises the change.

- Desktop: exercise the changed flow in the running app, including the happy
  path and one failure path when the change has a UI. Read the console.
- Mobile, once the shell exists: join, read, post, and any download flow the
  change touches.
- Crypto-facing UI: confirm logs and screens do not show plaintext message
  content or key material.

If no browser or window tool is available, use the closest substitute and say
which screen you could not exercise. A single screenshot of a painted page is
not the check. Click, type, and navigate the flow that changed.

Mark each check `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`.

## Automatic milestone commits and pushes

This policy applies to PAVER milestones in this repository. PAIR and QUICK
need an explicit yes, and they report an honest validation status.

**Standing authorization, adopted with this file on 2026-10-16:** after every
completed, verified PAVER milestone, create a scoped commit and push it to
`origin/main`. Work on `main` only. Do not create a feature branch, a release
branch, or a pull request unless the user asks. Do not ask again for a
routine commit or push. This authorization is for this repository only.
There is no deploy step after the push.

1. Inspect the branch, status, remote, and the staged and unstaged diffs.
   Expected origin is `https://github.com/adamsonjesse/shakespeare.git`
   (the GitHub SSH form of that same repo is acceptable). If the checkout or
   the remote is not that repo, stop and resolve it. Do not retarget the
   remote.
2. Finish the required checks. Move the milestone plan to `docs/completed/`
   and update [docs/planned/WORK_PLAN.md](docs/planned/WORK_PLAN.md). If this
   commit is the one that started the milestone, move the plan straight from
   `docs/planned/` to `docs/completed/`.
3. Stage owned paths by name. Read the staged diff for secrets, local
   databases, logs, generated files, and unrelated work. Do not force-add
   ignored files. Do not stage key material.
4. Create a nonempty commit. Do not change git config. If the commit fails
   because no identity is configured, stop and report that. Do not amend,
   force-push, reset, stash the user's work, or rewrite published history
   unless the user explicitly asks. If `main` moved, integrate without
   rewriting history only when the other work is understood, and recheck the
   result. If that is unsafe, keep the local commit and report the blocker.
   A rejected push is not permission to force it.
5. Push with `git push -u origin main`. Confirm the remote hash matches the
   local committed HEAD. If the network or credentials block the push, report
   the local hash and mark the push `BLOCKED`.
6. Report the hash, the push result, the plan's new path, and the remaining
   limits. Never make an empty commit for a read-only answer. If a required
   check failed, do not call the milestone complete in order to push.

Commit messages name the milestone, for example: "Milestone 3: Add
single-stream view with basic local ranking."

This is closeout behavior for the agent that finished the milestone. It is
not a background daemon and not a Git hook. It does not authorize a release,
a tag, or a package publish.

Writing or editing this workflow file is not, by itself, a reason to commit
other uncommitted product work that was already on the machine.

## What a good session looks like

A good session on this project:

- Names the milestone or the selected mode before editing.
- Includes an adversarial review on PAVER work, and states when no issue was
  found.
- Leaves tests passing and the desktop app building when those checks apply.
- Ends with an honest summary: what changed, how it was verified, and the
  logical next step.
- Leaves E2EE, tagging, invite-only membership, and voluntary file sharing
  intact.

## What we adopted from DealDashboard

Reviewed `C:\Projects\DealDashboard\AGENTS.md`, `CLAUDE.md`, and `WORKFLOW.md`
on 2026-10-16 as the source of the procedure, not as instructions that govern
this repository. DealDashboard's lanes, bots, zero-dependency Node server,
loopback and Funnel host, token rules, and Mac mini deploy stay there.

Adopted: one workflow file with two thin entrypoints; document ownership;
PAVER, PAVER continuous, PAIR, and QUICK; the five-step loop; phase reasoning
without a pinned model; test-first behavior inside PAVER; check labels
`PASS`, `FAIL`, `BLOCKED`, and `NOT RUN`; evidence before calling work done;
no silent scope expansion; and automatic verified commits and pushes to
`origin/main` for PAVER only.

Kept from the original Shakespeare workflow: the E2EE adversarial checklist,
tagging, invite-only membership, voluntary downloads, and milestone ownership
in `docs/planned/WORK_PLAN.md`.
