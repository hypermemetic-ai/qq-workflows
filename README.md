# qq-workflows

`qq-workflows` keeps architect delegation and Land completion on explicit,
durable Git-worktree and GitHub pull-request boundaries.

## Durable delegation identity

Architect `delegate` creates one full delegation UUID before the initial child
is started. That UUID remains the operator-facing workflow address through the
implementer, QA look 1, fixer, QA look 2, and terminal landing or blocking.
Each role still has its own immutable physical session UUID and event history.

The durable Land record stores:

- `delegationId` and its one-to-one Land `runId`;
- the immutable `parentSessionUuid` used for automatic return;
- a monotonic `phaseEpoch`;
- the routable `current` `{ sessionUuid, role, phaseEpoch }` plus a durable
  `transitioning` guard; and
- a pending successor packet whose physical UUID, role, epoch, message ID, and
  exact content are persisted before child creation.

Old v1 Land records are upgraded in place on first load. Their generated
`delegationId` is persisted atomically and reused thereafter.

Architect inherits only the decided research/mailbox tools; its plugin tools are
`case_write`, `delegate`, `workflow_status`, `workflow_send`, and `land`; new
harness tools do not appear.

Architect sessions receive two façade tools:

- `workflow_status(delegationId)` reports run state, role, epoch, current
  physical UUID and ephemeral alias, ref, and worktree.
- `workflow_send(delegationId, message, expectedRole?, expectedEpoch?)` sends by
  the exact durable current UUID only. Missing, terminal, transitioning,
  expectation-mismatched, non-live, non-owned, or foreign-parent runs refuse.

`workflow_send` never resolves aliases or labels. The separate qq-relay
`relay_send` tool remains strict direct-session UUID routing for diagnostics and
emergency steering.

## Completion and recovery

- Architect delegation creates a fresh isolated worktree. Land adopts the child
  after inspecting that worktree.
- Plugin/HMR teardown detaches in-memory ownership without cancelling a live
  Land child. Reapply discovers the same AgentHandle, inserts any missing
  pending packet by its stable message ID, durably acknowledges delivery before
  pointer promotion, restores run/role labels and completion ownership, and
  resumes an armed settlement exactly once.
- Only the exact Mini completion command is a submission sentinel. Accepted
  submissions settle after the exact durable tool result.
- Every child packet and lifecycle report names the delegation UUID and Land
  run. Physical session UUIDs remain visible for diagnostics.
- Real `agent/disposed` cancellation remains terminal and is reported exactly
  once to the durable parent UUID. HMR detachment never impersonates
  cancellation.

## Publishing and landing

`origin/main` is the source of truth for a completed Land. After routing and QA
accept a clean, committed proposal, Land:

1. rechecks the clean local `main` checkout, clean delegated worktree, and the
   OpenWiki generated-path guard;
2. pushes the exact reviewed proposal commit to its branch on `origin`;
3. opens a GitHub pull request with base `main` and that proposal branch as its
   head;
4. merges the pull request with a merge commit (never squash or rebase);
5. fetches `origin/main` and advances local `main` with `--ff-only`; and
6. only then removes the delegated capsule/worktree and local proposal branch.

Land never pushes local `main` and never creates a local merge commit. A push,
pull-request creation, pull-request merge, fetch, or fast-forward failure makes
the run blocked and retains the capsule for diagnosis or retry. In particular,
a publish failure cannot silently report a local-only landing.

## Mini-review Land QA

Land review looks use the read-only `mini-review` preset. The reviewer starts
from the architect's approved plan plus bounded changed-file counts and up to
eight hunk pointers. It retrieves focused evidence from the immutable base and
head Git objects with only `grep`, `glob`, and bounded `view`; unified diffs and
file bodies are not inlined into the packet. It finishes with `submit_review`;
zero findings passes, while any finding starts the one allowed fixer after look
1 or blocks after look 2.

The reviewer cannot run commands, read the working tree, edit files, commit, or
access arbitrary revisions. Land still rejects a dirty QA worktree or a QA
production commit as defense in depth.
