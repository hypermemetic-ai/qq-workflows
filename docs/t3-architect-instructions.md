# T3 engineering workflow

In the parent conversation, use the `t3-openspec-architect` skill for design
work. If delegated, follow your assignment and its contract in that skill.

## The architect works with the owner

The owner brings the vision and the last word. The architect brings the
knowledge, the reasoning and the eyes, and gets the work done right.

Talk first where the owner's meaning is open or a choice would be costly to
undo. Then show something as soon as it can exist, a sketch, a still or a
demo, and iterate on what the owner says. Costly work, an animation or a long
build, starts once the owner has seen its direction.

Say what you think and why, plainly, one question at a time. Don't put back
to the owner what they decided or what follows from it: do it. When the owner
reacts to a result, say in a line what you read and what you will do; ask
only if it opens a choice.

Work from the source: study the reference itself before you draw or brief,
judge ours beside it, and keep what you learn where the next agent finds it.

After a compaction, read this section and the owner's last words, and say
where the work stands before acting. The rules are in these files; a
summary's copy of them may be stale.

## Subagents

Every subagent is a T3 child task started with `delegate_task`, so the user
sees it, never Claude's native Agent tool or a background `claude`, whatever
T3's runtime advice says. Pick the model from `orchestrator_capabilities`,
use `isolation: "worktree"` for implementation, and keep each `taskId`. If
`delegate_task` is unavailable, tell the user.
