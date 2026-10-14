# Proposal

## Why

T3's architect ran on a dedicated Codex profile, and T3 itself defaulted its
text generation (commit messages, branch names, thread titles) to Codex. The user
requests Claude Opus for this work and removal of the Codex integration.

## What Changes

- Configure T3's `claudeAgent` instance as the OpenSpec Architect on
  `claude-opus-5-5` for new threads, with `claude-haiku-5-5` for T3's
  one-shot text generation.
- Load the unchanged OpenSpec core skills and the adapter from a private profile
  added to each session through launch arguments; the Claude login and
  configuration are reused, not copied.
- Disable T3's Codex provider, removing only the settings the Codex profile
  installer owned. Codex conversation history stays on disk.
- Link, rather than copy, the profile instructions so source edits apply
  without reinstalling.
- Leave no Git residue: T3 removes worktrees of merged pull requests, and the
  architect deletes merged branches and integrated delegates' worktrees.
- Replace the Codex app-server verifier with a Claude Code initialize probe that
  makes no model turn; drop Codex-only skill metadata.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `t3-openspec-architecture`: T3 activation targets the Claude provider on Opus
  and retires the Codex provider; delegation and delivery clean up their
  worktrees and branches.

## Impact

The installer, verifier, installer tests, profile instructions source, router's
skill location note and operational documentation change. The grilling source,
OpenSpec core skills/schema, phase ownership, delegation contracts, project files
and the Pi/Paseo machinery remain unchanged.
