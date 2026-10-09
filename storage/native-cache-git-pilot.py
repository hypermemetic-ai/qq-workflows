"""Fixed, read-only Git workload on an independent snapshot in the trial image.

No hooks, user Git configuration, arbitrary commands, live repository writes or
global cache eviction. This is an application measurement, not a live cutover.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import time

MIB = 1024**2
MAX_BYTES = 128*MIB
MAX_FILES = 20000
GIT = '/usr/bin/git'
COMMANDS = {
    'history': ('log', '--max-count=256', '--format=%H'),
    'source_search': ('grep', '-l', '-I', '-F', 'cache', 'HEAD', '--', 'storage', 'scripts', 'docs'),
}


class GitWorkload:
    def __init__(self, mountpoint, source, operator_uid):
        self.mountpoint = Path(mountpoint)
        self.source = Path(source).resolve(strict=True)
        self.snapshot = self.mountpoint/'application.git'
        self.uid = operator_uid
        self.expected = {}
        self.report = {'workload': 'Git history and source search', 'source': str(self.source),
                'writes_live_repository': False, 'snapshot_budget_bytes': MAX_BYTES,
                'ram_eviction': 'POSIX_FADV_DONTNEED on snapshot files only; advisory, metadata/drive caches may remain',
                'real_application': 'git', 'commands': {k:list(v) for k,v in COMMANDS.items()}}

    def git(self, directory, *args):
        # A fixed system binary and configuration prevent hooks, fsmonitor,
        # pagers, inherited alternate object directories and user shell commands.
        env = {'PATH':'/usr/bin:/bin', 'HOME':str(self.mountpoint), 'LC_ALL':'C',
                'GIT_CONFIG_NOSYSTEM':'1', 'GIT_CONFIG_GLOBAL':'/dev/null',
                'GIT_TERMINAL_PROMPT':'0', 'GIT_PAGER':'cat'}
        command = [GIT, '--no-pager', '--no-optional-locks', '-c', 'safe.directory='+str(directory),
                '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
                '-c', 'pack.threads=1', '-c', 'pack.windowMemory=16m', '-c', 'pack.window=0',
                '-C', str(directory), *map(str,args)]
        result = subprocess.run(command, env=env, capture_output=True, timeout=90)
        if len(result.stdout)>2*MIB or len(result.stderr)>2*MIB:
            raise ValueError('Git pilot output budget exceeded')
        if result.returncode:
            raise RuntimeError('Git pilot failed: '+result.stderr.decode(errors='replace')[-1500:])
        return result.stdout

    def head(self, directory):
        value = self.git(directory, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
        if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', value):
            raise ValueError('Unexpected snapshot commit identifier')
        return value

    def files(self):
        result = []; size = 0
        for root, dirs, names in os.walk(self.snapshot, followlinks=False):
            for name in dirs+names:
                p = Path(root)/name; s = p.lstat()
                if stat.S_ISLNK(s.st_mode) or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
                    raise ValueError('Unexpected linked or special snapshot entry')
                if stat.S_ISREG(s.st_mode):
                    result.append(p); size += s.st_size
                if len(result)>MAX_FILES or size>MAX_BYTES:
                    raise ValueError('Git snapshot exceeds the bounded pilot budget')
        return result, size

    def prepare(self):
        if self.uid<=0 or self.source.stat().st_uid!=self.uid:
            raise ValueError('Git pilot source must belong to the operator')
        if os.path.lexists(self.snapshot):raise ValueError('Snapshot destination already exists')
        before = self.head(self.source)
        counts = dict(line.split(': ',1) for line in self.git(self.source,'count-objects','-v').decode().splitlines())
        if (int(counts['size'])+int(counts['size-pack']))*1024>MAX_BYTES:
            raise ValueError('Source Git object budget exceeded')
        self.git(self.source,'clone','--quiet','--bare','--no-local',self.source,self.snapshot)
        if self.head(self.snapshot)!=before or self.head(self.source)!=before:
            raise ValueError('Source HEAD changed during the snapshot; live work was left untouched')
        if (self.snapshot/'objects/info/alternates').exists():
            raise ValueError('Snapshot must not depend on live Git objects')
        files, size = self.files()
        for p in files:
            fd = os.open(p, os.O_RDONLY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
        # Persist Git's directory entries before the first clean detach.
        directories = [Path(root) for root,_,_ in os.walk(self.snapshot)]
        for p in reversed(directories):
            fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
        self.report.update(commit=before, snapshot_files=len(files), snapshot_bytes=size)

    def evict(self):
        files, _ = self.files()
        for p in files:
            fd = os.open(p, os.O_RDONLY|os.O_NOFOLLOW)
            try:os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)
            finally:os.close(fd)

    def sample(self):
        result = {}
        for name, args in COMMANDS.items():
            self.evict()
            start = time.perf_counter_ns(); output = self.git(self.snapshot,*args)
            elapsed = (time.perf_counter_ns()-start)/1e6
            digest = hashlib.sha256(output).hexdigest()
            if name in self.expected and self.expected[name]!=digest:
                raise ValueError('Git result changed between storage phases: '+name)
            self.expected[name]=digest
            result[name]={'milliseconds':elapsed,'output_sha256':digest,'output_bytes':len(output)}
        return result

    def measure(self, phase):
        if self.head(self.snapshot)!=self.report['commit']:raise ValueError('Snapshot HEAD changed')
        warmup = 0
        if phase=='cached':
            started=time.monotonic()
            while warmup<6 and (warmup<3 or time.monotonic()-started<4):
                self.sample();warmup+=1;time.sleep(.3)
        samples=[self.sample() for _ in range(3 if phase in ('hdd_baseline','cached') else 1)]
        mean={name:sum(s[name]['milliseconds'] for s in samples)/len(samples) for name in COMMANDS}
        self.report[phase]={'samples':samples,'mean_ms':mean,'total_mean_ms':sum(mean.values()),'warmup_passes':warmup}
        if phase=='cached':
            baseline=self.report['hdd_baseline']['total_mean_ms'];cached=sum(mean.values())
            self.report['cached_to_hdd_ratio']=cached/baseline
            self.report['saving_ms']=baseline-cached
            self.report['benefit_observed']=cached<=baseline*.8 and baseline-cached>=50
