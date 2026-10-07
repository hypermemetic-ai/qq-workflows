# Proposal

## Why

Paseo's native status rings continue publishing frame updates to mounted hidden consumers and do not honor reduced motion. Small corrections to display-work lifetimes can reduce CPU use and wakeups, which is useful even when action latency does not improve; exploratory background CPU observations motivate an isolated comparison but do not establish the cause of the lag.

## What Changes

- Make native status-ring animation require an active retained panel, a foreground app and motion being enabled. Unsubscribe inactive consumers and stop the shared clock when its final eligible consumer leaves.
- After measuring the ring independently, pause working elapsed-time updates and the existing loader clock while the app is backgrounded; refresh from wall-clock time on return.
- Preserve status meaning, view identity, selected settings, taps and gestures.
- Keep at most two separately reviewable runtime patches. Treat verified reductions in unnecessary native callbacks, wakeups or CPU as useful outcomes; faster actions and measured battery savings are additional outcomes.
- Keep the plan and each retained patch's provenance, native evidence and upstream retirement condition linked from Paseo maintenance instructions for every update.

## Capabilities

### New Capabilities

- `paseo-display-activity`: Eligibility, suspension and resumption of native status animation and working-indicator timers, with evidence and update ownership for the fork patches.

### Modified Capabilities

None.

## Impact

Planning and update ownership live in `qq-workflows/projects/paseo-maintenance/AGENTS.md` and this OpenSpec change. Implementation belongs in the Paseo source fork, using stock Codex children: first `packages/app/src/components/status-ring/`, then `packages/app/src/components/synced-loader.tsx` and `packages/app/src/agent-stream/turn-footer.tsx`. Reuse the existing loader subscription pattern and app-visibility hook. No protocol, daemon, dependency, framework-flag or global-instruction changes are proposed.

The inspected source reference is upstream `0.11.0-beta.5`; native activation and signing are separate from source delivery and require an explicit distribution choice if the existing Play app cannot accept the build.
