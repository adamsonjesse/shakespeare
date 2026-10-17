# Milestone 9: Mobile completion

**Status:** planned
**Index:** [WORK_PLAN.md](WORK_PLAN.md)
**Depends on:** [Milestone 0](../completed/milestone-00-foundation.md), [Milestone 5](../completed/milestone-05-voluntary-files.md), [Milestone 6](../completed/milestone-06-hybrid-transport.md), and [Milestone 8](../completed/milestone-08-mcp-cli.md)
**Blocks:** [Milestone 10](milestone-10-security-docs.md)

## Outcome

The Capacitor app can join a club, read the ranked stream, post a human message, and download one chosen file. Catch-up works after the app process restarts. Notification text does not contain message bodies.

## Scope

- Wire the shared Vue UI into the Capacitor shell begun in milestone 0.
- Mobile layout for the single stream, composer, theme filter, and download action. No second product UI.
- Local SQLite on device through the storage interface from milestone 0.
- Catch-up through the milestone 6 hub after the process restarts.
- Voluntary download of one selected file to the app sandbox, with the same hash check.
- Push notification skeleton, only if the payload can be limited to "new activity" with no message text, sender name, or file name. Otherwise omit push and record that exclusion in the milestone report.

## Exclusions

- A store listing, a signing certificate, and push that includes message contents.
- Rewriting ranking or encryption in Swift or Kotlin.
- Background seeding that the OS will not reliably allow. Seeding while the app is open is enough.
- A separate mobile MCP server.

## Invariants

- The mobile client uses the same event verification and decrypt path as desktop.
- A notification, if registered, has a static body. The test or the registration payload fixture contains none of the message text.
- Joining still requires a valid invite.
- Opening the stream does not start file transfers.

## Data model

No new event fields. Mobile uses the same migrations. Platform path for the database and blob directory comes from the shell.

## Test strategy

Automated: the shared stream, invite, and download tests already cover the core. Add a Capacitor-level test or a scripted check that the web build used by `cap sync` includes the stream route. Manual checklist, because device background behavior is not fully automatable here:

- Accept invite, read catch-up, post, download one file, force-close, reopen, and confirm catch-up.
- Confirm no file landed before the download action.
- If push exists, inspect the payload fixture for plaintext.

Mark the manual device pass `PASS` only after it is run. If no device or emulator is available, mark it `BLOCKED` and say what ran instead. Do not mark the milestone complete on the shared unit tests alone.

## Acceptance checks

- The manual checklist above passes on one Android or iOS emulator or device.
- `cap sync` succeeds.
- Restart catch-up shows a message that arrived while the process was stopped.
- The selective download writes only the chosen file.
- Push payload check passes, or push is omitted.

## Rollback

The desktop app remains the supported client. Revert the Capacitor wiring without changing the event format.

## Adversarial self-review

This is a same-agent review, not an independent review.

### Findings

- "Push notification skeleton" is a common plaintext leak.
- "Offline behavior is acceptable" will be closed without a device.
- Starting this milestone before file sharing and the hub exist would build a second, thinner sync path.
- Background transfer on iOS cannot be promised from a unit test.

### Revisions applied

- Push is either content-free or absent.
- The milestone is not complete without the manual device checklist, honestly labeled.
- Dependencies include file sharing, the hub, and the shared stream.
- Seeding is required only while the app is open.
