# Tasks

## 1. Claude activation

- [x] 1.1 Rewrite the installer for T3's Claude instance on Opus with a private skill profile, Codex retirement and owned launch arguments; verify with isolated installer tests.
- [x] 1.2 Replace the verifier with a Claude Code initialize probe; verify authentication, Opus availability, seven skills and full access without a model turn.
- [x] 1.3 Update instructions, router note and documentation; remove Codex-only skill metadata.
- [x] 1.4 Link the profile instructions and enable T3's on-merge worktree cleanup; add delegate and post-merge cleanup to the router; verify with installer tests.

## 2. Integration

- [x] 2.1 Validate and sync the modified requirement, preserving unrelated requirements; archive the completed change.

## Delivery evidence

Activation from the permanent checkout follows Git delivery: run the installer,
`--check` and the verifier, then start a fresh T3 conversation.
