---
name: t3-openspec-architect
description: Route T3 design work through stock OpenSpec, with architect-owned phases, delegated research or implementation, and the original Matt Pocock grilling when the user asks to be grilled.
---

# T3 OpenSpec architect

This skill assigns phases and ownership. Follow the source instructions,
including their confirmation and handoff rules.

## Parent architect

Work with the owner as the architect's instructions say. When the owner asks
to be grilled, follow the [original grilling skill](references/grilling.md).

Once the owner agrees a design, follow `openspec-propose` to capture a new
change or `openspec-update-change` to revise one. If capture exposes an open
decision, take it to the owner before resuming.

When implementation is requested, follow `openspec-apply-change` in the
parent, delegate the tasks under the contracts below, review returned diffs
and checks, integrate accepted commits, and update task progress. For
verified implementation, follow `openspec-sync-specs`, verify the main specs,
follow `openspec-archive-change`, and finish the project's own Git delivery
path; local spec sync is not delivery. The stock skills are discovered from
the T3 architect profile's `.claude/skills/openspec-*/SKILL.md`.

The architect reviews every delegate's output before integrating it.

## Delegated agents

A brief gives the goal, the source to work from (the reference itself, not a
summary of it), the hard limits and where to stop, short enough to read on a
phone. A Fable brief leaves the how to Fable; an Opus brief is a complete
plan. The owner reviews the brief that starts a new piece of work; steers
within it, and practical details (branch, base commit, files folder, the
machine's rules), go without review.

Delegates follow their assignment, not the parent's interview or OpenSpec
workflows.

- **Research:** investigate the assigned question without changing project
  files; return evidence with source locations and what remains uncertain.
- **Implementation:** receive task IDs, base commit, artifact context,
  file ownership and acceptance criteria. First confirm the worktree's HEAD
  is the base commit. Edit, test, fix and commit within the assignment;
  return commits, checks and unresolved issues for review. The parent owns
  task progress, spec updates, sync, archive and delivery.

Delegates are T3 child tasks started with `delegate_task`, never Claude's
native Agent tool. Implementation delegates use `isolation: "worktree"`,
each started from the parent's current local commit: commit what the task
builds on first and name that commit as its base. Review each delegate's
changes as the diff from its base; overlapping work runs, and is integrated,
one at a time. After integrating or rejecting a delegate's work, remove its
worktree and branch; before delivery, `git worktree list` shows no leftovers.
