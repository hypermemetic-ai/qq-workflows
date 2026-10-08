# Design

## Context

See [proposal.md](proposal.md) for motivation and [the presentation spec](specs/paseo-status-presentation/spec.md) for behavior. The source target is the installed ring-only beta fork at `1ff50151c19ca8d870ded2727e8ed3c92133d041`. Its [completed delivery record](../../../projects/paseo-maintenance/display-work.md) owns the original CPU evidence and Android signing transition.

The native `StatusRing` already honors reduced motion, retained panels and app visibility, but still renders a frozen quarter arc. Its frame owns backdrop, size, track and center dot. Existing sidebar/project consumers already derive status and use distinct alert, filled-dot and running graphics.

The active-turn footer currently owns a `SyncedLoader`, optional fork action and `LiveElapsed`. Its loader already stops animation under reduced motion. `AgentStreamView` has lifecycle status and selected-agent pending permissions; the existing state/color helpers prioritize needs input over running. The workspace indicator aggregates multiple agents while the chat indicator describes only the selected agent.

## Goals / Non-Goals

**Goals:** Keep the display change within the existing ring and active-turn surfaces; reuse theme-tracked styles and existing state inputs; make the selected Android policy visually intentional with no new recurring work.

**Non-Goals:** New lifecycle states, persistent completed-chat status rows, new visible labels, changes to generic loaders, timer policy, status ordering, routes, dependencies, framework flags, daemon behavior or Android motion settings.

## Decisions

### Use the existing reduced-motion branch

Make the native ring's reduced-motion visual a deliberate complete outline and center mark within its existing frame, rather than a frozen quarter arc. Keep the accepted clock implementation and eligibility unchanged. This improves the static presentation without another animation strategy or changes throughout the workspace tree. Existing loading uses and backdrop consumers must be inspected so the shared change preserves their footprint.

In chat, replace only the reduced-motion graphic inside the existing working-indicator slot. Keep its placement, timing and actions. Replacing the generic `SyncedLoader` would affect unrelated loading surfaces, so the replacement belongs in the turn footer.

### Reuse state derivation and the status-dot palette

Pass the current selected-agent status bucket from existing lifecycle and pending-permission inputs into the footer. Working is blue and needs input is amber; use the existing shared mapping for all supported buckets. Do not infer every active turn is working when it has pending permissions. Preserve existing footer visibility on completion; green and muted states in workspace views keep their existing behavior.

Use ordinary native views and Unistyles styles for theme changes. Do not put theme-tracked styles on Reanimated views or add `useUnistyles()`. Reuse existing accessibility meanings or labels as metadata without adding visible text. Introduce a small shared static visual only if it reduces actual duplication; a general badge framework is unnecessary.

### Accept on legibility and resource preservation

This user-approved second presentation patch resolves an observed legibility gap. It does not reopen the rejected background-timer patch and does not require a further CPU reduction for acceptance. Compare equivalent profileable release artifacts against the accepted ring-only baseline, with at least three controlled native samples per artifact. Record actual CPU/frame results and investigate discrepancies; do not infer battery savings.

Check native static shapes and colors in light/dark themes, running and needs-input transitions, existing timer progression and background resume, workspace/session switching, taps, typing, scrolling and gestures. Retain the existing focused ring lifecycle evidence. Add focused automated checks only where new state wiring warrants them; use existing suites and npm scripts, never the full local suite.

## Risks / Trade-offs

- Static colors alone can be ambiguous → preserve existing workspace alert/dot shapes and accessibility labels, and use an intentional running outline rather than a stalled spinner.
- A workspace may have a different bucket from the current chat → preserve aggregation priority and individual-agent derivation; do not force them to agree.
- A permission update could leave a stale memoized footer → include its derived status input in existing render dependencies and verify the transition.
- A visual change can accidentally reattach a clock or disturb a touch target → preserve clock eligibility, footprint and containing controls, then verify native CPU and interactions.
- Android testing needs a fresh availability window → prepare the concrete signed candidate first and request a bounded window when ready; no unattended input into another app.

## Migration Plan

Implement in an isolated source checkout through a child agent, deliver one scoped presentation commit/PR onto the existing beta fork, and retain its exact build provenance. Prepare equivalent comparison artifacts and a production APK using the existing private Firebase configuration and durable fork key. After native acceptance, update `sh.paseo` in place, verify installed bundle/certificate, pairing/settings/session continuity and unchanged motion scales, and stop task-owned verification processes. Keep the current signed ring-only APK locally for same-signer rollback.

Maintenance links this plan and a separate delivery record with the retained presentation delta's upstream retirement condition. The previous completed change and measurements remain intact.
