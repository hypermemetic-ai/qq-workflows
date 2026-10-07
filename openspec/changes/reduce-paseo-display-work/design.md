# Design

## Context

The [proposal](proposal.md) and [display-activity requirements](specs/paseo-display-activity/spec.md) bound this work to two small native patches. The reported lag occurs around sending, rewinding, dismissing or submitting, and switching sessions. These patches remove display work that has no visible consumer; they do not assume that animation causes those action delays.

The inspected beta checkout is fork commit `188feb1ccbe0eac0cd8e1c630813005d6f9a519a`, based on upstream [0.11.0-beta.5](https://github.com/getpaseo/paseo/commit/15d774d4a17c69bc0f8a62a85842764fab3c038d). The installed Play app reports 0.10.3; its native status-ring implementation is identical in upstream [0.10.3](https://github.com/getpaseo/paseo/commit/b4af508e2a9e5a34a8b0ffb8dfaff6fd679da6c7). The deployed daemon and CLI are separate artifacts. None of these source references proves which candidate is live, and an app OTA bundle must be identified separately where applicable.

`status-ring/clock.ts` currently registers every mounted ring with a shared frame clock. Hidden retained consumers remain attached, and the ring does not consult reduced motion. The existing `SyncedLoader` provides a useful local pattern: per-consumer shared values, eligibility-driven subscriptions and one clock that stops after the final active consumer leaves. It already honors retained-panel activity and reduced motion, but does not gate on app foreground state. The working elapsed-time display already accepts an activity flag and calculates elapsed time from `Date.now()` when active.

Exploratory native background observations showed ongoing process work while no frames were rendered. They did not isolate a component, establish causality or measure battery savings. The combined Android animation-settings/restart experiment also did not isolate a cause. All three selected Android animation scales remain zero during this work.

## Goals / Non-Goals

**Goals:**

- Stop recurring native ring work for hidden, backgrounded or motion-disabled consumers, and stop the clock when none remain eligible.
- Stop working-indicator display clocks and timers in the background, with correct wall-clock resumption.
- Preserve native view ownership, status meaning, actions, gestures and settings.
- Retain each patch only with independent native evidence, and keep its maintenance and upstream retirement record discoverable.

**Non-Goals:**

- Rewrite rendering, Markdown, networking, action sequencing or retained-panel architecture.
- Add dependencies, speculative framework flags, global instruction machinery or a new lifecycle service.
- Change daemon operation or Android settings, or perform an unreviewed signing transition or local-data loss during the authorized Android replacement.
- Claim faster actions or longer battery life from source inspection or desktop measurements.

## Decisions

### 1. Make the native ring's eligibility explicit

In `packages/app/src/components/status-ring/`, combine the existing retained-panel activity, app-visibility and reduced-motion hooks. A ring is eligible only when the panel is active, the app is foregrounded and motion is allowed. The policy follows the app's selected reduced-motion behavior and existing platform hook; it does not change system settings.

Give each consumer a local shared rotation value. Eligible consumers subscribe to the shared clock; ineligible consumers detach, so hidden animated styles do not receive its frame updates. Registration and cleanup must be idempotent across rapid visibility changes and unmounts. The final eligible consumer stops scheduling the loop, allowing at most an already scheduled callback to complete teardown. Multiple eligible rings share one loop.

When eligibility returns, initialize rotation from the current wall-clock phase before receiving updates. Keep the running arc recognizable when static. Preserve the containing native views and controls. This adapts the existing loader pattern locally rather than introducing another clock abstraction or suspending native subtrees.

Gate-only alternatives would leave hidden consumers attached to a running shared value. Unmounting or freezing the containing panel would conflict with retained native identity and interaction rules. Independent clocks would increase scheduling and lose synchronization. These alternatives are rejected.

### 2. Gate existing working-indicator lifetimes on foreground state

Only after the ring has an isolated native comparison, add `useAppVisible` to `packages/app/src/components/synced-loader.tsx`. Combine it with the existing panel and reduced-motion gates; preserve its shared-clock and local-subscription behavior.

In `packages/app/src/agent-stream/turn-footer.tsx`, combine app visibility with panel activity before passing activity to the existing elapsed-time display. Its current suspension and wall-clock refresh behavior can then be reused. Do not broaden the generic message component unless a focused implementation finding shows that this is necessary to satisfy the requirements.

These are display subscriptions only. Backgrounding does not cancel agent work or change daemon connections. The existing app-visibility hook supplies lifecycle state; no new persistent listener infrastructure is needed.

### 3. Evaluate the patches separately on native Android

Establish the requested stable or beta target, exact upstream base, fork changes and installed app/bundle before implementation. Use an isolated source checkout and compare equivalent builds on the same device with the same Android settings, workload, restart procedure and thermal conditions. The operator explicitly selected replacing the Play Store app with the production-package fork client. Establish the signing transition, a durable fork key and a concrete local-data transfer or recovery procedure before removing the existing app. Unrecoverable data loss needs its own explicit decision. Preserve an identified compatible rollback artifact.

Use at least three repetitions per compared condition. Compare baseline with the ring patch, then the accepted ring baseline with the working-indicator patch. Include synthetic long timelines, idle and running states, streaming, hidden retained panels, background/foreground cycles, typing, scrolling, taps, native gestures, keyboard use and the reported actions. Measure first feedback and operation completion separately: rewind includes awaited server work that must not be mistaken for indicator scheduling cost. Exercise destructive-looking actions only in synthetic sessions owned by the verification task.

Prefer existing native profiling and trace support. A narrow temporary probe may verify active-consumer counts, recurring callbacks and resume behavior; remove task-only probes before delivery. Verify no eligible consumer means no recurring loop, hidden consumers receive no updates when another consumer is active, and foreground resumption is current and synchronized. Callback elimination or lower wakeups/CPU is sufficient resource evidence if interaction and resume checks pass. Report action latency honestly even if unchanged. Battery claims need actual comparable battery-consumption measurements.

Run focused lifecycle checks plus the checkout's required lint, typecheck and format commands. A meaningful lifecycle test should cover multiple consumers, the final consumer leaving, rapid eligibility changes and resumption; avoid tests that merely restate implementation details. The prohibited full local suite is outside this work. Desktop checks support correctness but do not substitute for native evidence.

### 4. Keep two independent patch records visible during updates

The entry point is `projects/paseo-maintenance/AGENTS.md`, linked to this change. Keep source implementation in the Paseo fork, normally through a child agent, and use one separately reviewable runtime commit per retained patch. This planning commit does not implement either patch.

| Patch | Source area | Source commit and native evidence | Retirement condition |
| --- | --- | --- | --- |
| Native status ring | `components/status-ring/` | Pending implementation and isolated native comparison | Upstream honors motion, panel and app eligibility, detaches inactive consumers and stops its final-consumer clock while preserving synchronization and interactions. |
| Background working indicators | `components/synced-loader.tsx`, `agent-stream/turn-footer.tsx` | Pending implementation and comparison against the accepted ring baseline | Upstream suspends both loader and elapsed display work in the background and resumes from current time with existing panel/motion behavior intact. |

Fill each record with its exact source commit, upstream base, verification artifact, measured outcome and retirement condition. Link those records from the maintenance entry point before delivery. On each update, inspect upstream independently for both outcomes, drop equivalent local deltas and adapt only what remains. If a candidate lacks resource evidence or regresses interactions, do not record it as an accepted patch. Archiving this change includes updating the maintenance link to the durable spec, archive or owning patch record.

The static working-badge alternative remains deferred because its existing panel gate and reduced-motion handling already stop animation. Other candidates require a measured problem and a separate explicit scope decision.

## Risks / Trade-offs

- **Eligibility transitions can race with queued worklets.** Make subscription cleanup idempotent, prevent duplicate loops, and exercise fast panel/app transitions and the final-consumer boundary.
- **Static rings could lose recognizable status meaning.** Keep the existing arc and verify every status visually with motion disabled and through resumed animation.
- **Background CPU has multiple possible sources.** Require per-patch comparison and callback evidence; do not attribute the exploratory totals to these components.
- **A newer source build can confound the Play baseline.** Compare the same pinned source/build configuration with only the candidate patch changed; identify installed versions separately.
- **Signing may prevent an in-place update.** Prepare a reviewable source candidate and verification plan, verify certificate compatibility and data recoverability before removal, and leave acceptance pending until the authorized replacement path is usable.

## Migration Plan

No daemon restart is needed. Implement and verify in an isolated pinned source checkout, deliver scoped commits through the fork's required PR/merge path, and record native acceptance separately from source delivery. The requested finish line is an Android app swap replacing Play Paseo under `sh.paseo`, with pairings and selected settings preserved or restored. Verify the installed package, version, signing certificate and connectivity. Retain a durable private fork signing key for subsequent updates; keep it out of source and public artifacts.

Prefer a compatible in-place update when certificates permit it. If the fork certificate differs, establish a recoverable migration before removing Play Paseo; do not assume Android backup can restore data across signers. Capture recoverable configuration locally and keep it out of agent/cloud inputs and public artifacts. Prepare baseline and patched clients with the same fork key and build configuration for native comparison. If data cannot be preserved or restored, present the concrete candidate and affected data for an explicit loss decision before removal; candidate delivery alone does not complete this change.

Each patch can be reverted independently in the app source and rebuilt using the same fork signing identity. A regression returns to the prior compatible fork app artifact without clearing app data; returning to the Play signer requires its own recovery procedure. Stop temporary verification processes owned by this task and run the Git-status helper from worked checkouts before finishing.
