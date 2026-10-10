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
No further automatic budget increase is approved by this record.

The repeated fixture window verified retained server/workspace/session identity
and pairing. Mock provider history did not survive restart: the helper now
fetches the selected timeline and automatically reseeds empty history through
normal messages before readiness. The restored workload was independently
checked as 60 synthetic user rows and 120 timeline entries. Named fixture stops
left no old descendants; these preparation results are separate from action
latency acceptance.

## Delivery status

| Outcome | State |
| --- | --- |
| OpenSpec plan | Validated; implementation authorized |
| Ordered interaction source | In progress in isolated beta checkout |
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
