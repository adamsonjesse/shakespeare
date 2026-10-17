# Agent instructions

Read [WORKFLOW.md](WORKFLOW.md) before planning, editing, or closing a
milestone. It is the canonical project workflow for all coding agents.

Honor its selected workflow: PAVER for autonomous verified milestones; PAIR for
interactive small diffs; QUICK for tiny edit-only changes. PAIR and QUICK run
no tests, builds, or app automation, and they do not commit or push unless the
user asks. PAVER commits and pushes each verified milestone to `origin/main`.
An explicit PAVER continuous request keeps one Goal, follows the dependency
and stop rules, and continues after each verified milestone inside that scope.

Milestones and definitions of done live in
[docs/planned/WORK_PLAN.md](docs/planned/WORK_PLAN.md). Each milestone plan
starts in `docs/planned/`, moves to `docs/in-progress/` when work starts, and
moves to `docs/completed/` when that milestone is verified and pushed.
Research notes live in `docs/references/`. They inform a plan. They do not
authorize building the backlog. Current user instructions take precedence.

Work on `main`. Do not create a branch unless the user asks. After each
verified PAVER milestone, commit and push to `origin/main`.

For PAVER behavior changes, follow the test-first procedure in WORKFLOW.md.
A passing test suite does not prove a layout change. Visible work needs the
desktop check named there, and the mobile check once the mobile shell exists.

Apply the phase-based reasoning guidance: high for planning and review, medium
for a settled implementation, and higher when the risk is encryption, identity,
sync, or a surprising result. Use the active client's current model. Do not
pin a model version in this repository.

Never log plaintext message content or private keys. Do not weaken end-to-end
encryption, human/AI tagging, invite-only membership, or the voluntary
download model to get past a blocker.
