The host collector runs in the host namespace as the desktop user, with Python 3
and its standard library. `journalctl` and `systemctl` provide journal and service
evidence. `nvidia-smi` is optional. Run one sample with:

```sh
python3 monitoring/host-health.py --once \
  --state-dir "$HOME/.local/state/host-health" \
  --policy monitoring/collector-policy.example.json
```

Omit `--once` for the persistent collector. A nonblocking file lock prevents two
collectors from writing the same state directory. The example policy provides
10 second sampling, 30 second inotify/GPU sampling, 60 second important service
polling, and three distinct measurements before resource incidents open or clear.
Configure important units explicitly in `important_user_units` and
`important_system_units`; an inactive unit is unexpected when listed here.
Failed units and recognized kernel errors open incidents immediately. Journal
access requires the host's existing journal-reading group membership, such as
`adm` or `systemd-journal`. Missing sources have explicit coverage indicators;
missing readings do not count as recovery.

`metrics.json` is an atomically replaced private JSON object with these fields:

| Field | Meaning |
| --- | --- |
| `schema`, `timestamp`, `boot_id`, `host` | Schema version 1, epoch seconds, Linux boot identity, hostname |
| `metrics.memory_available_ratio` | Available memory divided by total memory |
| `metrics.memory_psi_some`, `memory_psi_full`, `cpu_psi_some`, `io_psi_full` | Linux PSI `avg10` percentages |
| `metrics.disk_used_ratio`, `disk_inode_used_ratio` | Disk and inode use on configured `disk_path` |
| `metrics.inotify_watches`, `inotify_instances` | Observed sums across visible descriptors owned by the collector's UID |
| `metrics.inotify_watch_limit`, `inotify_instance_limit` | Configured per-UID kernel limits |
| `metrics.temperature_c` | Maximum valid named CPU/GPU hwmon reading |
| `metrics.gpu_bar1_used_ratio`, `gpu_vram_used_ratio`, `gpu_temperature_c`, `gpu_query_ok` | Maximum reported NVIDIA values across GPUs; unavailable values are null |
| `top_watchers` | Bounded per-process attribution: PID, parent, comm, observed counts, cgroup, cwd |
| `metrics.memory_total_bytes`, `largest_process_memory_ratio` | Host physical RAM and largest visible process RSS divided by physical RAM |
| `top_memory_processes` | Up to 12 memory-heavy PIDs, parents, comm, RSS bytes, cgroup, cwd and executable path; no arguments |
| `top_gpu_processes` | Up to 32 GPU process PIDs, usage in MiB and process type |
| `temperature_sensors`, `services` | Named sensor readings and allowlisted unit states/exit results |
| `coverage` | Availability, source errors, sample timestamps/ages, scan bounds and partial access |

The inotify sums are attribution estimates. Shared or inherited descriptors can
appear in multiple processes, so the sum can overcount actual allocated kernel
watches. Inaccessible processes and scan budgets can undercount them. The
collector exposes this limitation in metrics and incident evidence and never
claims an exact host-wide or per-UID allocation total. Watcher alerts flag a
resource risk for investigation; changing kernel limits needs further evidence.
The scan defaults to at most 2 seconds, 4,096 processes, 4,096 descriptors per
process, and 64 MiB of fdinfo content every 30 seconds. No process command lines
or environment variables are collected.
The collector records PID 1's name and considers a host process namespace
confirmed when PID 1 is `systemd` or `init`. A sandbox whose PID 1 is another
program has incomplete watcher coverage and a monitoring incident; its visible
counts cannot open or resolve host watcher incidents. Activate the service in
the host namespace and validate its coverage there.

NVIDIA queries have a 3 second / 512 KiB budget. After timeout, the collector
signals the process and retains a nonblocking handle. A driver-blocked process
in Linux D state can resist SIGKILL. The collector skips further queries until
that process exits, keeping a single outstanding probe and continuing all other
sampling. Journal and systemctl commands use the same bounded command runner.

`incidents/<uuid>.json` contains `id`, `host`, `type`, `severity`, `status`,
`first_seen`, `last_seen`, `summary`, `evidence`, and `delivery`. A given incident
type has one open incident. Severity escalates after sustained critical readings;
recovery requires three readings below a separate clear threshold. An unknown
reading keeps the existing incident open. Inotify and GPU readings cached across
collector ticks count only once. Low available memory also requires memory PSI
before opening an incident. GPU BAR1, temperature, disk, inodes and persistent
I/O pressure have independent rules. Kernel events include OOM, NVIDIA Xid and
mapping/allocation failures, lockups, storage/filesystem errors and critical
thermal events. Immediate events group by type and resolve after ten quiet
minutes; this records the lack of new events rather than proving a hardware
problem repaired itself. A boot identity change records a reboot and starts new
resource sample streaks. It does not classify the cause of the restart.

Memory attribution scans visible process status files every ten seconds with a
250 ms and 4,096 process budget. A single process above 20% of physical RAM opens
a warning after three distinct readings; above 30% opens a critical incident.
RSS includes shared pages. These incidents provide attribution for review and
never terminate a process automatically. A partial scan cannot clear an existing
memory attribution incident.

`samples.jsonl`, `samples.1.jsonl` and `samples.2.jsonl` preserve recent full
samples across restarts, each capped at 8 MiB. Rotation keeps total sample history
at or below 24 MiB. Files remain private and are flushed after each append, so a
forced power off has a better chance of leaving the last completed evidence.

`rule-state.json` preserves hysteresis and deduplication across collector
restarts. `journal-cursor.json` persists the last consumed event. The collector
takes a tail baseline on first start or a new boot, then reads capped oldest-first
batches from the cursor. It writes incidents before committing the cursor, and
uses cursor-derived stable event IDs to tolerate interruption between those
writes. Full batches indicate backlog. A failed cursor seek resets to the
current time and reports unavailable journal coverage rather than replaying a
whole boot. Only recognized kernel failure fragments and allowlisted unit
failure metadata enter incidents. Raw journals are never copied to state.

Files are mode 0600 and state directories default to 0700. Keep bridge delivery
bookkeeping in a separate ledger to avoid concurrent rewrites of incident
documents. Resolved incidents are pruned hourly after 14 days, retaining at most
500; open incidents are preserved. An exporter should publish only the metric
values needed by the dashboard and never make this private state directory
world-readable.

Validation uses deterministic temporary `/proc`, hwmon, journal, GPU and service
fixtures, plus bounded subprocess tests:

```sh
python3 -m unittest discover -s monitoring -p test_host_health.py
```
