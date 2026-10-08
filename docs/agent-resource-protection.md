# Agent job resource protection

A historical-data assertion in a resumed learning session grew to 16.7 GiB of
resident memory. Node's failure-diff implementation allocates typed-array
buffers outside its JavaScript old-space heap limit. Total job memory limits,
including native allocations and descendants, provide the useful failure
boundary. The desktop should remain available when an oversized test fails.

## Run a bounded job

Use `~/.local/bin/qq-job` for tests, builds, package installation, data processing,
and other commands that may allocate substantial resources when the execution
context already permits access to the user systemd manager:

```sh
qq-job -- npm test
qq-job -- /bin/bash -lc 'npm run build && npm run test:focused'
```

Each invocation starts a distinct user scope before executing the command. The
scope preserves the caller's working directory, environment, file descriptors,
credentials and existing sandbox. The launcher verifies kernel limits before
executing the payload and fails visibly if placement or verification fails.
It never falls back to an uncontained or less restricted execution path.

The default Codex tool sandbox denies the systemd Unix socket. Keep that sandbox
and its normal approval settings; broader access solely for the launcher is not
part of this setup. The independent guard described below protects recognized
test workers in existing sandboxed sessions. Other sandboxed commands need
bounded inputs and concurrency and do not gain a total-memory cap from guidance
alone.

The initial ordinary-job budget is 3 GiB memory high, 4 GiB memory maximum,
256 MiB swap and 256 tasks. These are limits, not reservations. The shared
`qqjobs.slice` has an 8 GiB high / 12 GiB maximum RAM budget and 1 GiB swap limit,
so simultaneous individually reasonable jobs cannot consume all host RAM.
Per-job `OOMPolicy=kill` ends a failing job's remaining processes together.
The aggregate slice does not enable group killing; reaching its limit can end
one job, with victim selection made by the kernel.

CPU weighting favors interactive work during contention while allowing jobs
to use idle CPU. There is no fixed CPU quota for ordinary jobs. This machine
does not delegate the I/O controller to the user manager, so this deployment
does not claim to enforce I/O weighting.

The built-in `large` profile has a 6 GiB high / 8 GiB maximum RAM budget,
512 MiB swap and 512 tasks: `qq-job --profile large -- COMMAND`. Named profiles in
`~/.config/qq-job/policy.json` provide explicit budgets for larger legitimate
work. Check available memory and the aggregate job load before
choosing a larger profile. After a memory failure, reduce the workload or make
its diagnostics compact; repeatedly rerunning the same failing input does not
resolve an allocation bug.

## Protect ongoing test workers

`qq-job-pressure-guard.service` also watches already-running local Codex test
workers. Its initial automatic policy is deliberately restricted to positively
identified Node test workers with a real Codex app-server ancestor. A large
Node process, a filename containing the word "test", or high CPU use alone
does not make a process eligible.

The fallback budget is 4 GiB resident memory per eligible worker, observed in
two fresh samples. The guard also recognizes sustained host memory pressure.
It signals only the selected worker using a PID file descriptor and revalidates
its identity and ancestry. A short TERM grace allows cleanup; KILL is reserved
for the same worker if its over-budget or pressure condition persists.
Desktop processes, Codex/Paseo servers, persistent studios, browsers and virtual
machines are outside this policy. Verified jobs already covered by finite job
and aggregate cgroup limits are exempt from the fallback RSS budget, including a
declared larger profile. An eligible worker in such a job can still be stopped
if sustained host memory pressure threatens the desktop.

Private incidents record process identity, working directory, cgroup, memory
and intervention reason. They do not record raw command lines or environment
variables. The existing host-monitor bridge delivers them to the dedicated
Paseo uptime conversation using its established batching and cooldown.

The fallback is reactive and can miss exceptionally fast allocations or an
unkillable kernel task. Launch-time cgroup placement is the stronger control.
Commands outside the launcher and the narrow test-worker recognizer are not
universally contained. This addresses runaway job memory; kernel/GPU faults
still require their own diagnosis.

## Install and inspect

```sh
python3 scripts/install-qq-job.py
systemctl --user status qq-job-pressure-guard.service qqjobs.slice
qq-job --status
```

The installer stores a versioned release and hash receipt under
`~/.local/share/qq-job`, preserves existing operator policy files, and installs
the two user units. It activates the job slice and guard without restarting
Paseo, the terminal app server, or existing agents. `--no-activate` installs the
reviewed files without starting units.

After activation, include `qq-job-pressure-guard.service` in the existing host
collector's `important_user_units` list and restart only `qq-host-health.service`
to reload that policy. The collector then alerts if the guard stops or fails.
The guard's journal reports scan coverage and recovery, so a running process
with incomplete evidence is visible during diagnosis.

Global Codex guidance uses the launcher for heavy commands where manager access
already exists and explains the protection available in the default sandbox. No
blanket approval or input-rewrite hook is installed: approval preservation and
mid-turn hook reloading across existing app servers have not been established.

To pause the fallback guard, stop `qq-job-pressure-guard.service`. Keep the job
slice active while any contained jobs are running; stopping it can stop its
jobs. Restore the previous `current` release symlink and restart only the guard
to roll back code. Operator configuration remains separate from release code.

## Validation on this host

A 64 MiB scope with zero swap contained a tiny native-buffer allocation probe
even with a 16 MiB Node old-space limit. It exited 137; systemd and the journal
reported an OOM kill, and no job processes remained. The last sampled memory
counters predated the kill and are not used as proof of its final memory usage.

A separate small native test ran in the real Codex sandbox. With a fixture-only
RSS threshold, the production guard identified its worker and app-server
ancestry, sent TERM, waited three seconds, then sent KILL to the same worker.
Candidate discovery was restricted to that disposable fixture; identity checks
and pidfd signalling used the production implementation. The guard had its
actual 64 MiB memory / 5% of one CPU limits during this check. Steady full scans
of roughly 610 processes took 33–40 ms, and the ten-second proof used 0.30 seconds
of CPU. Startup scans can be incomplete under the CPU cap; they reset the
two-sample streak and do not authorize a signal.
