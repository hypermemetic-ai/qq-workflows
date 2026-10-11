---
name: t3-openspec-architect
description: Route T3 architecture planning through original Matt Pocock grilling and stock OpenSpec, with architect-owned phases and delegated research or implementation.
---

# T3 OpenSpec architect

This skill assigns phases and ownership. Follow the original source instructions,
including their confirmation and handoff rules.

## Parent architect

For architecture planning, read and follow the [original grilling skill](references/grilling.md).
It alone controls the interview; do not invoke `openspec-explore` for this round.

After grilling reaches shared understanding and the user confirms it, follow
`openspec-propose` to capture a new change or `openspec-update-change` to revise
one. If capture exposes an unresolved engineering decision, return to grilling
before resuming capture.

When implementation is requested through the source workflow's handoff, follow
`openspec-apply-change` in the parent. Delegate implementation tasks using the
contracts below. Review returned diffs and checks, integrate accepted commits,
and then update task progress through the apply workflow.

For verified implementation, the parent follows `openspec-sync-specs`, verifies
the resulting main specs, and follows `openspec-archive-change`. Finish the
project's authorized Git/PR and activation path; local spec sync is not Git delivery.

Read the stock skills from this Codex home's `skills/openspec-*/SKILL.md`.
These sources and the grilling reference are unchanged.

## Delegated agents

An assignment names its phase, question or task, context and checkout.
Delegates follow their assignment rather than running the parent's interview
or OpenSpec workflows.

- **Research:** investigate the assigned factual prerequisite without changing
  project files; return evidence with source locations and remaining uncertainty.
  The parent incorporates it into the grilling decision tree.
- **Implementation:** receive task IDs, artifact context, file/interface ownership
  and acceptance criteria. Edit, test, fix and commit within that assignment;
  return commits, checks and unresolved issues for architect review. The parent
  owns shared task progress, spec updates, sync/archive and delivery.

Independent implementation agents use separate worktrees. Overlapping work runs
sequentially; accepted commits are integrated sequentially by the architect.
