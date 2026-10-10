# User-data HDD tier

This is an operator-enabled storage tier. It changes existing directory paths
with filesystem links, so applications and agents keep writing to their familiar
paths. Newly created children of a default directory land on the HDD. Existing
children preserve their SSD inodes during the atomic parent cutover, including
open file handles. A queued, checksum-verified move retires each old child once
it is idle. Writes through an already-open parent FD are reconciled every minute.
Files of every size and folders containing many small files participate.
Existing SSD children and late writes through old directory handles enter the
hourly migration queue automatically. Each unit still defers while busy or
unverifiable. Explicit SSD promotions retain their separate hot paths. Set
`automatic_migration` to false to disable this intake.
Concurrent watcher and worker admission reuses an existing root identity when
the live mapping agrees; a conflicting mapping remains intact and defers.
Path lookups reuse parsed route maps while checking the latest metadata on each
call, including changes committed by another watcher or worker.
Admission commits each coherent ledger update before continuing filesystem
scans, keeping long namespace walks from blocking the other ledger writer.
Stale queue entries for machinery's SSD backing directories are protected;
their admitted children migrate without re-partitioning the backing namespace.

After changing the archive to the native cached volume, run
`qq-job -- qq-cold-tier route-defaults`. This atomically redirects new children
while retaining earlier HDD directories and their open inodes. Late writes into
any former parent remain discoverable. A route interrupted during publication is
reconciled from its durable journal.
Partitioned parent tracking follows a proved bridge change while former parent
inodes stay available for late writes.
Queue priorities from 0 to 1000 put selected bulk units ahead of older small
units after required parent cutovers; every unit keeps the same safety guards.
`qq-cold-tier partition ROOT_ID` admits a
mixed SSD directory's children separately without copying or retiring its busy
children. An incomplete partition retains its journal for review.

With the opt-in `automatic_partition` policy, a queued folder that is busy,
exceeds the manifest budget, contains special files or has external hard links
is admitted as guarded child units on a later pass. Existing child inodes stay
in place during admission; each idle child still needs a verified move. Git
administration, protected paths, root-level database groups and unfinished
recovery transactions retain their existing guards.
If child admission is interrupted after a partition cutover, the next drain
finishes its metadata only when the recorded parent, backing and public paths
still agree. It preserves every child inode; changed or ambiguous paths retain
the recovery marker for review.

Install from the reviewed workflow checkout:

```sh
python3 storage/install-local.py
qq-cold-tier defaults ~/.cache ~/.local/state ~/.local/share ~/projects
qq-cold-tier queue --priority 100 ~/.cache/Homebrew ~/.local/share/paseo-maintenance
systemctl --user start --no-block qq-cold-tier-migrate.service
qq-cold-tier status
```

Use `qq-cold-tier status --summary` for a compact live report: queue counts,
the current copy or checksum-verification progress, watcher heartbeat age,
SSD/HDD free space and any last drain failure. It reads the operation journal
without scanning payloads. An empty active operation does not imply that the
pending or deferred queue has finished.

Core OS storage remains outside the configured user roots. Control state and the
machinery's own checkout are excluded. Do not admit paid contract work or another
operator's data. There are no blanket SSD exemptions for databases, application
state or development tools. Busy paths defer until quiescent; a database and its
sidecars must move as one directory. Existing directory-relative symlinks retain
their meaning because SSD backing directories remain at the same parent depth.

The default HDD mount is `/srv/media-box`. A missing mount fails closed, including
when its directory is still present on the SSD. Private data goes under the
operator-owned mode-0700 `qq-cold-tier` archive. Transfer is capped at 8 MiB/s;
SHA-256 verification has a separate 8 MiB/s budget shared by both copies. A normal
`rsync --bwlimit` alone does not limit checksum reads. User cgroup I/O controllers
are not assumed available. Run manual scans/moves through `qq-job`; the migration
service does this automatically. Read-only status and queue updates are light.

On Docker hosts, enable `protect_docker_binds` in the policy. Bounded read-only
mount metadata protects running containers' source folders and their children,
including bind mounts with no visible open descriptors. The check repeats before
publishing a verified move. Unavailable or oversized metadata defers the move.
Whole-root filesystem views used by monitors retain the root inode and do not
block unrelated child relocation. No environments or container commands are read.

Moves retain hard links, sparse files, symlinks, ACLs and xattrs. Before publishing,
the tool checks process references, a source mutation watch, manifest metadata and
file hashes. Paths with visible live references, sockets, foreign ownership,
nested mounts, external hard links, source changes or inadequate watch coverage defer. Process
references are limited to visible same-UID processes: sandboxes and root processes
can hide references. This is quiescent-user-data migration, not an online database
mover. An interrupted publish keeps `operation.json` and both copies; inspect and
recover them before retrying. It never deletes an ambiguous original on startup.
`qq-job -- qq-cold-tier recover-published` can finish a published HDD move after
interrupted retirement. It checks public and legacy aliases and compares every
surviving original file with its published copy; changed or active originals
remain intact. The scheduled drain also attempts this same guarded recovery
before resuming the queue; ambiguous or divergent operations remain blocked and
`status` reports the last drain error. A unit left running before journal creation
is retried through the ordinary migration guards. Read-only archive directories are made writable only in the
retired copy, preserving the published file modes and any external hard links.
`qq-job -- qq-cold-tier abort-unpublished` can discard journaled staging before
publication while retaining its authoritative source. Changed public paths,
registered or active destinations, restores and uncertain publication remain
protected. Failed staging cleanup retains the journal and original error.
The scheduled drain treats an occupied migration lock as a normal retry;
it leaves queued units intact and reports success while another move is active.
An unfinished operation or other I/O failure still requires recovery.

Flatpak private profiles under `~/.var/app` need real bind mounts for reliable
persistence. Exclude these paths from ordinary symlink migration. See the
[Flatpak compatibility guidance](https://github.com/flatpak/flatpak/security/advisories/GHSA-7hgv-f2j8-xw87).

With `mirror_layout: true`, HDD destinations retain the logical absolute folder
hierarchy under `archive/mirror`. Default parents route to these directories;
unmoved siblings continue through proxies to their existing objects. A verified
copy is exchanged into its final mirror slot before publishing the legacy alias.
This preserves runtime lookups across sibling folders, including Node module
resolution, instead of putting each migration unit under an unrelated UUID.
When admitting another ancestor, untouched child proxies target its resolved
backing paths, so publication cannot turn them into links to themselves.
`queue --action rehome ROOT` repairs older HDD units using same-filesystem hard
links where possible, then retires the old directory namespace after checking
for writers. Old opaque filenames retain sibling aliases for already loaded
modules. Unique data remains preserved; rehoming creates no second payload copy
when file identities and metadata match. Active units defer without publication.

`cached_retention_watches_only: true` limits access watches on declared native
block-cached mounts to regeneration scopes and their ancestor directories.
SMQ handles demand for ordinary data without a second recursive watch tree.
Unique data without a scope has no retention coverage and remains protected.
Scope or ancestor inode changes reset the observation clock before deletion;
unrelated new directories do not expand the watch budget.

`intake_parents` admits idle file or folder children of real SSD directories;
the parent stays in place and database sidecar files remain grouped. Excluded
control and paid-work paths remain excluded. `namespace-alias PUBLIC BACKING`
records an earlier inverse bridge only when all backing children resolve to the
same public objects, so its private path spelling does not enter the HDD layout.
This changes namespace metadata, preserving both real directories and open
inodes. Cross-filesystem HDD relocation keeps the ordinary shared-inode guard;
only rehoming within the same HDD filesystem can retain arbitrary hard links.

`migration_cpu_quota_percent` defaults to 20 and can be set from 1 to 100 percent
of one CPU core for an understood rollout. Job placement verifies this quota;
the RAM, swap, task and transfer budgets still apply independently.
Real-parent intake waits `intake_min_age_seconds` (one hour by default) after a
child's last top-level directory change, keeping new transient work in place.
Its migration still requires the ordinary ownership, writer and mutation checks.
`migration_memory_high_mib` defaults to 512; an understood directory-heavy
rollout can use 256–2048 MiB with a hard ceiling of 125% of that high watermark.
The launcher profile and aggregate limits can only lower these requested caps.
For explicitly reviewed immutable SDK/build-cache directories, the optional
`immutable_hardlink_scopes` policy permits copying shared files to independent HDD
inodes. External aliases remain untouched; internal hard links remain shared.
Receipts identify each detached inode, and direct inode watches detect changes
through outside aliases during verification and publication. This exception is
for immutable artifacts, never databases, object stores or unique source data.
Large shared-link audits are written once to `immutable-links.json` beside the
staging payload. The recovery journal retains the count and receipt path within
its read bound, so progress and interrupted retirement stay readable. Failed
unpublished copies remove their generated receipt through the same guarded cleanup.
Inherited executable/library search paths alone do not mark a directory busy;
actual executables, mappings, open descriptors, working directories, command
arguments and data-directory environment references still defer relocation.
Physical SSD backing paths become aliases as well, preserving absolute executable
paths and shebangs after migration. Publication flushes namespace changes, and a
late writer on the retired inode preserves both copies for review.

Access recording uses Linux inotify, independent of the HDD's `noatime` mount.
It records per-file opens, reads and writes in a small SQLite ledger on SSD.
One hot file does not reset siblings' retention clocks. A new or renamed subtree
starts its own clock. Restarts, overflow and failed watch admission fail closed;
incomplete coverage makes retention ineligible. Inotify cannot observe reads made
through an existing memory mapping. Destructive pruning additionally requires
complete visible process-reference checks and defers if sandboxed processes hide
their references. The status report exposes watch coverage and errors.

Use `qq-cold-tier split ROOT_ID relative/path` to admit a smaller file or folder
as its own promotion unit. This avoids promoting a whole large tree for one hot
child. Sources/results remain protected; splitting does not authorize deletion.

Parent cutovers and mixed-directory partitioning may also be queued for the
next worker pass, without competing with a copy in progress:

```sh
qq-cold-tier queue --action default ~/.var ~/.codex/sessions
qq-cold-tier queue --action partition ROOT_ID
```

The worker releases its transaction lock between units, refreshes a queued
unit's state before executing it, and preserves any interrupted-copy journal.
Nested parent requests execute from parent to child and follow recorded public
aliases. Root database files and sidecars must relocate together as a directory;
they cannot be split into separate migration units. A busy parent that defers
before any namespace exchange leaves its original intact and no false recovery
journal. Git administrative metadata remains a single unit.

SSD promotion requires both repeated reads (default 120 per rolling pair of hourly
buckets) and a recent matched task measurement showing at least 50 ms and 20%
saved. High access counts alone produce a request to measure task latency; they
do not assert a slowdown. Record actual timings, never guessed timings:

```sh
qq-cold-tier latency ROOT_ID --task 'representative task, matching inputs' --hdd-ms 400 --ssd-ms 200
```

The hourly queue reconsiders promotion and demotes managed SSD data after seven
continuously observed idle days. Explicit `restore ROOT_ID` is also available.
The original HDD copy is retained during promotion. No application benchmark is
invented or executed automatically. Existing busy processes are never stopped.

Retention is independent of tier placement. All data is protected initially.
Only a narrow subtree with a verified regeneration recipe and surviving proof
file may be marked disposable. The proof hash is pinned and checked before GC;
source code, results and unique data must be outside that scope. This explicit
classification is not inferred from folder names, age or size.

```sh
qq-cold-tier regenerable ROOT_ID build/cache --verified --recipe 'verified rebuild command' --proof /path/to/surviving/lockfile
qq-cold-tier gc             # eligibility report
qq-cold-tier gc --apply     # asks the live watcher to prune through its event barrier
```

Deletion requires 30 observed unused days per file, fresh watch coverage, no live
references, an unchanged file and matching proof. Empty child directories are
pruned; the scope directory itself remains. Daily GC is bounded to 10,000 scanned
files and 1 GiB per pass. Unique data stays protected inside broadly moved trees.
Freshly moved files cannot be eligible today. Policy is private at
`~/.config/qq-cold-tier.json`; receipts and queue are in `~/.local/state/qq-cold-tier`.
The ledger is capped at 128 MiB. Its watcher has CPU/RAM/task limits; the move
worker lowers its verified `qq-job` scope to 20% CPU, 640 MiB RAM and 32 tasks.
Automatic promotion preserves at least 10 GiB free on SSD.

`qq-job -- qq-cold-tier verify-cargo-cache` checks a bounded batch of official
crates.io `.crate` archives against the registry's published SHA256 checksums.
The hourly drain also revisits up to 100 archives within a 60-second budget.
Private registries, unpacked source trees, unknown files and modified archives
remain retained. Individual verified file identities and checksums are sealed
in a proof outside the prunable cache. A new proof starts that file's full
30-day wait; adding or changing another file does not make it disposable.

When `reference_socket` is `/run/qq-cold-tier-refs/socket`, the preparation helper
installs a socket-activated, root-pinned read-only collector. It accepts only the
operator's owned regular files on the mounted cached volume and compares device
and inode identities with descriptors and mappings across all process namespaces.
It emits no process commands, environments or file contents. GC makes one bounded
check per batch and drains access events before each unlink. Missing coverage,
changed identities and collector budget failures preserve the files. The collector
has no write permission to the data and cannot perform deletion or restart apps.

The watcher drains its own directory-walk events during admission and watches
new/deleted subtrees incrementally. Directory activity does not trigger a scan
of every managed root. Watch-budget failures are visible per root. Installed
code and ledger use their physical SSD paths, so the control plane survives an
absent HDD mount.
HDD roots receive watch admission first. Failed partial trees relinquish their
watches so they cannot starve smaller trees of complete coverage.
For a native-cache rollout, `watch_original_ssd: false` avoids recording the
mover's reads from legacy SSD data. HDD data and explicit SSD promotions still
receive access watches. Original SSD units keep their separate mutation guards
during migration and cannot accumulate a retention clock while unobserved.
New HDD roots can reclaim watch capacity from previously admitted SSD roots;
those SSD quiet clocks reset and incomplete roots remain ineligible for pruning.
Configured exclusions protect entire relocation units that contain an excluded
descendant, including already registered roots. Partitioning and retention scopes
honor the same boundary.

After production paths are redirected, the operator can run:

```sh
sudo ~/.local/bin/qq-cold-tier-system-prepare
```

This verifies the existing pinned volume service, adds ordering before user login
and the operator's user manager, and reloads the unit definitions. It preserves
the running volume and applications. The same bounded root scope records a
read-only SSD census, including directories inaccessible to the user account,
at the physical SSD control path `system-prepare.json`. It does not delete data,
change partitions or operate the excluded NVMe. A failed or missing data mount
continues to fail closed; no login failure is deliberately added.

## Native block-cache alternative

The long-term simpler design is HDD-backed data with a kernel-managed SSD block
cache, which transparently promotes hot blocks without knowing applications or
moving whole folders. It still needs a separate policy for deleting regenerable
artifacts. Linux supports this through dm-cache or bcache. Do not convert an
existing disk by formatting it. Writethrough keeps the HDD copy current, at the
cost of HDD write latency; writeback introduces a different durability contract.

The operator's KIOXIA NVMe is known failing and is excluded. Current devices are
plain ext4, not an existing LVM cache stack. An in-place cache conversion would
require a planned HDD cutover. A separate image-backed volume can instead be
created alongside the existing mount and populated one idle unit at a time.
The current file tier does not activate either native-cache design. Collect a
bounded read-only report before sizing or proposing that conversion:

```sh
sudo ~/.local/bin/qq-cold-tier-preflight
```

Only `/dev/sda` and `/dev/sdb` are inspected. This command does not mount, format,
repartition, unlock any device, change configuration or load kernel modules.

### Isolated image-backed trial

After installing the reviewed release, the operator runs:

```sh
sudo ~/.local/bin/qq-cold-tier-trial
```

This creates a new 512 MiB HDD image, a 64 MiB SSD cache and 16 MiB of cache
metadata. It verifies the known healthy SSD/HDD mount identities and preserves
10 GiB free on SSD. It attaches only those new files as direct-I/O loop devices,
formats only the new HDD image and mounts it in a private temporary directory.
Existing mounts, applications, data paths and the failing NVMe stay outside the
trial. It loads the installed dm-cache/smq modules as needed. The bounded root
systemd scope verifies 10% CPU, 512 MiB RAM, no swap, 32 tasks and 8 MiB/s device
I/O caps before doing work. User-scope I/O support is not assumed.

The synthetic workload checks SHA-256, hard links, symlinks, xattrs and a committed
SQLite transaction. Matched O_DIRECT reads compare the HDD baseline with a warmed
SMQ writethrough cache, report actual cache hits and latency, then verify cache
reattachment and read the HDD copy with the cache removed. A read-only e2fsck
checks the new filesystem. This is a clean detach/reattach test; it does not
simulate power loss, prove boot ordering or measure a real application's benefit.
Those remain gates before production activation. Functional success and measured
performance benefit are separate report fields.

The trial unmounts its own filesystem, removes its own mapper, confirms loop
detachment and deletes only its newly created image files. If teardown fails,
it retains the affected images and reports the remaining resources; it never
forces an unmount or discards a dirty cache. Private results are saved to the
physical SSD control-state directory as `native-trial.json`. No auto-start unit
or production volume is installed by this trial.

The same command recovers retained trial resources before starting a new attempt.
Recovery validates root-owned image files and their current kernel loop/mount
associations; diagnostic JSON fields are not used as device commands. Unexpected
mounts, ambiguous loops or dirty cache state stop recovery without removing them.
SQLite connections are explicitly closed before unmount, and a regression check
inspects open file descriptors after both population and verification.

### Read-only application pilot

After the synthetic trial passes, run:

```sh
sudo ~/.local/bin/qq-cold-tier-pilot
```

The pilot uses the same disposable images, mount validation, resource caps and
cleanup. It also creates an independent bare snapshot of the operator-owned
`qq-workflows` Git repository inside the new HDD filesystem, bounded to 128 MiB
and 20,000 files. It leaves working trees, uncommitted changes, live repositories
and running applications untouched. Only the fixed system Git binary runs;
hooks, fsmonitor, user Git configuration and inherited alternate object stores
are excluded. A changing source HEAD aborts the pilot without modifying it.
Ownership exceptions apply only to pilot subprocesses: a private configuration
file in the disposable filesystem accepts the exact source and source `.git`
paths, including clone's upload-pack child. Persistent root/operator Git settings
are untouched, and no wildcard exception is added. A regression uses Git's own
foreign-owner test mode to exercise both processes without sudo.

Matched Git history and source searches run on HDD, then on the warmed cache.
File-specific advisory RAM eviction applies only to snapshot files before each
measurement; it never drops the host's page cache. RAM metadata and drive caches
may remain, and the 10% CPU quota also affects measured application latency. The
report separates integrity, cache hits and measured benefit; successful execution
does not require a speedup. Benefit means at least 20% and 50 ms saved on the
combined Git workload. Both cache reattachment and cache-free HDD access must
return identical Git results. The six-minute bounded worker removes its private
images on completion and saves `native-pilot.json` separately from the successful
synthetic trial. No live paths or boot configuration are changed. Actual boot
ordering, abrupt power loss and the performance of other applications remain
unproven; the pilot does not authorize production migration.

### Startup and controller-recovery drill

After the application pilot passes, run:

```sh
sudo ~/.local/bin/qq-cold-tier-startup-test
```

The drill creates separate disposable 512 MiB HDD, 64 MiB SSD cache and 16 MiB
metadata images. Actual temporary systemd services declare and verify HDD mount
dependencies plus the same CPU, RAM, swap, task and physical I/O caps. The helper
preserves escaped systemd mount names through the launcher's property parser
and decodes quoted dependency lists when verifying the resulting unit. Launcher
errors are retained when startup fails before a worker can publish its report.
Workers only attach the already-validated drill images; normal startup never
formats or replaces a filesystem. A deliberately failed temporary dependency must prevent
the startup worker from running. The real HDD mount and application services
are never stopped. No boot-time service or configuration is installed.

The controller is deliberately killed with SIGKILL after fsyncing a file and
committing a SQLite transaction. A new service reconstructs the existing kernel
mount and loop/mapper associations, verifies acknowledged data, then detaches
them cleanly. The drill temporarily renames its detached cache image and verifies
the HDD copy through a read-only, no-journal-replay mount. The cache is restored
and its data checked again. Writable HDD bypass is deliberately excluded because
it would require invalidating old cache metadata before reattachment.

All temporary service units and images are cleaned up, or retained with a failed
report when associations, mount ownership, cache mode or teardown are ambiguous.
The helper recovers its own retained images before a new attempt and refuses to
clean up alongside an active worker. Results go to `native-startup.json`. Passing
this drill establishes runtime startup ordering and recovery from a controller
process crash; it does not test an actual reboot, power loss or drive unplugging.
Those distinctions remain explicit in the report. The drill migrates no live data.

### Persistent volume pilot

After the startup/recovery drill passes, provision the persistent
volume:

```sh
sudo ~/.local/bin/qq-cold-tier-native-volume
```

This creates new, exclusive 1 TB (1,000,000,000,000-byte) HDD, 256 MiB SSD cache
and 16 MiB metadata images on the verified sda/sdb filesystems, preserving at least 10 GiB free on
the root SSD. It formats only the newly allocated origin image, verifies file,
SQLite and filesystem integrity, then installs a root-owned, pinned helper and
`qq-native-cache-pilot.service`. Startup attaches existing images and verifies
their UUID, associations, clean writethrough mode and HDD mount dependencies.
The service is enabled for boot without changing existing application services.
No startup or recovery path formats existing data. Physical reboot, power loss
and unplugging remain untested.

The HDD image reserves its full capacity immediately. Ext4 uses one inode per
64 KiB (about 15 million files), with eager metadata initialization under the
existing 8 MB/s I/O cap. Formatting and the read-only filesystem check each
have a 30-minute limit; initial provisioning can therefore take tens of minutes.
The whole provisioning worker is bounded to 65 minutes, with three extra minutes
to allow worker cleanup. Startup and stop retain their shorter limits. An existing
8 GiB volume is refused by the new helper rather than resized or reformatted.

The volume mounts at `/srv/qqcachedpilot`; `/srv/qqcachedpilot/data` is owned by
the operator. The underlying unmounted directory is empty, root-owned and mode
000, so failed startup does not silently redirect user writes to the root SSD.
Provisioning and startup use the same verified CPU/RAM/swap/task/I/O caps as the
drill. Busy or ambiguous teardown retains resources instead of forcing unmounts
or deleting persistent images. Re-running the helper can update a failed or
inactive service after validating its exact managed unit and the digest and
ownership of its previous pinned release. It retains the volume and adopts its
verified existing mount. Running services and unfamiliar or altered units and
releases are preserved for inspection.

This command moves no user paths. `native-volume.json` records readiness and a
bounded root process-reference check for the proposed Zig-cache candidate;
unreadable process state prevents an idle verdict. Kernel threads skip address
space files, which can return ESRCH, while their file references are still
checked. Optional process-inspection errors defer migration without failing an
otherwise verified mounted volume. That check is a snapshot,
not authorization to delete cache files or skip mutation checks during a later
copy/cutover. Application state, source data and the paid DecIQ work remain
outside this initial pilot. The 30-day regenerable-file retention policy still
requires verified regeneration evidence and complete observation coverage.

After verifying the persistent volume, the operator can set `hdd_mount` to
`/srv/qqcachedpilot`, `archive` to `/srv/qqcachedpilot/data/qq-cold-tier`, and
`block_cached_mounts` to `["/srv/qqcachedpilot"]`. New migrations then land on
the native volume. Roots there report `block_cache`: kernel block caching handles
their demand instead of whole-file SSD promotion. Existing default parents and
their atomic-save writers continue to be admitted on their original filesystem.
Apply a configuration change by restarting only `qq-cold-tier.service`; this
resets its observation clocks, preserving the full 30-day GC requirement.
Migration flushes the destination filesystem after verification and before
publication or original retirement. Flush failure or timeout preserves the
original and removes only the unpublished staging copy.

Validation: `qq-job -- python3 -m unittest discover -s storage -p 'test_*.py'`.
