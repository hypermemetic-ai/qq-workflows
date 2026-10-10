#!/usr/bin/env python3
"""User-owned HDD tier: reversible relocation, access evidence, conservative GC."""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import select
import shutil
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import time
from types import SimpleNamespace
import uuid

DAY = 86400
ACCESS, MODIFY, ATTRIB, OPEN = 1, 2, 4, 32
MOVED_FROM, MOVED_TO, CREATE, DELETE = 64, 128, 256, 512
DELETE_SELF, MOVE_SELF, OVERFLOW, IGNORED, ISDIR = 1024, 2048, 16384, 32768, 0x40000000
MASK = ACCESS | MODIFY | ATTRIB | OPEN | MOVED_FROM | MOVED_TO | CREATE | DELETE | DELETE_SELF | MOVE_SELF
DEFAULT = {
    'schema': 1, 'hdd_mount': '/srv/media-box',
    'archive': '/srv/media-box/qq-cold-tier',
    'hot_storage': str(Path.home() / '.qq-cold-tier-hot'),
    'source_roots': [str(Path.home())],
    'excluded': [str(Path.home() / '.local/state/qq-cold-tier'),
                 str(Path.home() / '.local/share/qq-cold-tier'),
                 str(Path.home() / '.qq-cold-tier-hot'),
                 str(Path.home() / 'projects/qq-workflows')],
    'retention_days': 30, 'max_watches': 48000, 'max_scan_entries': 150000,
    'copy_kib_per_second': 8192, 'verify_bytes_per_second': 8 * 1024**2,
    'promotion_reads_per_hour': 120, 'promotion_min_saving_ms': 50,
    'promotion_min_saving_ratio': .20, 'demotion_idle_days': 7,
    'max_gc_files': 10000, 'max_gc_bytes': 1024**3, 'automatic_gc': True,
    'ssd_reserve_bytes': 10 * 1024**3,
    'automatic_promotion': True, 'automatic_demotion': True,
    'block_cached_mounts': [],
    'immutable_hardlink_scopes': [],
    'automatic_migration': True,
    'watch_original_ssd': True,
    'mirror_layout': False,
    'cached_retention_watches_only': False,
    'intake_parents': [],
    'migration_cpu_quota_percent': 20,
    'migration_memory_high_mib': 512,
    'intake_min_age_seconds': 3600,
    'automatic_artifact_verification': True,
    'reference_socket': '',
}


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    with temp.open('x') as f:
        os.chmod(temp, 0o600)
        json.dump(value, f, indent=2)
        f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def bounded_json(path, limit=262144):
    with Path(path).open('rb') as f: raw = f.read(limit + 1)
    if len(raw) > limit: raise ValueError('JSON exceeds bound')
    return json.loads(raw)


def absolute(path):
    return Path(os.path.abspath(os.path.expanduser(str(path))))


def within(path, root):
    return path == root or root in path.parents


def private(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('private directory must be owned by the operator')
    path.chmod(0o700)


class Store:
    def __init__(self, state):
        self.state = absolute(state); private(self.state)
        self.db = sqlite3.connect(self.state / 'ledger.sqlite', timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA cache_size=-2048')
        self.db.execute('PRAGMA max_page_count=32768')  # 128 MiB at the default 4 KiB page size.
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS roots (
            id TEXT PRIMARY KEY, source TEXT UNIQUE NOT NULL, target TEXT NOT NULL,
            location TEXT NOT NULL, verified INTEGER NOT NULL, created REAL NOT NULL,
            since REAL NOT NULL DEFAULT 0, coverage INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT 'awaiting watcher', hot TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS activity (
            root TEXT NOT NULL, path TEXT NOT NULL, accessed REAL NOT NULL,
            hour INTEGER NOT NULL, reads INTEGER NOT NULL, opens INTEGER NOT NULL,
            writes INTEGER NOT NULL, PRIMARY KEY(root,path));
          CREATE TABLE IF NOT EXISTS scopes (
            root TEXT NOT NULL, path TEXT NOT NULL, recipe TEXT NOT NULL,
            proof TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(root,path));
          CREATE TABLE IF NOT EXISTS latency (
            root TEXT PRIMARY KEY, task TEXT NOT NULL, hdd_ms REAL NOT NULL,
            ssd_ms REAL NOT NULL, measured REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS queue (
            source TEXT PRIMARY KEY, action TEXT NOT NULL, status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '', updated REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        if 'aliases' not in {r[1] for r in self.db.execute('PRAGMA table_info(roots)')}:
            self.db.execute("ALTER TABLE roots ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'")
        self.db.commit()

    def roots(self): return list(self.db.execute('SELECT * FROM roots ORDER BY created'))
    def root(self, key):
        row = self.db.execute('SELECT * FROM roots WHERE id=? OR source=?', (key, key)).fetchone()
        if row is None and Path(key).is_absolute():
            wanted=Path(key).resolve()
            matches=[r for r in self.roots() if Path(r['source']).resolve()==wanted]
            if len(matches)==1:row=matches[0]
            elif len(matches)>1:raise ValueError('ambiguous public alias: '+key)
        if row is None: raise ValueError('unknown root: ' + key)
        return row
    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default
    def put(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value)))
    def activity(self, root, path, mask, now):
        hour = int(now // 3600)
        self.db.execute('''INSERT INTO activity VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(root,path) DO UPDATE SET accessed=excluded.accessed,
          reads=CASE WHEN hour=excluded.hour THEN reads ELSE 0 END+excluded.reads,
          opens=CASE WHEN hour=excluded.hour THEN opens ELSE 0 END+excluded.opens,
          writes=CASE WHEN hour=excluded.hour THEN writes ELSE 0 END+excluded.writes,
          hour=excluded.hour''', (root, path, now, hour, int(bool(mask & ACCESS)),
                                    int(bool(mask & OPEN)), int(bool(mask & (MODIFY | ATTRIB)))))
    def register(self, source, target, location='hdd', hot=''):
        key = uuid.uuid4().hex[:12]
        self.db.execute('INSERT INTO roots (id,source,target,location,verified,created,hot) VALUES (?,?,?,?,1,?,?)',
                        (key, str(source), str(target), location, time.time(), str(hot)))
        self.db.commit(); return key


@contextlib.contextmanager
def lock(path):
    with Path(path).open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def contain_job(cfg=None):
    """qq-job owns placement; lower this job's CPU/RAM/task budgets in that scope."""
    cpu=(cfg or DEFAULT).get('migration_cpu_quota_percent',20)
    if type(cpu) is not int or not 1<=cpu<=100:raise ValueError('migration CPU budget must be 1 to 100 percent of one core')
    mem=(cfg or DEFAULT).get('migration_memory_high_mib',512)
    if type(mem) is not int or not 256<=mem<=2048:raise ValueError('migration memory high budget must be 256 to 2048 MiB')
    raw = Path('/proc/self/cgroup').read_text().strip()
    cg = Path('/sys/fs/cgroup') / raw.split('::', 1)[1].lstrip('/')
    if not cg.name.startswith('qq-job-') or not cg.name.endswith('.scope'):
        raise ValueError('run this command through ~/.local/bin/qq-job')
    def limited(name, cap):
        current = (cg/name).read_text().strip()
        return min(int(current),cap) if current.isdecimal() else cap
    memory = limited('memory.max',mem*5//4*1024**2)
    high = min(memory,limited('memory.high',mem*1024**2))
    tasks = limited('pids.max',32)
    subprocess.run(['systemctl','--user','set-property','--runtime',cg.name,
                    f'MemoryMax={memory}',f'MemoryHigh={high}','MemorySwapMax=0',
                    f'TasksMax={tasks}',f'CPUQuota={cpu}%'],check=True,stdout=subprocess.DEVNULL)
    if int((cg/'memory.max').read_text()) > memory or int((cg/'pids.max').read_text()) > tasks:
        raise ValueError('job resource limits could not be verified')
    quota, period = (cg/'cpu.max').read_text().split()
    if quota=='max' or int(quota)/int(period) > cpu/100: raise ValueError('job CPU limit could not be verified')


class Inotify:
    def __init__(self, limit, mask=MASK):
        self.lib = ctypes.CDLL(None, use_errno=True)
        self.lib.inotify_init1.argtypes = [ctypes.c_int]
        self.lib.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.lib.inotify_rm_watch.argtypes = [ctypes.c_int, ctypes.c_int]
        self.fd = self.lib.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0: raise OSError(ctypes.get_errno(), 'inotify_init1')
        self.limit = limit; self.mask=mask; self.paths = {}; self.by_path = {}; self.children = {}; self.by_root = {}
        self.deferred = []; self.on_progress = None; self.rebuild_roots = set()
    def close(self): os.close(self.fd)
    def add(self, path, root):
        path = Path(path)
        if len(self.paths) >= self.limit and path not in self.by_path: raise ValueError('watch budget exceeded')
        wd = self.lib.inotify_add_watch(self.fd, os.fsencode(path), self.mask)
        if wd < 0: raise OSError(ctypes.get_errno(), str(path))
        if wd in self.paths:
            previous, owner = self.paths[wd]
            self.by_path.pop(previous,None); self.by_root.get(owner,set()).discard(wd)
            self.children.get(previous.parent,set()).discard(previous)
        self.paths[wd] = (path, root); self.by_path[path] = wd
        self.by_root.setdefault(root,set()).add(wd)
        self.children.setdefault(path.parent,set()).add(path)
    def remove_path(self, path):
        pending = [Path(path)]
        removed = 0
        while pending:
            p = pending.pop(); pending.extend(self.children.pop(p,()))
            wd = self.by_path.pop(p,None)
            self.children.get(p.parent,set()).discard(p)
            if wd is None: continue
            _, key = self.paths.pop(wd)
            self.by_root.get(key,set()).discard(wd)
            self.lib.inotify_rm_watch(self.fd,wd)
            removed += 1
            # rm_watch itself emits IN_IGNORED. Releasing a large tree without
            # draining can overflow the kernel queue and trigger endless full
            # rebuilds, even when application activity is quiet.
            if self.on_progress and removed % 64 == 0: self.on_progress()
    def remove_root(self, key):
        removed = 0
        for wd in list(self.by_root.get(key,())):
            if wd in self.paths:
                self.remove_path(self.paths[wd][0]); removed += 1
                if self.on_progress and removed % 64 == 0: self.on_progress()
        self.by_root.pop(key,None)
        if self.on_progress: self.on_progress()
    def tree(self, path, root):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode): raise ValueError('watch root is a symlink')
        self.add(path, root)
        if not stat.S_ISDIR(info.st_mode): return
        def failed(error): raise error
        visited = 0; walked = 0
        for directory, dirs, _ in os.walk(path, followlinks=False, onerror=failed):
            walked += 1
            # Every scandir emits access/open notifications, including leaves
            # with no new child watches. Drain those walks as well as additions.
            if self.on_progress and walked % 64 == 0: self.on_progress()
            dirs[:] = [n for n in dirs if not (Path(directory) / n).is_symlink()]
            for name in dirs:
                self.add(Path(directory) / name, root); visited += 1
                if self.on_progress and visited % 64 == 0: self.on_progress()
        if self.on_progress: self.on_progress()
    def events(self, include_deferred=True):
        result = self.deferred if include_deferred else []
        if include_deferred: self.deferred = []
        # Bounded drain. Undrained events remain queued for the next iteration.
        for _ in range(16):
            try: raw = os.read(self.fd, 65536)
            except BlockingIOError: break
            offset = 0
            while offset < len(raw):
                wd, mask, _, length = struct.unpack_from('iIII', raw, offset)
                name = os.fsdecode(raw[offset+16:offset+16+length].split(b'\0', 1)[0])
                offset += 16 + length
                parent, root = self.paths.get(wd, (None, None))
                # Our own directory walks generate these too. They cannot describe
                # file demand and must be drained during watch admission.
                if mask & ISDIR and not mask & ~(ISDIR | ACCESS | OPEN): continue
                result.append((root, parent / name if parent and name else parent, mask))
        return result


class ReadBudget:
    """Throttle all checksum reads, including both copies and warm page cache."""
    def __init__(self, rate): self.rate = rate; self.deadline = time.monotonic(); self.bytes=0
    def account(self, count):
        # Slow reads already consumed their allotted time. Permit at most 1 MiB
        # of accumulated credit, rather than adding the same delay after disk I/O.
        self.bytes+=count
        self.deadline = max(self.deadline, time.monotonic()-1024**2/self.rate) + count / self.rate
        wait = self.deadline - time.monotonic()
        if wait > 0: time.sleep(wait)
    def digest(self, path):
        h = hashlib.sha256()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            with os.fdopen(fd, 'rb', closefd=False) as f:
                while block := f.read(262144):
                    self.account(len(block)); h.update(block)
            after = os.fstat(fd)
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('file changed while verifying')
            return h.hexdigest()
        finally: os.close(fd)


def inventory(path, limit, *, detached=None):
    """No-follow manifest, retaining metadata needed to detect concurrent changes."""
    result = {}; pending = [(path, '.')]; size = 0; hardlinks = {}; seen = set()
    device = path.lstat().st_dev
    while pending:
        p, rel = pending.pop(); info = p.lstat()
        if len(result) >= limit: raise ValueError('manifest entry budget exceeded')
        if info.st_dev != device: raise ValueError('nested filesystem; split the migration unit')
        if info.st_uid != os.getuid(): raise ValueError('foreign-owned entry; migration deferred')
        kind = stat.S_IFMT(info.st_mode)
        if kind not in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK): raise ValueError('socket/device/FIFO; migration deferred')
        result[rel] = (info.st_mode, info.st_size if stat.S_ISREG(info.st_mode) else 0,
                       info.st_mtime_ns, info.st_ctime_ns, os.readlink(p) if stat.S_ISLNK(info.st_mode) else None)
        identity = (info.st_dev, info.st_ino)
        if identity not in seen:
            size += info.st_blocks * 512; seen.add(identity)
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            count, total, names = hardlinks.get(identity, (0, info.st_nlink, []))
            hardlinks[identity] = (count+1, total, [*names, rel])
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(p) as it:
                for entry in it:
                    if len(pending) + len(result) >= limit: raise ValueError('manifest entry budget exceeded')
                    pending.append((Path(entry.path), entry.name if rel == '.' else rel + '/' + entry.name))
    external = {identity: (count,total,names) for identity,(count,total,names) in hardlinks.items() if count != total}
    if external and detached is None:
        raise ValueError('hard links extend outside migration unit; keep shared inodes together')
    if detached is not None:
        detached.update(external)
    return result, size


def immutable_scope(path, cfg):
    scopes = cfg.get('immutable_hardlink_scopes', [])
    if not isinstance(scopes,list) or any(not isinstance(p,str) or not Path(p).is_absolute() or Path(p)==Path('/') for p in scopes):
        raise ValueError('immutable hardlink scopes must be explicit absolute artifact paths')
    return any(within(path, absolute(p)) for p in scopes)


def references(paths, strict=False):
    """Visible same-UID references; strict GC fails closed on unreadable processes."""
    needles = [str(p) for p in paths]; ancestors = {os.getpid()}; pid = os.getppid()
    while pid > 1 and pid not in ancestors:
        ancestors.add(pid)
        try:
            raw = Path(f'/proc/{pid}/stat').read_text()
            pid = int(raw[raw.rindex(')') + 2:].split()[1])
        except (OSError, ValueError): break
    found = []; unknown = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal() or int(proc.name) in ancestors: continue
        try:
            if proc.stat().st_uid != os.getuid(): continue
        except FileNotFoundError: continue
        values = []; denied = False
        for name in ('cwd', 'exe'):
            try: values.append(os.readlink(proc / name))
            except FileNotFoundError: pass
            except PermissionError: denied = True
        for name in ('cmdline', 'environ', 'maps'):
            try:
                with (proc / name).open('rb') as f: raw = f.read(2097152).decode('utf8', 'replace')
                if name == 'environ':
                    # Lookup paths describe future opens through the preserved
                    # namespace; they do not hold an inode or make a tree busy.
                    lookup = {'PATH','MANPATH','INFOPATH','LD_LIBRARY_PATH','PKG_CONFIG_PATH','CMAKE_PREFIX_PATH'}
                    raw = '\0'.join(v for v in raw.split('\0') if v.partition('=')[0] not in lookup)
                values.append(raw)
            except FileNotFoundError: pass
            except PermissionError: denied = True
        try:
            for fd in (proc / 'fd').iterdir():
                try: values.append(os.readlink(fd))
                except FileNotFoundError: pass
                except PermissionError: denied = True
        except FileNotFoundError: pass
        except PermissionError: denied = True
        if denied: unknown.append(int(proc.name))
        if any(n in v for n in needles for v in values): found.append(int(proc.name))
    if strict and unknown: raise ValueError('process-reference coverage incomplete: ' + str(unknown[:8]))
    return found


def valid_source(source, cfg):
    source = absolute(source)
    if source.is_symlink(): raise ValueError('source already linked')
    resolved = source.resolve(strict=True)
    roots = [absolute(p).resolve() for p in cfg['source_roots']]
    if not any(within(resolved, r) and resolved != r for r in roots): raise ValueError('source outside configured user roots')
    if excluded_unit(resolved,cfg): raise ValueError('excluded control/core path or descendant')
    if resolved != source: raise ValueError('source has a symlink ancestor')
    return source


def excluded_unit(path,cfg):
    resolved=Path(path).resolve()
    return any(within(resolved,absolute(p).resolve()) or within(absolute(p).resolve(),resolved) for p in cfg['excluded'])


def live_path(root):
    return Path(root['target']) if root['location'] == 'hdd' else Path(root['hot'] or root['source'])


def database_file(path):
    if path.name.endswith(('.db','.sqlite','.sqlite3','-wal','-shm','-journal')):return True
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('root file changed type; defer cutover')
        return os.read(fd,16)==b'SQLite format 3\0'
    finally:os.close(fd)


def watch_enabled(root,cfg):
    if root['location']=='hdd' or cfg.get('watch_original_ssd',True): return True
    return bool(root['hot'] and within(absolute(root['hot']),absolute(cfg['hot_storage'])))


def retention_paths(store,root,cfg):
    if not watch_enabled(root,cfg):return []
    base=live_path(root)
    if not (cfg.get('cached_retention_watches_only',False) and root['location']=='hdd' and
            any(within(base,absolute(p)) for p in cfg.get('block_cached_mounts',[]))):return [base]
    paths=[]
    for scope in store.db.execute('SELECT path FROM scopes WHERE root=? ORDER BY path',(root['id'],)):
        relative=Path(scope['path'])
        if relative.is_absolute() or '..' in relative.parts or str(relative)=='.':raise ValueError('invalid retention watch scope')
        paths.append(base/relative)
    return paths


def watch_signature(store,root,cfg):
    paths=retention_paths(store,root,cfg);identities=[];base=live_path(root)
    for path in paths:
        for parent in [path,*[p for p in path.parents if within(p,base)]]:
            try:info=parent.lstat();identity=(info.st_dev,info.st_ino,stat.S_IFMT(info.st_mode))
            except FileNotFoundError:identity=None
            identities.append((str(parent),identity))
    return (root['location'],root['target'],root['source'],root['hot'],tuple(identities))


def exchange(a, b):
    """One rename transaction: processes never see the public directory missing."""
    lib = ctypes.CDLL(None, use_errno=True)
    lib.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if lib.renameat2(-100, os.fsencode(a), -100, os.fsencode(b), 2) < 0:
        raise OSError(ctypes.get_errno(), 'atomic directory/symlink exchange')


def bridge_parent(store, cfg, raw):
    """New children go to HDD. Existing children keep the same open inodes."""
    source = valid_source(raw, cfg)
    if not source.is_dir(): raise ValueError('default parent must be a directory')
    archive = mount_ready(cfg)
    backup = source.with_name('.' + source.name.lstrip('.') + '-qq-ssd')
    if os.path.lexists(backup): raise ValueError('SSD backing path already exists')
    bridge = archive / 'defaults' / hashlib.sha256(str(source).encode()).hexdigest()[:16]
    if bridge.exists(): raise ValueError('default destination already exists')
    bridge.mkdir(parents=True, mode=0o700)
    info = source.stat(); os.chmod(bridge, stat.S_IMODE(info.st_mode))
    children = list(source.iterdir())
    root_files = [p for p in children if p.is_file() and not p.is_symlink()]
    if any(database_file(p) for p in root_files):
        shutil.rmtree(bridge)
        raise ValueError('database and sidecars at parent root must move together as one directory')
    if root_files and references(root_files):
        shutil.rmtree(bridge)
        raise ValueError('active files at parent root; keep database/sidecars together and defer cutover')
    for child in children: (bridge / child.name).symlink_to(backup / child.name)
    backup.symlink_to(bridge)
    journal = store.state / 'default-operation.json'
    if journal.exists(): raise ValueError('unfinished default cutover; inspect default-operation.json')
    atomic_json(journal, {'source': str(source), 'ssd_backing': str(backup), 'hdd_parent': str(bridge), 'phase': 'prepared'})
    try: exchange(source, backup)
    except BaseException:
        backup.unlink(); shutil.rmtree(bridge); journal.unlink(); raise
    # Open directory FDs may have created a child in the small preparation window.
    for child in backup.iterdir():
        proxy = bridge / child.name
        if not os.path.lexists(proxy): proxy.symlink_to(child)
    parents = store.get('defaults', [])
    parents.append({'source': str(source), 'backing': str(backup), 'hdd': str(bridge)})
    store.put('defaults', parents); store.db.commit(); journal.unlink()
    print('DEFAULT HDD', source, 'existing inodes preserved at', backup)
    return parents[-1]


def adopt_defaults(store, cfg):
    """Admit newly created children and discover legacy SSD children of every size."""
    archive = mount_ready(cfg)
    parents = store.get('defaults', [])
    managed_backings = {str(Path(p['backing'])) for p in parents}
    # Partitioning creates another private backing beneath an existing default
    # parent. It is machinery, not a second data root: duplicate inode watches
    # otherwise steal ownership from the real child roots.
    for root in store.roots():
        if root['location'] == 'ssd' and root['hot'] in managed_backings and not json.loads(root['aliases']):
            if store.db.execute('SELECT 1 FROM scopes WHERE root=?', (root['id'],)).fetchone():
                raise ValueError('managed backing has a regeneration scope; review required')
            if Path(root['source']).resolve() != Path(root['hot']):
                raise ValueError('managed backing tracking changed; review required')
            for table,column in (('activity','root'),('latency','root'),('roots','id')):
                store.db.execute(f'DELETE FROM {table} WHERE {column}=?',(root['id'],))
            store.db.execute('DELETE FROM queue WHERE source=?',(root['source'],))
    store.db.commit()
    # Existing default parents can still be on the previous HDD filesystem
    # after the migration destination moves to a native cached volume.
    hdd_devices = {archive.stat().st_dev}
    for parent in parents:
        public, hdd = Path(parent['source']), Path(parent['hdd'])
        try:
            if public.resolve(strict=True) == hdd:
                hdd_devices.add(hdd.stat().st_dev)
                hdd_devices.update(Path(p).stat().st_dev for p in parent.get('previous', []))
        except FileNotFoundError: pass
    for root in store.roots():
        public = Path(root['source'])
        try:
            resolved = public.resolve(strict=True)
            if resolved != live_path(root) and not public.is_symlink() and resolved.stat().st_dev in hdd_devices:
                # Atomic-save writers replace the proxy with a new HDD file. Adopt
                # that new authoritative object; never copy the old SSD version over it.
                store.db.execute('UPDATE roots SET target=?,location=?,since=0,coverage=0,error=? WHERE id=?',
                                 (str(resolved), 'hdd', 'atomic replacement: awaiting watcher', root['id']))
        except FileNotFoundError: pass
    store.db.commit()
    existing = {r['source'] for r in store.roots()}
    for parent in parents:
        source, backing, hdd = (Path(parent[k]) for k in ('source', 'backing', 'hdd'))
        if source.resolve() != hdd: raise ValueError('default parent no longer matches ledger')
        # Catch parent-FD writes still landing in the old SSD inode.
        backings = [backing, *[Path(p) for p in parent.get('previous', [])]]
        for former in backings:
            for child in former.iterdir():
                if tier_temporary(child) or str(child) in managed_backings: continue
                proxy = hdd / child.name
                if not os.path.lexists(proxy): proxy.symlink_to(child)
                elif not proxy.is_symlink() and not child.is_symlink():
                    # Both versions survive an atomic replacement or conflicting
                    # late parent-FD write; never overwrite the authoritative path.
                    if child.is_dir() and proxy.is_dir():
                        store.put('defaults_conflict', {'public': str(source/child.name), 'former_copy': str(child)})
        for child in hdd.iterdir():
            if tier_temporary(child): continue
            public = source / child.name
            if str(public) in existing: continue
            resolved = child.resolve()
            if str(resolved) in managed_backings: continue
            if any(within(resolved, absolute(p).resolve()) for p in cfg['excluded']): continue
            if child.is_symlink():
                # Original symlinks, sockets and indirect links retain their semantics.
                real = next((p/child.name for p in backings if (p/child.name).exists()
                             and not (p/child.name).is_symlink() and (p/child.name).resolve() == resolved), None)
                if real is None or not (real.is_dir() or real.is_file()): continue
                if real.parent != backing and real.stat().st_dev in hdd_devices: store.register(public, real, 'hdd')
                else:
                    cold = archive / 'data' / uuid.uuid4().hex / child.name
                    store.register(public, cold, 'ssd', hot=real)
            elif child.is_dir() or child.is_file():
                store.register(public, child, 'hdd')
            existing.add(str(public))
    if cfg.get('automatic_migration', True):
        for root in store.roots():
            if root['location'] != 'ssd' or excluded_unit(live_path(root),cfg): continue
            parent=next((p for p in parents if Path(root['source']).parent==Path(p['source'])),None)
            # Explicit promotions have a separate hot path; preserve them.
            if not parent or live_path(root)!=Path(parent['backing'])/Path(root['source']).name: continue
            if not store.db.execute('SELECT 1 FROM queue WHERE source=?',(root['source'],)).fetchone():
                queue_add(store,root['source'])
        # Admit idle children of real SSD parents without changing the parent
        # inode. A parent can remain real for application compatibility.
        for raw in cfg.get('intake_parents',[]):
            parent=absolute(raw)
            if parent.is_symlink() or not parent.is_dir():continue
            for child in parent.iterdir():
                if child.is_symlink() or tier_temporary(child) or str(child) in managed_backings:continue
                try:
                    valid_source(child,cfg)
                    if time.time()-child.stat().st_mtime<cfg.get('intake_min_age_seconds',3600):continue
                    if child.stat().st_dev==archive.stat().st_dev:continue
                    if store.db.execute('SELECT 1 FROM queue WHERE source=?',(str(child),)).fetchone():continue
                    if child.is_file() and database_file(child):continue
                    if not (child.is_file() or child.is_dir()):continue
                    queue_add(store,child)
                except (OSError,ValueError):continue


def tier_temporary(path):
    return path.name.endswith(('.qq-tier-original', '.qq-tier-link', '.qq-tier-default-link'))


def logical_source(store, raw):
    """Undo private SSD backing names without resolving the final data inode."""
    path=absolute(raw)
    parents=[*store.get('defaults',[]),*[dict(source=p['public'],backing=p['backing']) for p in store.get('namespace_aliases',[])]]
    parents=sorted(parents,key=lambda p:len(Path(p['backing']).parts),reverse=True)
    for _ in range(32):
        match=next((p for p in parents if within(path,Path(p['backing']))),None)
        if match is None:return path
        rewritten=Path(match['source'])/path.relative_to(Path(match['backing']))
        if rewritten==path:raise ValueError('default backing rewrite cycle')
        path=rewritten
    raise ValueError('default backing rewrite depth exceeded')


def mirror_path(store, archive, raw):
    return archive/'mirror'/str(logical_source(store,raw)).lstrip('/')


def namespace_alias(store,cfg,raw,backing):
    public,backing=absolute(raw),absolute(backing)
    if public==backing or within(public,backing) or within(backing,public):raise ValueError('namespace alias overlaps')
    for path in (public,backing):
        if path.resolve()!=path or not path.is_dir() or path.stat().st_uid!=os.getuid():raise ValueError('namespace alias requires owned real directories')
        if not any(within(path,absolute(p)) for p in cfg['source_roots']):raise ValueError('namespace alias outside source roots')
    children=list(backing.iterdir())
    if not children or len(children)>cfg['max_scan_entries']:raise ValueError('namespace alias entry budget')
    for child in children:
        peer=public/child.name
        if not peer.exists() or peer.resolve()!=child.resolve():raise ValueError('namespace alias children differ')
    aliases=store.get('namespace_aliases',[])
    previous=next((p for p in aliases if p['backing']==str(backing)),None)
    if previous and previous['public']!=str(public):raise ValueError('namespace alias already differs')
    if not previous:aliases.append(dict(public=str(public),backing=str(backing)));store.put('namespace_aliases',aliases);store.db.commit()


def ensure_mirror_parent(store,cfg,raw):
    """Mirror ancestor directories; untouched siblings retain their public paths."""
    archive=mount_ready(cfg); logical=logical_source(store,raw)
    mirror=archive/'mirror';private(mirror)
    original=Path('/'); directory=mirror
    for part in logical.parent.parts[1:]:
        original=original/part;directory=directory/part
        if directory.is_symlink() or not directory.exists():
            if not original.is_dir():raise ValueError('logical mirror ancestor is not a directory')
            stage=directory.with_name('.'+directory.name+'.qq-tier-default-link')
            if os.path.lexists(stage):raise ValueError('mirror ancestor staging already exists')
            stage.mkdir(mode=0o700)
            entries=list(original.iterdir())
            if len(entries)>cfg['max_scan_entries']:raise ValueError('mirror ancestor entry budget exceeded')
            for child in entries:(stage/child.name).symlink_to(child)
            if os.path.lexists(directory):exchange(stage,directory);stage.unlink()
            else:stage.rename(directory)
            flush_directory(directory.parent)
        if directory.lstat().st_uid!=os.getuid() or not directory.is_dir():
            raise ValueError('mirror ancestor is not an owned directory')
    return mirror/str(logical).lstrip('/')


def recover_default_route(store):
    journal = store.state / 'default-route-operation.json'
    if not journal.exists(): return
    record = bounded_json(journal)
    old, new = record['old'], record['new']
    source = Path(old['source']); staged = Path(record['staged'])
    actual = source.resolve(strict=True)
    if actual not in (Path(old['hdd']), Path(new['hdd'])):
        raise ValueError('default route changed outside recorded transaction')
    selected = new if actual == Path(new['hdd']) else old
    parents = store.get('defaults', [])
    matches = [i for i,p in enumerate(parents) if p['source'] == old['source']]
    if len(matches) != 1: raise ValueError('default route ledger is ambiguous')
    parents[matches[0]] = selected; store.put('defaults', parents); store.db.commit()
    if os.path.lexists(staged):
        if not staged.is_symlink() or staged.resolve() not in (Path(old['hdd']), Path(new['hdd'])):
            raise ValueError('default route staging changed; retained for review')
        staged.unlink(); flush_directory(staged.parent)
    mirror_stage=record.get('mirror_stage')
    if mirror_stage and os.path.lexists(mirror_stage):
        candidate=Path(mirror_stage)
        if candidate.parent!=Path(new['hdd']).parent or not tier_temporary(candidate):
            raise ValueError('mirror route staging differs; retained')
        if candidate.is_symlink():candidate.unlink()
        elif candidate.is_dir() and candidate.stat().st_uid==os.getuid() and all(p.is_symlink() for p in candidate.iterdir()):
            for child in candidate.iterdir():child.unlink()
            candidate.rmdir()
        else:raise ValueError('mirror route staging contains data; retained')
        flush_directory(candidate.parent)
    journal.unlink(); flush_directory(store.state)


def route_defaults(store, cfg):
    """Route new names to the configured HDD without relocating any open inode."""
    archive = mount_ready(cfg); recover_default_route(store)
    for old in sorted(store.get('defaults', []),key=lambda p:len(logical_source(store,p['source']).parts)):
        source, previous = Path(old['source']), Path(old['hdd'])
        if source.resolve(strict=True) != previous:
            raise ValueError('default parent differs from ledger')
        mirrored=cfg.get('mirror_layout',False)
        bridge = mirror_path(store,archive,source) if mirrored else archive/'defaults'/hashlib.sha256(str(source).encode()).hexdigest()[:16]
        if previous==bridge or (not mirrored and within(previous,archive)):continue
        new = dict(old,hdd=str(bridge),previous=[*old.get('previous',[]),str(previous)])
        staged = source.with_name('.'+source.name+'.qq-tier-default-link')
        if os.path.lexists(staged):raise ValueError('default route staging already exists')
        journal=store.state/'default-route-operation.json'
        record={'old':old,'new':new,'staged':str(staged)}
        if mirrored:
            ensure_mirror_parent(store,cfg,source)
            if bridge.is_symlink():
                stage=bridge.with_name('.'+bridge.name+'-'+uuid.uuid4().hex+'.qq-tier-default-link')
                if os.path.lexists(stage):raise ValueError('mirror bridge staging exists')
                record['mirror_stage']=str(stage);atomic_json(journal,record)
                stage.mkdir(mode=0o700)
                for child in previous.iterdir():
                    if not tier_temporary(child):(stage/child.name).symlink_to(child)
                flush_copy(stage);exchange(stage,bridge);stage.unlink()
            elif not bridge.exists():atomic_json(journal,record);bridge.mkdir(mode=0o700)
            elif not bridge.is_dir() or bridge.stat().st_uid!=os.getuid():raise ValueError('mirror bridge differs')
            else:atomic_json(journal,record)
        else:
            if bridge.exists():raise ValueError('default route destination already exists')
            bridge.mkdir(parents=True,mode=stat.S_IMODE(previous.stat().st_mode))
        for child in previous.iterdir():
            if tier_temporary(child):continue
            proxy=bridge/child.name
            if not os.path.lexists(proxy):proxy.symlink_to(child)
            elif mirrored and proxy.is_symlink() and os.readlink(proxy)==str(logical_source(store,source)/child.name):
                temp=proxy.with_name('.'+proxy.name+'.qq-tier-default-link')
                if os.path.lexists(temp):raise ValueError('mirror proxy staging exists')
                temp.symlink_to(child);os.replace(temp,proxy)
        # Persist the bridge and transaction before exposing a link to it.
        flush_copy(bridge)
        atomic_json(journal,record)
        # A nested public path can already be this actual mirror directory after
        # its parent route. Replacing it with a link to itself would create a cycle.
        if source.resolve()!=bridge:
            staged.symlink_to(bridge);exchange(source,staged);flush_directory(source.parent)
        recover_default_route(store)
        print('ROUTED', source, 'to', bridge, flush=True)
    adopt_defaults(store, cfg)


def partition_root(store, cfg, key):
    """Keep existing inodes while admitting a mixed SSD root's children separately."""
    root = store.root(key); original = live_path(root)
    if '.git' in original.parts: raise ValueError('keep Git administrative metadata in one migration unit')
    if excluded_unit(original,cfg): raise ValueError('partition contains protected data; deferred')
    if root['location'] != 'ssd' or not original.is_dir() or original.is_symlink() or json.loads(root['aliases']):
        raise ValueError('partition requires an original SSD directory')
    if store.db.execute('SELECT 1 FROM scopes WHERE root=?', (root['id'],)).fetchone():
        raise ValueError('partition would change a regeneration scope; deferred')
    journal = store.state/'partition-operation.json'
    if journal.exists(): raise ValueError('unfinished partition; original inodes preserved for review')
    if (store.state/'default-operation.json').exists():raise ValueError('unfinished default cutover; preserve it for review')
    identity=original.lstat()
    atomic_json(journal, {'root': root['id'], 'original': str(original), 'source': root['source']})
    try:parent = bridge_parent(store, cfg, original)
    except BaseException:
        # A busy root file can defer before any exchange. Do not leave a false
        # recovery barrier when the original directory is demonstrably intact.
        if not (store.state/'default-operation.json').exists() and original.exists():
            current=original.lstat()
            if (current.st_dev,current.st_ino,current.st_mode)==(identity.st_dev,identity.st_ino,identity.st_mode):
                journal.unlink();flush_directory(store.state)
        raise
    # The old public proxy still resolves through the physical path, now to a
    # native directory of proxies. No child inode has been copied or removed.
    if Path(root['source']).resolve() != Path(parent['hdd']):
        raise ValueError('partition public path changed; both namespaces retained')
    store.db.execute('UPDATE roots SET location=?,target=?,hot=?,since=0,coverage=0,error=? WHERE id=?',
                     ('hdd',parent['hdd'],'','partitioned: awaiting watcher',root['id']))
    store.db.execute("UPDATE queue SET status='complete',error='partitioned into child migration units',updated=? WHERE source=?",
                     (time.time(),root['source']))
    store.db.commit(); adopt_defaults(store,cfg); journal.unlink(); flush_directory(store.state)
    print('PARTITIONED',root['source'],flush=True)


def mount_ready(cfg):
    mount = absolute(cfg['hdd_mount']); archive = absolute(cfg['archive'])
    if not mount.is_mount(): raise ValueError('HDD mount absent; refusing to write on root disk')
    if not within(archive, mount) or archive == mount: raise ValueError('archive outside HDD mount')
    if archive.resolve() != archive: raise ValueError('archive has symlink ancestors')
    private(archive)
    if archive.stat().st_dev != mount.stat().st_dev: raise ValueError('archive on unexpected filesystem')
    return archive


def hot_ready(cfg, archive):
    hot_storage = absolute(cfg['hot_storage']); private(hot_storage)
    if hot_storage.resolve() != hot_storage or hot_storage.stat().st_dev == archive.stat().st_dev:
        raise ValueError('SSD hot storage must be on a separate filesystem without symlink ancestors')
    return hot_storage


def copied_link(source, rel, raw):
    if os.path.isabs(raw): return raw
    relative = Path(os.path.normpath(str(Path(rel).parent / raw)))
    if relative == Path('..') or relative.parts[:1] == ('..',):
        # Preserve references outside the relocation unit through the public
        # namespace. Keeping their relative spelling would change their target.
        return os.path.abspath(source / Path(rel).parent / raw)
    return raw


def flush_copy(destination):
    # Persist data and directory entries on the destination filesystem before
    # publishing its link and retiring the original. Never sync all host disks.
    subprocess.run(['sync', '-f', '--', str(destination)], check=True, timeout=120)


def flush_directory(path):
    fd = os.open(path, os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def remove_retired(path, limit):
    """Remove an owned retired copy, including read-only archived directories."""
    path = Path(path)
    if not os.path.lexists(path): return
    inventory(path, limit, detached={})
    if path.is_dir() and not path.is_symlink():
        # Files can have surviving hard links elsewhere. Only directories need
        # write permission for unlink, and never follow links while granting it.
        pending = [path]
        while pending:
            directory = pending.pop()
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                info = os.fstat(fd)
                if info.st_uid != os.getuid(): raise ValueError('foreign retired directory')
                os.fchmod(fd, info.st_mode | stat.S_IWUSR | stat.S_IXUSR)
                with os.scandir(fd) as entries:
                    pending.extend(directory / e.name for e in entries if e.is_dir(follow_symlinks=False))
            finally: os.close(fd)
        if not shutil.rmtree.avoids_symlink_attacks: raise ValueError('safe directory removal unavailable')
        shutil.rmtree(path)
    else: path.unlink()


def recover_published(store, cfg):
    """Finish only an unambiguous published move; preserve divergent originals."""
    archive = mount_ready(cfg)
    journal = store.state / 'operation.json'
    record = bounded_json(journal)
    if record.get('phase') != 'published' or record.get('restore') is not False:
        raise ValueError('only published HDD moves can be recovered automatically')
    source, original, destination = [absolute(record[k]) for k in ('source','original','destination')]
    expected = archive / 'data' / destination.parent.name / source.name
    mirror_expected=mirror_path(store,archive,source) if cfg.get('mirror_layout',False) else None
    normal=(destination==expected and len(destination.parent.name)==32 and
            all(c in '0123456789abcdef' for c in destination.parent.name))
    if ((not normal and destination!=mirror_expected) or
            destination.resolve() != destination or destination.stat().st_dev != archive.stat().st_dev):
        raise ValueError('unexpected recovery destination')
    if not any(within(source, absolute(p)) for p in cfg['source_roots']):
        raise ValueError('recovery source outside declared roots')
    row = store.db.execute('SELECT * FROM roots WHERE source=?', (str(source),)).fetchone()
    if original != source and (row is None or (row['location']=='ssd' and Path(row['hot'])!=original)):
        raise ValueError('recovery original differs from ledger')
    allowed = {Path(p) for p in json.loads(row['aliases'])} if row else set()
    if original != source: allowed.add(original)
    aliases = {absolute(p) for p in record.get('aliases',[])}
    if aliases != allowed: raise ValueError('recovery aliases differ from ledger')
    for link in {source, *aliases}:
        if link.lstat().st_uid != os.getuid() or link.resolve()!=destination:
            raise ValueError('published recovery path changed; both copies retained')
    staged = source.with_name('.'+source.name+'.qq-tier-original')
    retired = original.with_name('.'+original.name+'.qq-tier-original')
    if record.get('staged') != str(staged) or record.get('original_staged',str(retired)) != str(retired):
        raise ValueError('unexpected retired path')
    if original != source and os.path.lexists(staged) and (not staged.is_symlink() or staged.resolve() not in (retired,destination)):
        raise ValueError('unexpected public staging entry')
    if references([retired]): raise ValueError('retired original remains active')
    guard = Inotify(cfg['max_watches'],mask=MODIFY|ATTRIB|CREATE|DELETE|MOVED_FROM|MOVED_TO|DELETE_SELF|MOVE_SELF)
    try:
        if os.path.lexists(retired):
            guard.tree(retired,'recovery')
            before, _ = inventory(retired,cfg['max_scan_entries'],detached={})
            budget = ReadBudget(cfg['verify_bytes_per_second'])
            for rel, meta in sorted(before.items()):
                a = retired if rel=='.' else retired/rel
                b = destination if rel=='.' else destination/rel
                info = b.lstat()
                if stat.S_IFMT(meta[0]) != stat.S_IFMT(info.st_mode):
                    raise ValueError('retired original diverged from published copy')
                if stat.S_ISREG(meta[0]) and (meta[1]!=info.st_size or budget.digest(a)!=budget.digest(b)):
                    raise ValueError('retired original diverged from published copy')
                if stat.S_ISLNK(meta[0]) and copied_link(source,rel,meta[4])!=os.readlink(b):
                    raise ValueError('retired original link diverged from published copy')
            after, _ = inventory(retired,cfg['max_scan_entries'],detached={})
            if before != after or guard.events() or references([retired]):
                raise ValueError('retired original changed during recovery')
        _, size = inventory(destination,cfg['max_scan_entries'],detached={})
        if row:
            store.db.execute('UPDATE roots SET target=?,location=?,hot=?,aliases=?,since=0,coverage=0,error=? WHERE id=?',
                             (str(destination),'hdd','',json.dumps(sorted(map(str,aliases))),'awaiting watcher',row['id']))
        else: store.register(source,destination)
        store.db.commit()
        remove_retired(retired,cfg['max_scan_entries'])
        if staged != retired and os.path.lexists(staged): staged.unlink()
        mirror_stage=record.get('mirror_staged')
        if mirror_stage and os.path.lexists(mirror_stage):
            candidate=absolute(mirror_stage)
            if (candidate.parent.parent!=archive/'data' or len(candidate.parent.name)!=32 or
                    any(c not in '0123456789abcdef' for c in candidate.parent.name) or
                    candidate.name!=source.name or not candidate.is_symlink() or candidate.resolve()!=destination):
                raise ValueError('mirror recovery staging differs; retained')
            candidate.unlink();flush_directory(candidate.parent)
        record.update(phase='complete',completed=time.time(),allocated_bytes=size,recovered=True)
        with (store.state/'moves.jsonl').open('a') as f:
            f.write(json.dumps(record)+'\n');f.flush();os.fsync(f.fileno())
        store.db.execute("UPDATE queue SET status='complete',error='',updated=? WHERE source=? AND action IN ('move','demote','rehome')",(time.time(),str(source)))
        store.db.commit()
        journal.unlink();flush_directory(store.state)
        print('RECOVERED', source, flush=True)
    finally: guard.close()


def migrate(store, cfg, source, *, restoring=None, demoting=None):
    """Copy, compare, publish symlink atomically, then retire the verified original."""
    archive = mount_ready(cfg)
    source = absolute(source) if restoring or demoting else valid_source(source, cfg)
    original = Path(restoring['target']) if restoring else live_path(demoting) if demoting else source
    if excluded_unit(original,cfg): raise ValueError('migration contains protected data; deferred')
    old = restoring or demoting
    mirrored=bool(cfg.get('mirror_layout',False) and not restoring)
    rehoming=bool(mirrored and demoting and demoting['location']=='hdd' and original.stat().st_dev==archive.stat().st_dev)
    aliases = [Path(p) for p in json.loads(old['aliases'])] if old else []
    for alias in aliases:
        if not alias.is_symlink() or alias.resolve() != original.resolve():
            raise ValueError('legacy path differs from ledger; original retained')
    if restoring:
        hot_storage = hot_ready(cfg, archive)
        destination = hot_storage / restoring['id'] / uuid.uuid4().hex / source.name
    else: destination = archive / 'data' / uuid.uuid4().hex / source.name
    if demoting and source.resolve() != original.resolve(): raise ValueError('source path changed since admission')
    if restoring:
        if source.resolve() != original.resolve(): raise ValueError('source path no longer matches ledger')
    for p in (original, source):
        if p.lstat().st_uid != os.getuid(): raise ValueError('migration requires operator-owned paths')
    if references([original, source, *aliases]): raise ValueError('live process references; deferred')
    if original.is_file() and database_file(original):
        raise ValueError('database and sidecars must move together as one directory')
    detached = {} if rehoming or immutable_scope(original,cfg) else None
    before, size = inventory(original, cfg['max_scan_entries'], detached=detached)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.path.lexists(destination): raise ValueError('staging destination exists')
    reserve = cfg['ssd_reserve_bytes'] if restoring else 1024**3
    if shutil.disk_usage(destination.parent).free < size + reserve: raise ValueError('destination lacks space reserve')
    # Read/copy verification must not overflow its own mutation guard.
    guard = Inotify(cfg['max_watches'],mask=MODIFY|ATTRIB|CREATE|DELETE|MOVED_FROM|MOVED_TO|DELETE_SELF|MOVE_SELF)
    guard.tree(original, 'move')
    # Directory watches cannot see modifications through an external alias.
    # Watch shared immutable files themselves while making independent copies.
    for _,_,names in (detached or {}).values():
        guard.add(original if names[0]=='.' else original/names[0], 'move')
    journal = store.state / 'operation.json'
    if journal.exists(): raise ValueError('unfinished operation; inspect operation.json before another move')
    staged = source.with_name('.' + source.name + '.qq-tier-original')
    if os.path.lexists(staged): raise ValueError('original staging path exists')
    record = {'source': str(source), 'original': str(original), 'destination': str(destination),
              'staged': str(staged), 'restore': bool(restoring), 'phase': 'copying', 'started': time.time()}
    record['detached_immutable_links'] = [dict(device=dev,inode=ino,inside=count,total=total,paths=names)
                                         for (dev,ino),(count,total,names) in (detached or {}).items()]
    atomic_json(journal, record)
    published = False
    mirror_stage=None
    try:
        print('COPY', source, flush=True)
        # --bwlimit caps transfer; checksum verification below has its own read budget.
        args = ['rsync', '-aHAXS', '--modify-window=-1', '--bwlimit=' + str(cfg['copy_kib_per_second']), '--']
        if rehoming and original.is_dir():args.insert(-1,'--link-dest='+str(original))
        if original.is_dir():
            destination.mkdir(mode=0o700)
            args += [str(original) + '/', str(destination) + '/']
        else: args += [str(original), str(destination)]
        if rehoming and original.is_file():os.link(original,destination,follow_symlinks=False)
        else:subprocess.run(['ionice', '-c', '3', *args], check=True)
        for rel, meta in before.items():
            if stat.S_ISLNK(meta[0]):
                expected = copied_link(source, rel, meta[4])
                if expected != meta[4]:
                    link = destination / rel
                    link.unlink(); link.symlink_to(expected)
        budget = ReadBudget(cfg['verify_bytes_per_second'])
        print('VERIFY', source, flush=True)
        record.update(phase='verifying',verification_entries=len(before),verified_entries=0,verification_read_bytes=0)
        atomic_json(journal,record);next_progress=time.monotonic()+5
        verified_pairs=set()
        # rsync lays out sibling files in name order. Keep HDD reads nearby and
        # hash shared file content once, while checking every name's metadata below.
        for index,(rel, meta) in enumerate(sorted(before.items()),1):
            a = original if rel == '.' else original / rel
            b = destination if rel == '.' else destination / rel
            if stat.S_ISREG(meta[0]) and not (rehoming and os.path.samefile(a,b)):
                left,right=a.lstat(),b.lstat()
                pair=(left.st_dev,left.st_ino,right.st_dev,right.st_ino)
                if pair not in verified_pairs:
                    if budget.digest(a)!=budget.digest(b):raise ValueError('checksum mismatch')
                    verified_pairs.add(pair)
            if time.monotonic()>=next_progress:
                record.update(verified_entries=index,verification_read_bytes=budget.bytes)
                atomic_json(journal,record)
                print('VERIFY_PROGRESS',source,index,'/',len(before),'read_MiB',round(budget.bytes/1024**2),flush=True)
                next_progress=time.monotonic()+5
        after_links = {} if detached is not None else None
        after, _ = inventory(original, cfg['max_scan_entries'], detached=after_links)
        copied, _ = inventory(destination, cfg['max_scan_entries'],detached={} if rehoming else None)
        if rehoming:
            if set(before)!=set(after) or any((v[:3],v[4])!=(after[k][:3],after[k][4]) for k,v in before.items()):
                raise ValueError('source changed during migration')
        elif before != after or detached != after_links: raise ValueError('source changed during migration')
        def matches(rel, meta):
            actual = copied[rel]
            if stat.S_ISLNK(meta[0]):
                return meta[0] == actual[0] and copied_link(source, rel, meta[4]) == actual[4]
            if stat.S_ISDIR(meta[0]): return meta[0] == actual[0]
            return (meta[:3], meta[4]) == (actual[:3], actual[4])
        if set(before) != set(copied) or any(not matches(k,v) for k,v in before.items()):
            raise ValueError('copy metadata mismatch')
        print('SYNC', source, flush=True)
        record.update(phase='syncing',verified_entries=len(before),verification_read_bytes=budget.bytes)
        atomic_json(journal,record)
        flush_copy(destination)
        change_mask=MODIFY|CREATE|DELETE|MOVED_FROM|MOVED_TO|OVERFLOW|DELETE_SELF|MOVE_SELF|(0 if rehoming else ATTRIB)
        if any(mask & change_mask
               for _, _, mask in guard.events()): raise ValueError('source mutation during migration')
        if references([original, source, *aliases]): raise ValueError('source became active; original retained')
        if restoring or demoting:
            if source.resolve() != original.resolve(): raise ValueError('public path changed during migration')
        record['phase'] = 'verified'; atomic_json(journal, record)
        mirror_is_source=False
        if mirrored:
            final=ensure_mirror_parent(store,cfg,source)
            if final.exists() and not final.is_symlink():raise ValueError('mirror destination already contains data')
            if os.path.lexists(final):
                if not final.is_symlink() or final.resolve()!=original.resolve():raise ValueError('mirror proxy differs from original')
            else:final.symlink_to(original)
            mirror_is_source=source.parent.resolve()/source.name==final
            mirror_stage=destination
            record.update(phase='mirror-publishing',destination=str(final),mirror_staged=str(mirror_stage))
            atomic_json(journal,record);published=True
            exchange(destination,final);flush_directory(final.parent)
            destination=final
            if mirror_is_source:
                mirror_stage.rename(staged);mirror_stage=None
        if mirror_is_source:
            pass
        elif restoring:
            link = source.with_name('.' + source.name + '.qq-tier-link')
            if os.path.lexists(link): raise ValueError('link staging path exists')
            link.symlink_to(destination)
            record['swap_path'] = str(link); atomic_json(journal, record)
            published = True  # Any ambiguous exchange preserves both copies for recovery.
            exchange(source, link)
            link.rename(staged)
        else:
            link = source.with_name('.' + source.name + '.qq-tier-link')
            if os.path.lexists(link): raise ValueError('link staging path exists')
            link.symlink_to(destination)
            record['swap_path'] = str(link); atomic_json(journal, record)
            published = True
            exchange(source, link)
            link.rename(staged)
        published = True
        retired = staged
        if demoting and original != source:
            # Public bridges and executable shebangs can retain the physical SSD
            # name. Exchange that inode for an alias before retiring its contents.
            original_link = original.with_name('.' + original.name + '.qq-tier-link')
            retired = original.with_name('.' + original.name + '.qq-tier-original')
            if os.path.lexists(original_link) or os.path.lexists(retired):
                raise ValueError('legacy alias staging exists; both copies retained')
            record['original_staged'] = str(retired)
            record['original_swap_path'] = str(original_link)
            atomic_json(journal, record)
            original_link.symlink_to(destination)
            exchange(original, original_link); original_link.rename(retired)
            if original not in aliases: aliases.append(original)
        for alias in aliases:
            if alias == original and demoting: continue
            link = alias.with_name('.' + alias.name + '.qq-tier-link')
            if os.path.lexists(link): raise ValueError('alias staging exists; both copies retained')
            if not alias.is_symlink() or alias.resolve() != original.resolve():
                raise ValueError('legacy path changed during publication; both copies retained')
            link.symlink_to(destination); os.replace(link, alias)
        record['aliases'] = [str(p) for p in aliases]
        if rehoming and original.parent.parent==archive/'data':
            # Already loaded modules can retain the former opaque filename.
            # Keep sibling lookups from that filename routed to the mirror too.
            for sibling in destination.parent.iterdir():
                legacy=original.parent/sibling.name
                if not tier_temporary(sibling) and not os.path.lexists(legacy):legacy.symlink_to(sibling)
            flush_directory(original.parent)
        for parent in {source.parent, original.parent, *[p.parent for p in aliases]}:
            flush_directory(parent)
        record['phase'] = 'published'; atomic_json(journal, record)
        # A writer that opened the original during publication is now visible
        # at its retired inode path. Keep both versions if it wrote or remains
        # open, rather than orphaning its work during cleanup.
        if any(mask & (MODIFY|CREATE|DELETE|MOVED_FROM|MOVED_TO|OVERFLOW|(0 if rehoming else ATTRIB))
               for _, _, mask in guard.events()) or references([retired]):
            raise ValueError('retired original became active; both copies and journal retained')
        if restoring:
            cold_target = original
            if staged.is_symlink(): staged.unlink()
            else:
                cold_target = archive / 'data' / uuid.uuid4().hex / source.name
                cold_target.parent.mkdir(parents=True, mode=0o700)
                staged.rename(cold_target)
            store.db.execute('UPDATE roots SET location=?,hot=?,target=?,aliases=?,since=0,coverage=0,error=? WHERE id=?',
                             ('ssd', str(destination), str(cold_target), json.dumps(record['aliases']), 'awaiting watcher', restoring['id']))
        else:
            if demoting:
                store.db.execute('UPDATE roots SET target=?,location=?,hot=?,aliases=?,since=0,coverage=0,error=? WHERE id=?',
                                 (str(destination), 'hdd', '', json.dumps(record['aliases']), 'awaiting watcher', demoting['id']))
            else: store.register(source, destination)
            if staged.is_symlink():
                staged.unlink()
                remove_retired(retired,cfg['max_scan_entries'])
            else: remove_retired(staged,cfg['max_scan_entries'])
        store.db.commit()
        if mirror_stage is not None and os.path.lexists(mirror_stage):
            if not mirror_stage.is_symlink():raise ValueError('mirror staging changed; retained')
            mirror_stage.unlink();flush_directory(mirror_stage.parent)
        record['phase'] = 'complete'; record['completed'] = time.time()
        record['allocated_bytes'] = size
        with (store.state / 'moves.jsonl').open('a') as f:
            f.write(json.dumps(record) + '\n'); f.flush(); os.fsync(f.fileno())
        journal.unlink(); flush_directory(store.state)
        print('MOVED', source, 'SSD_free_GiB', round(shutil.disk_usage(Path.home()).free / 1024**3, 2), flush=True)
    except BaseException as error:
        # An interrupted publish retains both copies and its journal for recovery.
        if not published:
            try:remove_retired(destination,cfg['max_scan_entries'])
            except (OSError,ValueError) as cleanup:
                record.update(phase='aborted-cleanup-needed',error=str(error)[:300],cleanup_error=str(cleanup)[:300])
                atomic_json(journal,record)
                raise ValueError(str(error)+'; unpublished staging cleanup deferred; original and recovery journal retained') from cleanup
            journal.unlink(missing_ok=True);flush_directory(store.state)
        raise
    finally: guard.close()


def abort_unpublished(store,cfg):
    """Discard only journaled, unpublished staging while keeping the authoritative source."""
    journal=store.state/'operation.json';record=bounded_json(journal)
    if record.get('phase') not in ('copying','verifying','syncing','aborted-cleanup-needed') or record.get('restore'):
        raise ValueError('operation may be published or a restore; both copies retained')
    source=absolute(record['source']);original=absolute(record['original']);destination=absolute(record['destination'])
    archive=mount_ready(cfg)
    if (destination.parent.parent!=archive/'data' or len(destination.parent.name)!=32 or
            any(c not in '0123456789abcdef' for c in destination.parent.name) or destination.name!=source.name):
        raise ValueError('unrecognized staging destination; preserved')
    if source.resolve()!=original or not original.exists() or original.lstat().st_uid!=os.getuid():
        raise ValueError('authoritative source changed; staging retained')
    if store.db.execute('SELECT 1 FROM roots WHERE target=?',(str(destination),)).fetchone() or references([destination]):
        raise ValueError('staging is registered or active; retained')
    remove_retired(destination,cfg['max_scan_entries'])
    journal.unlink();flush_directory(store.state)
    print('Discarded unpublished staging; authoritative source preserved',source,flush=True)


def proof_digest(proof):
    fd=os.open(proof,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_size>1024**2:
            raise ValueError('regeneration proof must be an owned regular file no larger than 1 MiB')
        with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(1024**2+1)
        after=os.fstat(fd)
        if len(raw)>1024**2 or (info.st_ino,info.st_mtime_ns,info.st_ctime_ns)!=(after.st_ino,after.st_mtime_ns,after.st_ctime_ns):
            raise ValueError('regeneration proof changed during read')
        return hashlib.sha256(raw).hexdigest()
    finally:os.close(fd)


def artifact_module():
    spec=importlib.util.spec_from_file_location('artifact_proof',Path(__file__).with_name('artifact-proof.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def verify_artifacts(store,cfg,max_files=100,seconds=60):
    api=SimpleNamespace(ReadBudget=ReadBudget,excluded_unit=excluded_unit,bounded_json=bounded_json,
                        proof_digest=proof_digest,atomic_json=atomic_json,record_scope=record_scope)
    return artifact_module().verify(store,cfg,api,max_files,seconds)


def verified_files(scope):
    if not scope['recipe'].startswith('verified-files-v1:'):return None
    manifest=bounded_json(scope['proof'],1024**2)
    if not isinstance(manifest,dict) or manifest.get('schema')!='verified-files-v1' or manifest.get('scope')!=scope['path'] or not isinstance(manifest.get('files'),dict):
        raise ValueError('invalid verified artifact manifest')
    return manifest['files']


def broker_references(paths,cfg):
    """A root-owned read-only collector resolves inaccessible process references."""
    address=cfg.get('reference_socket','')
    if not address or not os.path.lexists(address):return None
    info=Path(address).lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=0:raise ValueError('untrusted process reference socket')
    nonce=uuid.uuid4().hex
    request=json.dumps({'nonce':nonce,'paths':[str(p) for p in paths]}).encode()+b'\n'
    if len(request)>262144:raise ValueError('process reference request budget exceeded')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(35);client.connect(address)
        if struct.unpack('3i',client.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=0:
            raise ValueError('process reference collector is not root-owned')
        client.sendall(request)
        with client.makefile('rb') as stream:raw=stream.readline(262145)
    if len(raw)>262144:raise ValueError('process reference response budget exceeded')
    report=json.loads(raw)
    if report.get('nonce')!=nonce or not report.get('complete') or report.get('identities')!=[
            [p.stat().st_dev,p.stat().st_ino] for p in paths]:
        raise ValueError('process-reference coverage incomplete or file identity changed')
    blocked=report.get('blocked')
    if not isinstance(blocked,list) or any(type(n)!=int or not 0<=n<len(paths) for n in blocked):
        raise ValueError('invalid process reference report')
    return set(blocked)


def record_scope(store, key, relative, recipe, proof):
    root = store.root(key); rel = Path(relative)
    if rel.is_absolute() or '..' in rel.parts or str(rel) == '.': raise ValueError('scope must be a strict subtree')
    target = live_path(root)
    scope = target / rel
    if scope.resolve() != scope or not scope.is_dir(): raise ValueError('scope must be a real directory without symlinks')
    proof = absolute(proof)
    if within(proof.resolve(), scope): raise ValueError('regeneration proof must survive pruning')
    if not recipe.strip(): raise ValueError('a verified regeneration recipe is required')
    digest = proof_digest(proof)
    store.db.execute('INSERT OR REPLACE INTO scopes VALUES (?,?,?,?,?)', (root['id'], str(rel), recipe, str(proof), digest))
    store.db.commit()


def quiet(store, root, relative, info, now, days):
    # Directory activity is recorded only for newly admitted/renamed subtrees.
    # Ordinary file reads never update their parents' retention clocks.
    parts = [relative, '.', *[str(p) for p in Path(relative).parents if str(p) != '.']]
    placeholders = ','.join('?' for _ in parts)
    row = store.db.execute(f'SELECT MAX(accessed) FROM activity WHERE root=? AND path IN ({placeholders})',
                           (root['id'], *parts)).fetchone()
    last = max(root['since'], row[0] or 0, info.st_mtime)
    return bool(root['coverage'] and root['since'] and now - last >= days * DAY)


def gc(store, cfg, apply=False, now=None, barrier=None):
    now = now or time.time(); summary = {'eligible_files': 0, 'eligible_bytes': 0, 'deleted_files': 0, 'errors': []}
    # Missing heartbeat, startup gaps or inotify overflow fail closed.
    heartbeat = store.get('heartbeat', 0)
    if not heartbeat or now - heartbeat > 60:
        summary['errors'].append('watcher coverage is stale'); return summary
    if apply and barrier is None:
        raise ValueError('destructive GC must run inside the live watcher event barrier')
    seen = 0; candidates=[]; visited_bases=[]; limit=False
    for root in store.roots():
        if root['location'] != 'hdd' or not root['coverage']: continue
        target = Path(root['target']); source = Path(root['source'])
        if source.resolve() != target.resolve(): continue
        for scope in store.db.execute('SELECT * FROM scopes WHERE root=?', (root['id'],)):
            try:
                proof = Path(scope['proof'])
                if proof_digest(proof) != scope['digest']: continue
                manifest=verified_files(scope)
                base = target / scope['path']
                if excluded_unit(base,cfg): continue
                if not within(base, target) or base.resolve() != base: continue
                visited_bases.append(base)
                for directory, dirs, files in os.walk(base, followlinks=False):
                    dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
                    for name in files:
                        seen += 1
                        if seen > cfg['max_gc_files']: limit=True;break
                        p = Path(directory) / name; info = p.lstat()
                        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid(): continue
                        rel = str(p.relative_to(target))
                        if manifest is not None:
                            record=manifest.get(str(p.relative_to(base)),{})
                            if not isinstance(record,dict):continue
                            identity=[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns]
                            verified_at=record.get('verified_at',now)
                            if (record.get('identity')!=identity or type(verified_at) not in (int,float) or not math.isfinite(verified_at) or
                                    now-verified_at<cfg['retention_days']*DAY):continue
                        if not quiet(store, root, rel, info, now, cfg['retention_days']): continue
                        if summary['eligible_bytes'] + info.st_size > cfg['max_gc_bytes']:limit=True;break
                        summary['eligible_files'] += 1; summary['eligible_bytes'] += info.st_size
                        candidates.append((root,p,info,rel,scope))
                    if limit:break
            except (OSError, ValueError) as e: summary['errors'].append(str(e)[:200])
            if limit:break
        if limit:break
    if apply and candidates:
        # One bounded all-process scan per batch; event barriers catch later opens.
        candidates=candidates[:1000]
        try:blocked=broker_references([p for _,p,_,_,_ in candidates],cfg)
        except (OSError,ValueError) as e:
            summary['errors'].append(str(e)[:200]);return summary
        for index,(root,p,info,rel,scope) in enumerate(candidates):
            try:
                if blocked is not None:
                    if index in blocked:continue
                elif references([p,Path(root['source'])/rel],strict=True):continue
                barrier()
                fresh=store.root(root['id']);current=p.lstat()
                if proof_digest(scope['proof'])!=scope['digest']:continue
                if (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=(
                        current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns,current.st_ctime_ns):continue
                if not quiet(store,fresh,rel,current,now,cfg['retention_days']):continue
                p.unlink();summary['deleted_files']+=1
                store.db.execute('DELETE FROM activity WHERE root=? AND path=?',(root['id'],rel))
            except (OSError,ValueError) as e:
                summary['errors'].append(str(e)[:200]);break
        for base in visited_bases:
            for directory,dirs,_ in os.walk(base,topdown=False,followlinks=False):
                for name in dirs:
                    p=Path(directory)/name
                    if not p.is_symlink():
                        try:p.rmdir()
                        except OSError:pass
    store.db.commit(); return summary


def demand(store, root, now):
    return store.db.execute('SELECT COALESCE(SUM(reads),0),COALESCE(SUM(opens),0),COALESCE(MAX(accessed),0) FROM activity WHERE root=? AND hour>=?',
                            (root['id'], int(now // 3600)-1)).fetchone()


def decisions(store, cfg, now=None):
    now = now or time.time(); rows = []
    for root in store.roots():
        reads, opens, _ = demand(store, root, now)
        latency = store.db.execute('SELECT * FROM latency WHERE root=?', (root['id'],)).fetchone()
        impact = bool(latency and now - latency['measured'] < 30*DAY and
                      latency['hdd_ms'] - latency['ssd_ms'] >= cfg['promotion_min_saving_ms'] and
                      (latency['hdd_ms'] - latency['ssd_ms']) / latency['hdd_ms'] >= cfg['promotion_min_saving_ratio'])
        last = store.db.execute('SELECT MAX(accessed) FROM activity WHERE root=?', (root['id'],)).fetchone()[0] or root['since']
        cached = root['location'] == 'hdd' and any(within(absolute(root['target']), absolute(p))
                                                  for p in cfg.get('block_cached_mounts', []))
        action = 'block_cache' if cached else 'hdd'
        if root['location'] == 'hdd' and not cached and reads >= cfg['promotion_reads_per_hour']:
            action = 'promote' if impact else 'measure_task_latency'
        elif root['location'] == 'ssd':
            if excluded_unit(live_path(root),cfg): action='protected'
            else: action = 'demote' if root['coverage'] and root['since'] and now - max(root['since'], last) >= cfg['demotion_idle_days']*DAY else 'ssd'
        rows.append({'id': root['id'], 'source': root['source'], 'location': root['location'],
                     'coverage': bool(root['coverage']), 'coverage_error': root['error'],
                     'observed_since': root['since'], 'recent_reads': reads, 'recent_opens': opens,
                     'measured_latency_impact': impact, 'block_cached': cached, 'decision': action})
    return rows


def consume_events(store, watcher, roots, defer_topology=False):
    """Coalesce demand; repair only changed subtrees, without full scan loops."""
    byid = {r['id']: r for r in roots}; rebuild = False; now = time.time(); activity = {}
    for key, path, mask in (watcher.events(include_deferred=False) if defer_topology else watcher.events()):
        if mask & OVERFLOW:
            store.db.execute('UPDATE roots SET coverage=0,since=0,error=?', ('inotify overflow: quiet clock reset',))
            if hasattr(watcher,'rebuild_roots'): watcher.rebuild_roots.update(byid)
            rebuild = True; continue
        if key not in byid: continue
        root = byid[key]
        base = live_path(root)
        topology = mask & (DELETE_SELF | MOVE_SELF | IGNORED) or (mask & ISDIR and mask & (CREATE | MOVED_FROM | MOVED_TO | DELETE))
        if topology:
            if defer_topology:
                if len(watcher.deferred)>=65536:
                    store.db.execute('UPDATE roots SET coverage=0,since=0,error=?',('topology queue overflow: quiet clock reset',))
                    watcher.rebuild_roots.update(byid);watcher.deferred=[]
                watcher.deferred.append((key,path,mask)); continue
            try:
                if path and within(path,base) and mask & ISDIR and mask & (CREATE | MOVED_TO):
                    store.activity(key,str(path.relative_to(base)),MODIFY,now)
                    boundaries=getattr(watcher,'boundaries',{}).get(key,[base])
                    if any(within(path,b) for b in boundaries):
                        if path.is_dir() and not path.is_symlink():watcher.tree(path,key)
                    elif any(within(b,path) for b in boundaries):watcher.rebuild_roots.add(key);rebuild=True
                elif path and mask & (DELETE_SELF | MOVE_SELF | IGNORED | MOVED_FROM | DELETE):
                    watcher.remove_path(path)
                    if path==base:
                        store.db.execute('UPDATE roots SET coverage=0,since=0,error=? WHERE id=?',('root changed: waiting for re-admission',key))
                        watcher.rebuild_roots.add(key); rebuild=True
            except (OSError,ValueError) as e:
                store.db.execute('UPDATE roots SET coverage=0,since=0,error=? WHERE id=?',(str(e)[:200],key))
        if not mask & ISDIR and path and mask & (ACCESS | OPEN | MODIFY | ATTRIB | CREATE | MOVED_TO):
            if within(path, base):
                identity = (key,str(path.relative_to(base)))
                activity[identity] = activity.get(identity,0) | mask
    for (key,path),mask in activity.items(): store.activity(key,path,mask,now)
    store.db.commit()
    return rebuild


def watch(store, cfg):
    with lock(store.state / 'watch.lock'):
        watcher = Inotify(cfg['max_watches']); signatures = {}; next_report = 0; next_adopt = 0; next_gc = time.time() + 3600
        store.db.execute('UPDATE roots SET coverage=0,since=0,error=?', ('watcher restarted: quiet clock reset',)); store.db.commit()
        try:
            while True:
                if time.time() >= next_adopt:
                    try:
                        if (store.state/'default-route-operation.json').exists():
                            try:
                                with lock(store.state / 'move.lock'): recover_default_route(store)
                            except BlockingIOError: pass
                        # Copies may take hours; late parent-FD writes must stay
                        # discoverable during them. Internal staging is excluded.
                        adopt_defaults(store, cfg); store.put('defaults_error',None);store.db.commit()
                    except (OSError, ValueError) as e: store.put('defaults_error', str(e)[:200]); store.db.commit()
                    next_adopt = time.time() + 60
                # HDD roots can be retained/pruned; prioritize their complete
                # coverage over SSD roots which are ineligible for retention.
                roots = sorted(store.roots(), key=lambda r: (r['location'] != 'hdd', r['created']))
                current = {r['id']:watch_signature(store,r,cfg) for r in roots}
                watcher.boundaries={r['id']:retention_paths(store,r,cfg) for r in roots}
                for key in set(signatures)-set(current): watcher.remove_root(key); signatures.pop(key)
                def progress():
                    consume_events(store,watcher,roots,defer_topology=True)
                    store.put('heartbeat',time.time());store.put('watches',len(watcher.paths));store.db.commit()
                watcher.on_progress=progress
                for root in roots:
                    key=root['id']
                    if signatures.get(key)!=current[key] or key in watcher.rebuild_roots:
                        watcher.rebuild_roots.discard(key);watcher.remove_root(key)
                        paths=watcher.boundaries[key]
                        if not paths:
                            reason=('original SSD watches disabled; migration guard remains active' if root['location']=='ssd'
                                    else 'unique data retained; native block cache handles demand; no retention scope')
                            store.db.execute('UPDATE roots SET coverage=0,since=0,error=? WHERE id=?',
                                             (reason,key))
                            signatures[key]=current[key];store.db.commit();continue
                        if signatures.get(key)!=current[key]:
                            store.db.execute('UPDATE roots SET coverage=0,since=0 WHERE id=?',(key,));store.db.commit()
                        for attempt in range(2):
                            try:
                                path = live_path(root)
                                if Path(root['source']).resolve() != path:
                                    raise ValueError('source symlink differs from ledger')
                                for scope in paths:
                                    if scope.resolve()!=scope or not scope.exists():raise ValueError('retention watch path changed')
                                    for ancestor in [p for p in scope.parents if within(p,path)]:watcher.add(ancestor,key)
                                    watcher.tree(scope,key)
                                store.db.execute('UPDATE roots SET coverage=1,since=CASE WHEN since=0 THEN ? ELSE since END,error=? WHERE id=?',
                                                 (time.time(), '', root['id']))
                                break
                            except (OSError, ValueError) as e:
                                # Partial admission provides no retention evidence.
                                watcher.remove_root(key)
                                if attempt == 0 and root['location']=='hdd' and str(e)=='watch budget exceeded':
                                    victims=[r for r in roots if r['location']=='ssd' and watcher.by_root.get(r['id'])]
                                    for victim in victims:
                                        store.db.execute('UPDATE roots SET coverage=0,since=0,error=? WHERE id=?',
                                                         ('HDD coverage takes priority',victim['id']))
                                        watcher.remove_root(victim['id']);signatures.pop(victim['id'],None)
                                    if victims:
                                        watcher.rebuild_roots.update(r['id'] for r in roots if r['location']=='hdd' and not r['coverage'] and r['id']!=key)
                                        continue
                                store.db.execute('UPDATE roots SET coverage=0,since=0,error=? WHERE id=?', (str(e)[:200], root['id']))
                                break
                        signatures[key]=current[key];store.db.commit()
                select.select([watcher.fd], [], [], 2)
                now = time.time()
                consume_events(store,watcher,roots)
                store.put('heartbeat', now); store.put('watches', len(watcher.paths)); store.db.commit()
                if now >= next_report:
                    atomic_json(store.state / 'status.json', {'timestamp': now, 'watches': len(watcher.paths), 'roots': decisions(store, cfg)})
                    next_report = now + 30
                if now >= next_gc or store.get('gc_requested', False):
                    if cfg['automatic_gc'] or store.get('gc_requested', False):
                        try:
                            with lock(store.state / 'move.lock'):
                                def barrier():
                                    consume_events(store,watcher,roots)
                                store.put('last_gc', gc(store, cfg, apply=True, barrier=barrier))
                                store.put('gc_requested', False)
                        except BlockingIOError: pass
                    store.db.commit(); next_gc = now + DAY
        finally:
            store.db.execute('UPDATE roots SET coverage=0,since=0,error=?', ('watcher stopped',)); store.db.commit()
            watcher.close()


def queue_add(store, source, action='move'):
    store.db.execute('INSERT OR REPLACE INTO queue VALUES (?,?,?,\'\',?)', (str(absolute(source)), action, 'pending', time.time()))
    store.db.commit()


def drain(store, cfg):
    with lock(store.state / 'move.lock'):
        if store.state.joinpath('operation.json').exists(): raise ValueError('unfinished operation; inspect recovery journal')
        if cfg.get('mirror_layout',False):route_defaults(store,cfg)
        # A decision can promote only with both recorded demand and matched task timing.
        if time.time() - store.get('heartbeat', 0) < 60:
            for row in decisions(store, cfg):
                if row['decision'] == 'promote' and cfg['automatic_promotion']: queue_add(store, row['source'], 'restore')
                if row['decision'] == 'demote' and cfg['automatic_demotion']: queue_add(store, row['source'], 'demote')
        jobs=list(store.db.execute("""SELECT * FROM queue WHERE status IN ('pending','deferred')
          ORDER BY CASE action WHEN 'default' THEN 0 WHEN 'partition' THEN 1 ELSE 2 END,
          CASE WHEN action='default' THEN length(source) ELSE 0 END, updated"""))
        if cfg.get('automatic_artifact_verification',True):
            verify_artifacts(store,cfg)
    for job in jobs:
        # Release between units so newly requested parent cutovers and daily GC
        # are not blocked for the duration of an entire large rollout.
        with lock(store.state / 'move.lock'):
            if store.state.joinpath('operation.json').exists(): raise ValueError('unfinished operation; inspect recovery journal')
            current=store.db.execute('SELECT * FROM queue WHERE source=?',(job['source'],)).fetchone()
            if not current or current['status'] not in ('pending','deferred') or current['action']!=job['action']: continue
            source = Path(job['source'])
            store.db.execute('UPDATE queue SET status=?,updated=? WHERE source=?', ('running', time.time(), str(source))); store.db.commit()
            try:
                if job['action'] == 'default':
                    parent=next((p for p in store.get('defaults',[]) if p['source']==str(source)),None)
                    if parent:
                        if source.resolve()!=Path(parent['hdd']): raise ValueError('default path changed; review required')
                    else:
                        try:registered=store.root(str(source))
                        except ValueError as e:
                            if not str(e).startswith('unknown root:'):raise
                            registered=None
                        if registered:
                            if Path(registered['source']).resolve()!=live_path(registered).resolve():raise ValueError('tracked public path changed; review required')
                            if registered['location']=='ssd':partition_root(store,cfg,registered['id'])
                        else:bridge_parent(store,cfg,source)
                    if cfg.get('mirror_layout',False):route_defaults(store,cfg)
                    else:adopt_defaults(store,cfg)
                elif job['action'] == 'partition':
                    root=store.root(str(source))
                    if root['location']=='ssd': partition_root(store,cfg,root['id'])
                    if cfg.get('mirror_layout',False):route_defaults(store,cfg)
                elif job['action']=='rehome':
                    root=store.root(str(source))
                    if root['location']!='hdd' or not cfg.get('mirror_layout',False):raise ValueError('rehome requires a mirrored HDD root')
                    if live_path(root)!=mirror_path(store,mount_ready(cfg),source):migrate(store,cfg,source,demoting=root)
                elif job['action'] == 'restore': migrate(store, cfg, source, restoring=store.root(str(source)))
                elif job['action'] == 'demote':
                    old = store.root(str(source))
                    migrate(store, cfg, source, demoting=old)
                elif job['action'] == 'move':
                    registered = store.db.execute('SELECT * FROM roots WHERE source=?', (str(source),)).fetchone()
                    if registered and registered['location'] == 'ssd': migrate(store, cfg, source, demoting=registered)
                    else: migrate(store, cfg, source)
                else: raise ValueError('unknown queue action')
                status, error = 'complete', ''
            except (OSError, ValueError, subprocess.SubprocessError) as e:
                status, error = 'deferred', str(e)[:300]
                print('DEFER', source, error, flush=True)
            store.db.execute('UPDATE queue SET status=?,error=?,updated=? WHERE source=?', (status, error, time.time(), str(source))); store.db.commit()
            if (store.state/'operation.json').exists():
                raise ValueError('migration halted with recovery journal; subsequent jobs are preserved')


def discover(cfg, bases):
    """Return immediate migration units of all sizes; aggregate directories count."""
    rows = []
    for raw in bases:
        base = absolute(raw)
        with os.scandir(base) as entries:
            for entry in entries:
                path = Path(entry.path)
                try:
                    if path.is_symlink(): continue
                    valid_source(path, cfg)
                    _, size = inventory(path, cfg['max_scan_entries'])
                    rows.append({'path': str(path), 'allocated_bytes': size, 'kind': 'folder' if path.is_dir() else 'file'})
                except (OSError, ValueError) as e: rows.append({'path': str(path), 'deferred': str(e)[:160]})
    return sorted(rows, key=lambda r: r.get('allocated_bytes', 0), reverse=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', default=str(Path.home() / '.local/state/qq-cold-tier'))
    parser.add_argument('--config', default=str(Path.home() / '.config/qq-cold-tier.json'))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('init'); sub.add_parser('watch'); sub.add_parser('status'); sub.add_parser('drain'); sub.add_parser('route-defaults'); sub.add_parser('recover-published');sub.add_parser('abort-unpublished')
    p = sub.add_parser('discover'); p.add_argument('paths', nargs='+')
    p = sub.add_parser('defaults'); p.add_argument('paths', nargs='+')
    p = sub.add_parser('namespace-alias');p.add_argument('public');p.add_argument('backing')
    p = sub.add_parser('queue'); p.add_argument('--action',choices=('move','default','partition','rehome'),default='move');p.add_argument('paths', nargs='+')
    p = sub.add_parser('move'); p.add_argument('path')
    p = sub.add_parser('restore'); p.add_argument('root')
    p = sub.add_parser('split'); p.add_argument('root'); p.add_argument('relative')
    p = sub.add_parser('partition'); p.add_argument('root')
    p = sub.add_parser('register'); p.add_argument('source'); p.add_argument('target')
    p = sub.add_parser('regenerable'); p.add_argument('root'); p.add_argument('relative'); p.add_argument('--recipe', required=True); p.add_argument('--proof', required=True); p.add_argument('--verified', action='store_true', required=True)
    p = sub.add_parser('latency'); p.add_argument('root'); p.add_argument('--task', required=True); p.add_argument('--hdd-ms', type=float, required=True); p.add_argument('--ssd-ms', type=float, required=True)
    p = sub.add_parser('gc'); p.add_argument('--apply', action='store_true')
    p = sub.add_parser('verify-cargo-cache');p.add_argument('--max-files',type=int,default=100);p.add_argument('--seconds',type=int,default=60)
    args = parser.parse_args(); config_path = absolute(args.config)
    if args.command == 'init' and not config_path.exists():
        config_path.parent.mkdir(parents=True, exist_ok=True); atomic_json(config_path, DEFAULT)
    cfg = dict(DEFAULT); cfg.update(bounded_json(config_path))
    if cfg['schema'] != 1 or cfg['retention_days'] < 30: raise ValueError('unsupported policy or retention shorter than 30 days')
    if not isinstance(cfg['block_cached_mounts'], list) or any(not isinstance(p, str) or
            not Path(p).is_absolute() or Path(p) == Path('/') for p in cfg['block_cached_mounts']):
        raise ValueError('block-cached mounts must be absolute non-root paths')
    for key in ('max_watches', 'max_scan_entries', 'copy_kib_per_second', 'verify_bytes_per_second', 'max_gc_files', 'max_gc_bytes'):
        if not isinstance(cfg[key], int) or cfg[key] <= 0: raise ValueError('invalid budget ' + key)
    store = Store(args.state_dir)
    if args.command in ('drain','move','restore','discover','route-defaults','recover-published','verify-cargo-cache','abort-unpublished'): contain_job(cfg)
    if args.command == 'init': mount_ready(cfg); print('Initialized', store.state)
    elif args.command == 'watch': watch(store, cfg)
    elif args.command == 'status':
        print(json.dumps({'defaults': store.get('defaults', []), 'defaults_error': store.get('defaults_error'),
                          'roots': decisions(store, cfg), 'queue': [dict(r) for r in store.db.execute('SELECT * FROM queue')],
                          'heartbeat': store.get('heartbeat'), 'watches': store.get('watches'), 'last_gc': store.get('last_gc')}, indent=2))
    elif args.command == 'register':
        source, target = absolute(args.source), absolute(args.target)
        if not source.is_symlink() or source.resolve() != target or not target.exists(): raise ValueError('existing source link must point exactly to the target')
        if target.stat().st_dev != mount_ready(cfg).stat().st_dev: raise ValueError('target must be on configured HDD')
        print(store.register(source, target))
    elif args.command=='namespace-alias':
        with lock(store.state/'move.lock'):namespace_alias(store,cfg,args.public,args.backing)
    elif args.command == 'queue':
        for path in args.paths:
            if args.action in ('partition','rehome'):
                queue_add(store,store.root(path)['source'],args.action);continue
            if args.action=='default':
                try:registered=store.root(str(absolute(path)))
                except ValueError as e:
                    if not str(e).startswith('unknown root:'):raise
                    registered=None
                queue_add(store,registered['source'] if registered else valid_source(path,cfg),'default');continue
            registered = store.db.execute('SELECT * FROM roots WHERE source=?', (str(absolute(path)),)).fetchone()
            queue_add(store, registered['source'] if registered and registered['location']=='ssd' else valid_source(path, cfg),args.action)
    elif args.command == 'drain': drain(store, cfg)
    elif args.command == 'recover-published':
        with lock(store.state/'move.lock'): recover_published(store,cfg)
    elif args.command=='abort-unpublished':
        with lock(store.state/'move.lock'):abort_unpublished(store,cfg)
    elif args.command == 'route-defaults':
        with lock(store.state / 'move.lock'): route_defaults(store, cfg)
    elif args.command == 'partition':
        with lock(store.state / 'move.lock'):
            partition_root(store, cfg, args.root)
            if cfg.get('mirror_layout',False):route_defaults(store,cfg)
    elif args.command == 'move':
        with lock(store.state / 'move.lock'): migrate(store, cfg, args.path)
    elif args.command == 'restore':
        with lock(store.state / 'move.lock'): migrate(store, cfg, store.root(args.root)['source'], restoring=store.root(args.root))
    elif args.command == 'split':
        root = store.root(args.root); relative = Path(args.relative)
        if root['location'] != 'hdd' or relative.is_absolute() or '..' in relative.parts or str(relative)=='.':
            raise ValueError('split requires a real HDD child path')
        target = Path(root['target']) / relative
        if target.resolve() != target or not target.exists(): raise ValueError('split child has symlinks or is absent')
        print(store.register(Path(root['source']) / relative, target))
    elif args.command == 'regenerable': record_scope(store, args.root, args.relative, args.recipe, args.proof)
    elif args.command=='verify-cargo-cache':
        with lock(store.state/'move.lock'):
            print(json.dumps(verify_artifacts(store,cfg,args.max_files,args.seconds),indent=2))
    elif args.command == 'latency':
        if not (args.hdd_ms > 0 and args.ssd_ms > 0): raise ValueError('positive matched task timings required')
        store.db.execute('INSERT OR REPLACE INTO latency VALUES (?,?,?,?,?)', (store.root(args.root)['id'], args.task, args.hdd_ms, args.ssd_ms, time.time())); store.db.commit()
    elif args.command == 'gc':
        if args.apply:
            store.put('gc_requested', True); store.db.commit()
            print('GC requested; the live watcher checks queued access before any deletion')
        else: print(json.dumps(gc(store, cfg), indent=2))
    elif args.command == 'discover': print(json.dumps(discover(cfg, args.paths), indent=2))
    elif args.command == 'defaults':
        with lock(store.state / 'move.lock'):
            for path in args.paths: bridge_parent(store, cfg, path)
            if cfg.get('mirror_layout',False):route_defaults(store,cfg)
            else:adopt_defaults(store,cfg)


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print('cold-tier:', error, file=sys.stderr); sys.exit(1)
