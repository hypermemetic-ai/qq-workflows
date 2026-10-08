# Proposal

## Why

Under the operator's reduced-motion Android settings, Paseo's frozen running ring and working dot grid can look stalled. Replace those motion-dependent graphics with intentional static status marks while preserving the measured ring savings and existing chat text, timer and controls.

## What Changes

- Render a deliberate static running mark in the workspace/project list under reduced motion, using the existing footprint and running color.
- Replace the chat turn footer's reduced-motion dot-grid presentation with a static status-colored mark, using existing agent status and pending permissions.
- Keep existing labels, elapsed time, footer visibility and actions; add no visible text, animation loop, timer, status protocol or preference.
- Verify native legibility, state transitions and CPU against the installed ring-only fork. Acceptance is improved legibility without recurring-work regression; no additional CPU or battery reduction is presumed.
- Track this explicitly approved presentation follow-up separately from the completed ring optimization and deliver a verified Android update with the existing fork package and signing key.

## Capabilities

### New Capabilities

- `paseo-status-presentation`: Static, theme-aware status presentation in existing workspace and chat indicators under reduced motion, without additional recurring work or visible labels.

### Modified Capabilities

None. The completed `reduce-paseo-display-work` change retains its original evidence and acceptance record.

## Impact

Source changes belong in the beta Paseo fork at `1ff50151c19ca8d870ded2727e8ed3c92133d041`, based on upstream `0.11.0-beta.5`. Expected runtime scope is the native status-ring presentation and chat `agent-stream/view.tsx` / `turn-footer.tsx`, with a small shared static visual only if necessary. Reuse `getStatusDotColor`, existing state derivation and theme tokens; preserve the accepted ring clock eligibility. The generic loader, protocol, server, dependencies and framework configuration remain outside this change.

Planning and update ownership live in qq-workflows. Implementation runs in a source child agent. Native acceptance and installed Android activation are recorded independently; the update uses `sh.paseo` and the durable fork signer for an in-place installation preserving pairing, projects, sessions and phone preferences.
