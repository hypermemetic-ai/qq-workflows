# Design

## Context

See proposal.md for the approved scope. The accepted beta source is `3a9ad6789d39d65866287303ed8ebd255c13e659`. Its x86 QA release reproduces Close opening the covered right Explorer in 3/3 final immediate-tap trials under four streams; adding 500 ms produced 3/3 correct closes. Idle immediate taps worked 3/3. In each failed trial's first 500 ms after the settled-looking drawer frame, JS was running or runnable throughout while the Android main thread mostly slept. Those are emulator routing and scheduling observations, not phone timing or proof of every reported freeze.

`mobile-panels/` already owns one normalized UI position, revision-checked gestures and React-published settled activity. UI gesture motion can precede the RN semantic commit, UI adoption and RN active publication. `presentation.tsx` enables panel/backdrop children from React `isOpen` even though their visible transform is UI-owned. The underlying center header remains touchable. Repeating a canonical target is currently idempotent, so merely enabling panel children early can allow an early Close to fail to invalidate a pending opening command.

The selected center workspace remains presentation-active behind the full-width drawer. Existing route/tab activity gates and stream-retained values can be composed with center occlusion without moving host runtime or session ingestion. Provider updates ingest synchronously host-wide; main stream events use a queued flush. Small desktop reducer/model benchmarks did not establish seconds-scale work. Existing daemon telemetry separately contains 3.7-second event-loop delays and a sampled 13.2 MiB outgoing queue without phone/type-byte attribution.

Implementation source belongs in the user-designated isolated Paseo checkout, not this planning repository. This repository owns specs, reusable QA fixtures, maintenance instructions and delivery provenance. Children use the resolved planning artifacts and edit their explicitly assigned source/fixture areas.

## Goals / Non-Goals

**Goals:** Fix first-tap panel behavior under delayed JS handoff; retain revision cancellation and native scroll/gesture correctness; quantify optional covered-center work; establish reusable controlled native interaction and remaining-stall evidence; deliver an accepted Android release in place.

**Non-Goals:** Broad framework flags or dependency changes, new native layout roots, native Suspense/freezing, protocol/history truncation, general reducer redesign, custom updater, upstream version migration or production daemon restart. A native input shield alone does not meet first-tap acceptance. CPU reduction does not substitute for interaction results.

## Decisions

### 1. Trace the existing handoff before changing ownership

Use the existing profile trace API for bounded labels containing only panel enums, revisions and accepted/rejected decisions. Mark gesture semantic commit, active publication, rendered input policy and Close/row/Explorer handling. Correlate them with native motion/input/Fabric and thread scheduling. React commit observations alone are not proof of native hit-test property application; preserve that distinction in the report.

Prefer these few profile markers over broad logging or new native profiler infrastructure. Use existing transport markers for sizes and handler timing; add targeted provider ingestion/queued-flush markers only where needed to separate later JS work. Avoid private content and unconditional diagnostic timers.

### 2. Separate visible input ownership from settled presentation activity

Preserve the single UI position and mounted native hosts. Derive compact native input coverage from the same geometry that paints the retained panels, while keeping settled activity/accessibility publication and revision validation. The explicit panel interaction command path must invalidate an older opening intent even when the durable store still says center, without allowing stale callbacks to replace the newer command.

Add delayed-open/early-Close, delayed-open/row-navigation, canceled gesture and newer-command model regressions in existing suites. The child resolves the narrow implementation using the trace and existing transition model, and presents its concrete diff before native candidate packaging. Keep desktop and noncompact behavior unchanged. Do not remove the existing draggable reattachment correctness patch merely because it may contribute cost.

Alternatives rejected: a fixed delay, always-auto panel touches, center shielding alone, framework hit-test flags, remounting hosts or replacing the navigation/panel system. They either leave first-tap failure unresolved or discard existing native invariants.

### 3. Evaluate covered-center presentation independently

After the correctness candidate works, compose `RetainedPanelActivity` around shared `AgentStreamView` presentation using a stable covered-center signal from the existing compact host. The signal is always present and false when compact native coverage is inapplicable; only stream presentation consumes it. Keep the inner stream's existing ref/memo contract and native hosts. This covers main, provider-child and submitting-draft transcripts while file/diff/catalog observers, parent selectors, agent observation and session demand remain outside the gate. Keep the separate right overlay active. Existing parent activity composition and retained stream values supply suspension/resume; do not add native layout nodes or change viewed-timeline membership, incoming reducers, caches or agent lifetime.

The independent consumer audit rejected a `RetainedPanelActivity` wrapper over the whole center: it would also close live-file watchers and release checkout-diff observation. The stream boundary keeps this evaluation within covered-chat presentation without adding those subscription changes. An already queued native text reveal is not controlled by retained activity, so this candidate does not claim to suspend every form of transcript work.

Compare input-fix-only and input-fix-plus-presentation candidates under the same fixture and matched stream phase/history. Use at least three measured windows per relevant surface, recording process CPU and JS running time, input latency and environment pressure. Retain this optional delta only when gain is useful and repeatable beyond run-to-run noise, controls do not regress, and content/timer/draft restoration passes. Otherwise remove it and record rejection as the completed evaluation outcome.

### 4. Reuse the native workload as a maintenance asset

Extend the existing maintenance fixture pattern with synthetic production-like directory density, long history, four main streams, bounded provider-child events, questions and plan approvals. Use the real isolated daemon harness and normal event paths rather than an app/runtime test hook. Own one synthetic home/pairing throughout matched baseline/candidate windows; verify any persistence assumption, then clean task state explicitly.

The driver targets an explicit owned emulator serial, checks fresh settled frames separately from input outcomes, saves failure frames, measures observer overhead and records all action outcomes. Include repeated immediate Close and different-workspace selection, vertical scroll/retained offsets, submit/dismiss, keyboard and background/resume. Use at least ten immediate Close and ten alternating different-workspace selections per accepted streaming candidate, with idle controls and an independent provider-child workload. Initial baseline repetitions may be bounded once the same failure is confirmed.

Preserve accepted baseline/toolchain/native caches and use incremental JavaScript packaging. The emulator uses the already justified 6 GiB cap, 256 MiB swap, 512 tasks and two CPUs; its roughly 2.5 GiB guest plus software-renderer overhead caused reclaim at 4 GiB. Fixture and build services retain their own existing bounds. Warm-up/system-wide storage failures are excluded, with pressure/cgroup counters recorded. Do not run native builds and VM-heavy work concurrently when headroom is insufficient.

### 5. Distinguish remaining client and server stalls

Use synthetic provider/large-item bursts and queue-flush markers to attribute client JS occupancy, then compare the same local actions and server-dependent submission. Read existing production aggregate telemetry only; never copy real history, pairings or credentials into fixtures. Separate dispatch handler duration, event-loop scheduling, physical/shared-relay buffering and client processing. A pending async Git/PR request is not automatically a blocked event loop or local input gate.

Produce an explicit findings record with demonstrated mechanisms, remaining uncertainty and the next discriminating measurement. Fix additional runtime behavior only if it fits the approved bounded mobile interaction/presentation scope; broader server or state architecture work needs a separate decision. The 64 MiB socket limit is an intentional OOM backstop, not a target for speculative latency tuning.

### 6. Accept and deliver each delta separately

The handoff delta retires when upstream preserves visible input ownership and superseding commands under the same native stress checks. Any retained center-presentation delta retires when upstream supplies equivalent covered-center activity with preserved ingestion/resume. Diagnostic code remains profile-gated and bounded; keep optional allocations/caches out unless their native cost warrants another maintained delta.

Complete source checks through repo npm scripts and focused existing tests. Commit/push/PR/merge source into the established beta fork branch and integrate QA/spec/provenance through the workflow repository's PR path. Record source, release acceptance and Android installation separately. Preserve signer/package, pairings, drafts, phone preferences and zero animation settings. A disconnected phone leaves installation pending; a source merge or signed APK is not activation proof.

## Risks / Trade-offs

- Moving input ahead of settled publication can expose delayed-command races → verify superseding revisions and first-tap outcomes; retain settled resource/accessibility gates.
- React trace markers may precede Fabric hit-test application → correlate native events and actual reached handlers; label unresolved intervals.
- Center presentation gating can show stale content or elapsed status → test incoming content, wall-clock timer, draft and ordering restoration independently.
- Software-rendered emulator and shared storage distort absolute timing/CPU → repeated matched warm trials with scheduling/pressure evidence; reserve phone hardware claims for physical measurements.
- Provider bursts may stress different paths than the initial mock streams → label workload types and test both; do not generalize one result to every freeze.
- Extra maintained deltas increase update cost → use separate commits/acceptance/retirement conditions and reject optional changes without useful evidence.

## Migration Plan

Use the accepted release as baseline, package a profileable correctness candidate, evaluate the optional presentation candidate, then package and audit the retained final source for QA and production. Merge accepted source, integrate records/fixtures, install with the existing signer when ADB is reachable, and verify installed release/embedded bundle plus visible preferences and daemon/session continuity. Roll back with a compatible signed accepted APK while preserving application data if a release regression appears.
