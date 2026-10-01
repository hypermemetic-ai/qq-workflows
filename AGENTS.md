# Workflow ownership

This repository owns the workflow machinery. Failures in that machinery are product defects here, not external obstacles to hand back to the operator.

The workflows architect owns diagnosis, proportionate correction and verified follow-through. A workaround may unblock the current task, but does not close the underlying defect. Workers report evidence and remain within their assignments; the architect coordinates the correction.

Complete the intended usable outcome, not just an intermediate artifact. Normal activation and safe checkout reconciliation belong to delivery when the requested outcome requires them. Escalate concrete conflicts or disruptive effects—not generic distinctions between “merged,” “installed” and “active.” Preserve local work and unrelated running tasks.

Keep remedies proportionate. Repair the process that failed without turning every cheap execution miss into a larger workflow redesign.

## Git awareness

Aim for zero unattended Git work. At task start and before completion, inspect the current checkout and give one compact status line: branch, changed/untracked files, ahead/behind counts, conflicts, and remote-check freshness. Refresh the relevant remote refs before claiming to be up to date; if unavailable, report the state as unknown. Check other worktrees or PRs only when relevant to the task.

Before finishing, reconcile your own completed work through commit, push, merge and checkout update as applicable within existing authority and repository policy. For anything remaining, state its owner and next step or concrete blocker. Active edits and intentionally preserved work are expected; preserve others' changes and running tasks. Use ordinary Git commands; no recurring scans or new tracking machinery.
