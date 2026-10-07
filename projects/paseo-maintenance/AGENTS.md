# Paseo maintenance

Maintain a small, responsive Paseo fork. Source changes belong in its checkout.
Use stock Codex and OpenSpec, with implementation normally in a child agent.
Keep instructions here; add no global skill, orchestrator or custom updater.

## Current ownership

Read the target checkout's `AGENTS.md` and relevant `docs/`. Source checkouts are
`/home/qqp/projects/paseo` and `/home/qqp/projects/paseo-beta`; verify their current
fork/upstream remotes and commits. Discover deployed app, daemon and CLI versions
separately, including app OTA bundles. A checkout or candidate is not live proof.

[OpenSpec integration](../../docs/paseo-openspec.md) owns the actively used
planning/child behavior; its [beta artifact](../../patches/paseo/0.11.0-beta.5/README.md)
owns exact provenance. Reassess need and upstream equivalents on every update.
Keep actively used custom behavior; delete obsolete or unused local additions.

## Small performance shortlist

Both changes are unimplemented. Start with the ring; keep one or two small
patches unless a measured problem and an explicit decision justify more.

- **Status ring** (`packages/app/src/components/status-ring/`): honor selected
  reduced motion and retained-panel visibility. Detach inactive consumers from the
  shared clock through local shared values; stop it when nobody needs animation.
- **Optional working badge** (`packages/app/src/components/message.tsx`): test a
  static native badge under reduced motion, keeping it only for a measured gain.
  Its existing panel gate and Reanimated reduction already stop animation.

Preserve status meaning, taps and gestures. The operator's Android animation
settings are all zero and must stay so unless asked to change them. The combined
animation-settings/restart test improved responsiveness but did not isolate a
component or establish the cause of remaining lag. Avoid speculative framework
flags, dependency changes or broad rewrites, especially flags affecting hit testing.

## Update workflow

1. Establish the requested stable/beta target, exact upstream commit, deployed
   artifacts and relevant dirty worktrees/PRs. Run
   `node /home/qqp/projects/qq-workflows/scripts/git-status.mjs` from each checkout
   at start and before completion; preserve other work.
2. Use an isolated checkout at the pinned commit. Inventory necessary outcomes,
   inspect upstream fixes, retire equivalent deltas and adapt only what remains.
3. Follow the repo's focused tests and npm lint/typecheck/format commands; avoid
   the prohibited full local suite. Use synthetic long timelines, streaming,
   idle/hidden panels, typing, scrolling, taps, native gestures and keyboard use.
   Compare repeated same-device/workload measurements with controlled restarts
   and thermal conditions. Desktop-only results do not prove native improvement.
4. Update owned provenance and link each retained patch's source commit, native
   evidence and retirement condition here or in its owning PR/spec. Complete
   scoped commit, push and the required PR/merge path, plus authorized activation.

Keep private data and credentials out of agent/cloud inputs and public artifacts.
Preserve running agents, pairings, package/signing identities and selected settings.
Never wipe the Play app to force a fork installation; different signing requires
an explicit distribution choice. Client work does not justify a daemon restart;
follow the Paseo rule requiring permission for the main daemon on port 6767.
Give temporary verification/previews a known owner; stop them at task end unless
explicitly retained as usable output. Preserve other owners' active processes.
