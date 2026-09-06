# Ticket: restore a usable Architect workflow

## Kind

open — repair and verify the workflow end to end.

## Operator intent

Parent agent: `ae4a72cf-80cc-4a94-906b-d185fdbf1f77`, native Architect session `0fd7ea62-c64e-4202-b2e4-f888d6b07044`, workspace `/home/qqp/projects/qq-workflows`.

The operator asked an execution-capable recovery agent to take direct ownership, preserve the existing work, and consult where intent matters. They confirmed automatic merging after review. Workflow notifications must not masquerade as operator messages or consume the two operator-exchange retention slots. The operator also wants an evidence-based explanation of the 49-minute run and the project's repeated failures.

## Confirmed incidents

- Original search repair: host job `740058b9-befe-48ee-ac93-ffa37c49f086`, child `e90ef2c8-6ff8-4642-b8ec-985955b2cc39`.
- Approved diagnostic-tools v1: host job `c3a9da24-0b11-4412-8c95-ad3cc65cc7e0`, child `4ff5c6fa-9418-4e09-b6ac-a1c7d6d50170`.
- Both children executed in the source checkout while the host committed/reviewed empty worktrees. Both retained review packets have identical base/head `7e18d74453a88b92ca598314cffe978682a47a2d` and no files. Both jobs failed review. Their edits survived in the source checkout.
- Read-only collector: job `ca986a48-43df-4707-aee0-c1806bed9f93`, child `919feaca-a5c3-4065-9ffa-4fc8630c3015`. Its answer is retained, but bounded completion incorrectly attempted publication. Remote inspection found no matching PR and the branch identical to main. Preserve historical uncertain status; no blind retry.
- Researcher `81e68395-f46a-47d2-b531-f2bb820210c0` failed with a Python syntax error. Historical traceback is absent. Supervisor journaling exported Tool source on every request; that reparses mutable files. Recovery journals loaded schemas and retains future tracebacks. This fixes a reproducible failure mode without claiming an unretained historical traceback was recovered.

## Acceptance contract

1. Child ownership remains with Architect, but execution, commit, review and publication use the same prepared checkout. Verify actual SDK placement; reject a mismatched child and preserve its identity.
2. Preserve and validate original search-wrapper and diagnostic-v1 changes. Diagnostic authority remains investigation, with managed scratch processes and finite command/output/lifetime bounds.
3. Report-only Implementer handoffs return findings without commit/review/publication. Ordinary empty implementations stop with a useful error. Skipped review remains failure.
4. Background events stay visible, survive session replay, and do not evict human exchanges. Retention accounting groups them with the relevant operator exchange.
5. Retain attempt finish timestamps, failed review manifests and Python tracebacks for future diagnosis.
6. Run Python tests, JavaScript integration tests and both Paseo plugin compilers. Review the actual recovered diff before automatic integration. Verify deployed source separately from test results.

## Performance evidence

For original repair, 50 model turns and 49 commands span about 49m49s. Across the first 49 model/command cycles, model-start to command-start intervals total 2,831.652s; command-start to next-model-start intervals total 118.615s. The final model start precedes the failure wake by 36.608s. These are interval bounds including adapter overhead, not exact provider durations. Prompt tokens grew 5,422 → 102,361; reported reasoning totaled 102,043 tokens. Large-context high-reasoning generation dominated elapsed time; OCR did not. No model or reasoning setting was changed without an operator decision.

## Recovery status

Direct source repair is in progress. An initial full check passed 24 JavaScript files, 38 Python tests, typecheck and both plugin compilers. Additional retention/lifecycle regressions are being completed. No claim of final review, merge or deployment yet.

## Deferred

Android Researcher visibility enhancements, provider renaming and model/runtime replacement remain separate product decisions. Keep automatic merge after review. Do not restart the normal Paseo daemon merely to load plugin changes.

## Historical decisions

The preceding detailed ticket and approvals are preserved in `.architect/recovery-history-2026-09-06.md`; use it as evidence, not as competing instructions or the next delegation task.
