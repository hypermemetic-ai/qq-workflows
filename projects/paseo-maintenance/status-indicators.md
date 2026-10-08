# Paseo static-status delivery record

The approved [presentation change](../../openspec/changes/clarify-paseo-status-indicators/design.md)
replaces motion-dependent graphics under reduced motion, keeping existing text,
elapsed timing, actions and status semantics. The original ring optimization and
rejected background-timer patch remain owned by [display-work.md](display-work.md).

## Acceptance and ownership

This follow-up resolves the operator's observed legibility problem. Native
acceptance requires intentional static presentation, correct status transitions
and interaction/timer behavior, with repeated CPU/frame checks against the
ring-only fork on an isolated Android emulator, as requested by the operator.
Emulator results do not establish physical-phone CPU or battery savings. The
original ring's physical-device evidence remains separate.

Retire the presentation delta when upstream provides equivalent deliberate
reduced-motion workspace and active-turn graphics with shared status colors and
no additional recurring work. Reassess it independently of ring clock eligibility
on every update.

## Source delivery

The presentation source is [commit e94e96cda](https://github.com/qqp-dev/paseo/commit/e94e96cda0b9ce738f8b6adae2ebc7a282a6c3d5)
in [PR #2](https://github.com/qqp-dev/paseo/pull/2), targeting the existing beta fork.
It merged as `3a9ad6789d39d65866287303ed8ebd255c13e659`; the merge tree matches
the audited source exactly. The primary beta checkout was fast-forwarded to this
merge, preserving its pre-existing untracked index directory.
The four-file runtime patch contains 62 additions and 5 removals: a complete native
reduced-motion ring outline, a static chat dot, existing status/permission wiring
and a screen-reader label. It adds no visible text, clock, timer or subscription.
The generic loader, accepted ring clock, footprint and containing controls are
unchanged.

The pinned source base is the installed ring-only beta fork at
`1ff50151c19ca8d870ded2727e8ed3c92133d041`, based on upstream
`0.11.0-beta.5` / `15d774d4a17c69bc0f8a62a85842764fab3c038d`. Upstream main
was checked at `99fc204c55c8c1666477282eeba562ba87a3135f`; these source areas
contain no equivalent presentation change. The isolated source worktree preserves
the previous ring branch and both primary checkouts' existing index directories.

Thirteen existing status-derivation checks, app typecheck, targeted npm lint,
formatting and formatting checks passed. The accessibility correction was followed
by another affected-source typecheck/lint/format check; the unchanged derivation
suite was not repeated. No full local suite was run.

## Native and Android delivery status

Native acceptance, source merge and installed activation are complete. The
production phone APK was pulled after the in-place update and matches the signed
candidate exactly (`bc6978fb9709437896e1f800d590bf4926078126ee9b8995feb47c591e309423`).
The production Android client was then cold-started to load the bundled change.
Its durable signer, app ID, data directory and first-install timestamp are
preserved, retaining pairing and phone-preference storage. All three Android
animation scales remain zero. The optional visible-preference reread was stopped
when the phone focus guard found another window; no older preference values were
restored over current values. Android 17 reports `appId` rather than `userId`;
the delivery observer was corrected without repeating the successful install.
A fresh read-only daemon checkpoint
matches its prior identity, beta version and configured endpoint. All 47 agent IDs
from this task's checkpoint remain present after the operator's unrelated host
recovery. The final checkpoint contains all 47 original task agent IDs (50
current), with unchanged daemon identity, beta version, endpoint, start time and
supervisor/worker processes. Private settings/session checkpoints remain local;
no main daemon was restarted for client work.

Delivery uses an in-place `sh.paseo` update with the existing durable fork signer,
preserving pairing and phone preferences while projects/sessions remain on the
existing daemon. The all-zero Android animation policy stays selected.

## Build and comparison provenance

The matched QA APKs are native x86_64 `sh.paseo.debug` release builds. A parent
audit confirms their 1,441 other payload entries are byte-identical, including
manifest, DEX, native libraries and resources. Only `assets/index.android.bundle`
differs. The baseline bundle matches the installed ring-only production bundle.
The candidate bundle matches its audited ARM64 comparison and production builds.
Both QA and production APKs are profileable, non-debuggable, use normal modules,
version code `11000` and Hermes bytecode v96.

| Signed artifact | SHA-256 |
| --- | --- |
| Ring-only x86_64 QA | `2fc7f4ec98b70b470bdb2c9d0f328b924dffbc3b1c895706acf5c72e2c5fe982` |
| Static-status x86_64 QA | `ce463157e5d95b2e01f986a4c292120f66291a459959c48348be8456c89405c8` |
| Static-status ARM64 production | `bc6978fb9709437896e1f800d590bf4926078126ee9b8995feb47c591e309423` |

Baseline Hermes SHA-256:
`43c7ab78bbde9b90a13cf8756d08352e539a0c03a89800701b82b82dec7e6d1c`.
Candidate Hermes SHA-256:
`8d8254146757a09642980b21bd2b841859dcb6934124c7cb2ab8ef70afa0b4ff`.
All signed artifacts use the existing fork certificate SHA-256
`486587a12a3881dbc25a8fc63fdb8f740cfd8695a0f567a39fd0f51267fab734`.

Production uses `sh.paseo`, ARM64 and the private Firebase configuration; compiled
Firebase resource values were checked privately. Its manifest and DEX match the
installed baseline, preserving the disabled OTA policy. Nine rebuilt native
libraries differ only in GNU build IDs; every other ELF section, including code,
data and layout, matches. No temporary compiler asset is packaged.

Native builds used one Gradle worker, one compile/link job, two host CPUs, a
9 GiB RAM cap, 256 MiB swap and 256 tasks. An interrupted Hermes optimizer pass
was excluded; packaging reused already audited architecture-independent bytecode
after proving unchanged source/configuration/compiler inputs. The fresh x86_64
raw JavaScript and cached production raw JavaScript matched exactly (48,953,334
bytes). A SHA-guarded bundle task remains in Gradle's graph. The
[owned build helper](fixtures/build-unsigned.gradle) passed clean candidate and
baseline packaging; no APK/runtime packaging flag was changed.

## Reusable native setup

The [emulator workflow](android-emulator.md) is the default client-update QA
pipeline, including its bounded build helper and maintained synthetic fixture.
The retained Google APIs API 36 x86_64 image revision 7 runs on emulator 37.2.12,
KVM, SwiftShader/GLES with Vulkan disabled, two cores and 2048 MiB guest RAM.
The display is 720 × 1616 at 280 dpi (the original 411 × 923 dp layout).
The owned VM has a 4 GiB RAM cap, 256 MiB swap, 512 tasks and CPU affinity 4–5.
It uses native x86_64 libraries without ARM translation.

The translated ARM64 launch failed before React because SoLoader chose an x86_64
library path. An initial 256-task VM later failed to create a QEMU thread during a
reinstall; the corrected VM runs above that old limit with no task-limit events.
Failed preparation runs and an initial APK containing an empty temporary compiler
asset were excluded. Near-cap VM memory includes reclaimable guest disk cache;
pressure/OOM counters were checked instead of repeatedly enlarging its RAM budget.

The fixture creates one synthetic workspace, three mock agents and 60 completed
turns. Native controls/captures always target the separate QA package and isolated
loopback daemon. Real projects, agents and phone data are not test inputs. Raw
screenshots, connection/settings checkpoints and detailed logs stay private.

## Native acceptance: 2026-10-08

Three ten-second samples per artifact per surface were collected in interleaved
candidate/baseline order, restarting the QA process each trial with seven seconds
of chat warmup and three seconds after opening the workspace sidebar. The same
two ongoing synthetic thirty-minute streams were used. Every foreground probe
was true; all three animation scales were zero. Build jobs had exited. VM
task-limit events remained zero, with no OOM and negligible memory pressure.

| Surface / artifact | CPU ticks, three samples | Median CPU, one emulated core | Rendered frames, three samples |
| --- | --- | --- | --- |
| Chat / ring-only | 331 / 362 / 345 | 34.43% | 94 / 119 / 95 |
| Chat / static-status | 348 / 352 / 348 | 34.74% | 115 / 112 / 116 |
| Workspace sidebar / ring-only | 376 / 331 / 365 | 36.45% | 178 / 151 / 153 |
| Workspace sidebar / static-status | 348 / 363 / 374 | 36.15% | 150 / 170 / 172 |

Android process ticks use 100 ticks/second. CPU and frame ranges overlap; the
candidate adds no animation cycle. Frames include streaming content beneath the
sidebar, not just the static mark. Software-renderer jank varied substantially
(chat 60–93 janky frames per sample), so this establishes preserved recurring
resource use within the VM, not physical action latency or battery savings.
The presentation patch is retained for approved legibility, without claiming
additional CPU savings over the accepted ring.

Native light/dark captures confirm complete blue workspace outlines with center
dots and deliberate chat dots: blue while working and amber for pending input.
Existing elapsed metadata, fork/rewind controls and completion visibility remain.
Typing with the native keyboard, Send, synthetic plan Dismiss, question option
selection and Submit, conversation rewind/draft recovery, session switching,
long-timeline scrolling, bottom-sheet drag dismissal and tapping the workspace
ring all pass. No visible status label was added.

The final controlled background check held a synthetic approval pending: over
10.016 seconds it rendered zero frames with every foreground probe false. On
resume, the same turn's timer advanced from 7s to 20s over 13.432 seconds of wall
time. Native timer suspension and wall-clock refresh pass without a second timer
patch. Earlier OCR failures were observer errors and supplied no resume verdict;
the successful check combined split minute/second spans and used a stable pending
turn. Main daemon and real agents were not test inputs.

The fixture was left running during later source/installation delivery and hit
its 1536 MiB service budget at 07:34:28 UTC, after all accepted native evidence.
That later resource intervention supplied no acceptance evidence. The reusable
workflow now starts fixtures after APK readiness, bounds each QA window and stops
them before delivery. The emulator, fixture and QR helpers are stopped; owned
device XML, copied source helpers and expired QR credentials were removed. The
SDK, stopped AVD, build caches, private artifacts and durable signer are retained
for subsequent updates.
