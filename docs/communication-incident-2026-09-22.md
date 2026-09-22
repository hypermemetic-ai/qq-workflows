# Communication incident, 22 September 2026

This report distinguishes native model output, managed result publication, and delivery to the coordinating Architect. A final assistant answer proves only the first of those.

## Observed incident

Architect owner: `0e74f128-8d65-4fe3-a527-c46e48d09f6f`.

| Job | Preserved evidence | Managed conclusion |
| --- | --- | --- |
| `5498ca64-fab0-4e73-8751-9a5700c50e8b` | Native recording has 70 tool calls, 70 results, no tool errors, and final assistant text at `2026-09-22T09:19:28.872Z`. | No original registered result report; interrupted. Native final text does not establish adapter success. |
| `aa532357-bd3d-463d-9908-220a482d75e4` | Native recording ends with 8 calls, 6 results, two outstanding calls, and no final assistant answer. | Process disappeared; outcome unknown. |
| `1a2c167b-a1eb-43f7-824a-c0960969114f` | Later bounded control completes with registered report and an automatically delivered completion. | Working ordinary return path; report `runner-1a2c167b-a1eb-43f7-824a-c0960969114f-2407ee65c7985cff`. |

The Paseo daemon log records a voice-related reload of this Architect at `09:16:36.877Z`, completed at `09:16:37.502Z`. The native extension's process-local job map and completion callbacks did not survive that reload. Tool activity became unavailable and cached running status was not reliable evidence of a live worker.

A second, independently reproduced failure was the adapter's handling of disconnected parent pipes. A real installed-Pi test against a localhost provider reproduced an exit without published result when final stdout hit a closed pipe. Previously, final stdout preceded durable completion publication and an unhandled pipe error could terminate the adapter. The repaired adapter treats pipe output as best-effort and publishes durable results first.

The historical exit signal or operating-system cause was not retained. We cannot establish that either historical worker died specifically from EPIPE. The reload and loss of coordinator supervision are observed; the pipe/result ordering defect is reproduced; the exact cause of the second worker's disappearance remains unknown. The later control ran with an intact coordinator callback and therefore does not contradict the reload failure.

## Preservation and useful recovery

Original job outcomes and native recordings remain unchanged. Assistant text and tool evidence were extracted structurally; private reasoning was not exported. The original findings from the first runner are available through normal `read_report` as:

`recovered-evidence-5498ca64-fab0-4e73-8751-9a5700c50e8b-fed72a56a139d6ca`

That is a recovered-evidence report, not a retroactive successful execution. Backups and review artifacts are retained under `~/.local/state/qq-workflows/communication-completion-20260922/`. The current Architect ticket contains the exact native artifact paths and ongoing activation checkpoint.

## Implemented bootstrap and proof

PR116 adds durable runner result recovery before disappearance reconciliation, bounded durable telemetry, automatic supervision, and report-before-notification ordering. A missing telemetry map is reported as unavailable; it is not interpreted as idle reasoning. Unexpected process loss is never automatically relaunched.

PR117 separates coordinating-session ownership from the selected phase/worktree identity and validates preserved worktrees. The original unfinished phase was resumed through a new explicit execution without restarting the deliberately stopped execution. Dirty root changes and stashes were preserved.

Subsequent owned-host work exercises the existing managed pipeline in an independent process. Tests use installed Pi, an isolated localhost provider, real Git worktrees and local landing. They kill the coordinator during the first model turn and verify role reports, pipeline completion, recovery and deduplication. Their external notification sink is a test seam; actual Architect delivery still requires release acceptance in the live session.

Source landing, a release pointer, a native final answer, and a queued notification are not deployment acceptance. The final release checkpoint records the activated source and current-session evidence separately.
