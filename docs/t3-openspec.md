# OpenSpec Architect in T3 Code

T3 runs the architect on Claude Code with Claude Opus 5.5 (`claude-opus-5-5`).
Architecture planning follows the byte-original, pinned Matt Pocock grilling
instructions: whole-frontier rounds, recommended answers, delegated fact-finding
and engineer confirmation. OpenSpec supplies the change artifacts and maintained
specifications. T3's Codex provider is disabled.

All custom integration is in [the phase/role router](../skills/t3-openspec-architect/SKILL.md).
The short profile instruction points to it. The router selects the original
controller for each phase; it does not rewrite its interview or confirmation rules.

| Phase | Original source | Owner |
| --- | --- | --- |
| Architecture interview | `references/grilling.md` (pinned upstream) | Parent architect; research agents return factual evidence |
| Capture/revise | Stock `openspec-propose` / `openspec-update-change` | Parent architect |
| Apply | Stock `openspec-apply-change` | Parent architect; implementation agents return commits and checks |
| Sync/archive | Stock `openspec-sync-specs` / `openspec-archive-change` | Parent architect |

`openspec-explore` remains available for standalone use, but is excluded from
this grilling round. Some projects advertise their own OpenSpec skill copies;
phase routing applies regardless of discovery location. Neither the global core
collection nor project-local source files are patched.

Start a fresh **OpenSpec Architect** conversation in the selected T3 project:

> Use /t3-openspec-architect to plan [change]. Discuss the architecture with me
> and produce the OpenSpec proposal, delta specs, design and tasks.

Follow grilling's completion confirmation and the stock capture skill's handoff.
After the proposal is presented, request implementation when ready:

> Implement and deliver this change. Delegate the work and review the results.

The parent runs the OpenSpec workflows and stays the architect. Research agents
return evidence without project edits. Implementation agents receive task IDs,
context, ownership and acceptance criteria, with separate worktrees for independent
tasks and permission to edit, test, fix and commit their assignments. The architect
reviews actual diffs and acceptance evidence,
integrates accepted commits, syncs the deltas into maintained specs, and archives
the change. Implementation, updated specs and archive land through the project's
normal Git/PR path together. An archived change on an unmerged branch is still
pending delivery.

New T3 threads default to Opus, worktrees and full implementation access. Those
access settings do not authorize coding during a planning-only request. Use the
normal write-capable interaction mode for planning artifacts; Claude plan mode is
read-only. Existing threads need a fresh conversation to load the profile.
Projects with an OpenSpec root use their existing schema and any configured
store. Projects without one need OpenSpec initialization when adopting this
workflow; the installer does not initialize every project indiscriminately.

## How the profile is wired

T3's `claudeAgent` instance keeps the normal Claude Code login, settings and
global instructions in `~/.claude`; the installer never writes there. A second
Claude config directory is deliberately avoided: Claude Code locks and refreshes
its OAuth credentials per config directory, so two homes sharing one login would
race on token refresh.

The private profile `~/.t3/claude-architect` holds `.claude/skills` links to the
six unchanged OpenSpec core skills plus the adapter, and an `instructions.md`
link to [the T3 instructions](t3-architect-instructions.md). The instance's
launch arguments add it to every session:

```text
--add-dir ~/.t3/claude-architect --append-system-prompt-file ~/.t3/claude-architect/instructions.md
```

Claude Code discovers skills under an added directory's `.claude/skills` with
their original names, and appends the instructions file after T3's own runtime
instructions. T3's `full-access` runtime mode maps to Claude's
`bypassPermissions`. Subagents run as T3 child tasks through the t3-code
`delegate_task` tool, which T3 shows as subagent pills in the parent chat;
the instructions forbid Claude's native Agent tool, whose subagents T3 cannot show.

T3 settings select `claude-opus-5-5` as the default thread model. T3's own
text generation (commit messages, pull request text, branch names and thread
titles) is a separate one-shot model setting; it uses `claude-haiku-5-5` at low
effort. T3 otherwise defaults text generation to Codex. The instance's
auto-compact window is 300,000 tokens, well below Opus's 1M-token context. The `codex`
instance is kept with `enabled: false`, because T3 enables an unconfigured
default Codex instance.

Work leaves nothing behind. Each change runs on its thread's worktree branch and
lands through a pull request. T3's storage cleanup has `worktreeOnMerge`
enabled: once the pull request is merged, T3 removes the thread worktree unless
it has uncommitted changes. T3 does not delete the branch, so the architect
deletes the local branch after the merge, and removes each delegate's worktree
and branch once that delegate's commits are integrated or rejected.

Implementation delegates use `delegate_task` with `isolation: "worktree"`, which
starts each delegate's checkout from the parent's current local commit and runs
project setup; uncommitted edits are not copied. The architect commits what a
task builds on, names that commit as the task's base, and reviews the
delegate's diff from it. A delegate whose worktree does not start at the named
base resets to it before working.

## Install and verify

Install from the permanent, landed qq-workflows checkout. Skill links depend on
that checkout remaining present; do not activate from a disposable worktree.

```bash
cd /home/qqp/projects/qq-workflows
/home/qqp/.local/bin/qq-job -- python3 scripts/install-t3-openspec.py
python3 scripts/install-t3-openspec.py --check
/home/qqp/.local/bin/qq-job -- node scripts/verify-t3-openspec.mjs "$PWD"
```

The installer preserves unrelated T3 settings, provider instances and Claude
launch arguments. On a machine set up by the earlier Codex installer it removes
only the Codex settings that installer owned (the dedicated home, setup mode and
binary path, and the provider display name) and disables Codex. The old Codex
profile `~/.t3/codex` and its conversation history are left on disk. Conflicting
links, unowned profile files and conflicting `--add-dir` or
`--append-system-prompt-file` launch arguments are refused before writes. Changes
to owned files receive private backups under `~/.t3/backups/t3-openspec-architect-*`
with a restoration manifest. No credentials are read, printed or committed.

The skills and instructions are links, so edits to their sources apply to new
sessions without reinstalling. `--check` reports drift without writes. The verifier checks T3's settings, then
starts Claude Code with the instance's profile arguments in each workspace and
sends only the initialize control request. That reports the account, whether it
offers `claude-opus-5-5` and `claude-haiku-5-5`, all seven discovered skills and the effective
permission mode. It makes no model turn. Multiple workspace paths may be supplied.

T3 watches `~/.t3/userdata/settings.json`. If a particular version does not adopt
the new settings immediately, restart `t3code.service` when its threads are idle.
The existing listening address and project registry are unchanged.

## Roll back

Restore `~/.t3/userdata/settings.json` from the private backup recorded in the
installer's `manifest.json`; that re-enables the Codex profile when it was the
prior state. Start fresh threads. Without a backup, re-enable the `codex`
instance in T3's provider settings and remove the installer's `claudeAgent`
launch arguments, display name and model selections. The architect profile can
remain unused. Do not delete `~/.claude` or the login.

Conversations started on Codex remain in T3's history and `~/.t3/codex`, but
cannot continue while the Codex provider is disabled. Delete `~/.t3/codex` only
when that history is no longer wanted.

## Validation

T3's service task limit includes threads in Claude Code, MCP servers, Git, and its
own Node processes. `spawn ... EAGAIN` together with an increasing cgroup
`pids.events` maximum counter indicates exhausted task capacity, independently
of provider authentication or storage paths. On qq-box, the 256-task limit was
exhausted by three provider processes and their MCP children. A bounded 512-task
limit supplies launch headroom. Apply a service property change without
restarting active conversations, and verify a new initialize probe using the
verifier above.

```bash
/home/qqp/.local/bin/qq-job -- python3 tests/t3-openspec-install-test.py
openspec validate --all --strict
```

Installer tests exercise isolation from the Claude home, idempotence, provider
preservation, migration from the Codex profile, launch argument ownership,
private backups and ownership conflicts. Independent review checks the router
against the source handoffs and evaluates planning and delegated roles. Source
hashes verify the original grilling content; native discovery and installation
checks verify activation.
