# Delegated implementation and architect review

Use the agreed OpenSpec change as the dispatch contract. Read
`openspec instructions apply --change <name> --json` and its context files, then
follow the installed stock apply skill in each worker's bounded assignment.
Missing artifacts or unresolved product/architecture choices return to the
architect. The host's current permissions remain authoritative.

## Worktree and task ownership

Keep the architect on the thread's integration branch/worktree. Record its base
commit and the target upstream branch. Commit the agreed planning artifacts when
appropriate so workers have a reachable, stable contract. Inspect existing
worktrees and PRs before choosing a new branch or starting a competing change.

Give a worker the exact checkout path, base commit, task IDs, spec/design paths,
owned files or interfaces, dependencies and acceptance criteria. If multiple
workers can proceed independently, give each its own worktree/branch from the
integration base. Assign overlapping files or dependency-sensitive changes
sequentially. Never switch or reset another owner's checkout. Routine fixes can
use one assigned worktree without inventing a branch hierarchy.

Workers may edit, run relevant checks, fix failures and commit their assigned
work without per-step confirmation. They preserve product decisions, shared
interfaces, unrelated changes and the user's explicit constraints. Changes to
scope or an architectural contract go back to the parent. Use the existing model
defaults unless the user or project instructions request another selection.

The architect is the sole writer of shared task progress, main specs and the
integration branch while parallel workers run. Tell workers not to race on
`tasks.md`, spec sync, archive, a shared Git index, pushes or merge operations.
They can report completed task IDs for the architect to mark after review.

## Returned evidence

A worker reports its branch/worktree, commit range, changed files, task IDs,
checks run and outcomes, acceptance evidence, unresolved issues and any proposed
contract deviation. Prefer file paths and concise evidence over pasted logs.
Resume the same worker for a focused correction when that keeps useful context.

The architect reviews the actual diff and appropriate tests, not only the report.
Check behavior against the delta's scenarios, interfaces against `design.md`, and
quality against project conventions. An independent reviewer is useful for a
substantial or subtle change. Keep defect fixes with implementers; the architect
resolves architectural questions with the engineer when needed. Do not mark
tasks complete or accept exceptions merely because a worker says DONE.

Integrate accepted commits sequentially. Resolve conflicts using the agreed
contract; run integration checks that exercise the composed behavior. Parallel
verification does not establish that the integrated branch works. Reconcile any
accepted architectural change into the delta and design before final review.
Persist task progress and important review decisions in the change's existing
artifacts so compaction or reconnects do not cause completed work to be repeated.

## Delivery

Carry the authorized work through the established remote and required PR/merge
route, including required checks and ordinary activation. A delivery request may
already authorize this; do not add repeated approval gates for routine steps.
Do not fabricate merge/deployment authority when the user requested only a plan
or a PR. Show the concrete reviewable result before asking for any missing final
approval, and explain the requirement that makes it necessary.

Use current stock sync/archive workflows only after accepted implementation and
verification. Check every ADDED/MODIFIED/REMOVED/RENAMED delta against the main
specs after sync. Keep the archive and specification update on the branch being
delivered; they become maintained documentation when that branch lands. Do not
label an unmerged branch as the shipped specification.
