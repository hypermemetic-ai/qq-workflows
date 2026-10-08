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
| VM | 2 cores, 3072 MB RAM, 1080 × 2424 at 420 dpi, SwiftShader |
| QA app | `sh.paseo.debug`, non-debuggable profileable release, native x86_64 |
| Workload | Isolated synthetic daemon; never the production daemon on 6767 |

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

## Start and target

Check that port 5580 is free and no previous owner is running. Launch in a
tracked terminal session, recording its owner/session and a private log:

```bash
export ANDROID_SDK_ROOT=/home/qqp/.local/share/paseo-maintenance/toolchain/android-sdk
export ANDROID_AVD_HOME=/home/qqp/.local/share/paseo-maintenance/android-emulator/avds
export ANDROID_USER_HOME=/home/qqp/.local/share/paseo-maintenance/android-emulator/android-user
taskset -c 4,5 "$ANDROID_SDK_ROOT/emulator/emulator" \
  -avd paseo_qa -port 5580 -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader -cores 2 -memory 3072
```

For work spanning conversation turns, use a named transient `systemd-run --user`
unit with `CPUQuota=200%`, `MemoryMax=4G` and a private append log. Pass the same
three environment values with `--setenv` and the command above. Record the unit
name as its owner and stop it explicitly at task end. The initial run used
`paseo-static-status-emulator`; these units are task services, not startup services.
Keep Gradle at one worker with bounded JVM/native parallelism while the VM runs.

Wait for `adb -s emulator-5580 shell getprop sys.boot_completed` to return `1`.
Every install, input, capture and reverse command must name `-s emulator-5580`.
Do not rely on ADB's default target while a phone may be connected. Set all three
emulator animation scales to zero for the selected reduced-motion workload;
record any deliberate test-only policy change and restore zero afterwards.
Set its screen timeout long enough for bounded tests. Never change phone motion
settings as part of emulator preparation.

## Evidence and cleanup

Use identical native release configuration, dependencies, fixture and VM for the
baseline and candidate. Verify native libraries, DEX and manifest equivalence
when comparing only JavaScript changes. Record source commit, APK and Hermes
bundle hashes, signer, profileability, debug flag, ABI and OTA policy. Preserve
production pairing/settings by keeping QA under its separate package.

Run at least three controlled CPU/frame samples per artifact with process
restarts and consistent warmup, then test status transitions, light/dark themes,
timer/background resume, taps, typing, scrolling and panel gestures. Use only
synthetic content, check QA foreground focus before input/capture, and reject
stale UI hierarchies. Keep raw local evidence private; publish sanitized results.

The Google image advertises ARM translation, but the ARM64 comparison APK failed
before React startup because SoLoader chose the x86_64 direct-APK library path.
Use native x86_64 QA builds. Do not change production packaging or framework
flags to make translated ARM builds work. Exclude failed launches from samples.

Emulator results establish native presentation and a recurring-work comparison
within that VM. Physical CPU, battery, thermal, voice/audio and hardware-specific
claims require relevant physical-device evidence. Android same-signer activation
is a separate step after acceptance.

At task end, stop the synthetic daemon through its owned control channel, remove
the owned ADB reverse, then run `adb -s emulator-5580 emu kill` and verify its
process exited. Stop any owned transient units as well. Remove task-only source
helpers and device XML. Retain the stopped
AVD, SDK and build cache; leave no test server or VM running unattended.
