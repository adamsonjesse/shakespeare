# Milestone 8: MCP and CLI parity

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 4](../completed/milestone-04-ai-tagging.md), [Milestone 5](milestone-05-voluntary-files.md), and [Milestone 7](milestone-07-learned-ranking.md)
**Blocks:** [Milestone 9](milestone-09-mobile.md) and [Milestone 10](milestone-10-security-docs.md)

## Outcome

A local MCP server and a matching CLI can do the club actions a person can do, except export keys or pretend to be the human. Every action is tagged and written to a local audit log. An example script runs against the local server with no provider API key.

## Scope

Extend the milestone 4 `post_message` tool. Add these tools, each with a CLI command:

- `read_stream` with theme and origin filters
- `reply`
- `mark_read`
- `bookmark`
- `save_theme` and `list_themes`
- `request_download` for selected manifest paths
- `list_members`

Permission rules:

- Every post and reply is signed `origin: "ai"`.
- No tool accepts an origin argument.
- No tool exports, prints, or returns private keys.
- `request_download` is the only path that starts a transfer. `read_stream` returns manifests without fetching blobs.
- The audit log records tool name, event ids, and time. It does not record message bodies.

Document the tool list and one example script that posts, reads, and requests a download against a temporary profile.

## Exclusions

- A hosted MCP endpoint. The server binds to loopback only.
- Provider API keys, prompt templates for a specific model, and token billing.
- Tools that change hub billing or delete a club.
- Silent downloads inside `read_stream`.

## Invariants

- MCP and CLI call the same core functions as the UI.
- A tool cannot set `origin` to `human`.
- Audit records and MCP stdout do not contain the plaintext fixture except where `read_stream` is explicitly returning decrypted text to the local caller. That return stays on loopback.
- The server does not listen on a non-loopback address.

## Data model

New client table: `audit_log` (time, tool, public key, event ids, result code). No body column.

## Test strategy

One test per tool. Fail first on the permission cases: origin override refused, key export absent from the tool list, `read_stream` does not create a `download_requests` row, `request_download` does. Use a temporary profile and a fixture club. Do not call a live model.

## Acceptance checks

- The example script posts an AI-tagged message, reads it back, and downloads one requested file.
- `mark_read`, bookmark, and theme changes match the same UI state.
- The audit log contains the tool names and not the message body.
- Binding is loopback. A test or startup check shows the listen address.
- Desktop check is not required for every tool. Run the script and confirm the new AI message appears in the stream.

## Rollback

Disable the server command. The club store remains readable in the UI. Audit rows can stay.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "Everything a human can do" will be read as key export and unmarked human posts.
- Returning decrypted text to a remote MCP client would publish club contents to whatever host the model runs on. The requirement is local tooling for the user's own subscription, not a public API.
- `read_stream` that helpfully downloads attachments breaks voluntary transfer.
- Example scripts that embed real provider keys will get committed.

## Revisions applied

- Key export is out of the tool list. Origin is forced to `ai`.
- The server binds to loopback. Decrypted text is returned only to that local caller.
- Downloads start only in `request_download`.
- The example script uses a temporary profile and no provider secrets.
