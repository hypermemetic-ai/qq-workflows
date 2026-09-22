# Communication Release Handoff — 2026-09-22

Operational handoff for the landed communication implementation.

## Release and ownership

- Active executable release: `bd15d4f42f55cf7b339f2aa5fd3e9e05444be82d`. PRs 116–126 contain the implementation and the final production-path repair. The full 66-test suite and independent reviews passed. This documentation commit does not change the active executable release.
- Existing Architect owner: `0e74f128-8d65-4fe3-a527-c46e48d09f6f`; model unchanged. Worker roles remain externally configured Pi/MiMo v2.6-pro/high.

## Current-owner runner acceptance

- Job `b9d58c96-8082-45fb-8e93-9519fbc96719`, attempt `01f1a09a-88e1-4dd4-ac0d-bca985895261`: revision 2 acknowledged at seq 11, completed at seq 14. Progress sequences 7/12 reached the idle Architect; the original worker PID 2745777 survived a coordinated same-session reload; completion receipt entry `6786ad47`; full report `runner-b9d58c96-8082-45fb-8e93-9519fbc96719-9f4d5eb077dc7358` (763 chars) read via normal read_report. No operator polling drove completion.

## Known failures and repairs

- Historical model `5498ca64` completed, but managed success was not established; `aa532357` process disappearance remains unexplained. An observed coordinator reload lost callbacks; the closed-pipe result-publication failure was independently reproduced and fixed. The recovered evidence report remains retrievable without changing interrupted outcomes.
- Live initial acceptance also caught native durable-result paths outside `/tmp` being refused. It failed before inference, pushed truthful failure, and retained its report. The repair accepts the exact already-bound result path; tests now cover state outside `/tmp`. Failed job `56e6986e-9177-4922-a2bc-3e89f5c8bdc7` stays failed.

## Communication semantics

- Native/MCP runners and managed implementer/reviewer attempts use one change record, the original relay, durable report-before-notify, scoped updates, and cancellation-before-signal. Submission, transport receipt, acknowledgement, and success remain distinct.
- Pending B after result A remains unresolved; no automatic relaunch. Recovery never relaunches an interrupted worker; unresolved instructions need an explicit follow-up phase. Legacy/manual communication limitations are explicit. External queue acceptance alone is not model receipt; no exactly-once external queue claim.

## Operations

- Use `dispatch_execution` with explicit `phaseId` for a preserved phase; coordinator ownership remains current. Fresh phases use a fresh remote base. The root checkout remains dirty/stale; do not reset/pull/clean it. Old stopped jobs are not restartable without explicit new authorization.

## Checkpoints and rollback

- Checkpoints: `/home/qqp/.local/state/qq-workflows/communication-completion-20260922/`. Rollback: restore the saved prior qq-architect command, config reload, then same idle-session reload. Never roll back or delete durable state, reports, or pending updates.
