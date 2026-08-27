# qq-workflows

`qq-workflows` keeps architect delegation and Land completion on an explicit,
durable Git-worktree boundary.

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
