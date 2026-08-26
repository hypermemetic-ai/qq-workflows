# qq-workflows

`qq-workflows` keeps architect delegation and Land completion on an explicit,
durable Git-worktree boundary.

- Architect delegation uses the parent session's exact cwd. It refuses a
  projects root, non-Git directory, detached/invalid repository, or other
  ambiguous target before creating an agent.
- A valid delegation gets a fresh isolated worktree. Land adopts the child only
  after that worktree passes inspection; failed inspection creates no run,
  completion binding, tool, label, listener, or child owner.
- Plugin/HMR teardown detaches in-memory ownership without cancelling a live
  Land child. Reapply discovers the same AgentHandle, restores run/role labels
  and completion ownership, and resumes an armed settlement exactly once.
- Only the exact Mini completion command is a submission sentinel. Accepted
  submissions settle after the exact durable tool result. Refused or impossible
  submissions terminate safely; Land-owned refusals become reported blocked
  handoffs instead of mandatory-Bash retry loops.
- Real `agent/disposed` cancellation remains terminal and is reported as a
  blocked handoff. HMR detachment must never impersonate cancellation.
