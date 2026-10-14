# Design

## Profile without a second Claude home

A dedicated `CLAUDE_CONFIG_DIR` would mirror the Codex design but split the
login: Claude Code holds its credential write lock inside the config directory,
so two directories sharing one OAuth login could refresh the rotating token
concurrently and invalidate one another. The T3 instance therefore keeps the
default `~/.claude` home. Its launch arguments add
`--add-dir <profile> --append-system-prompt-file <profile>/instructions.md`.
Claude Code discovers `<profile>/.claude/skills` under the skills' original
names and concatenates the instructions file after T3's appended runtime
instructions. T3 parses launch arguments into a one-value-per-flag map, so the
installer owns both flags and refuses values that point elsewhere.

## Model and permissions

`defaultModelSelection` names the `claudeAgent` instance and `claude-opus-5-5`.
`textGenerationModelSelection` names `claude-haiku-5-5` at low effort: commit
messages, pull request text, branch names and titles are one-shot writes.
The instance's `autoCompactWindow` is 300,000 tokens: Claude's automatic window
for Opus would otherwise run sessions toward its 1M-token context. T3's `full-access` runtime mode maps to Claude's
`bypassPermissions`. Native delegation (the Agent tool) and worktree isolation
need no configuration, replacing Codex's `multi_agent` and agent concurrency keys.

## Codex retirement

T3 enables an unconfigured default `codex` instance, so the installer keeps that
instance with `enabled: false`. It removes the dedicated home, setup mode and
binary path only where they name the home recorded by the Codex installer's
ownership marker, plus the `OpenSpec Architect` display name. `~/.t3/codex` is
not deleted: it holds prior T3 conversations.

## Linked instructions

`instructions.md` in the profile is a link to `docs/t3-architect-instructions.md`
in the permanent checkout, like the skills. An owned copy from an earlier install
is backed up and replaced by the link.

## Cleanup

T3's `storageCleanup.worktreeOnMerge` removes a thread worktree once its pull
request is merged and it has no uncommitted changes. T3 does not delete the
branch, so the router has the architect delete the merged local branch and
remove each delegate's worktree and branch after integrating or rejecting it.

## Verification

The verifier checks T3's settings, then starts Claude Code per workspace with the
instance's profile arguments and sends only the stream-json `initialize` control
request. Its response reports the account, available models, discovered skills
and permission mode. Standard input closes without a user message.
