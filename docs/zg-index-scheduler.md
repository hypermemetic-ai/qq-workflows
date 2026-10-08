# Background project indexing

`scripts/zg-index-projects.py` is the maintained source of the workstation's
`~/.local/bin/zg-index-projects`. It reconciles the explicit project list in
`~/.config/zg-index-projects.json`; it never discovers or initializes new indexes.
The checked-in policy retains the previously indexed projects, their 500 KiB
file cap, and the established DecIQ Logic and STS2 exclusions. New Learning App
and Score Converter indexes require a separate, explicit initialization and
policy review before they can join the scheduled list.

The October 7 freeze investigation found that initializing a project without a
local manifest could resolve an existing parent index. The 22:00 scheduled sweep
attempted new Learning App indexing at 22:11:09; the workstation exhausted file
watches at 22:11:45. New Score Converter indexing followed at 22:12:34. Those
times identify a background indexing defect; they do not establish the cause of
the earlier hard freeze. See `~/.zvec-grep/index-projects.log` and
`~/.paseo/daemon.log` for the original evidence.

## Admission and resource policy

Each configured project must have a real project-local `.zvec-grep/manifest.json`
whose storage path and sole canonical `rootPaths` entry exactly match that
project. Symlink aliases, parent/multiple roots, disabled indexes, symlink
following, and missing/oversized file caps are rejected. Missing manifests are
skipped with initialization guidance. The script does not change root selections
or append exclusions: required exclusions and dangling-link exclusions must
already be stored explicitly. Existing narrower caps and other selections survive.

Before each submission, the script requires at least 8 GiB available host RAM,
no more than 1 GiB swap use, low CPU load and a sampled CPU busy percentage, and
low CPU/I/O/memory pressure stall averages. Missing pressure evidence defers work.
The thresholds are explicit policy values for this 32 GiB workstation. Deferral
returns 75, which the service treats as successful postponement. A project error
returns 1; invalid configuration returns 2. A failed job stops the sweep.

Submissions use `--mode server --device cpu --runtime-ephemeral --embedding-concurrency 1`.
The coordinated zvec-grep candidate must support `--runtime-ephemeral` before
activation; the previously installed 0.2.1 build does not. This keeps the existing
local embedding schema, model, and stored query runtime device. The scheduler removes
forced Vulkan-driver and model-override environment variables. Its client runs
at nice 15 with one CPU of affinity, idle I/O priority and a service CPU quota.
**Client cgroup limits do not constrain work inside the shared zvec daemon.**
CPU embedding, one embedding request, and resource admission reduce the scheduled
job's impact; these client settings do not promise a hard CPU or memory bound for
the daemon. The coordinated daemon candidate additionally supports
`ZVEC_GREP_CPU_THREADS=2` to bound CPU inference contexts. Set that in the daemon's
environment during the reviewed candidate activation, not just on this client.
Watcher budgets and daemon resource handling belong to zvec-grep itself.

The timer has no boot catch-up trigger or persistent missed-job replay. Daily
reconciliation and hourly retries after a completed/deferred service keep existing
indexes useful when resources permit. The lock prevents overlapping scheduler
instances. A reboot alone does not immediately start a sweep.

## Failure handoff

`~/.local/state/zg-index-projects/last-client.log` contains the most recent client
output. Completed work requires both exit 0 and `Workspace index: succeeded`.
Failed jobs are never counted as reconciled. A 15-minute client timeout, abnormal
exit, or nonterminal result leaves `uncertain-job.json` and stops further work.
The handoff is persisted before submission, so a killed scheduler cannot silently
forget an outstanding daemon job.

Killing the CLI **does not cancel a submitted daemon job**. Subsequent sweeps
defer while the handoff exists. The operator must inspect `zg status --mode
server`, establish the identified job has finished or has been explicitly
cancelled, and then remove the handoff. Do not clear it merely because the client
PID is gone. The service may be left enabled during investigation: admission will
continue to defer safely.

## Review and installation

Focused tests use temporary manifests and a mock `zg`; they never index a real
repository or contact the daemon:

```sh
node tests/zg-index-projects.mjs
```

After review, install the Python source as executable `~/.local/bin/zg-index-projects`,
copy `config/zg-index-projects/policy.json` to `~/.config/zg-index-projects.json`,
and install the service/timer sources into `~/.config/systemd/user/`. Preserve the
disabled timer until the corrected zvec build and these sources are activated
together. Run `systemctl --user daemon-reload`, inspect a scheduler `--dry-run`,
and enable the timer only after the admission results and root list are reviewed.
An existing live daemon can remain running; this scheduler change does not require
restarting Paseo, changing its agents, or rebuilding indexes.
