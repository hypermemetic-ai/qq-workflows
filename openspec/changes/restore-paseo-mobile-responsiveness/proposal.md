# Proposal

## Why

The accepted Android client reproduces a workspace-list failure during streaming: the fully visible drawer's first Close tap opens Explorer underneath it, while a delayed tap works. The operator also experiences broader multi-second stalls, so restoring correct local interaction must be accompanied by workload and latency evidence rather than an animation-only CPU improvement.

## What Changes

- Correct compact native panel interaction ownership and ordered gesture/command handoff so first taps act on the visible panel during streaming and superseding close/navigation commands remain authoritative.
- Add narrow profile-build trace markers for semantic panel commits, settled publication and control handling to distinguish JavaScript scheduling from native touch commits.
- Evaluate covered-chat presentation suspension through the existing retained-activity mechanism; retain it only with repeated native benefit and correct resume behavior. Incoming state, running sessions and drafts must remain intact.
- Make the reproducing synthetic workload reusable in local Android QA, including different-workspace selection, scrolling, submission, long history and main/provider-child streaming. Measure interaction latency alongside CPU and preserve independent baseline/candidate provenance.
- Trace remaining freezes across client handling/queued work and existing daemon telemetry using sanitized aggregate evidence. Record demonstrated causes, competing explanations and unresolved gaps; make further runtime changes only when supported by that evidence and this bounded scope.
- Deliver accepted client changes through scoped commits, the fork PR/merge path, and an in-place Android update with the existing signer and settings.

## Capabilities

### New Capabilities

- `mobile-panel-interaction`: Input ownership and revision-safe interaction for retained compact native panels.
- `mobile-responsiveness-verification`: Reusable isolated native workloads, interaction measurements and evidence-based acceptance of responsiveness changes.

### Modified Capabilities

None. The planning repository has no durable specs yet; the accepted ring and static-status changes remain governed by their existing artifacts and delivery records.

## Impact

App work is based on accepted beta merge `3a9ad6789d39d65866287303ed8ebd255c13e659`, with source in an isolated Paseo checkout. Likely areas are `mobile-panels/`, the existing compact center host, profile tracing and retained presentation composition. QA fixtures, instructions and provenance belong to the isolated `qq-workflows` maintenance checkout.

This is an explicitly approved expansion beyond the original two-patch maintenance limit for a measured mobile defect, with independent retention/retirement decisions for each added runtime delta. It does not authorize framework flags, dependency upgrades, a broad state/reducer rewrite, protocol changes, a custom updater or a production daemon restart. No battery-saving claim is made without physical measurements.
