# User-data HDD tier

This is an operator-enabled storage tier. It changes existing directory paths
with filesystem links, so applications and agents keep writing to their familiar
paths. Newly created children of a default directory land on the HDD. Existing
children preserve their SSD inodes during the atomic parent cutover, including
open file handles. A queued, checksum-verified move retires each old child once
it is idle. Writes through an already-open parent FD are reconciled every minute.
Files of every size and folders containing many small files participate.

Install from the reviewed workflow checkout:

```sh
python3 storage/install-local.py
qq-cold-tier defaults ~/.cache ~/.local/state ~/.local/share ~/projects
qq-cold-tier queue ~/.cache/Homebrew ~/.local/share/paseo-maintenance
systemctl --user start --no-block qq-cold-tier-migrate.service
qq-cold-tier status
```

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

Moves retain hard links, sparse files, symlinks, ACLs and xattrs. Before publishing,
the tool checks process references, a source mutation watch, manifest metadata and
file hashes. Paths with visible live references, sockets, foreign ownership,
nested mounts, external hard links, source changes or inadequate watch coverage defer. Process
references are limited to visible same-UID processes: sandboxes and root processes
can hide references. This is quiescent-user-data migration, not an online database
mover. An interrupted publish keeps `operation.json` and both copies; inspect and
recover them before retrying. It never deletes an ambiguous original on startup.

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

Validation: `qq-job -- python3 -m unittest discover -s storage -p 'test_*.py'`.
