# Ticket: restore a usable Architect workflow

## Kind

open — repair and verify the workflow end to end.

## Operator intent

Parent agent: `ae4a72cf-80cc-4a94-906b-d185fdbf1f77`, native Architect session `0fd7ea62-c64e-4202-b2e4-f888d6b07044`, workspace `/home/qqp/projects/qq-workflows`.

The operator asked an execution-capable recovery agent to take direct ownership, preserve the existing work, and consult where intent matters. They confirmed automatic merging after review. Workflow notifications must not masquerade as operator messages or consume the two operator-exchange retention slots. The operator also wants an evidence-based explanation of the 49-minute run and the project's repeated failures.

## Current follow-up: interrupted collector outcome

Operator reports: `Interrupted operation has an unknown outcome. Inspect /home/qqp/.paseo-architect/worktrees/architect/architect-bounded-ca986a48; no command or publication was replayed.` This identifies the worktree associated with collector job `ca986a48-43df-4707-aee0-c1806bed9f93`; verify correlation from retained records. This is not evidence of a new publication, nor evidence that recovery PR #75 failed. No replay has been reported.

Read-only Researcher inspection `5440ab36-8ecd-4fb8-b333-74d399211d6d`: findings received from the operator for observation window **2026-09-06T23:38:39Z–23:40:45Z**. This findings-only follow-up is complete; no intervention or implementation handoff is needed. Do not duplicate inspection, replay commands, retry publication, push, merge, delete the leftover branch, reconcile job state, or restart services on its account. No Grok review.

### Collector inspection findings

- Identity confirmed: worktree `/home/qqp/.paseo-architect/worktrees/architect/architect-bounded-ca986a48`, gitdir `/home/qqp/projects/qq-workflows/.git/worktrees/architect-bounded-ca986a48`, repository `hypermemetic-ai/qq-workflows`, branch `architect/bounded/ca986a48` with no upstream. Clean at `7e18d74453a88b92ca598314cffe978682a47a2d`, equal to local main and origin/main (0/0). Reflog creation 2026-09-06T21:23:04Z. Primary checkout is distinct, on `architect/recover-workflow-contracts` at `1e6c8a6a5e502bfe10fd233b238b610589edc0cd`.
- SQLite opened read-only: collector job remains `uncertain`, phase `landing`; created 2026-09-06T21:23:04.850Z, heartbeat 21:40:20.673Z, PID 424360 not live. Child `919feaca-a5c3-4065-9ffa-4fc8630c3015` is not a separate job row; agent JSON reports idle/finished at 21:40:27.085Z, session `4c80f71d-aed8-4b16-bd56-d97f3f09050f`.
- Retained commit record says `committed:false` at `7e18d74…`. Publication remains `pr_pending`, head `architect/bounded/ca986a48`, base `main`, same SHA; decision `commit_pr_merge`, `reviewer:false`. Attempt IDs `ca986a48-43df-4707-aee0-c1806bed9f93:push_pending` and `:pr_pending` have matching repo/head/SHA, but no result/success rows or returned PR identifier. There are 85 complete model/command attempt rows, no dedicated publish/push/PR operation row.
- Retained error/result describe uncertain PR creation, not success. Receipt `9f0f2b9a-e438-4462-950b-e010b1b4e131`; failure wake at 2026-09-06T21:40:30.541Z and reconcile wake at 23:32:46.147Z both acknowledged. Inspection did not reconcile or change this state.
- Fresh remote evidence (`git ls-remote`, GitHub branch API and all-state PR queries, no fetch/push): remote collector branch **exists**, at the same SHA as remote main; no open/closed/merged PR matches its head or `ca986a48`. SHA is the merge of PR #74, not a collector change. No records connect this job to PR #75; #75 is OPEN on the separate recovery branch at `1e6c8a6…`, created 2026-09-06T22:23:50Z.
- Limits: GitHub compare endpoint returned HTTP 500; independent SHA identity establishes current equality. zvec-grep timed out; inspection used read-only SQLite/git/gh. Report notes WAL mtime 2026-09-06T23:40:45Z during inspection; this is not attributed to a write by the reader. No historical publication success or definitive failure can be inferred solely from current equality or absence of matching PRs. Avoid the overbroad claim that equal head/base means a historical PR could never have existed.

Disposition: current evidence supports **no publication replay or other collector intervention**. Preserve the retained historical `uncertain` / `pr_pending` state and same-SHA remote branch. Recovery PR #75 and native Android acceptance work remain separate and outstanding.

Sources: collector worktree above; `/home/qqp/.paseo-architect/architect/state.sqlite`; `/home/qqp/.paseo-architect/agents/home-qqp-projects-qq-workflows/919feaca-a5c3-4065-9ffa-4fc8630c3015.json`; GitHub repository branch/PR/commit observations supplied in the findings.

Coordination correction: the preceding Architect response updated an obsolete on-disk triage ticket rather than the operator-supplied current recovery ticket. This file restores the supplied recovery contract; obsolete statements that collector findings are pending, mobile is deferred, or merge lacks approval are not current instructions. Automatic integration approval for the recovery remains subject to its acceptance gates; this collector inspection itself authorizes no publication.

## Confirmed incidents

- Original search repair: host job `740058b9-befe-48ee-ac93-ffa37c49f086`, child `e90ef2c8-6ff8-4642-b8ec-985955b2cc39`.
- Approved diagnostic-tools v1: host job `c3a9da24-0b11-4412-8c95-ad3cc65cc7e0`, child `4ff5c6fa-9418-4e09-b6ac-a1c7d6d50170`.
- Both children executed in the source checkout while the host committed/reviewed empty worktrees. Both retained review packets have identical base/head `7e18d74453a88b92ca598314cffe978682a47a2d` and no files. Both jobs failed review. Their edits survived in the source checkout.
- Read-only collector: job `ca986a48-43df-4707-aee0-c1806bed9f93`, child `919feaca-a5c3-4065-9ffa-4fc8630c3015`. Its answer is retained, but bounded completion incorrectly attempted publication. Prior remote inspection found no matching PR and the branch identical to main. Preserve historical uncertain status; no blind retry.
- Researcher `81e68395-f46a-47d2-b531-f2bb820210c0` failed with a Python syntax error. Historical traceback is absent. Supervisor journaling exported Tool source on every request; that reparses mutable files. Recovery journals loaded schemas and retains future tracebacks. This fixes a reproducible failure mode without claiming an unretained historical traceback was recovered.

## Acceptance contract

1. Child ownership remains with Architect, but execution, commit, review and publication use the same prepared checkout. Verify actual SDK placement; reject a mismatched child and preserve its identity.
2. Preserve and validate original search-wrapper and diagnostic-v1 changes. Diagnostic authority remains investigation, with managed scratch processes and finite command/output/lifetime bounds.
3. Report-only Implementer handoffs return findings without commit/review/publication. Ordinary empty implementations stop with a useful error. Skipped review remains failure.
4. Background events stay visible, survive session replay, and do not evict human exchanges. Retention accounting groups them with the relevant operator exchange.
5. Retain attempt finish timestamps, failed review manifests and Python tracebacks for future diagnosis.
6. Run Python tests, JavaScript integration tests and both Paseo plugin compilers. Inspect the actual recovered diff before automatic integration. Verify deployed source separately from test results.
7. Verify the native Android fork from its conversation screen. The operator sees no Ticket tab at all; desktop navigation followed by viewport resizing is insufficient. Establish an Android emulator environment, reproduce the missing interface, and test the fix there before calling the mobile workflow verified.

## Performance evidence

For original repair, 50 model turns and 49 commands span about 49m49s. Across the first 49 model/command cycles, model-start to command-start intervals total 2,831.652s; command-start to next-model-start intervals total 118.615s. The final model start precedes the failure wake by 36.608s. These are interval bounds including adapter overhead, not exact provider durations. Prompt tokens grew 5,422 → 102,361; reported reasoning totaled 102,043 tokens. Large-context high-reasoning generation dominated elapsed time; OCR did not. No model or reasoning setting was changed without an operator decision.

## Recovery status

Recovery PR: https://github.com/hypermemetic-ai/qq-workflows/pull/75 (ready for integration). All 25 JavaScript test files, 46 Python tests, typecheck and both plugin compilers pass after review-driven fixes. The affected idle agent was reloaded after a database backup. Saved history is now version 2 with two operator exchanges and six workflow events; the replayed timeline contains only two real user messages.

The first configured Grok review produced useful findings but repeatedly failed its filtering tool schema validation (`required: null`) and had incomplete coverage. It was stopped after 18m11s; this is not a passed review. Substantiated findings are fixed and the provider proxy now normalizes null required lists at the tool-schema boundary. That correction has local regression coverage but still needs live review validation.

The operator subsequently approved disclosure, then stopped further Grok review for this recovery after another lengthy run was interrupted while generating. Do not launch another Grok review for this recovery. Inspect locally, communicate progress, validate with the operator, and merge automatically after checks. Future open tickets retain OCR review; bounded tickets retain direct landing and report-only investigations do not enter review/publication.

Native Android reproduced the missing entry point. The approved Ticket composer button now opens the correct workspace from a conversation. The redesigned Plan/Work panel passes native navigation and formatted-plan checks with Pure black selected, including returning to the original conversation. Emulator instructions are in `.architect/scratch.md`. The existing plugin is reloaded, the live host matches reviewed source, and history migration is verified. Final PR integration remains outstanding.

## Operational constraints

Do not restart the normal Paseo daemon merely to load plugin changes. Preserve historical uncertain jobs without blind retry. Model/runtime replacement and native push setup remain separate decisions.

## Historical decisions

The preceding detailed ticket and approvals are preserved in `.architect/recovery-history-2026-09-06.md`; use it as evidence, not as competing instructions or the next delegation task.
