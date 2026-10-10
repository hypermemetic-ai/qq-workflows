# Paseo mobile responsiveness delivery record

The approved [proposal](../../openspec/changes/restore-paseo-mobile-responsiveness/proposal.md),
[design](../../openspec/changes/restore-paseo-mobile-responsiveness/design.md) and
[tasks](../../openspec/changes/restore-paseo-mobile-responsiveness/tasks.md) own
this bounded effort. Source implementation, native acceptance and Android
activation are separate outcomes. The accepted [ring](display-work.md) and
[static-status presentation](status-indicators.md) remain in place.

## Baseline and finding

The accepted source is beta merge
`3a9ad6789d39d65866287303ed8ebd255c13e659`, with presentation source
`e94e96cda0b9ce738f8b6adae2ebc7a282a6c3d5`.
The accepted x86 QA APK SHA-256 is
`ce463157e5d95b2e01f986a4c292120f66291a459959c48348be8456c89405c8`;
its Hermes SHA-256 is
`8d8254146757a09642980b21bd2b841859dcb6934124c7cb2ab8ef70afa0b4ff`.
The production package remains `sh.paseo`; QA uses `sh.paseo.debug`.

The independently verified deployed daemon and CLI are `0.11.0-beta.5`, from
release `0.11.0-beta.5-qq-openspec.3bff62b2e95b301a`. The service and process
ancestry still select the same installed server worker, with unchanged October 8
start and Node 26.7.0. The worker file SHA-256 is
`dd2152bfee060b4c9737a5a435570e51953ada72af26e31c91d641fbe8baf9f0`.
This is deployment provenance, independent of the app source and APK.

Source work uses branch `qq/restore-mobile-responsiveness` in an isolated Paseo
worktree; planning and QA use `fix/paseo-mobile-responsiveness` in an isolated
workflow worktree. The implementation child owns app source, the native child
owns the `paseo_qa` emulator and isolated fixture, and the build child owns the
generated QA/production caches and candidate packaging. Task units must record
their explicit names and resource bounds before starting; no verification unit
was running at this task's initial audit. Other checkout and storage-migration
work is preserved.

The first native window uses `paseo-mobile-responsiveness-emulator.service`
(6 GiB RAM, 256 MiB swap, 512 tasks, two CPUs) and
`paseo-mobile-responsiveness-fixture.service` (1536 MiB RAM, 256 MiB swap,
128 tasks, one CPU, bounded runtime). The reusable fixture's full initial seed
required a 512 MiB Node heap, an 8 MiB young generation and serialized lifecycle
flushes to stay within that unchanged process-tree limit. Two preparation OOMs
are excluded from app measurements. Packaging uses separately bounded units
such as `paseo-mobile-diagnostic-build-20261010.service` (9 GiB RAM,
256 MiB swap, 256 tasks, two CPUs and one native worker). Resource processing
and source checks use the repository job launcher. Sampling windows exclude
active compilation and storage-confounded preparation.

Warm emulator investigation reproduced a first-tap failure: after the list's
fully visible header matched the settled reference, immediate Close opened the
underlying right Explorer in 3/3 final four-stream trials. Another 500 ms before
the tap gave 3/3 correct closes; idle immediate taps worked 3/3. Failed windows
had the JS thread continuously running or runnable for the following 500 ms
while the main UI thread mostly slept. That supports a delayed interaction
handoff; existing traces did not identify the precise active publication versus
native touch-property commit.

The selected chat also continues presentation behind the full-width list.
Single exploratory CPU samples do not quantify the gain from pausing it.
Daemon telemetry independently recorded a 3.7-second event-loop maximum and a
13.2 MiB sampled outgoing queue, without attribution to the phone. Neither
observation proves the cause of every complete freeze.

The accepted 45-second native trace had 15.92 seconds of JS running time. Its
60 synchronous inbound frame sections totaled about 208 ms of inclusive wall
time, with a longest section of 17.48 ms. That workload did not establish a
seconds-long inbound handler; deferred queue/render work remains outside those
sections. Nested transport/provider/flush spans must not be summed as disjoint
CPU work. New bounded provider/large-item traces remain pending.

The inspected upstream main commit
`6ec663342554bb9c9b50a5e91954aa54e7eb7877` retained the settled React child input
gate and idempotent same-target command behavior in the relevant panel files.
It did not supply the proposed ordered interaction outcome. Server status detail
also awaits provider availability; its 1.5-second diagnostic timeout alone
does not isolate network delay or event-loop starvation.

The initial fixture used 16 expanded projects, 16 workspaces, 64 sessions, a
selected 60-turn starting history and four mock streams, with no provider
subagents. The reusable workload adds different-workspace selection and provider
traffic. System-wide cold-start I/O failures and an early, unconfirmed
modal-backdrop hypothesis are excluded from app evidence.

## Build preparation

The first immutable snapshot exported successfully, but source-map comparison
found duplicated helpers through logical/canonical dependency aliases and a
missing protocol-local dependency directory selecting a different semver.
Matching copied files alone did not establish an equivalent resolution graph.
That export is excluded from controlled native acceptance. Preparation now
preserves the complete canonical root and workspace-local dependency layout
without installing packages or changing app/Metro configuration.

Its optimized Hermes job exceeded the 9 GiB process-tree cap before packaging.
The previous 9 GiB QA optimizer had also failed; accepted QA bytecode came from
an earlier ARM build without a recorded peak, so a completed fresh compile under
that cap was never established. One reviewed 12 GiB optimizer stage is allowed
with the VM/fixture and other heavy checks stopped, unchanged bounded swap/tasks,
and verified host/aggregate headroom. Native packaging keeps its separate budget.
No further automatic budget increase is approved by this record. That isolated
12 GiB stage also failed at its own memory limit after about 137 seconds. Kernel
records show abrupt compiler anonymous RSS growth to approximately 12 GiB;
sampling shortly beforehand had seen about 1.5 GiB. No candidate bytecode/APK
was completed, and neither attempt changed the retained native cache. Compiler
input and successful-build provenance were reconciled before another compile.
The accepted HBC96 header's source SHA-1 matches the retained earlier raw bundle;
the prior successful ARM run had no observed systemd memory cap. The current
compiler bytes match the retained SDK copies, while the earlier successful
compiler argv was not recorded and is inferred from pinned Gradle defaults.

A guarded debugger run, inside the ordinary 4 GiB job envelope, stopped at
2.5 GiB RSS without an OOM. Its backend stack/disassembly matches initialization
of five dense liveness vectors per basic block. The generated
`safeParse_WSOutboundMessageSchema` function is about 11.8 million characters;
the accepted bytecode preserves an 8.1 MB body for it. Pinned Hermes enables its
bounded fast allocator only when optimization is disabled. A standard minified
Expo export is being evaluated before the same optimized compiler, without app,
dependency or runtime configuration changes. Any resulting native comparison
must rebuild the baseline and candidates with the same pipeline; it cannot be
presented as a matched comparison against the earlier unminified bytecode.

The first minified export completed in 276.8 seconds within
the ordinary 4 GiB job limit. It produced a 24,018,397-byte raw bundle with the
same 6,225 modules and 6,232 source-map path/content records. All 32 emitted
resource files matched exactly (Expo reports 33 asset records). The validated
transform cache is retained for compatible warm exports. This was the first
minified pass; no warm timing is established. Pinned Expo disables the supplied
reset-cache option under CI, so the effective reset was false. The validator's
text shrank substantially, but its AST branch count barely changed.

The guarded minified probe stopped before allocation: 56,226 basic blocks and
564,933 instructions require 18.49 GiB for the five rounded dense liveness
vectors alone. Existing compiler RSS was about 1.43 GiB, before allocator and
later-pass overhead. The probe itself stayed below the ordinary 4 GiB job cap
and left no compiler process or partial bytecode. Minification therefore does
not resolve the optimized compiler's resource boundary. No full compile of that
input is authorized by these results, and no candidate APK exists yet. A
read-only capacity check found the existing satellite has less physical RAM
than that allocation and no established build-job containment; nothing was
transferred or built there. Supported compiler controls are under investigation
before selecting a delivery recipe.

The corrected interaction source is committed as
`bfe5e9a749dc0d7d7ebe66ba65201d87b548f426` in
[draft source PR #3](https://github.com/qqp-dev/paseo/pull/3). It passed app
typecheck, scoped lint/format,
38 panel model/gesture/store tests and four queued-reducer tests in an independently
copied source tree with the audited physical dependency layout. The tests cover
an opening superseded by Close/navigation and a repeated dismissal overtaking
an older active-state publication. Dependency metadata stayed unchanged after
the checks. These source checks do not establish native acceptance.

The repeated fixture window verified retained server/workspace/session identity
and pairing. Mock provider history did not survive restart: the helper now
fetches the selected timeline and automatically reseeds empty history through
normal messages before readiness. The restored workload was independently
checked as 60 synthetic user rows and 120 timeline entries. Named fixture stops
left no old descendants; these preparation results are separate from action
latency acceptance.

Reusable QA functionality is verified through normal isolated daemon paths:
two provider-child descriptors and four tool-call items were returned by SDK
list/timeline queries and appeared natively; a 65,587-byte diff result was
stored normally; native question Submit/Dismiss and plan Implement/Dismiss
resolved their pending requests and returned idle. Primary history remained at
60 turns/120 entries. A repeated restart restored 12 idle and 40 closed sessions
before readiness, with pairing and IDs intact, and a graceful stop exited zero
with no descendants.

The driver saves actual destination outcomes and failure frames; its functional
run detected an eight-second workspace-selection timeout without retrying.
That run overlapped build observation and is excluded from latency acceptance.
Raw frame capture records its own interval and tap uncertainty before image
encoding. Preparation rejects stale Android hierarchy dumps and verifies the
origin workspace/session before each trial. Its bounded eight-second Perfetto
smoke trace finalized, pulled, parsed and removed the owned device files; that
observer-overlap trace is also excluded from performance claims.

An independent consumer audit found that a whole-center retained-activity gate
would additionally close file watches and release diff observation. The optional
design now places activity around shared stream presentation, using a stable
covered-center signal; those unrelated observers and session demand stay
outside. No optional runtime delta has been implemented or accepted yet.

## Delivery status

| Outcome | State |
| --- | --- |
| OpenSpec plan | Validated; implementation authorized |
| Ordered interaction source | Committed/pushed in draft PR #3; focused source checks pass; native acceptance pending |
| Profile-only diagnostic source | `dc7ef17b746e4089670a6fcd35ad420e559f82dd`; source checks passed; labels fit the native trace limit |
| Instrumented baseline and corrected native controls | Pending |
| Covered-chat presentation retention decision | Pending independent comparison |
| Provider/client/daemon attribution | In progress; broader freezes remain open |
| Final signed release | Pending |
| Production Android activation | Pending device connection and accepted release |

The phone was absent from ADB at this task's start, so this record does not
claim a freshly verified installed APK or active OTA bundle. The accepted
production activation is owned by the prior static-status record until this
release is installed and independently verified. Existing phone preferences,
pairing, signer and zero animation scales must survive the in-place update.

## Acceptance and retirement

The handoff correction must pass immediate Close and different-workspace
selection during streaming, including delayed opening superseded by newer
Close/navigation intent. Center input shielding alone is insufficient. Keep
existing gesture arbitration, retained scroll offsets and native host identity.
Retire this delta when upstream supplies equivalent visible input ownership and
ordered superseding commands under the same native regression workload.

Evaluate covered-center presentation through the existing retained activity
signal in a separate candidate. Retain it only for useful repeated native gain
with correct content, elapsed-status, draft and ordering restoration. Retire any
retained delta when upstream provides equivalent covered-center presentation
activity without changing ingestion or session lifetime. Record rejection and
remove the candidate when the acceptance condition fails.

Use the [emulator workflow](android-emulator.md) for repeated native verification.
Keep candidate hashes, stage timings, action outcomes and pressure/observer
limits beside each independent result. Private raw traces and operator data do
not belong in public Git. CPU and battery claims require their own evidence;
source integration never proves Android activation.
