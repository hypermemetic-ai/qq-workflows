# Host uptime monitoring

This stack preserves evidence around host freezes and sends incident reviews to
one dedicated Paseo agent. It watches memory and process growth, Linux pressure,
inotify consumption, GPU allocation errors/BAR1, temperature, disk space/inodes,
kernel failures and explicitly configured services. Netdata provides local charts
and its stock health rules. A separate receiver on `infer1` records lost heartbeats
even when `qq-box` cannot write its own journal.

## Local activation

Requirements: Python 3, a working user systemd manager, Docker Compose and the
existing Paseo CLI. The desktop user needs its existing journal-reading access.
Run from a reviewed checkout:

```sh
python3 monitoring/install-local.py
```

The installer preserves `~/.config/qq-host-monitor/{collector,bridge}.json`, copies
code into a versioned release with a SHA-256 receipt, and activates only the two
monitor services and `qq-netdata`. It does not restart Paseo. Existing configuration
is private. User lingering must already be enabled for unattended user-service
startup; check `loginctl show-user "$USER" -p Linger`.

Configure important units explicitly in `collector.json`; listing an intentionally
inactive unit would create unnecessary incidents. The operator deployment watches
Paseo, ISO notation studio, Orca, Voice Vault, Docker and NetworkManager.
The user collector and bridge have CPU, memory and task limits. Netdata is pinned
to stable v2.12.0's amd64 image digest, limited to half a CPU and 768 MiB, and binds
to loopback port 19999. Its persistent Docker volumes hold bounded chart history.
The Docker socket and GPU runtime are not mounted. Unsupported cgroup network
helpers are disabled; host and user-service CPU/memory charts remain available.

Dashboard: <http://127.0.0.1:19999>. Raw evidence is in
`~/.local/state/qq-host-monitor`: `metrics.json`, three bounded sample-history
files, `incidents/`, `watchdog-status.json` and the independent delivery ledger.
Process attribution includes PID, parent, service/cgroup, working directory and
executable when permissions permit. Command lines and environment variables are
not collected. See [collector.md](collector.md) for source bounds, coverage
limitations, thresholds and retention.

## Paseo delivery

Copy `investigator-AGENTS.md` into the dedicated investigator directory (the
installer does this), then create one agent with the normal Paseo provider in its
supported `auto-review` mode. Its directory instructions authorize only read-only
incident review. Set its ID in `bridge.json` as `paseo_agent_id`, and restart only
`qq-host-alerts.service`. Keep `desktop_notifications` false for Paseo-only alerts.
The investigator uses direct bounded evidence reads; it may not run zvec, builds,
other agents or remediation. Incident batches contain at most four items, with a
ten-minute cooldown and an owned-turn stop after three minutes when Paseo's
control path is reachable. Delivery is
acknowledged only after Paseo accepts the message. Incidents survive provider and
daemon outages for retry. Accepted-but-unacknowledged sends can be repeated after
a forced power loss; this is deliberate at-least-once delivery.

## Independent watchdog

Install `offbox-watchdog.py` at `/srv/qq-host-monitor/offbox-watchdog.py` on `infer1`.
The example service documents its private token/certificate/key paths and binds
only to the private Ethernet address `10.99.0.66:19997`. Enable that new service
without touching existing inference services. Use a fresh random shared token and
a certificate with that IP in its subject alternative names. Keep tokens and keys
mode 0600 and outside Git. Set `watchdog_url`, `watchdog_ca` and
`watchdog_token_file` in the local bridge configuration.

The receiver accepts authenticated, size-bounded metrics only. It cannot issue
commands to the monitored host. Heartbeats go every twenty seconds; ninety seconds
without one opens a warning and two minutes escalates to critical. Its archives
are bounded by size and age, and its persisted state distinguishes a receiver
restart from host recovery. A watchdog outage can also mean private-link failure;
it does not establish that the host froze.

With Paseo-only delivery on `qq-box`, a complete host freeze cannot produce a live
notification there. The independent receiver retains the outage, and the bridge
delivers the incident once `qq-box` and Paseo recover. Missing receiver connectivity
also produces a local incident instead of silently disabling offbox coverage.

## Shared search backend containment

`zg-backend.service` runs the repaired, pinned zvec-grep release in the foreground
under the user manager. Its two-CPU quota, 2 GiB memory high watermark, 4 GiB memory
maximum, 512 MiB swap maximum and 128-task cap apply to the shared backend itself.
The scheduler client separately has a 128 MiB swap maximum. The RAM limit alone
does not bound swapping, so both limits are applied. Background watcher,
eventual-refresh and freshness reconciliation use CPU embeddings at concurrency
one; interactive query embedding retains its stored device. CPU embeddings use two
threads; per-root and daemon watcher budgets are 2,048 and 8,192, with idle watcher
release after fifteen minutes. Index runtime overrides do not change the default
interactive GPU query model. The separate admitted scheduler reconciles one
existing root at a time with CPU embeddings and preserves stored selections.

Install a reviewed package with its exact runtime dependencies under
`~/.local/share/zvec-grep/releases/<commit>` and atomically point `current` there.
Use `zg-managed.py` as `~/.local/bin/zg` and set the Codex MCP command to that
absolute path. It translates established CLI management commands and disables
automatic uncapped daemon spawning. Copy/enable the backend unit only after the
candidate validates; use `systemctl --user restart zg-backend.service` for managed
backend restarts. `zg server on` cannot spawn outside the manager when autostart
is disabled. The existing Paseo daemon needs no restart for this backend change.
Include `zg-backend.service` in important monitored user units. Its service limit
contains process memory/CPU growth; it cannot prevent a kernel/driver deadlock.
The pinned upstream agent MCP surface exposes semantic search; exact lookup uses
native `rg`, or the CLI's managed `--rg` interface. Old long-lived MCP clients that
lose their transport during backend replacement may need reopening; the monitor
agent itself does not depend on that transport.

## Verification and operation

```sh
python3 -m unittest discover -s monitoring -p 'test_*.py'
systemctl --user status qq-host-health.service qq-host-alerts.service
docker stats --no-stream qq-netdata
```

Tests use fixtures and local bounded receiver requests. They do not load models,
build applications, index real projects or create persistent project indexes.
To disable this stack, stop/disable only its two user services and run
`docker compose down` in `~/.local/share/qq-host-monitor/netdata` with
`MONITOR_EXPORT_DIR` set to the state export directory. Do not remove the evidence
or Docker volumes when preserving an incident. Old releases provide rollback:
atomically repoint `current` and restart the two monitor services. Re-apply the
reviewed Netdata configuration separately if rolling that part back.
