# Stock Orca desktop after service startup

The stock `orca serve` supervisor starts headlessly. Desktop-backed terminal
sleep and saved-tab restore need its renderer. The local
[helper](scripts/orca-desktop-after-start.cjs) opens the ordinary stock desktop
on the existing server after checking readiness. It does not start or update a
server, change settings, launch sessions directly, or replace Orca's updater.
Ordinary desktop startup can restore saved terminals; review existing owners
and saved commands before initial activation.

[The drop-in](systemd/orca-desktop-after-start.conf) is a reviewable template,
not an installed service change. Preserve the existing stock `ExecStart`,
supervisor and restart policy. The leading `-` on `ExecStartPost` is required:
failed promotion must leave the healthy server running. The helper has a
60-second budget; the outer timeout allows 65 seconds, then terminates only the
post-start command group. It logs a fixed reason without credentials or status
payloads. It never signals the existing server.

Supply the established profile, stock supervisor's `$MAINPID`, paired runtime
port, and owned X display. The template uses the existing host's values. For
isolated acceptance, pass the fixture's private values, including `--display`;
never reuse the main display. The existing profile must canonicalize to an
owned directory named `orca`, with its actual Unix socket no longer than
107 UTF-8 bytes. Long cold-tier paths cannot be fixed by a profile alias that
Electron canonicalizes differently. The helper refuses a mismatch rather than
creating another profile. It pins `XDG_CONFIG_HOME` to the profile's parent,
`ORCA_USER_DATA_PATH` to that profile, and uses stock `--user-data-dir` as a
companion argument. That argument alone is insufficient evidence of Electron's
chosen application profile.

It reads only bootstrap metadata and `status.get`, checks owner/PID lineage,
port, socket, current ELF and runtime identity, verifies the actual display with
`xdpyinfo`, then launches that running package's executable. Exit 0 or 3 is
accepted only when the same runtime reports an authoritative ready renderer.
Unexpected package layouts fail without falling back to another installed app.
`xdpyinfo`, `/usr/bin/timeout` and the template's Node path must exist on the host.

Run focused checks through the normal job launcher:

```sh
qq-job -- node --test --test-concurrency=1 projects/paseo-maintenance/scripts/orca-desktop-after-start.test.cjs
```

Before activation, complete an isolated real stock service cold start using the
same profile pins and a separate display, then verify same-runtime promotion,
original-provider sleep commit and saved-tab reopen. Unit tests do not establish
native restore or phone compatibility. Reloading/installing the drop-in and
restarting the main service are separate operational decisions; this repository
change does neither. Reevaluate the helper on stock updates and retire it if
stock service startup supplies equivalent desktop readiness.
