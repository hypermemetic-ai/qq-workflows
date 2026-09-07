# Recovery review disposition

PR: https://github.com/hypermemetic-ai/qq-workflows/pull/75

## Review evidence

Configured reviewer: Grok 4.6, high effort. Range: `7e18d74453a88b92ca598314cffe978682a47a2d..73d03a5`. Session: `01c11c56-b72d-4564-b1cf-236325a37b8c`.

The run emitted 19 provisional findings, then was cancelled after 18m11s because repeated filter-schema HTTP 400 errors and a timeout prevented reliable completion. The final output reports failed status and 8 of 29 selected items failed. It is **not approval**. Summary usage: 2,596,856 input tokens and 277,440 output tokens. These figures concern this recovery review, not the earlier 49-minute Implementer run.

## Applied findings

- Workflow replay now removes the model-only event prefix so the displayed body matches the live event. Covered by actual ACP restart/replay comparison.
- A failed or misplaced corrective child leaves its original delegation active, preventing another worker from starting. Covered by a two-spawn/blocked-third-spawn regression.
- Terminal host close awaits Researcher settlement, with a finite wait, so cancellation status and wakes can be persisted before exit.
- Unreaped diagnostic groups remain tracked for later cleanup; ownership writes are atomic and persistence failures are reported.
- Cancellation during process creation is checked again after registration; shutdown disallows subsequent work. Tests inject cancellation inside process creation for foreground commands and services.
- Nonpositive time limits clamp to the minimum rather than a long default.
- A failed Researcher spawn callback cleans up its child. JavaScript termination still attempts SIGKILL after a non-ESRCH SIGTERM failure.
- The review provider boundary converts null tool-schema required lists to empty lists. This addresses the observed x.ai schema rejection without removing the filtering stage. Live validation is pending.

## Findings not applied

- Arbitrarily cap wakes at two: conflicts with preserving background events within the selected operator exchanges. A separate token policy would be a product decision. No silent event dropping was added.
- Accept unknown SDK workspace paths or substitute raw transport fields: the actual installed SDK exposes `WorkspaceHandle.directory`; the integration test verifies the adapter's mapping from `workspaceDirectory`. Strict placement validation remains.
- Treat Teacher's shared checkout as an Implementer placement defect: Teacher placement is intentionally unchanged. Implementers use prepared checkouts.
- Count leading wakes as a human exchange in metrics: the proposed change would reintroduce nonhuman retention slots. Individual turn accounting retains those rows; two-operator windows start with an operator.
- Remove the persisted spawn-failure wake: the retained notification remains useful if the current tool response is interrupted; it no longer consumes a human exchange.
- Infer host process-group ownership from arbitrary recorded groups: managed diagnostic groups are created with `start_new_session=True`; they do not inherit the host group. No `process.getpgrp` fallback was added (Node does not expose that API).
- Replace the runtime test packet helper: explicit test options already override the default fixture, and dedicated integration tests cover empty packets.

## Recovery review decision

The operator approved the additional disclosure, then explicitly ended further Grok review for this recovery. The second run was interrupted while still generating after about 16m43s; it did not pass. A later direct request failed without a final report. No external review approval is claimed. The operator asked for direct local inspection and progress they can validate. Keep OCR for future open tickets only, with bounded direct landing unchanged.

The interrupted process exposed two additional defects: proxy shutdown left upstream requests running, and nonzero OCR exits discarded the structured failure manifest. Both are fixed with cancellation and sanitized-evidence regressions. A complete local workflow test now exercises the actual Paseo SDK adapter, real Git worktrees and landing for bounded, open, correction and report-only cases, with only model/daemon responses simulated.

## Final local review and deployment

All 25 JavaScript test files, 46 Python tests, TypeScript checks and both Paseo plugin compilers pass. Native Android reproduced the absent entry point and now passes Ticket → formatted Plan → Work → original conversation with Pure black selected. Screenshots were inspected. Parser initialization failed in Hermes during development; parsing now stays on the server and the native client renders serialized tokens. Emulator details live in `.architect/scratch.md`.

Local inspection covered cancellation settlement, retained OCR evidence, prepared-checkout placement, correction ownership, report-only completion, subscription races, per-workspace callback binding and phone navigation. No further Grok review was launched. The approved final step is automatic PR integration.

The existing plugin is running. Host PID 905520 reports source hash `7df1cf8b9839b966627079d9ffba0a330515badef02baf790d42404df3cc2f2e`, matching the reviewed source. After a SQLite backup and confirmation that the affected Architect was idle with no unacknowledged wakes, its process was reloaded. Saved history is version 2: two operator exchanges and six workflow events. The replayed timeline has two real user messages. The Paseo daemon was not restarted. The completed collector inspection remains recorded in the ticket; historical uncertainty and publication state were preserved.
