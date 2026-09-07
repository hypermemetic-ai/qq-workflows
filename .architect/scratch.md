# Architect workflow verification

Use a separate Paseo home and daemon endpoint. Keep existing credentials in their current locations; do not change `HOME` or the normal daemon.

Run from this repository:

```bash
export ARCHITECT_REPO="$PWD"
export ARCHITECT_SCRATCH="$(mktemp -d /tmp/paseo-architect.XXXXXX)"
export PASEO_HOME="$ARCHITECT_SCRATCH/paseo"
export PASEO_HOST="127.0.0.1:16867"
mkdir -p "$PASEO_HOME" "$ARCHITECT_SCRATCH/repos"
printf '{"pluginsEnabled":true}\n' > "$PASEO_HOME/config.json"
python3 -m venv runtimes/python/.venv
runtimes/python/.venv/bin/pip install -e './runtimes/python[dev]'
npm ci --prefix paseo-plugin
paseo daemon start --home "$PASEO_HOME" --listen "$PASEO_HOST" --no-relay --no-inject-mcp --web-ui
paseo plugin install "$ARCHITECT_REPO/paseo-plugin"
```

Search credentials may be supplied through `BRAVE_API_KEY` and `EXA_API_KEY`, or a private `$PASEO_HOME/architect/credentials.yaml` (override its path with `ARCHITECT_CREDENTIALS`). Pass any required environment into the scratch daemon before it starts. The host stores its SQLite database, diagnostic artifacts, and endpoint metadata beneath `$PASEO_HOME/architect`; implementer worktrees belong beneath this same home. Native Teacher state is isolated there too; its authentication is copied from the existing Grok login without inheriting user plugins or repository MCP configuration.

Create a disposable repository for each routing scenario:

```bash
git init -b main "$ARCHITECT_SCRATCH/repos/bounded"
git -C "$ARCHITECT_SCRATCH/repos/bounded" config user.name 'Architect verification'
git -C "$ARCHITECT_SCRATCH/repos/bounded" config user.email 'architect-test@example.invalid'
printf 'one\n' > "$ARCHITECT_SCRATCH/repos/bounded/example.txt"
git -C "$ARCHITECT_SCRATCH/repos/bounded" add example.txt
git -C "$ARCHITECT_SCRATCH/repos/bounded" commit -m 'Test baseline'
```

Use additional disposable repositories for open review, remaining findings, and divergent local-main tests. Use an explicitly identified test remote for publication checks. Record actual runtime requests/session artifacts, committed SHAs, and PR URLs in `.architect/artifacts/` without credentials.

```bash
npm test
npm run test:python
npm run typecheck
paseo plugin reload architect
```

Cleanup only after all scratch workers have finished or been explicitly cancelled. The independent Architect host survives plugin reloads; terminate that scratch host before removing its state:

```bash
paseo daemon stop --home "$PASEO_HOME"
zg server off --home "$PASEO_HOME/architect/zg"
python3 - <<'PY'
import json, os, pathlib, signal
meta = pathlib.Path(os.environ['PASEO_HOME']) / 'architect' / 'host.json'
if meta.exists():
    pid = json.loads(meta.read_text())['pid']
    cmdline = pathlib.Path(f'/proc/{pid}/cmdline')
    if cmdline.exists() and b'host-process.mjs' in cmdline.read_bytes():
        os.kill(pid, signal.SIGTERM)
PY
# Inspect the directory and preserved work before removing this disposable tree.
rm -rf -- "$ARCHITECT_SCRATCH"
unset PASEO_HOME PASEO_HOST ARCHITECT_SCRATCH ARCHITECT_REPO
```

## Native Android testing

Use the native Paseo Architect APK. A browser resized to phone dimensions cannot verify the native panel hosts or navigation. Begin from an existing conversation, assert the available controls, open Ticket, and return to the same conversation without sending a prompt.

### Local environment

The recovery environment is `/tmp/architect-phone` on the daemon machine:

- Android Emulator 37.1.11 with KVM, Android 15 Google APIs x86_64 image revision 9, 1080×2340 at 420 dpi.
- AVD `architect-phone`, emulator serial `emulator-5580`, isolated ADB server on port 5039.
- SDK under `sdk/`, AVD data under `avd/`, Python UI automation under `python/`.
- Fork package `ai.hypermemetic.paseo`, source `8a3b6645a2f32af92cb7347030f001c972e8e63e`, from GitHub Actions run `34010117249`, artifact `9982451630`.
- APK SHA-256: `21f11b5e0f3682c02059fe0db56fb0926bc4fa7e96f19bb455085ed0abe27c64`.

Official emulator, platform-tools and system-image archives were checked against Google's repository checksums. The fork APK was checked against its build artifact checksum. No app source or APK bytes were changed for this environment.

The ARM64 APK needs an emulator-only installation workaround: SoLoader selects the x86 APK library path, while the APK contains ARM64 libraries. Extract its `lib/arm64-v8a/*.so` files into the emulator package's `lib/arm64` directory with rooted ADB, then run `restorecon -RF` on that directory. Android's native bridge runs the original ARM64 binaries. Keep this separate from application fixes. This environment establishes native UI behavior; it does not establish physical-phone performance or verify the normal ARM64 installation path.

Resume the existing emulator:

```bash
ANDROID_HOME=/tmp/architect-phone/sdk \
ANDROID_AVD_HOME=/tmp/architect-phone/avd \
ANDROID_ADB_SERVER_PORT=5039 \
/tmp/architect-phone/sdk/emulator/emulator \
  -avd architect-phone -port 5580 -no-window -no-audio \
  -no-boot-anim -no-snapshot -gpu swiftshader_indirect
```

Connect the emulator to the existing fork daemon without restarting it:

```bash
/tmp/architect-phone/sdk/platform-tools/adb -P 5039 -s emulator-5580 reverse tcp:3083 tcp:3083
/tmp/architect-phone/sdk/platform-tools/adb -P 5039 -s emulator-5580 shell am start -n ai.hypermemetic.paseo/.MainActivity
```

The app's Direct connection uses host `127.0.0.1` and port `3083`. ADB root/restarts clear reverse tunnels; restore the tunnel afterward. The host field's `localhost` text is a placeholder and must be filled in. Use the sidebar to open the existing recovery or Architect conversation. Do not press Start Architect or submit prompts during a navigation test.

### Repeatable smoke test

`uiautomator2` 3.7.0 drives Android's native accessibility hierarchy and captures screenshots. It disables the idle wait because streaming conversations continuously animate. A failed hierarchy capture must fail the test, never reuse an older dump. The driver shutdown waits for completion so it cannot kill the next test connection.

From an open conversation:

```bash
PYTHONPATH=/tmp/architect-phone/python \
python3 scripts/android-ticket-smoke.py \
  --workspace-id wks_de7cb6332a4ab1a7 --expect present --pure-black \
  --artifacts /tmp/architect-phone/evidence/pure-black-redesign
```

Use `--expect absent` only to reproduce the original defect. Screenshots and native XML remain local because they can contain conversation text. Retain the build identity, test result and limitations in the verification record.

The baseline confirmed that the mobile tab switcher only lists existing tabs, while `compact-explorer-sidebar.tsx` only exposes Changes, Files and PR. Neither includes the plugin Ticket panel. Registering another desktop launcher item or changing the browser viewport cannot fix that native path.
