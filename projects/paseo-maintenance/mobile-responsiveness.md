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
CPU work. Completed bounded provider/large-item traces are recorded below.

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

The reusable workload's later accepted-APK baseline completed 24 clean outcome
trials. Idle immediate Close passed 2/3, delayed Close 3/3 and immediate
different-workspace selection 4/4. With four main streams, immediate Close
passed 1/3, delayed Close 3/3, immediate different-workspace selection 3/4 and
delayed selection 4/4. The failed selection left the drawer unchanged for
8.218 seconds; no tap was retried. Two failed Close taps reached Explorer.

In the first 500 ms after those failed Close taps, JS ran for 362/368 ms and was
runnable for the remaining 138/132 ms. The missed selection had JS running
209 ms and runnable 291 ms initially, but JS later slept for 6.615 seconds of
the full unchanged-drawer interval. This distinguishes persistent missed input
from eight seconds of continuous CPU blockage. Raw capture intervals, tap
uncertainty and shared-host pressure are recorded separately; these remain
emulator outcomes, not exact phone input latency or proof of a particular
native touch-property state. The fixture stopped cleanly with pairing/history
retained and no stream or profiler worker left running.

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
bounded fast allocator only when bytecode optimization is disabled. A standard
minified Expo export was evaluated before the same optimized compiler, without
app, dependency or runtime configuration changes. Any changed compiler pipeline
requires matching baseline/candidate builds and a separate comparison against
the accepted pipeline; it cannot silently replace the performance baseline.

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
input is authorized by these results. A
read-only capacity check found the existing satellite has less physical RAM
than that allocation and no established build-job containment; nothing was
transferred or built there. Supported compiler controls are under investigation
before selecting a delivery recipe.

The supported `-Og` diagnostic experiment compiled the original unminified
profile-only source in 10.30 seconds, peaking at about 2.03 GiB within the normal
4 GiB job envelope, with no swap or pressure events. Its valid HBC96 source hash
matches the audited input. Maximum frame size is 160 registers, well below the
pinned runtime limit; the validator instead has 5,515 environment slots versus
zero in accepted optimized bytecode. This setting changes runtime code quality
and was initially authorized only for diagnostic QA packaging and a separate
native comparison. That first experiment was not a production acceptance or
performance claim. The unchanged optimized build exceeds the established job
cap; the later bounded release decision is recorded below.

The diagnostic QA APK now exists: SHA-256
`3453fcf600682673315d7065ac74874b1d73d616fa90fbc21eb5e1aa41f6db62`,
with HBC SHA-256
`0c65d85ea183019c25810391eb6320b0927c82f6e4c372c16f55570735b25a37`.
A bounded incremental Gradle pass stopped at its ten-minute deadline while
hashing cached inputs; it did not produce a new native build. The subsequent
QA-only construction reused the accepted APK's native shell after proving all
32 emitted resource files equivalent: the 31 PNGs have identical decoded pixels
and dimensions, and the raw keep XML matches exactly. AAPT resource IDs and
compiled paths were checked rather than inferred from export filenames.

The construction replaced only the audited bytecode, removed the three obsolete
v1 signature entries, retained all 119 ordinary META-INF entries, aligned and
signed with the established fork key. All 1,441 remaining payload entries match
the accepted QA APK byte for byte. Package, ABI, profileability, non-debuggable
state, disabled updates, certificate and 16 KiB alignment passed audit. The
packaging job took 9.174 seconds, peaked at about 742 MiB and left no descendants.
This is audited QA shell reuse, not a fresh Gradle native build. Diagnostic
installation, runtime comparison and panel chronology were separate gates;
that artifact alone did not accept its compiler setting for production.

The native pipeline comparison completed accepted optimized → diagnostic `-Og`
→ accepted optimized drift windows. Each block used three 20-second samples
per surface, restored history/pairing, the same warm route and four streams,
with setup/capture/build observers outside the quiet intervals.

| Surface | Accepted first | Diagnostic `-Og` | Accepted drift |
| --- | --- | --- | --- |
| Idle process CPU | 1.55–1.75% | 1.45–1.65% | 1.45–1.60% |
| Selected streaming chat CPU | 65–74% | 71–77% | 70–75% |
| Covered drawer CPU | 78–80% | 57.5–60.7% | 52.9–56.7% |

Selected-chat windows delivered 808–818 frames each, with closely matched
history and throughput. Both diagnostic and drift builds received the same
124 provider-update frames and stored eight descriptors with 15 unique,
strictly ordered tool rows each, without sequence gaps or stale cursors. Both
stored four 65,587-byte UTF-8 diff results through normal daemon paths and
showed the eight working children natively. Settled Close worked in both.
Quiet windows had no memory-cap or OOM deltas. The initial covered difference
disappeared on returning to the accepted build: retained route/native state
and shared scheduler pressure confound a compiler effect. This supports further
correctness testing of the bounded build path, without establishing runtime
equivalence, a CPU reduction or battery savings. Corrected input and final
disabled-marker controls were independent delivery gates, completed below.

The selected-chat diagnostic median was about four percentage points above
the accepted return block. The accepted samples themselves varied widely,
so a small runtime penalty remains possible and is not isolated by this test.
The final marker-disabled release completed its own matched visible-stream
check below; this comparison does not establish identical compiler performance.

Small embedded-config reads confirmed that both accepted shells have
`extra.profileBuild=true`. The existing marker guard reads that runtime flag
through Expo Constants; the manifest's profileable attribute is separate.
Source/plugin audit found no other runtime behavior selected by that flag:
the runtime uses are diagnostics, while the prebuild plugin only adds the
manifest profileability entry. Final production disables markers through
the pinned normal public-config generator, with exact object equivalence
apart from that flag and its omitted serialized profileable plugin entry, plus
native controls with markers disabled. The reused native
shell remains manifest-profileable. The pinned normal generator completed
in 1.27 seconds at about 59.6 MiB and reproduced the accepted objects exactly
with profiling enabled. Disabling profiling produced exactly those two expected
metadata differences for each variant. Final artifact and native acceptance
are recorded below; this does not claim a clean non-profile native build.

The installed diagnostic reproduced wrong input routing: a Close tap after a
matched visible drawer reached Explorer, with Explorer press-in/press markers
and a newer file-explorer command, but no Close handler marker. The trace records
accepted drawer revision 9 and subsequent Explorer revision 10, alongside
React policy publication. Another immediate Workspace 02 selection left the
drawer unchanged for 8.153 seconds without a row handler marker. This completes
the bounded diagnostic handoff gate and permits correctness-candidate packaging.
Pinned React Native source maps the native event timestamp to Android monotonic
uptime. Nine Perfetto clock snapshots establish a negligible monotonic/boottime
offset over this trace without a suspend discontinuity. The wrong Explorer
event preceded the React layout-effect policy observation by about six
milliseconds, subject to the event's integer-millisecond precision. This
mapping does not prove Fabric hit-test application.
Corrected native controls, compiler selection and final release acceptance are
recorded separately below.

The corrected interaction source is committed as
`bfe5e9a749dc0d7d7ebe66ba65201d87b548f426` in
[source PR #3](https://github.com/qqp-dev/paseo/pull/3). It passed app
typecheck, scoped lint/format,
38 panel model/gesture/store tests and four queued-reducer tests in an independently
copied source tree with the audited physical dependency layout. The tests cover
an opening superseded by Close/navigation and a repeated dismissal overtaking
an older active-state publication. Dependency metadata stayed unchanged after
the checks. These source checks do not establish native acceptance.

The correctness-only QA APK is signed and audited: SHA-256
`a6d18812f0d406ae352b1a9ae2afbb2715ad19fc528310afe306b6df6d93195b`,
with HBC SHA-256
`4af82cee68eb0aee806bf8c35dbf5ac7e86fff4ecfe28ac3641845340b3f4708`.
Its fresh source graph differs only by the committed interaction correction;
assets and all 1,441 other payload entries remain equivalent to the accepted
QA shell. Fresh bytecode compilation took 11.00 seconds and packaging/signing
took 6.20 seconds. Repeated native control acceptance remains separate.

That installed APK passed all 40 required immediate-input trials, with fresh
origin/reference guards and no tap retries:

| Workload | Immediate Close | Alternating different workspace | Input-to-observed destination upper bounds |
| --- | --- | --- | --- |
| Idle | 10/10 | 10/10 | Close 213–383 ms; selection 465–862 ms |
| Four daemon streams | 10/10 | 10/10 | Close 255–588 ms; selection 925–1,313 ms |

No trial reached Explorer incorrectly, lost its action or timed out. These
upper bounds include ADB, raw capture and native route rendering; they are not
phone latency or an isolated action benchmark. Streaming transitions remain
slower than idle. A cold deep-link preparation exceeded its 15-second guard;
a standard warm relaunch reached the verified origin in 2.33 seconds. That
setup timeout and a stale selection reference rejected before any trial are
excluded from the 40 outcomes. Rapid supersession, retained-scroll, keyboard,
submission and resume acceptance are recorded separately below.

Six rapid gesture/Close probes recorded accepted opening gestures and remained
at center. Five have explicit Close handler markers; one has an unproven control
recipient and is not counted as a marked Close. Three traces independently
show the newer center command overtaking the older queued sidebar publication,
which is rejected against the current revision. For example, opening revision
93 was rejected after Close selected center revision 94, and center publication
94 was accepted. This proves revision supersession without claiming a Fabric
commit timestamp. Vertical drawer scrolling remained usable and its retained
viewport matched exactly on reopening; the long-chat viewport also matched
exactly. Opening the drawer dismissed the keyboard, and the actual draft
survived drawer navigation and idle home/resume. Native question Submit/Dismiss
and plan Implement/Dismiss removed their prompts and were independently
confirmed idle through the normal SDK. These complete core native acceptance.
Active timer/provider/file/terminal restoration was evaluated separately on the
optional candidate, as recorded below.

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
outside. The independently identifiable evaluation source is
`7427afe834ab711da42bc798d8f4b8c165f8a634`, three files with 49 additions and
three deletions on the accepted core fix. It preserves the single existing
stream memo comparator, forwards the imperative ref through a permanent React
activity boundary, and adds no native view. Focused app typecheck, lint/format
and 30 existing presentation/history-window tests pass; immutable dependency
metadata stayed unchanged. The native comparison and restoration acceptance
below support retaining this independently identifiable patch.

The correctness-only and optional candidates completed three matched 15-second
native windows per valid surface on the same VM/kernel, with identical `-Og`
compiler and enabled diagnostic markers. Four streams ran on the isolated
daemon; this route's native traffic was mainly the selected primary stream,
about 150 agent-stream frames per window. All streams continued advancing.

| Surface | Correctness-only process CPU | Optional process CPU |
| --- | --- | --- |
| Idle | 1.40–1.73% | 2.06–2.20% |
| Selected streaming chat | 47.24–48.69% | 45.85–48.25% |
| Covered workspace list | 48.05–51.23% | 27.78–28.62% |
| Covered Explorer | 47.67–49.60% | 26.22–26.78% |

Percentages represent one guest CPU core. The original core drawer setup swipe
left chat visible, so its mislabeled samples are excluded, including that failed
preparation action. A bounded left-only comparison restored the same workload
and used the native header button with fresh full drawer-header guards before
every sample. Actual stream ages were matched within roughly 0.1 seconds at
15/50/85 seconds. Native frame counts were 154/158/155 versus 153/158/155,
with matched history/sequence progress. Explorer used verified matching Changes
surfaces at 235/270/305 seconds.

Covered-list JS running time fell from about 5.3–5.7 seconds to 2.6–2.7 seconds
per window; Explorer similarly fell from 5.5–5.8 to 2.6–2.7 seconds. No owned
memory-limit or OOM events occurred. Shared pressure differed, including higher
I/O pressure in the optional left samples, so these are observed ranges rather
than a precise isolated causal percentage or phone/battery result. Visible
streaming overlaps; idle shows a small absolute increase of about half a
percentage point with the same pong counts, which is not called unchanged.
An independent source audit found no new autonomous idle timer, animation,
transport or producer loop in the three-file patch. The small idle increase
remains disclosed rather than attributed to a particular render source. The
parent explicitly retained `7427afe834ab711da42bc798d8f4b8c165f8a634` after the
repeated covered benefit and restoration checks. Final marker-disabled idle,
visible-stream and control checks were separate release gates and subsequently
passed, as recorded below.

Restoration checks verified current content and the actual draft after covering
and revealing active chat. A settled background/resume check advanced Working
from seven to fourteen seconds; an immediate cached frame before hydration is
excluded. Completed older history retained its exact viewport through eight
seconds of coverage while four daemon streams advanced. A pre-hydration image
still showing Updating messages is also excluded. Idle elapsed status refreshed
normally. Provider children retained 15 unique ordered tool rows each; the
selected child's viewport matched exactly after coverage.

A normal file-watch sentinel written while the list covered center appeared
after reveal. A terminal created through the normal workspace actions received
an SDK sentinel while covered and showed it on reveal, then was killed normally.
The file was restored and only the owned test tabs were closed. Every covered
file, terminal and child check used a fresh full native drawer-header guard.
The compact portrait layout did not expose a center diff tab, so this does not
claim a native center-diff check. Explorer's existing retained diff surface
restored normally under its own activity gate; file/diff/catalog consumers stay
outside the new shared-stream boundary by source audit.

Targeted native provider/queued-work traces completed on the optional source
with diagnostic markers enabled. The 120-update main request was coalesced
before client delivery: three main-stream frames produced one five-event queued
flush taking 2.15 ms inclusive wall time. It is not a 120-frame client stress
result. Direct provider traffic produced 124 captured ingestion calls totaling
32.63 ms inclusive wall time, with a 9.74 ms maximum. Four descriptor upserts
were captured after four already existed; all 120 child timeline calls then
observed eight descriptors and the expected 15-entry progression per child.
Normal SDK queries independently verified eight known children with 15 unique,
ordered rows each.

The separate large-item trace delivered 14 main-stream frames and one
14-event queued flush taking 1.47 ms. Four 65,587-byte UTF-8 diff results were
stored through normal paths. Parent frame spans include ingestion and whole
flush spans include per-agent flushes; these wall-time totals cannot be added
or called CPU. Parsing size counters use UTF-16 units, which equal bytes for
this ASCII fixture only. Shared I/O pressure remains recorded. Post-burst Close
returned to usable chat; its local outcome, the core input upper bounds and
the independently confirmed question/plan RPC waits remain separate evidence.
These bounded bursts do not reproduce a production 14 MB queue or establish
the cause of every reported freeze.

The final daemon reconciliation used existing telemetry without restarting or
changing production. In 298 thirty-second windows over 148.5 minutes, twelve
event-loop maxima exceeded one second and the worst was 3.7245 seconds. The
maximum sampled individual physical socket queue was 13,839,954 bytes
(13.20 MiB). Existing logs do not identify its owning client or outgoing byte
types; relay channels can share that physical queue. The worst event-loop and
queue samples occurred in different windows. Message counts alone do not
attribute those queued bytes to provider updates or to the phone.

Millisecond-scale local dispatched handlers exclude mobile/relay transit and
client processing. A 27.639-second cold Git/PR request awaited asynchronous
work; it does not establish continuous JS occupation or global serialization.
There are no paired phone input/network timestamps or GC-duration measurements
for the historical freezes. The 64 MiB transport limit remains an intentional
memory backstop. Current evidence supports these bounded client corrections,
not another daemon behavior change. Remaining total phone freezes require a
narrow paired input/receive/dispatch observation and server event-loop/physical
transport ownership and type/size evidence before expanding scope.

## Final release construction

The final frozen source is `7427afe834ab711da42bc798d8f4b8c165f8a634`.
[Source PR #3](https://github.com/qqp-dev/paseo/pull/3) merged as
`5297c75ccf4e4136528772bcc42366fc8211d1e1` into
`qq/openspec-planning-beta`, preserving all four reviewed commits. Its parents
are exactly the accepted base and reviewed head; merged tree
`3e6e8c4374743d2d2861a277be1b49ae37f844a1` equals the audited candidate tree,
with no additional base change. The repository has no required hosted checks or
branch rules; focused source checks and independent native evidence govern this
acceptance.
Every tracked file matches its Git archive, all twelve native/config/plugin
inputs match the accepted shells, and a full owned-module byte audit found no
dependency mutation. QA and production exports are byte-identical to the tested
optional executable JavaScript, SHA-256
`c50bd5b743d86d051111726b6921ead3a22913d6dab2feced1704f90cff12412`.
All source-map occurrences/content also match except one generated Router
context containing 25 absolute snapshot-root prefixes. Normalizing only those
known prefixes yields identical metadata; original and normalized hashes are
retained privately. QA and production source maps themselves are identical.
This exact-input proof permits reuse of the tested HBC rather than another
compiler run; it does not permit reuse after a future executable source edit.

Both final configurations are generated normally with runtime profiling off.
Each differs from its accepted shell only in `extra.profileBuild=false` and
omission of the corresponding prebuild-plugin entry. The already-built native
profileable manifest stays true. These are audited shell constructions, not
fresh non-profile native builds. They preserve all 1,440 other non-signature
payloads, ordinary META-INF entries, disabled OTA, non-debuggable native code,
the production signing key and verified 16 KiB alignment. Only the HBC and
generated app.config payloads change before ordinary signing.

| Final artifact | SHA-256 |
| --- | --- |
| x86_64 QA APK, `sh.paseo.debug` | `adb71f75ecf05177b904af117ab51396d20fc16b847feb1187a5f7c0b291705a` |
| ARM64 production APK, `sh.paseo` | `7e9cc01154618ccda2c2bfec4888fe97d44a345afe49c413f0eb0850a58afec2` |
| Shared HBC v96, supported `-Og` | `4a0552db105e452d0f36f68f7c1a444f0fb88c6938b999af51d1b8050f31cd72` |

Both packages retain version code 11000/name 0.11.0 and certificate SHA-256
`486587a12a3881dbc25a8fc63fdb8f740cfd8695a0f567a39fd0f51267fab734`.
The final successful preparation stage took 98.56 seconds, reusing its completed
QA export. The first complete owned-template byte audit took 148.68 seconds;
two-package alignment/signing/audit took 45.67 seconds. All ran within the
normal 4 GiB envelope with zero swap or memory-limit/OOM events and ended with
empty cgroups. Setup failures are preserved separately. Final native compiler
acceptance is recorded below; actual phone activation remains distinct from this
artifact proof.

The actual installed final QA APK matches the signed hash. After a fresh
60-turn/120-row restore, three 15-second idle windows measured 2.06, 2.00 and
2.06 percent of one guest core. Three visible streaming windows measured
47.12, 47.23 and 43.92 percent at actual stream ages 15.001, 50.037 and
85.009 seconds. This does not show a material visible regression against the
matched optional diagnostic ranges, while its roughly 0.3–0.7 percentage-point
idle cost versus the correctness-only source remains. The source audit found
no new autonomous idle loop; disabling markers did not remove that observed
cost. It is not hidden inside the covered saving or claimed to be battery gain.

All six traces contain zero Paseo markers and no nonzero error/loss/overrun
statistics or owned memory-limit/OOM events. Builds and heavy observers had
exited. Shared host I/O pressure persisted and is retained with OS JS/UI/Render
scheduling and clock snapshots. With markers off, exact native inbound counts
are unavailable. Native visible content and actual SDK stored history/sequence
progression verify the continuing workload; they are not described as four
native subscriptions. Immediate input, form and resume acceptance is separate.

The installed marker-disabled release passed all ten final no-retry navigation
controls: one idle Close and two different-workspace selections, then three
immediate Close and four alternating selections with the daemon streams running.
There was no wrong Explorer recipient, unchanged-drawer timeout or retry.
Observation-inclusive streaming upper bounds were 528–554 ms for Close and
702–1,067 ms for selection; ADB/capture/rendering remain included and these are
not isolated phone latency results. Question Submit/Dismiss and plan
Implement/Dismiss each removed the prompt and were independently confirmed idle
through the normal SDK. The actual soft keyboard appeared, opening the list
dismissed it, and Close restored the selected primary. A three-second Home then
standard VIEW resume retained the selected workspace/session and exact draft.
All three Android motion settings remain zero.

The parent accepts the supported `-Og` compiler for this bounded release after
the artifact, data-integrity, quiet-resource and native-control gates passed.
This decision does not assert optimized-compiler equivalence: the possible
roughly four-percentage-point visible penalty in the earlier unisolated
comparison remains disclosed. It avoids the demonstrated out-of-budget stock
optimizer allocation without changing the compiler, dependencies or job limits.
On an upstream/schema update, reevaluate ordinary optimized compilation within
the established budget and runtime behavior before changing this recipe.

## Delivery status

| Outcome | State |
| --- | --- |
| OpenSpec plan | Validated; implementation authorized |
| Ordered interaction source | PR #3 merged as `5297c75ccf4e4136528772bcc42366fc8211d1e1`; exact audited tree and focused/native checks verified |
| Profile-only diagnostic source | `dc7ef17b746e4089670a6fcd35ad420e559f82dd`; source checks passed; labels fit the native trace limit |
| Diagnostic QA artifact | Signed/audited/installed; wrong-recipient chronology reproduced; optimized/diagnostic/optimized comparison complete with confounds disclosed |
| Corrected native controls | 40/40 immediate Close/selection outcomes plus supersession, viewport, keyboard, forms and idle resume pass |
| Covered-chat presentation retention decision | Retain `7427afe834ab711da42bc798d8f4b8c165f8a634`; matched native comparisons, settled restoration and final release gates pass; idle cost remains explicit |
| Provider/client/daemon attribution | Bounded investigation complete; no daemon change justified; broader phone/transport freezes remain open |
| Final signed release | Both ABI packages signed/audited; final marker-disabled native acceptance passes; supported `-Og` accepted with comparison limits |
| Production Android activation | Pending physical ADB connection; accepted release prepared, no installation performed |

The phone remains absent from ADB at the delivery gate, so this record does not
claim a freshly verified installed APK or active OTA bundle. The accepted
production activation is owned by the prior static-status record until this
release is installed and independently verified. Existing phone preferences,
pairing, signer and zero animation scales must survive the in-place update.
The bounded reconnect QR expired without pairing and removed its credential
image. The private activation helper is prepared with locked candidate hashes,
public installed-APK and app-data-identity checks, one normal cold launch and
before/after daemon/session metadata continuity. It has not been executed.
Resume activation only with the explicitly selected physical target; do not
repeat the completed native investigation or builds merely to reconnect.

Owned native cleanup completed after acceptance: the fixture and emulator
stopped successfully with zero MainPID and empty cgroups; owned ports
46013/5580/5581 are closed. The task reverse, FIFO, staged fixture, 36 recorded
device trace/config names and runtime extension were removed. The source child
then removed its eight owned dependency links after fixture-stop confirmation,
preserving the other owner's ignored server link. Build scopes also exited with
empty cgroups, and the expired QR helper removed its credential image. Retain
the SDK, AVD, signed APKs, compatible caches and private evidence for reuse;
the existing ADB server and other owners' processes remain untouched.

The workflow record, durable specs and QA entry points are integrated through
[workflow PR #208](https://github.com/hypermemetic-ai/qq-workflows/pull/208).
Task 5.3 intentionally remains unchecked until actual physical activation is
verified; source merge and native acceptance do not complete that outcome.

## Acceptance and retirement

The handoff correction must pass immediate Close and different-workspace
selection during streaming, including delayed opening superseded by newer
Close/navigation intent. Center input shielding alone is insufficient. Keep
existing gesture arbitration, retained scroll offsets and native host identity.
Retire this delta when upstream supplies equivalent visible input ownership and
ordered superseding commands under the same native regression workload.

Covered-center presentation is retained independently for repeated native gain
with correct content, elapsed-status, draft and ordering restoration. Retire
this delta when upstream provides equivalent covered-center presentation
activity without changing ingestion or session lifetime. Reevaluate its idle
cost and native restoration on each update; remove it if the acceptance
condition ceases to hold.

Use the [emulator workflow](android-emulator.md) for repeated native verification.
Keep candidate hashes, stage timings, action outcomes and pressure/observer
limits beside each independent result. Private raw traces and operator data do
not belong in public Git. CPU and battery claims require their own evidence;
source integration never proves Android activation.
