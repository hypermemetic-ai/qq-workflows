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

## Small performance plan

The active [OpenSpec design](../../openspec/changes/reduce-paseo-display-work/design.md)
and [implementation tasks](../../openspec/changes/reduce-paseo-display-work/tasks.md)
own the agreed scope, independent native evidence and per-patch retirement
conditions. The [delivery record](display-work.md) tracks source, native acceptance
and Android activation separately. The ring is accepted, merged and installed on
Android. The optional working-indicator source patch was rejected after the
existing native background and resume checks passed. Keep at most two small
runtime patches unless a measured problem and an explicit decision justify more.

- **Status ring** (`packages/app/src/components/status-ring/`): honor selected
  reduced motion, retained-panel visibility and app foreground state. Detach
  inactive consumers from the shared clock through local shared values; stop it
  when nobody needs animation and resume at the current shared phase.
- **Background working indicators** (`packages/app/src/components/synced-loader.tsx`
  and `packages/app/src/agent-stream/turn-footer.tsx`): reevaluate existing native
  suspension and wall-clock refresh before adding a patch. The current runtime
  passes under the selected motion policy; no second source patch is retained.

Verified reductions in unnecessary native callbacks, wakeups or CPU are useful
even if action latency is unchanged. Claim battery savings only when measured.
The approved [static-status follow-up](../../openspec/changes/clarify-paseo-status-indicators/design.md)
addresses reduced-motion legibility in the workspace ring and chat graphic,
without new visible labels or changes to the existing timer. Its separate
[delivery record](status-indicators.md) owns source, native resource checks and
Android activation. Acceptance requires legibility and preserved resource use;
additional CPU or battery savings are not presumed. This explicit presentation
decision does not reopen the rejected background-timer patch.

## Mobile responsiveness effort

The approved [design](../../openspec/changes/restore-paseo-mobile-responsiveness/design.md)
and [tasks](../../openspec/changes/restore-paseo-mobile-responsiveness/tasks.md)
own the measured workspace-list interaction correction, independent covered-chat
presentation evaluation and remaining-freeze attribution. Its
[delivery record](mobile-responsiveness.md) separates source, native acceptance
and Android activation. Durable
[input](../../openspec/specs/mobile-panel-interaction/spec.md) and
[verification](../../openspec/specs/mobile-responsiveness-verification/spec.md)
contracts preserve the regression requirements for future updates.
This is the operator's explicit expansion beyond the
original two-patch limit for a reproduced defect; retain each added runtime delta
only with its own acceptance and upstream retirement condition. First-tap Close
and different-workspace selection must work during streaming. Blocking covered
controls alone does not satisfy the interaction outcome.

The shared-stream presentation gate is retained after repeated covered native
CPU reductions and settled content, elapsed-status, draft and ordering restoration.
It preserves live ingestion and leaves file/diff/catalog observers outside its
boundary. Reevaluate it independently on updates, including its small observed
idle cost; reject it without useful repeated native benefit. Use the reusable
native workload for subsequent relevant changes; CPU savings do not establish
faster interaction or measured battery gain.

## Android delivery

The selected delivery outcome includes replacing the existing Android
Play Store client under the production package. Record any initial signing
transition and keep the fork signing key stable for later updates. Verify a
concrete pairing/settings recovery path before removing the existing app; any
unrecoverable local-data loss requires an explicit operator decision. A source
merge alone is not completed Android delivery.

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
   Review the linked performance plan and each retained patch independently;
   upstream may replace either outcome without replacing the other.
3. Follow the repo's focused tests and npm lint/typecheck/format commands; avoid
   the prohibited full local suite. Start native client QA with the reusable
   [Android emulator workflow](android-emulator.md). Use synthetic long timelines, streaming,
   idle/hidden panels, typing, scrolling, taps, native gestures and keyboard use.
   Compare repeated same-device/workload measurements with controlled restarts
   and thermal conditions. Reserve physical-device testing for hardware behavior
   or physical CPU/battery evidence; keep emulator measurements labeled. Android
   activation is separate from routine emulator QA.
4. Update owned provenance and link each retained patch's source commit, native
   evidence and retirement condition here or in its owning PR/spec. Complete
   scoped commit, push and the required PR/merge path, plus authorized activation.
   When archiving a plan, update this entry point to its durable spec, archive or
   owning patch records so subsequent updates can still find every retained patch.

For compatible JavaScript/TypeScript-only tweaks, follow the runbook's
[small-change turnaround](android-emulator.md#small-change-turnaround): reuse the
retained toolchain and native caches, avoid unconditional clean prebuilds, and
use upstream's development-client/Metro workflow for iteration once its local
setup is verified. Compile one fresh release bundle, reuse it only with audited
matching inputs, and complete focused native release checks before activation.
Repeat controlled benchmarks when performance/recurring work changes or the
active plan requires them. Record stage timings; distinguish warm packaging from
a fresh bundle and full delivery. This policy belongs here and in the runbook;
add no app runtime patch or custom updater to accelerate development.

Keep private data and credentials out of agent/cloud inputs and public artifacts.
Preserve running agents, pairings, package/signing identities and selected settings.
Never wipe the Play app to force a fork installation; different signing requires
an explicit distribution choice. Client work does not justify a daemon restart;
follow the Paseo rule requiring permission for the main daemon on port 6767.
Give temporary verification/previews a known owner; stop them at task end unless
explicitly retained as usable output. Preserve other owners' active processes.
