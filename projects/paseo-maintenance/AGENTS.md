# Paseo maintenance

Maintain a small Paseo fork that stays easy to update and responsive on the phone.
This project owns maintenance decisions and the performance patch shortlist.
Source changes belong in the Paseo checkout. Use stock Codex and OpenSpec;
implementation normally runs in a child agent while decisions stay here.
Keep these instructions project-local. Do not install a global skill or introduce
an orchestrator, custom updater, schema or patch wrapper.

## Find the current target

Read the target checkout's `AGENTS.md` and relevant `docs/` before changing it.
The existing source checkout is `/home/qqp/projects/paseo`, with fork remote
`qqp-dev/paseo` and upstream `getpaseo/paseo`; a separate beta checkout exists at
`/home/qqp/projects/paseo-beta`. Verify their current remotes and commits.
Discover the deployed app, daemon and CLI independently. A checkout, sealed
candidate or Android package version alone does not prove the running source;
account for app OTA bundles. Stable phone and beta daemon targets can differ.

Current integration intent is owned by
[OpenSpec in Paseo](../../docs/paseo-openspec.md). The beta
[README](../../patches/paseo/0.11.0-beta.5/README.md) and
[manifest](../../patches/paseo/0.11.0-beta.5/manifest.json) own its exact provenance
and Pi admission/receipt behavior. Update those owners when their target changes.
The active beta contains OpenSpec planning/child integration and a Pi delivery
correction; installed code does not establish current Pi usage. Reassess their
need against current upstream on every update. Do not copy all
downstream commits into a client fork or retain retired versions for rollback.

## Performance shortlist

Start with the status ring. Aim for one or two small behavior changes; enlarge
the scope only for a measured problem and an explicit decision.

| Change | Status | Outcome to preserve |
| --- | --- | --- |
| Status-ring animation lifecycle (`packages/app/src/components/status-ring/`) | Proposed; unimplemented | Honor selected reduced motion and retained-panel visibility. Inactive consumers detach from the shared clock through local shared values; stop the clock when no active consumer needs it. Keep status, gestures and visible animation behavior. |
| Native working-badge shimmer (`packages/app/src/components/message.tsx`) | Optional candidate; unimplemented | Use a static badge when reduced motion is requested if isolated native measurements show a useful gain. Preserve working/status meaning. |

The ring clock lacks reduced-motion and retained-panel gates. The synced loader
offers the existing per-consumer shared-value/listener pattern to follow. The
shimmer already has a panel gate and Reanimated motion reduction; reducing its
static mask work is a hypothesis to measure.

The operator's October 7 Android animation settings are all zero and must remain
so unless the operator asks to change them. Preserve operator-selected settings
on every device. Disabling animations and restarting Paseo substantially improved
the observed experience, but that combined test did not isolate either component
or explain all remaining animation callback cost.

Keep this table current. For an implemented patch, record the source commit,
reason, native verification evidence and condition for retirement in its owning
PR/spec or release manifest, and link it here. Distinguish proposed, applied and
retired changes. Remove an unnecessary delta when upstream supplies the outcome.
Avoid broad renderer/dependency rewrites and speculative framework flags. Flags
that change hit testing need measured justification and gesture/tap verification.

## Handle an upstream update

1. Establish the requested target: stable tag or beta, exact upstream commit,
   relevant checkout/worktrees/PRs, and deployed artifacts. Run
   `node /home/qqp/projects/qq-workflows/scripts/git-status.mjs` from each checkout
   being worked on at task start and before completion. Preserve unrelated work.
2. Use an isolated checkout at the pinned commit. Inventory the owned changes,
   inspect upstream equivalents, and retain only behavior still needed. Review
   existing planning/child and Pi delivery changes on their own merits; preserve
   upstream features and working consumers while resolving their ownership.
3. Reapply or adapt the necessary small changes separately. A successful patch
   application does not establish correct behavior. Keep verification fixtures
   synthetic; they are supporting evidence, not additional product patches.
4. Use the target repo's focused tests and npm lint/typecheck/format commands;
   follow its prohibition on a full local suite. Verify a synthetic long timeline,
   active streaming, idle and hidden panels, typing, scrolling, taps, native
   gestures, keyboard behavior and reduced motion. Compare repeated measurements
   on the same device and workload, controlling restarts and thermal conditions.
   Desktop results and a restart-confounded sample do not prove native causality.
5. Update the shortlist and owned provenance, then complete scoped commit, push
   and the repository's required PR/merge path. An authorized update includes
   ordinary activation needed for a usable result; explain any unfinished step
   with its owner and concrete next action.

## Preserve the usable system

Keep recordings, transcripts, profiles, app histories and credentials out of
agent/cloud inputs, fixtures and public artifacts. Preserve pairings, package and
signing identities and running agents. A different Android signing identity
requires a deliberate distribution choice; do not wipe or uninstall the Play app
to force an installation. Client performance work does not justify interrupting
the daemon. The Paseo repo requires permission to restart the main daemon on port
6767; follow that rule and preserve independent processes.

This maintenance setup authorizes no app installation or upstream/runtime update.
Make those changes when requested, with their actual target and usable outcome.
