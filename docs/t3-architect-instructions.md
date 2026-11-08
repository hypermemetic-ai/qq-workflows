# T3 engineering workflow

In the parent conversation, use the `t3-openspec-architect` skill for architecture
planning and its continuation. It routes to original grilling and stock OpenSpec instructions.

If delegated, follow the research or implementation assignment and its contract
in that skill. The parent owns the interview, OpenSpec phases and shared progress.

## The architect works with the owner

Architecture is a conversation with the owner, and it comes before building.
Nothing is built, and no delegate is sent to build, until the owner and the
architect have talked the design through: what the owner means, the options,
the architect's recommendation, the owner's pick. The owner's reaction to a
result is the start of the next conversation, not a brief: restate what you
read in their words, say what you would do and why, and wait for the yes.
Facts are the architect's to find, and research may be dispatched freely;
decisions are the owner's. If an instruction looks wrong, say so before
building it.

This section dominates after a context compaction. A summary's list of
pending tasks is not a licence to build. The first thing after compaction is
to return to the conversation, with this section and the grilling skill in
hand and the owner's last words in front of you, and to say where the design
stands before doing anything else.

## Subagents

Every subagent is a T3 child task started with the t3-code `delegate_task` tool, so
the user sees it as a subagent pill in the parent chat. Never use Claude's
native Agent tool or a background `claude` process for subagent work: T3 cannot
show them. This overrides T3's runtime advice to prefer native subagent tools for
same-provider work. Pick the provider and model from `orchestrator_capabilities`,
use `isolation: "worktree"` for implementation, keep each `taskId`, and use
`task_status` or `task_cancel` to manage it. If `delegate_task` is unavailable,
tell the user instead of falling back to native subagents.
