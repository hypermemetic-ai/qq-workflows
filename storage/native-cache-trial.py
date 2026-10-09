#!/usr/bin/env python3
"""Isolated, administrator-run trial of an image-backed dm-cache volume.

Formats only a newly created loop image. No existing mount, service, partition,
user directory or retention policy is changed. A successful trial is not a
production activation or a power-loss test.
"""
import argparse
from contextlib import closing
import fcntl
import hashlib
import importlib.util
import json
import mmap
import os
from pathlib import Path
import pwd
import random
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

MIB = 1024**2
SSD_BASE = Path('/var/lib/qq-native-cache-trial')
HDD_BASE = Path('/srv/media-box/.qq-native-cache-trial')
EXPECTED_MOUNTS = {
    '/': ('/dev/sda3', 'afc8804c-8a1c-4a5b-a75f-b4252ea492fe'),
    '/srv/media-box': ('/dev/sdb1', 'f404c6d7-2a96-492b-b9d5-068607680afe'),
}
SIZES = {'origin.img': 512*MIB, 'cache.img': 64*MIB, 'metadata.img': 16*MIB}
DATA_MIB = 16
TOOLS = {name: shutil.which(name, path='/usr/sbin:/usr/bin:/sbin:/bin') for name in
         ('systemd-run', 'findmnt', 'losetup', 'dmsetup', 'modprobe', 'mkfs.ext4', 'e2fsck', 'mount', 'umount', 'udevadm')}


def run(name, *args, timeout=30):
    executable = TOOLS.get(name)
    if not executable: raise RuntimeError('Required host tool missing: '+name)
    result = subprocess.run([executable, *map(str, args)], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(name+': '+(result.stderr or result.stdout)[-1500:])
    return result.stdout.strip()


def atomic_json(path, value, uid=None, gid=None):
    temporary = path.with_name('.'+path.name+'.'+uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            if uid is not None: os.fchown(f.fileno(), uid, gid if gid is not None else -1)
            json.dump(value, f, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, path)
    finally: temporary.unlink(missing_ok=True)


def private_directory(path):
    if not os.path.lexists(path): path.mkdir(mode=0o700)
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o077:
        raise ValueError('Trial directory must be root-owned, private and not a symlink: '+str(path))
    return path


def verified_host_mounts():
    mounts={}
    for target,(device,expected_uuid) in EXPECTED_MOUNTS.items():
        found=json.loads(run('findmnt','--json','--output','SOURCE,TARGET,FSTYPE,UUID','--target',target))['filesystems'][0]
        if (found['source'],found['target'],found['fstype'],found['uuid']) != (device,target,'ext4',expected_uuid):
            raise ValueError('Healthy host mount identity changed: '+target)
        mounts[target]=found
    return mounts


def new_image(path, size):
    """Allocation never opens an existing file or accepts an arbitrary device."""
    fd = os.open(path, os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.posix_fallocate(f.fileno(), 0, size); f.flush(); os.fsync(f.fileno())
    except BaseException:
        path.unlink();raise


def cache_table(origin, cache, metadata):
    if not all(re.fullmatch(r'/dev/loop[0-9]+', p) for p in (origin, cache, metadata)):
        raise ValueError('Trial cache accepts only its loop devices')
    if len({origin, cache, metadata}) != 3: raise ValueError('Cache subdevices must be distinct')
    return f'0 {SIZES["origin.img"]//512} cache {metadata} {cache} {origin} 64 2 writethrough metadata2 smq 0'


def cache_status(raw):
    words = raw.split()
    if len(words) < 15 or words[2] != 'cache' or 'needs_check' in words:
        raise ValueError('Invalid or damaged cache status')
    # Kernel ABI after start/length/target: metadata block, metadata use,
    # cache block, cache use, read hits/misses, write hits/misses, demotions,
    # promotions, dirty count, feature count and features.
    n = int(words[14]); features = words[15:15+n]
    if len(features) != n or 'writethrough' not in features:
        raise ValueError('Trial requires verified writethrough mode')
    dirty = int(words[13])
    if dirty: raise ValueError('Writethrough trial has dirty blocks; retain all images')
    return {'read_hits': int(words[7]), 'read_misses': int(words[8]),
            'promotions': int(words[12]), 'dirty_blocks': dirty, 'raw': raw}


def stamp(index): return hashlib.sha256(f'qq-cache-trial:{index}'.encode()).digest()
def payload(index): return stamp(index) * (MIB//32)


def populate(mountpoint):
    digest = hashlib.sha256(); deadline = time.monotonic()
    with (mountpoint/'payload.bin').open('xb') as f:
        for index in range(DATA_MIB):
            block = payload(index); f.write(block); digest.update(block)
            deadline += 1/8  # Cap synthetic data writes at 8 MiB/s.
            time.sleep(max(0, deadline-time.monotonic()))
        f.flush(); os.fsync(f.fileno())
    (mountpoint/'payload.link').symlink_to('payload.bin')
    os.link(mountpoint/'payload.bin', mountpoint/'payload.hardlink')
    os.setxattr(mountpoint/'payload.bin', 'user.qq_trial', b'preserved')
    with closing(sqlite3.connect(mountpoint/'example.sqlite')) as db:
        db.execute('create table evidence (id integer primary key, value text)')
        db.execute('insert into evidence values (1, ?)', ('committed trial data',)); db.commit()
    directory = os.open(mountpoint, os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
    return digest.hexdigest()


def verify(mountpoint, expected):
    digest = hashlib.sha256()
    with (mountpoint/'payload.bin').open('rb') as f:
        while block := f.read(MIB): digest.update(block)
    if digest.hexdigest() != expected: raise ValueError('Payload checksum mismatch')
    if os.readlink(mountpoint/'payload.link') != 'payload.bin': raise ValueError('Symlink changed')
    if (mountpoint/'payload.bin').stat().st_ino != (mountpoint/'payload.hardlink').stat().st_ino:
        raise ValueError('Hard link changed')
    if os.getxattr(mountpoint/'payload.bin','user.qq_trial') != b'preserved': raise ValueError('xattr changed')
    with closing(sqlite3.connect('file:'+str(mountpoint/'example.sqlite')+'?mode=ro', uri=True)) as db:
        if db.execute('pragma integrity_check').fetchone() != ('ok',): raise ValueError('SQLite integrity failure')
        if db.execute('select value from evidence').fetchone() != ('committed trial data',):
            raise ValueError('Committed row changed')


def direct_reads(path, seed=17, count=256):
    """Aligned O_DIRECT file reads; avoids mistaking the RAM page cache for SSD hits."""
    rng = random.Random(seed)
    positions = [rng.randrange(DATA_MIB*16)*65536 for _ in range(count)]
    fd = os.open(path, os.O_RDONLY|os.O_DIRECT)
    buffer = mmap.mmap(-1, 4096); timings = []
    try:
        for offset in positions:
            start = time.perf_counter_ns()
            length = os.preadv(fd, [buffer], offset)
            timings.append((time.perf_counter_ns()-start)/1e6)
            if length != 4096 or buffer[:] != stamp(offset//MIB)*128:
                raise ValueError('Direct-read data mismatch')
    finally: buffer.close(); os.close(fd)
    ordered = sorted(timings)
    return {'reads':count, 'bytes':count*4096, 'mean_ms':sum(timings)/count,
            'p50_ms':ordered[len(ordered)//2], 'p95_ms':ordered[int(len(ordered)*.95)],
            'direct_io':True, 'seed':seed}


class Trial:
    def __init__(self, identifier, application_pilot=False):
        if not re.fullmatch(r'[0-9a-f]{12}', identifier): raise ValueError('Invalid trial ID')
        self.identifier = identifier; self.name = 'qq-cache-trial-'+identifier
        self.ssd = SSD_BASE/identifier; self.hdd = HDD_BASE/identifier
        self.mountpoint = self.ssd/'mount'; self.loops = {}; self.images = []
        self.mapper = False; self.mounted = False
        self.report = {'schema':1,'trial_id':identifier,'started':time.time(),'success':False,
                       'mode':'writethrough','nvme_excluded':True,'changes_existing_paths':False,
                       'synthetic_only':True,'power_loss_tested':False,'boot_ordering_tested':False,
                       'image_bytes':SIZES, 'checks':{}, 'phase':'preflight',
                       'benchmark_note':'Synthetic direct reads under symmetric I/O/CPU caps with existing host work; not application latency'}
        self.application = None
        if application_pilot:
            spec = importlib.util.spec_from_file_location('cache_git_pilot',
                    Path(__file__).with_name('native-cache-git-pilot.py'))
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            self.application = module.GitWorkload(self.mountpoint,
                    Path('/home/qqp/projects/qq-workflows'), int(os.environ.get('SUDO_UID', '0')))
            self.report.update(application_pilot=True, synthetic_only=False,
                    benchmark_note='Read-only Git workload on a private repository snapshot under matched CPU/I/O caps; per-file RAM eviction is advisory; live application benefit and boot/power-loss behavior remain unproven')

    def save(self, phase):
        self.report['phase'] = phase
        self.report['resources'] = {'loops':self.loops,'mapper':self.mapper,'mounted':self.mounted,
                                    'mountpoint':str(self.mountpoint),'images':list(map(str,self.images))}
        atomic_json(self.ssd/'result.json',self.report)
        print('TRIAL', phase, flush=True)

    def attach(self, key, path):
        device = run('losetup','--find','--show','--nooverlap','--direct-io=on',path)
        if not re.fullmatch(r'/dev/loop[0-9]+',device): raise ValueError('Unexpected loop device')
        self.loops[key] = device; self.save('attached '+key)
        self.check_loop(key, path)

    def check_loop(self, key, path):
        data=json.loads(run('losetup','--json','--list','--output','NAME,BACK-FILE,DIO',self.loops[key]))['loopdevices']
        if len(data)!=1 or Path(data[0]['back-file'])!=path or data[0]['dio'] not in (True,1):
            raise ValueError('Loop association or direct-I/O mode mismatch')

    def mapped(self):
        for key in self.loops:
            self.check_loop(key,self.hdd/'origin.img' if key=='origin' else self.ssd/(key+'.img'))
        run('dmsetup','create',self.name,'--table',cache_table(self.loops['origin'],self.loops['cache'],self.loops['metadata']))
        self.mapper=True;self.save('cache attached')
        self.status()

    def status(self): return cache_status(run('dmsetup','status',self.name))

    def mount(self, device, readonly=False):
        allowed=set(self.loops.values())|{'/dev/mapper/'+self.name}
        if device not in allowed:raise ValueError('Unexpected trial mount device')
        run('mount','-t','ext4','-o','ro,noatime' if readonly else 'rw,noatime',device,self.mountpoint)
        self.mounted=True;self.save('mounted trial filesystem')

    def unmount(self):
        if self.mounted:
            # Never force/lazy-unmount, and never unmount an existing host mount.
            for attempt in range(5):
                try:run('umount',self.mountpoint);break
                except RuntimeError as error:
                    if 'target is busy' not in str(error) or attempt==4:raise
                    time.sleep(.25)
            self.mounted=False;self.save('unmounted trial filesystem')

    def recover_resources(self):
        """Reconstruct from kernel associations, never execute saved diagnostic fields."""
        private_directory(self.ssd)
        if self.hdd.exists():private_directory(self.hdd)
        for key,base in [('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd)]:
            path=base/(key+'.img')
            if not os.path.lexists(path):continue
            s=path.lstat()
            if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_size!=SIZES[key+'.img']:
                raise ValueError('Unexpected retained trial image; recovery refused: '+str(path))
            self.images.append(path)
            devices=json.loads(run('losetup','--json','--list','--output','NAME,BACK-FILE,DIO,OFFSET,SIZELIMIT',
                                   '--associated',path) or '{"loopdevices":[]}')['loopdevices']
            if not devices:continue
            if len(devices)!=1 or devices[0].get('offset')!=0 or devices[0].get('sizelimit')!=0:
                raise ValueError('Ambiguous or partial retained loop; recovery refused')
            device=devices[0]['name']
            if not re.fullmatch(r'/dev/loop[0-9]+',device):raise ValueError('Unexpected retained loop name')
            self.loops[key]=device;self.check_loop(key,path)
        mapper=Path('/dev/mapper')/self.name
        if mapper.exists():
            if len(self.loops)!=3:raise ValueError('Retained mapper without all trial loops; recovery refused')
            expected={os.stat(p).st_rdev for p in self.loops.values()}
            raw=run('dmsetup','deps','--noheadings',self.name)
            actual={os.makedev(int(a),int(b)) for a,b in re.findall(r'\((\d+),\s*(\d+)\)',raw)}
            if actual!=expected:raise ValueError('Retained mapper references unexpected devices')
            self.status();self.mapper=True
        if self.mountpoint.is_mount():
            found=json.loads(run('findmnt','--json','--mountpoint',self.mountpoint,
                                 '--output','SOURCE,TARGET,FSTYPE,MAJ:MIN'))['filesystems'][0]
            permitted={os.stat(self.loops['origin']).st_rdev} if 'origin' in self.loops else set()
            if self.mapper:permitted.add(mapper.stat().st_rdev)
            major,minor=map(int,found['maj:min'].split(':'))
            if os.makedev(major,minor) not in permitted or found['target']!=str(self.mountpoint) or found['fstype']!='ext4':
                raise ValueError('Retained mount does not belong to trial; recovery refused')
            self.mounted=True
        self.report['recovery_only']=True;self.save('retained resources verified')

    def remove_cache(self):
        self.unmount()
        if self.mapper:
            self.status()  # Dirty cache or invalid mode fails closed.
            run('dmsetup','remove',self.name);self.mapper=False;self.save('cache detached')

    def application_measure(self, phase):
        if self.application is None:return
        before = self.status() if self.mapper else None
        self.application.measure(phase)
        if before is not None:
            self.application.report[phase]['cache_read_hit_delta'] = self.status()['read_hits']-before['read_hits']
            if phase=='cached':
                self.application.report['cache_benefit_supported'] = (
                        self.application.report['benefit_observed'] and
                        self.application.report[phase]['cache_read_hit_delta']>0)
        self.report['application'] = self.application.report
        self.save('application '+phase)

    def execute(self):
        self.report['host_mounts']=verified_host_mounts()
        if shutil.disk_usage('/').free < 10*1024**3 + sum(SIZES[n] for n in ['cache.img','metadata.img']):
            raise ValueError('Preserve at least 10 GiB free on SSD')
        if shutil.disk_usage('/srv/media-box').free < 1024**3 + SIZES['origin.img']:
            raise ValueError('Insufficient HDD space reserve')
        private_directory(HDD_BASE); self.hdd.mkdir(mode=0o700)
        self.mountpoint.mkdir(mode=0o700)
        run('modprobe','dm_cache');run('modprobe','dm_cache_smq')
        for key,base in [('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd)]:
            path=base/(key+'.img');new_image(path,SIZES[key+'.img']);self.images.append(path)
            self.attach(key,path)
        # Format only the trial origin, before any cache table is created.
        self.check_loop('origin',self.hdd/'origin.img')
        run('mkfs.ext4','-q','-F','-m','0','-L','qq-cache-trial','-E',
            'lazy_itable_init=0,lazy_journal_init=0,nodiscard',self.loops['origin'])
        self.mount(self.loops['origin']);expected=populate(self.mountpoint)
        if self.application is not None:
            self.application.prepare()
            self.report['application'] = self.application.report
            self.save('application snapshot prepared')
        self.unmount()
        self.report['payload_sha256']=expected
        self.mount(self.loops['origin'],readonly=True)
        self.application_measure('hdd_baseline')
        verify(self.mountpoint,expected)
        self.report['hdd_baseline']=direct_reads(self.mountpoint/'payload.bin');self.unmount()
        self.mapped();self.mount('/dev/mapper/'+self.name)
        verify(self.mountpoint,expected);start=time.monotonic();passes=0
        before=self.status()
        # Policy ticks require elapsed time; bounded warmup may fail to show a benefit.
        while passes<12 and (passes<3 or time.monotonic()-start<4):
            direct_reads(self.mountpoint/'payload.bin');passes+=1
            time.sleep(.3)
        self.report['warmup_passes']=passes
        self.report['cached_reads']=direct_reads(self.mountpoint/'payload.bin')
        self.application_measure('cached')
        after=self.status();self.report['cache_status']=after
        self.report['read_hit_delta']=after['read_hits']-before['read_hits']
        self.report['checks']['cached_integrity']=True
        self.remove_cache()
        self.mapped();self.mount('/dev/mapper/'+self.name);verify(self.mountpoint,expected)
        self.application_measure('reattached')
        self.report['checks']['reattach_integrity']=True
        self.report['reattached_reads']=direct_reads(self.mountpoint/'payload.bin')
        self.remove_cache()
        # No cache device participates here: tests a clean, cache-free HDD recovery.
        self.mount(self.loops['origin'],readonly=True);verify(self.mountpoint,expected)
        self.application_measure('hdd_without_cache')
        self.report['checks']['hdd_without_cache_integrity']=True;self.unmount()
        run('e2fsck','-f','-n',self.loops['origin'])
        self.report['checks']['filesystem_integrity']=True
        self.report['latency_ratio']=self.report['cached_reads']['mean_ms']/self.report['hdd_baseline']['mean_ms']
        self.report['cache_hits_observed']=self.report['read_hit_delta']>0
        self.report['success']=True;self.save('checks complete')

    def cleanup(self):
        errors=[]
        try:self.remove_cache()
        except Exception as e:errors.append(str(e))
        if not self.mounted and not self.mapper:
            for key,device in list(self.loops.items()):
                path=self.hdd/'origin.img' if key=='origin' else self.ssd/(key+'.img')
                try:
                    self.check_loop(key,path);run('losetup','--detach',device)
                    # Lazy detach must finish before an image is removed.
                    run('udevadm','settle',timeout=10)
                    associated=json.loads(run('losetup','--json','--list','--associated',path) or '{"loopdevices":[]}')['loopdevices']
                    if associated:raise ValueError('Trial loop remains associated; image retained')
                    del self.loops[key]
                except Exception as e:errors.append(str(e))
            for path in list(self.images):
                try:
                    associated=json.loads(run('losetup','--json','--list','--associated',path) or '{"loopdevices":[]}')['loopdevices']
                    if associated:raise ValueError('Trial image still associated; retained: '+str(path))
                    path.unlink();self.images.remove(path)
                except Exception as e:errors.append(str(e))
        self.report['cleanup_complete']=not(errors or self.loops or self.images or self.mapper or self.mounted)
        self.report['cleanup_errors']=errors
        if self.report['cleanup_complete']:
            try:
                if self.mountpoint.exists():self.mountpoint.rmdir()
                if self.hdd.exists():self.hdd.rmdir()
            except OSError as e:
                errors.append(str(e));self.report['cleanup_complete']=False
        if not self.report['cleanup_complete']:self.report['success']=False
        self.report['finished']=time.time();self.save('finished')


def output_path(raw, uid):
    home=Path(pwd.getpwuid(uid).pw_dir).resolve()
    output=Path(raw).absolute()
    parent=output.parent.resolve(strict=True)
    if not parent.is_relative_to(home) or parent.stat().st_uid!=uid or parent.stat().st_dev!=Path('/').stat().st_dev:
        raise ValueError('Report parent must be operator-owned and on the healthy SSD')
    output=parent/output.name
    if os.path.lexists(output):
        st=output.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=uid or st.st_nlink!=1:
            raise ValueError('Refuse non-operator, linked or non-file report destination')
    return output


def worker(identifier,recovery=False,application_pilot=False):
    expected='qq-cache-trial-'+identifier+('-recovery' if recovery else '')+'.scope'
    raw=Path('/proc/self/cgroup').read_text().strip()
    if raw.split('/')[-1] != expected:
        raise ValueError('Trial worker must run inside its bounded systemd scope')
    private_directory(SSD_BASE);private_directory(SSD_BASE/identifier)
    trial=Trial(identifier,application_pilot=application_pilot and not recovery)
    can_cleanup=not recovery
    def interrupted(signum, frame):raise InterruptedError('Trial interrupted by signal '+str(signum))
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    signal.signal(signal.SIGALRM,interrupted);signal.alarm(360 if application_pilot else 180)
    try:
        cg=Path('/sys/fs/cgroup')/raw.split('::',1)[1].lstrip('/')
        limits={name:(cg/name).read_text().strip() for name in
                ['cpu.max','memory.max','memory.swap.max','pids.max','io.max']}
        quota,period=limits['cpu.max'].split()
        if quota=='max' or int(quota)/int(period)>.1 or int(limits['memory.max'])>512*MIB or limits['memory.swap.max']!='0' or int(limits['pids.max'])>32:
            raise ValueError('Trial resource limits were not applied')
        devices={line.split()[0]:dict(item.split('=') for item in line.split()[1:]) for line in limits['io.max'].splitlines()}
        for path in ['/dev/sda','/dev/sdb']:
            device=os.stat(path).st_rdev;setting=devices.get(f'{os.major(device)}:{os.minor(device)}',{})
            if any(setting.get(key,'max')=='max' or int(setting[key])>8*MIB for key in ['rbps','wbps']):
                raise ValueError('Trial I/O limits were not applied for '+path)
        trial.report['verified_resource_limits']=limits
        if recovery:
            trial.report['host_mounts']=verified_host_mounts()
            trial.recover_resources();can_cleanup=True
        else:trial.execute()
    except Exception as e:trial.report['error']=str(e)[:2000];trial.report['success']=False
    finally:
        signal.alarm(0)
        if can_cleanup:trial.cleanup()
        else:
            trial.report['cleanup_complete']=False;trial.save('recovery refused')
    if recovery and not trial.report.get('error') and trial.report.get('cleanup_complete'):
        trial.report['success']=True;trial.save('recovery complete')
    return 0 if trial.report['success'] else 1


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output');parser.add_argument('--worker');parser.add_argument('--recover',action='store_true')
    parser.add_argument('--application-pilot',action='store_true')
    args=parser.parse_args()
    if os.geteuid()!=0:raise SystemExit('Kernel trial requires sudo; it has not run')
    if args.worker:return worker(args.worker,args.recover,args.application_pilot)
    if not args.output:raise ValueError('An operator-readable report path is required')
    uid=int(os.environ.get('SUDO_UID','0'));gid=int(os.environ.get('SUDO_GID','0'))
    if uid<=0:raise ValueError('Invoke through the operator sudo command')
    output=output_path(args.output,uid)
    for name,path in TOOLS.items():
        if not path:raise ValueError('Required host tool missing: '+name)
    verified_host_mounts()
    private_directory(SSD_BASE)
    lock_fd=os.open(SSD_BASE/'trial.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)  # Held until the administrator command exits.
    recovered=[]
    candidates=list(SSD_BASE.iterdir())
    if len(candidates)>64:raise ValueError('Trial directory budget exceeded; inspect old records')
    for old in candidates:
        if not re.fullmatch(r'[0-9a-f]{12}',old.name):continue
        private_directory(old)
        if any(os.path.lexists(p) for p in [old/'cache.img',old/'metadata.img',HDD_BASE/old.name/'origin.img']) or (old/'mount').is_mount():
            report=run_scope(old.name,recovery=True)
            if not report.get('success'):
                atomic_json(output,report,uid,gid);print('Retained trial recovery failed; report:',output);return 1
            recovered.append(old.name)
    identifier=uuid.uuid4().hex[:12];root=SSD_BASE/identifier;root.mkdir(mode=0o700)
    report=run_scope(identifier,application_pilot=args.application_pilot)
    report['recovered_previous_trials']=recovered
    atomic_json(output,report,uid,gid)
    print('Saved native cache trial:',output)
    print('Integrity:', 'PASS' if report.get('success') else 'FAIL',
          'cache hits:',report.get('cache_hits_observed'), 'cleanup:',report.get('cleanup_complete'))
    if 'latency_ratio' in report:print('Cached / HDD mean read latency:',round(report['latency_ratio'],3))
    application=report.get('application',{})
    if 'cached_to_hdd_ratio' in application:
        print('Git workload cached / HDD latency:',round(application['cached_to_hdd_ratio'],3),
              'cache benefit supported:',application.get('cache_benefit_supported',False))
    return 0 if report.get('success') else 1


def run_scope(identifier,recovery=False,application_pilot=False):
    scope=TOOLS['systemd-run']
    command=[scope,'--quiet','--collect','--scope','--unit=qq-cache-trial-'+identifier+('-recovery' if recovery else ''),
             '--property=CPUQuota=10%','--property=MemoryMax=512M','--property=MemorySwapMax=0',
             '--property=TasksMax=32','--property=IOWeight=10','--property=IOAccounting=yes',
             '--property=IOReadBandwidthMax=/dev/sda 8M','--property=IOReadBandwidthMax=/dev/sdb 8M',
             '--property=IOWriteBandwidthMax=/dev/sda 8M','--property=IOWriteBandwidthMax=/dev/sdb 8M',
             '/usr/bin/python3',str(Path(__file__).resolve()),'--worker',identifier]
    if recovery:command.append('--recover')
    if application_pilot:command.append('--application-pilot')
    result=subprocess.run(command)
    root=SSD_BASE/identifier
    record=root/'result.json'
    report=json.loads(record.read_text()) if record.exists() else {'schema':1,'trial_id':identifier,'success':False,
            'error':'Bounded worker did not produce a result','cleanup_complete':False,'root':str(root)}
    report['scope_exit_code']=result.returncode
    if result.returncode or not report.get('cleanup_complete'):
        report['success']=False
        if 'error' not in report:report['error']='Worker did not finish with verified teardown; inspect retained trial resources'
    return report


if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,RuntimeError,OSError) as error:raise SystemExit(str(error))
