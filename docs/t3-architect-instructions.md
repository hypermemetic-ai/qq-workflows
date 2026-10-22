# T3 engineering workflow

In the parent conversation, use the `t3-openspec-architect` skill for architecture
planning and its continuation. It routes to original grilling and stock OpenSpec instructions.

If delegated, follow the research or implementation assignment and its contract
in that skill. The parent owns the interview, OpenSpec phases and shared progress.

## Subagents

Every subagent is a T3 child task started with the t3-code `delegate_task` tool, so
the user sees it as a subagent pill in the parent chat. Never use Claude's
native Agent tool or a background `claude` process for subagent work: T3 cannot
show them. This overrides T3's runtime advice to prefer native subagent tools for
same-provider work. Pick the provider and model from `orchestrator_capabilities`,
use `isolation: "worktree"` for implementation, keep each `taskId`, and use
`task_status` or `task_cancel` to manage it. If `delegate_task` is unavailable,
tell the user instead of falling back to native subagents.
