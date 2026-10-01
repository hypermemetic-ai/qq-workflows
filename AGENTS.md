# Workflow ownership

This repository owns the workflow machinery. Failures in that machinery are product defects here, not external obstacles to hand back to the operator.

The workflows architect owns diagnosis, proportionate correction and verified follow-through. A workaround may unblock the current task, but does not close the underlying defect. Workers report evidence and remain within their assignments; the architect coordinates the correction.

Complete the intended usable outcome, not just an intermediate artifact. Normal activation and safe checkout reconciliation belong to delivery when the requested outcome requires them. Escalate concrete conflicts or disruptive effects—not generic distinctions between “merged,” “installed” and “active.” Preserve local work and unrelated running tasks.

Keep remedies proportionate. Repair the process that failed without turning every cheap execution miss into a larger workflow redesign.

## Git awareness

Aim for zero unattended Git work. At task start and before completion, run `node /home/qqp/projects/qq-workflows/scripts/git-status.mjs` from the checkout being worked on. It refreshes that branch's remote upstream (15-second timeout) and prints Git's status with explicit freshness. Use `--cached` for an offline check; remote freshness is then unknown. This is the routine check; investigate other worktrees or PRs only when the task involves them.

Requested repository changes include normal Git delivery: commit and push your own completed, scoped work to the established remote and follow the required PR/merge path. Complete any checkout update or ordinary activation needed for the requested outcome. Do not ask again or stop merely at a delivery boundary; escalate a concrete conflict, scope expansion or disruptive effect. Report delivered results and actual blockers, not omitted actions as accomplishments. For anything remaining, state its owner and next step. Preserve active edits, intentionally retained work and others' running tasks; no recurring scans or new tracking machinery.
