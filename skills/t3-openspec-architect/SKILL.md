---
name: t3-openspec-architect
description: Plan software changes interactively with an informed engineer, capture agreed architecture as OpenSpec delta specs, and coordinate delegated implementation with architect review. Use for T3 architecture or planning conversations and continuing their agreed changes; skip quick fixes and general questions.
---

# OpenSpec architect

Keep the parent conversation available for engineering decisions. Use Matt
Pocock's design-tree questioning approach, adapted here for OpenSpec and a phone
conversation. The upstream reference is [grilling.md](references/grilling.md);
the rules below define this adapter rather than invoking the entire Matt skills
suite. OpenSpec owns the artifacts and the maintained project specification.

## Establish the change

Read the active checkout's instructions, existing OpenSpec configuration, relevant
specs and active changes. Use the local retrieval route before broad reads. Run
the repository's Git-status helper when available and inspect worktree ownership,
the branch base and the required remote/PR path. T3 may already have created this
thread's worktree: reuse it when it is appropriate rather than nesting another.

Resolve the OpenSpec planning home with `openspec context --json`. Carry an
explicitly selected store through every supported command. A failed root or store
lookup is an error to resolve, not permission to write somewhere else. If the
project has no OpenSpec root, explain the stock initialization needed and do it
when the user has requested setup; do not invent specs for an uninitialized root.
Existing setup and implementation authorization persists through the workflow.

Distinguish the shipped behavior documented in `openspec/specs/` from the proposed
delta in `openspec/changes/`. Inspect code, tests and operational evidence when
they disagree. Ask the engineer to resolve a material behavior conflict, and
record whether the spec, implementation or proposal will change.

## Interactive architecture round

Start with the user's purpose and success criteria, then follow dependencies:
resolve a decision before asking about decisions that depend on it. Investigate
facts yourself. Ask about intent, tradeoffs and constraints that only the user
can settle. Reuse decisions already made in the conversation.

For an informed engineer, explain the technical consequence and give a grounded
recommendation with the strongest relevant alternative. Challenge assumptions
when evidence warrants it. Ask one focused question at a time by default; use a
small round of independent questions when the user prefers that. Phrase yes/no
questions so accepting the recommendation is unambiguous. Use the host's question
tool if it is available and appropriate; otherwise ask in ordinary chat and wait.

Cover the parts that can change the architecture or acceptance criteria: user
behavior, boundaries and interfaces, state and ownership, compatibility and
migration, failure/recovery, operational constraints, and the verification that
would demonstrate success. A diagram or small experiment can resolve uncertainty
more cheaply than another abstract question. Experiments that write code need
the user's existing or new authority and stay separate from production changes.

Keep confirmed decisions, proposed defaults and unresolved questions distinct.
Silence is not agreement. Follow the user's desired depth; stop when the material
choices are settled, deliberately delegated or explicitly deferred with their
impact understood. Do not exhaust irrelevant branches or manufacture questions.

## Capture the OpenSpec contract

A request to plan with this workflow authorizes the agreed change artifacts.
Until that scope is clear, keep investigation read-only. Once ready, summarize
the architecture and unresolved items, then use the installed stock
`openspec-propose` or `openspec-update-change` skill to produce or revise the
change. Locate the skills in this Codex home's `skills/` collection; the installer
links the byte-unmodified OpenSpec core there. Follow CLI-returned roots, schema,
artifact paths, dependency order, instructions and rules.

Use the stock `spec-driven` schema unless the project already selects another
schema or the user requests one. Keep the planning record in OpenSpec:

- `proposal.md` states purpose, scope and affected capabilities.
- Delta `specs/<capability>/spec.md` files state the behavioral change and
  observable scenarios using ADDED, MODIFIED, REMOVED and RENAMED requirements.
- `design.md` records architecture, rejected alternatives, tradeoffs, migrations
  and the rationale an engineer maintaining this later will need.
- `tasks.md` defines implementation units, dependencies, file/interface ownership
  and acceptance evidence tied to the requirements.

Do not create a parallel CE or Superpowers plan as a second source of truth. Do
not use `skip_specs` for a behavioral change. A MODIFIED delta preserves the full
updated requirement and its still-applicable scenarios. Reconcile new discoveries
into the change rather than quietly narrowing the intended behavior.

Check artifact readiness with `openspec status --change <name> --json` and
`openspec validate <name> --strict --no-interactive`. Present the concrete artifacts
for engineer review. Planning alone does not launch implementers; start work when
the user asks to implement the agreed change. Existing explicit implementation
authority should not be re-requested just because this adapter has stages.

## Delegate and review

Once implementation is authorized, read [implementation.md](references/implementation.md).
The parent architect owns decisions, integration, review and finalization.
Workers own bounded implementation assignments and can make routine engineering
choices within their agreed interfaces. Use native delegation and ordinary Git
worktrees; do not introduce a legacy Architect provider or another orchestration
service. A delegated worker follows its assignment rather than restarting this
planning interview.

## Finalize the durable specification

After the architect has reviewed the integrated change and its acceptance
evidence, sync the implemented delta into the current main specs, then archive
the change using the stock `openspec-sync-specs` and `openspec-archive-change`
skills. Read their current instructions; sync must finish and its resulting
requirements must be verified before archive moves the source change.

Finish the approved delivery scope through the project's commit, push, PR/merge
and activation path. Spec sync and Git merge are distinct operations: neither
substitutes for the other. Commit updated main specs and the archived change with
the implementation so the landed branch documents the behavior that shipped.
For a separate OpenSpec store, deliver both repositories through their own paths.

If implementation or acceptance verification is incomplete, leave the change
active and report what remains. A reviewed implementation can be synced and
archived on its delivery branch before that branch lands; describe it as pending
delivery until Git merge and any required activation are confirmed. Preserve
unrelated main-spec requirements during semantic sync.
Remove only owned, clean, merged worktrees and stop task-only background processes.

