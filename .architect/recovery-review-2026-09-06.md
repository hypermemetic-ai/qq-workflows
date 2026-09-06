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

## Remaining steps

1. Obtain approval for sending the added migration and review-driven changes in PR #75 to the configured external reviewer. Automatic approval review interpreted the earlier approval narrowly and rejected the added payload.
2. Review the final source range through the production provider proxy, retaining sanitized coverage/findings on both successful and unsuccessful process exits. Supply the reviewed workflow contract as background; the reviewer cannot read untracked node_modules through Git.
3. Resolve any substantiated new findings and require complete review coverage before automatic merge.
4. Reload the existing Architect plugin on `/home/qqp/.paseo-architect` and upgrade its idle background host. Reload affected idle agent `ae4a72cf-80cc-4a94-906b-d185fdbf1f77` to migrate its saved history. Verify the host version, plugin running status and restored session. Do not restart the Paseo daemon.

Latest validation: 24 JavaScript test files, 46 Python tests, TypeScript checking, and stock v0.7/fork v0.8 plugin compilers pass. No merge or deployment has been claimed.
