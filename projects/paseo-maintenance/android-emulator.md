# Android emulator QA

Use this workflow for routine Paseo client changes before Android activation.
Keep source implementation in an isolated child checkout. Read that checkout's
`docs/android.md`, `docs/mobile-testing.md` and `docs/qa.md` before adapting the
build recipe to an upstream update. [status-indicators.md](status-indicators.md)
owns the first run's acceptance and artifact provenance.

## Retained local setup

The operator requested a reusable emulator instead of routine phone takeover.
These private local resources survive tasks; stop the VM between tasks:

| Resource | Location / configuration |
| --- | --- |
| SDK | `/home/qqp/.local/share/paseo-maintenance/toolchain/android-sdk` |
| JDK | `/home/qqp/.local/share/paseo-maintenance/toolchain/jdk21` |
| ADB | `/home/qqp/.local/bin/adb` |
| AVD home | `/home/qqp/.local/share/paseo-maintenance/android-emulator/avds` |
| AVD | `paseo_qa`, Google APIs API 36, x86_64 image revision 7 |
| VM | 2 cores, 2048 MB RAM, 720 × 1616 at 280 dpi, SwiftShader with Vulkan disabled |
| QA app | `sh.paseo.debug`, non-debuggable profileable release, native x86_64 |
| Workload | Isolated synthetic daemon; prohibit production ports 6767 and 6769 |

Emulator 37.2.12 and KVM were used for the initial run. Record the actual version,
image revision, ABI and renderer again on subsequent runs. Preserve unrelated
AVDs and private production signing/Firebase files.

If the retained image is missing, the installed command-line tools use slash
package names: with `JAVA_HOME` set to the retained JDK, run
`cmdline-tools/latest/bin/android --sdk="$ANDROID_SDK_ROOT" sdk install system-images/android-36/google_apis/x86_64`.
The legacy `avdmanager create avd` still uses the semicolon package key
`system-images;android-36;google_apis;x86_64`. Create only the owned `paseo_qa`
profile under the AVD home above; preserve the recorded display and resource
configuration.

Run ordinary tests, prebuilds, package installs and evidence processing through
`/home/qqp/.local/bin/qq-job` when the user systemd manager is accessible, following
the repository's resource instructions. Long-lived task services need declared
RAM, swap and task limits and an explicit owner. Keep the VM off during the first
native compilation if shared host load needs that headroom.

## Start and target

Check that port 5580 is free and no previous owner is running. Launch in a
tracked terminal session, recording its owner/session and a private log:

```bash
export ANDROID_SDK_ROOT=/home/qqp/.local/share/paseo-maintenance/toolchain/android-sdk
export ANDROID_AVD_HOME=/home/qqp/.local/share/paseo-maintenance/android-emulator/avds
export ANDROID_USER_HOME=/home/qqp/.local/share/paseo-maintenance/android-emulator/android-user
taskset -c 4,5 "$ANDROID_SDK_ROOT/emulator/emulator" \
  -avd paseo_qa -port 5580 -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader -feature -Vulkan -cores 2 -memory 2048
```

For work spanning conversation turns, use a named transient `systemd-run --user`
unit with `CPUQuota=200%`, `MemoryMax=6G` and a private append log. Pass the same
three environment values with `--setenv` and the command above. Record the unit
name as its owner and stop it explicitly at task end. The accepted run used
`paseo-static-status-emulator-gles`; these units are task services, not startup services.
Also declare `MemorySwapMax=256M` and `TasksMax=512`. The initial 256-task VM
failed to create a QEMU thread during an APK reinstall; its failed run is excluded
from acceptance. Keep this VM budget separate from the smaller build/fixture
task budgets and record task usage alongside memory pressure.
Keep Gradle at one worker with bounded JVM/native parallelism while the VM runs.

The workspace-stall investigation found the 4 GiB VM budget repeatedly hit its
reclaim limit with the emulator's automatically enlarged roughly 2.5 GiB guest
and software-renderer overhead. A single adjustment to 6 GiB allowed stable warm
controls without OOM. Keep the fixture and build budgets separate; check host
headroom, cgroup pressure and limit events before changing any budget further.

Wait for `adb -s emulator-5580 shell getprop sys.boot_completed` to return `1`.
Every install, input, capture and reverse command must name `-s emulator-5580`.
Do not rely on ADB's default target while a phone may be connected. Set all three
emulator animation scales to zero for the selected reduced-motion workload;
record any deliberate test-only policy change and restore zero afterwards.
Set its screen timeout long enough for bounded tests. Never change phone motion
settings as part of emulator preparation.

If the running VM is absent from `adb devices`, explicitly connect
`adb connect 127.0.0.1:5581` and verify boot completion using
`adb -s 127.0.0.1:5581 shell getprop sys.boot_completed`. Use that explicit local
TCP serial consistently for all commands in that run and record it as the owner
target. Verify port 5581 belongs to the owned emulator before connecting; preserve
the shared ADB server and other devices. Stop the owned unit when `emu kill`
cannot address a TCP serial.

The compact profile preserves the original 411 × 923 dp layout with lower
pixel-buffer and guest-RAM cost. The successful run used the emulator's documented
`-feature -Vulkan` option; this is a host renderer setting, not an application
framework change. Treat failed or interrupted setup runs as preparation and
establish stable boot/input before collecting evidence. A service near its memory
cap can include reclaimable guest disk cache: check its memory pressure and OOM
counters before concluding that it needs a larger budget.

## Small-change turnaround

Use two stages for compatible JavaScript/TypeScript-only tweaks. First iterate
on the emulator with upstream's development client and Metro, which reloads
JavaScript without rebuilding native code. Then produce a release candidate for
final native acceptance and the production phone update. This uses the existing
Expo workflow; it requires no app patch, new dependency or custom update service.
The release workflow below is verified. A reusable debug client/Metro session
has not yet been built or timed on this retained AVD; treat its initial setup as
a separate one-time step, and verify it before relying on reload speed.

Read the pinned checkout's `docs/android.md` and `docs/mobile-testing.md` for
development-client connection and replay details. Run Metro against the isolated
synthetic daemon, with an explicit emulator serial and separate owned ports.
Preserve its debug generated project independently of the QA release and
production caches. Rebuild the client when native modules, dependencies or app
configuration change; Metro cannot validate those changes. Debug behavior does
not establish release CPU or battery performance.

For the release stage:

1. Reuse the SDK, AVD, installed dependencies and compatible generated native
   projects. Check source/configuration compatibility before reuse. The upstream
   `android:development` and `android:production` wrappers run `prebuild --clean`;
   invoke the appropriate incremental steps directly for compatible UI edits.
2. Compile the changed JavaScript/Hermes bundle once. Reuse it across the x86_64
   QA and ARM64 production packaging passes only after proving matching bundle
   inputs and assets as described below. A source edit always invalidates the
   previous candidate bundle.
3. Keep the last accepted QA APK as the baseline rather than rebuilding it for
   every tweak. Rebuild a matched baseline when native configuration changes or
   equivalent payloads are required for a new performance comparison.
4. Run focused source checks and native controls relevant to the change. Perform
   the repeated controlled comparison below for recurring-work/performance
   changes; a small unrelated presentation change does not automatically require
   repeating every prior benchmark and control check. Complete any checks its
   active OpenSpec plan explicitly requires.
5. Stop the fixture and VM immediately after acceptance, sign/package the final
   candidate, and install once with the existing signer. Record build, QA and
   activation timings separately so a slow stage can be identified.

Initial logs show one warm ARM64 comparison release build, including bundling,
completed in 4m21s. Fully cached x86_64 packaging took 59s–1m02s, but skipped the
already-audited Hermes bundle. A production pass that rebuilt native outputs took
12m37s even with bundle reuse. These are individual stage timings, not a measured
end-to-end estimate for the next fresh tweak. Cold native/toolchain updates can
still take much longer; routine compatible UI edits should avoid those stages.

## Native QA build

Use `APP_VARIANT=development` and `PASEO_PROFILE_BUILD=1` at both Expo prebuild
and Gradle stages, with normal modules and `reactNativeArchitectures=x86_64`.
The separate QA package needs no production Firebase file. Keep F-Droid mode
unset. Set `JAVA_HOME` to the retained JDK and `ANDROID_HOME` / `ANDROID_SDK_ROOT`
to the retained SDK. For a new generated project, run from `packages/app`:

```bash
APP_VARIANT=development PASEO_PROFILE_BUILD=1 \
  /home/qqp/.local/bin/qq-job -- npx expo prebuild --platform android --non-interactive
```

From its generated `android` directory, the verified Gradle command is:

```bash
./gradlew :app:assembleRelease \
  --init-script /home/qqp/projects/qq-workflows/projects/paseo-maintenance/fixtures/build-unsigned.gradle \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false \
  '-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m -XX:ActiveProcessorCount=2' \
  -Pkotlin.compiler.execution.strategy=in-process \
  -PreactNativeArchitectures=x86_64
```

Run this long build in a named task-owned user service with declared limits:
`MemoryMax=9G`, `MemorySwapMax=256M`, `TasksMax=256`, two-core CPU affinity,
and a private log. Pass the SDK/JDK/variant/profile environment plus
`CMAKE_BUILD_PARALLEL_LEVEL=1` and `NODE_OPTIONS=--max-old-space-size=3072`.
The [init script](fixtures/build-unsigned.gradle) limits native compile/link jobs
and clears the release signing configuration for that invocation. It changes no
APK packaging or runtime flag. Check host/aggregate headroom before launching;
ordinary short checks use `qq-job`'s default profile.

The output is `app/build/outputs/apk/release/app-release-unsigned.apk`. Align and
sign it using the existing private fork signer, then verify the certificate,
package, ABI and non-debuggable/profileable manifest before `adb -s emulator-5580
install -r`. Keep signing passwords out of command arguments and logs; use
apksigner's password-file input. Never uninstall the production phone app for QA.

The warm QA generated project is retained in
`/home/qqp/projects/.paseo-worktrees/status-ring-activity/packages/app/android`.
For compatible JavaScript-only changes, rebuild directly with Gradle; repeated
`prebuild --clean` discards useful native cache. Recreate for relevant native,
dependency/configuration or upstream changes after reviewing source docs. Keep
production and QA generated projects separate: the first task parks them at
private `static-status/android-production-cache` and `static-status/android-x86-cache`
while switching variants, restoring QA to the source worktree afterwards.

For a JavaScript-only comparison, verify the candidate's Hermes bundle matches
its audited architecture-independent bundle before reusing an audited baseline
bundle in the same native build. Supply
`-PpaseoUseAuditedBundle=true -PpaseoAuditedBundleSha256=<expected-sha256>` with the
owned init script after placing the audited bundle and matching assets in the
generated output. The optional gate verifies the existing bundle's hash and
skips only its bundle action while keeping the task in Gradle's graph. Excluding
the task with `-x` fails AGP's generated-resource provider query. Require every
other APK payload entry to match. Record this
construction explicitly. Rebuild normally if source, environment, dependencies,
platform or bundle equivalence cannot be established.

The current beta's generated validator makes optimized Hermes compilation exceed
the established 12 GiB aggregate even without Gradle heap. The earlier successful
ARM compiler peak and cap were not recorded. See the measured
[compiler boundary](mobile-responsiveness.md#build-preparation) before compiling
a changed bundle; a smaller raw bundle or warm native cache does not resolve it.
The supported `-Og` setting is currently a diagnostic experiment, with production
selection pending an independent native runtime comparison. Keep existing job
limits and record interventions separately from measurements. Reusing audited
architecture-independent bytecode for another ABI avoids another optimizer pass
when its inputs are proved equal; changed source requires new bytecode.

For compatible JavaScript-only diagnostic QA, accepted APK shell reuse was also
verified after Gradle spent its bounded ten-minute window hashing cached inputs.
Establish unchanged native configuration, dependencies, generated manifest and
embedded Expo configuration first. Verify disabled OTA updates and absence of
embedded update manifests or bundle checksums. Compare exported assets with the
accepted shell using AAPT resource IDs and compiled paths: compiled PNG bytes can
differ from export PNG bytes, so require identical decoded pixels/dimensions as
well as matching names/scales/declarations and exact non-image resources.

Construct a fresh ZIP containing the accepted payloads and new audited HBC.
Remove only the old signing entries (the three v1 entries for this accepted APK),
preserving ordinary META-INF files; ZIP reserialization drops the old APK signing
block. Preserve entry compression methods, run the retained SDK's
`zipalign -P 16 4`, sign normally through private password files, and verify every
other payload byte plus certificate, package, ABI, manifest, updates policy and
alignment. Record shell reuse explicitly rather than describing it as a fresh
native build. This diagnostic construction took 9.174 seconds under the normal
4 GiB job envelope. Its candidate compiler remains pending runtime acceptance;
QA shell equivalence does not establish production-shell compatibility. Native,
configuration or asset changes require the normal native resource/build path.

## Responsiveness workload

[native-responsiveness.ts](fixtures/native-responsiveness.ts) extends the original
display fixture with bounded directory density, long history, main streams,
provider-child events and question/plan controls through normal daemon paths.
Copy it into the audited source checkout's ignored
`packages/server/src/.dev/native-responsiveness.ts`. Keep its private output/home
and FIFO separate from production and from another task's fixture.

The verified initial workload has 18 projects, 16 workspaces and 52
stored sessions: 12 idle, 40 closed and 34 archived. Workspace 01 retains seven
tabs; Session 01.1 starts with 60 synthetic user turns and 120 timeline entries.
The first two project blocks were verified expanded with native row bounds;
record full-drawer expansion separately when tested.
Four main streams and provider bursts are explicit later commands. This differs
from the earlier 16-project/64-session investigation; label results accordingly.

The fixture service uses `CPUQuota=100%`, `MemoryMax=1536M`,
`MemorySwapMax=256M`, `TasksMax=128`, `RuntimeMaxSec=30min` and
`TimeoutStopSec=15s`. Pass
`NODE_OPTIONS='--max-old-space-size=512 --max-semi-space-size=8'` to its TSX
process. The smaller heap and serialized lifecycle flushes avoid the initial
preparation OOMs without increasing the process-tree cap. Record failures as
preparation rather than app latency.

Create the output directory with mode 0700 and `control.fifo` with mode 0600.
The tested service holds that FIFO read/write on fd 3 and runs the staged helper
from the source root:

```bash
exec 3<>"$PASEO_NATIVE_FIXTURE_OUTPUT/control.fifo"
exec node_modules/.bin/tsx packages/server/src/.dev/native-responsiveness.ts <&3
```

Wait for `fixture-ready-private.json` and its logged `history-check`. A restart
preserves server/workspace/session identities and Android pairing, but the mock
provider does not preserve history. The helper automatically reseeds the normal
mock message path when the restored timeline is empty, then checks it before
readiness. This restoration was verified with all 60 turns; do not assume that a
persisted home alone restores an equivalent workload.

The companion [native-responsiveness.py](fixtures/native-responsiveness.py)
requires an explicit emulator serial and private absolute output. It rejects a
physical phone and production package. With `PASEO_QA_RUN` naming the evidence
directory and `PASEO_QA_STATE` the fixture output, preparation was exercised with:

```bash
/usr/bin/python3 projects/paseo-maintenance/fixtures/native-responsiveness.py \
  --serial 127.0.0.1:5581 --output "$PASEO_QA_RUN" capture drawer
/usr/bin/python3 projects/paseo-maintenance/fixtures/native-responsiveness.py \
  --serial 127.0.0.1:5581 --output "$PASEO_QA_RUN" controls
/usr/bin/python3 projects/paseo-maintenance/fixtures/native-responsiveness.py \
  --serial 127.0.0.1:5581 --output "$PASEO_QA_RUN" \
  --fixture "$PASEO_QA_STATE" launch --index 0
```

Install an ADB reverse only on that serial for the actual isolated port. Fresh
reference captures and hierarchy-based control bounds precede timed trials;
never dump hierarchy or encode/write a PNG between observing the fully visible
drawer and its immediate tap. The driver waits for the reached destination
without retrying the tap. Its timings include ADB and screenshot observation
overhead. Outcome-bearing trial commands and release acceptance belong in the
[mobile delivery record](mobile-responsiveness.md).

Stop only the recorded fixture/VM units. The repeated fixture stop was verified
to leave no old descendants. Preserve the home during matched APK windows, then
remove only owned synthetic state and the staged helper at task end. Keep the
SDK, AVD and compatible accepted artifacts for the next task.

## Original display workload

Copy [fixtures/native-display.ts](fixtures/native-display.ts) into the target
source checkout's ignored `packages/server/src/.dev/native-display.ts`; its
relative imports intentionally use that checkout's test utilities. Run from the
source checkout with a private output directory:

```bash
PASEO_NATIVE_FIXTURE_OUTPUT=/absolute/private/qa-output \
PASEO_NATIVE_FIXTURE_PORT=46013 \
  /home/qqp/.local/bin/qq-job -- npx tsx packages/server/src/.dev/native-display.ts
```

Check port availability first. Omitting the port selects a free port; read the
actual port from local `fixture-ready-private.json`. The fixture rejects 6767,
listens on loopback, creates a temporary mock workspace and three agents, and
seeds 60 completed turns on agent index 0. No real agent is contacted. Wait for
the ready record before connecting. Use an explicit emulator ADB reverse for the
fixture port, then add a direct host at `127.0.0.1`, that port, with SSL off.
Start the fixture after comparison APKs are ready and stop it immediately after
native QA, before source/Android delivery work. The first setup left it alive
through long build and delivery stages; it reached its 1536 MiB service budget
after all accepted samples/checks and was killed. Keep inputs and duration
bounded instead of raising that budget. For a persistent fixture service, declare
`MemoryMax=1536M`, `MemorySwapMax=256M`, `TasksMax=128`, `CPUQuota=100%` and a
bounded `RuntimeMaxSec=20min`; recreate a fresh fixture for another QA window.

The foreground process accepts one JSON command per stdin line:

```json
{"op":"send","index":1}
{"op":"send","index":2}
{"op":"send","index":0,"text":"emit a synthetic plan approval"}
{"op":"cancel","index":0}
{"op":"status"}
{"op":"quit"}
```

Indices 1 and 2 stream for thirty minutes; index 0 normally streams for ten
seconds. Run equivalent fresh workloads for comparisons. Use synthetic plan or
question prompts for native permission controls, and ordinary message entry for
typing/send checks. `quit`, EOF, SIGINT and SIGTERM close the owned daemon and
remove its temporary workspace. For a named task service, use a private FIFO
kept open for stdin, bounded memory/swap/tasks, and send `quit` before stopping
the unit. Remove the copied `.dev` helper at task end.

## Evidence and cleanup

Use identical native release configuration, dependencies, fixture and VM for the
baseline and candidate. Verify native libraries, DEX and manifest equivalence
when comparing only JavaScript changes. Record source commit, APK and Hermes
bundle hashes, signer, profileability, debug flag, ABI and OTA policy. Preserve
production pairing/settings by keeping QA under its separate package.

For recurring-work/performance acceptance, run at least three controlled CPU/frame
samples per artifact with process restarts and consistent warmup, then test status
transitions, light/dark themes, timer/background resume, taps, typing, scrolling
and panel gestures. Scope other changes' checks as described above. Use only
synthetic content, check QA foreground focus before input/capture, and reject
stale UI hierarchies. Keep raw local evidence private; publish sanitized results.

The elapsed timer can prevent `uiautomator dump` from reaching idle. If a fresh
dump fails, use a guarded screenshot of the synthetic QA app and local OCR or
coordinates from that fresh image; do not reuse an old hierarchy or guess a
control location. Some icon/button labels are missed by OCR. Allow the native
screen to settle after navigation, and stop a dependent control sequence on its
first failure. Select Light/Dark in the app's Appearance settings for theme
checks; an emulator system-mode change alone is insufficient for retained views.

The Google image advertises ARM translation, but the ARM64 comparison APK failed
before React startup because SoLoader chose the x86_64 direct-APK library path.
Use native x86_64 QA builds. Do not change production packaging or framework
flags to make translated ARM builds work. Exclude failed launches from samples.

Emulator results establish native presentation and a recurring-work comparison
within that VM. Physical CPU, battery, thermal, voice/audio and hardware-specific
claims require relevant physical-device evidence. Android same-signer activation
is a separate step after acceptance.

For Android activation, reconnect the phone through its existing ADB pairing and
use its explicit serial. Verify the production package and durable signer before
`install -r`; never uninstall for a regular fork update. Pull the installed APK
and compare its whole-file and bundle hashes with the accepted signed artifact.
Compare app identity, data directory and first-install timestamp before/after;
Android 17 names the identity field `appId`, while older dumps may use `userId`.
This preserves pairing and phone-preference storage. Keep all motion scales zero.
Cold-restart the Android client after installation to ensure it loads the accepted
bundle; client activation does not require a daemon restart. Keep phone UI reads
bounded and guarded by production-app focus, and retain raw values privately.
If the guard stops a read, preserve existing data and report the verification
limit instead of restoring older preferences or taking over another window.

Immediately after native QA, stop the synthetic daemon through its owned control channel, remove
the owned ADB reverse, then run `adb -s emulator-5580 emu kill` and verify its
process exited. Stop any owned transient units as well. Remove task-only source
helpers and device XML. Retain the stopped
AVD, SDK and build cache; leave no test server or VM running unattended.
