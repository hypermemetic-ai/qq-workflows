#!/usr/bin/env python3
"""Provision one small persistent HDD/SSD cache pilot without moving user paths."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

spec=importlib.util.spec_from_file_location('volume_startup',Path(__file__).with_name('native-cache-startup.py'))
startup=importlib.util.module_from_spec(spec);spec.loader.exec_module(startup)
base=startup.base
base.SSD_BASE=Path('/var/lib/qq-native-cache-volume')
base.HDD_BASE=Path('/srv/media-box/.qq-native-cache-volume')
base.SIZES={'origin.img':8*1024**3,'cache.img':256*base.MIB,'metadata.img':16*base.MIB}
base.DATA_MIB=1
base.TOOLS['blkid']=shutil.which('blkid',path='/usr/sbin:/usr/bin:/sbin:/bin')
IDENTIFIER='000000000001'
SERVICE='qq-native-cache-pilot.service'
SCOPE='qq-native-cache-pilot-provision.scope'
MOUNT=Path('/srv/qqcachedpilot')
LIBRARY=Path('/usr/local/lib/qq-native-cache-pilot')
UNIT=Path('/etc/systemd/system')/SERVICE
SOURCE=Path('/home/qqp/.cache-qq-ssd/zig')
PROC=Path('/proc')
OWNER=1000


def mountpoint_ready():
    if MOUNT.is_mount():return
    if not os.path.lexists(MOUNT):MOUNT.mkdir(mode=0)
    s=MOUNT.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=0 or any(MOUNT.iterdir()):
        raise ValueError('Unmounted pilot mountpoint must be root-owned, empty and mode 000')


def manifest_path():return base.SSD_BASE/IDENTIFIER/'volume.json'


def read_manifest():
    path=manifest_path();s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o077:
        raise ValueError('Unexpected persistent-volume manifest ownership')
    with path.open('rb') as f:data=json.loads(f.read(16384))
    if data.get('schema')!=1 or data.get('owner')!=OWNER or data.get('image_bytes')!=base.SIZES or not re.fullmatch(
            r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',data.get('filesystem_uuid','')):
        raise ValueError('Unexpected persistent-volume identity')
    data['output']=str(base.output_path(data['output'],OWNER))
    return data


def idle_evidence():
    # Read process state as root; emit only identities, never command/environment
    # contents. Incomplete coverage defers migration rather than declaring idle.
    report={'source':str(SOURCE),'checked_at':time.time(),'references':[],'unknown':[]}
    if not SOURCE.is_dir() or SOURCE.is_symlink():
        report.update(idle_verified=False,error='Candidate absent or already linked');return report
    needles=(str(SOURCE),'/home/qqp/.cache/zig');budget=2000
    for proc in PROC.iterdir():
        if not proc.name.isdecimal() or int(proc.name)==os.getpid():continue
        budget-=1
        if budget<0:report['unknown'].append('process budget exceeded');break
        values=[];denied=False
        for name in ('cwd','exe'):
            try:values.append(os.readlink(proc/name))
            except FileNotFoundError:pass
            except PermissionError:denied=True
        for name in ('cmdline','environ','maps'):
            try:
                with (proc/name).open('rb') as f:
                    raw=f.read(2*base.MIB+1)
                    if len(raw)>2*base.MIB:denied=True
                    values.append(raw.decode('utf8','replace'))
            except FileNotFoundError:pass
            except PermissionError:denied=True
        try:
            for n,fd in enumerate((proc/'fd').iterdir()):
                if n>=8192:denied=True;break
                try:values.append(os.readlink(fd))
                except FileNotFoundError:pass
                except PermissionError:denied=True
        except FileNotFoundError:pass
        except PermissionError:denied=True
        if denied:report['unknown'].append(int(proc.name))
        if any(needle in value for needle in needles for value in values):report['references'].append(int(proc.name))
    report['idle_verified']=not(report['references'] or report['unknown'])
    return report


class Volume(base.Trial):
    def __init__(self):
        super().__init__(IDENTIFIER)
        self.name='qq-native-cache-pilot';self.mountpoint=MOUNT
        self.report.update(persistent_pilot=True,synthetic_only=False,changes_existing_paths=False,
                           benchmark_note='Persistent volume; no new application-latency measurement in this stage',
                           actual_reboot_tested=False,power_loss_tested=False)

    def detach(self):startup.StartupTrial.detach(self)

    def origin_uuid(self):
        self.check_loop('origin',self.hdd/'origin.img')
        return base.run('blkid','-p','-s','UUID','-o','value',self.loops['origin'])

    def health(self):
        expected=hashlib.sha256(base.payload(0)).hexdigest()
        base.verify(self.mountpoint/'.health',expected)

    def start(self,identity):
        self.recover_resources()
        if len(self.images)!=3:raise ValueError('Persistent startup requires all three existing images')
        for key,root in (('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd)):
            if key not in self.loops:self.attach(key,root/(key+'.img'))
        if self.origin_uuid()!=identity['filesystem_uuid']:raise ValueError('Pilot filesystem UUID changed')
        if self.mounted and not self.mapper:raise ValueError('Refuse to adopt a cache-free persistent mount')
        if not self.mapper:self.mapped()
        if not self.mounted:self.mount('/dev/mapper/'+self.name)
        self.health();self.status()
        self.report.update(success=True,ready=True,persistent_mount=str(self.mountpoint),
                           filesystem_uuid=identity['filesystem_uuid'],candidate=idle_evidence())

    def provision(self,output):
        # The only formatting path. Refuse every pre-existing backing image.
        if manifest_path().exists():raise ValueError('Volume already provisioned; never reformat')
        if self.mountpoint.is_mount():raise ValueError('Provisioning refuses an existing mount')
        if shutil.disk_usage('/').free<10*1024**3+base.SIZES['cache.img']+base.SIZES['metadata.img']:
            raise ValueError('Preserve 10 GiB free on SSD')
        if shutil.disk_usage('/srv/media-box').free<base.SIZES['origin.img']+1024**3:
            raise ValueError('Insufficient HDD reserve')
        base.private_directory(base.HDD_BASE);base.private_directory(self.hdd)
        if any(os.path.lexists(root/(key+'.img')) for key,root in
               (('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd))):
            raise ValueError('Uncommitted images retained; inspect before retrying provisioning')
        base.run('modprobe','dm_cache');base.run('modprobe','dm_cache_smq')
        for key,root in (('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd)):
            path=root/(key+'.img');base.new_image(path,base.SIZES[key+'.img']);self.images.append(path)
            self.attach(key,path)
        self.check_loop('origin',self.hdd/'origin.img')
        base.run('mkfs.ext4','-q','-F','-m','0','-L','qq-cache-pilot','-E',
                 'lazy_itable_init=0,lazy_journal_init=0,nodiscard',self.loops['origin'],timeout=240)
        fs_uuid=self.origin_uuid();self.mapped();self.mount('/dev/mapper/'+self.name)
        health=self.mountpoint/'.health';health.mkdir(mode=0o700);base.populate(health);self.health()
        data=self.mountpoint/'data';data.mkdir(mode=0o700);os.chown(data,OWNER,OWNER)
        fd=os.open(self.mountpoint,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
        self.remove_cache();base.run('e2fsck','-f','-n',self.loops['origin'],timeout=60)
        self.detach()
        base.atomic_json(manifest_path(),{'schema':1,'owner':OWNER,'filesystem_uuid':fs_uuid,
                         'image_bytes':base.SIZES,'output':str(output)})
        self.report.update(success=True,provisioned=True,filesystem_uuid=fs_uuid,filesystem_integrity=True)


def worker(action,output=None):
    expected=SCOPE if action=='provision' else SERVICE
    base.private_directory(base.SSD_BASE);base.private_directory(base.SSD_BASE/IDENTIFIER)
    lock=os.open(base.SSD_BASE/'volume.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    t=Volume();identity=None
    def interrupted(signum,frame):raise InterruptedError('Pilot worker interrupted: '+str(signum))
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGALRM):signal.signal(sig,interrupted)
    signal.alarm(300 if action=='provision' else 120)
    try:
        limits,deps=startup.verified_limits(expected,verify_dependencies=action!='provision')
        t.report.update(action=action,verified_resource_limits=limits,verified_dependencies=deps,
                        host_mounts=base.verified_host_mounts())
        mountpoint_ready()
        if action=='provision':t.provision(base.output_path(output,OWNER))
        else:
            identity=read_manifest()
            if action=='start':t.start(identity)
            else:
                t.recover_resources();t.detach();t.report.update(success=True,ready=False)
    except Exception as error:t.report.update(success=False,error=str(error)[:2000])
    finally:
        signal.alarm(0)
        # Failed starts never discard persistent images or forcibly unmount data.
        if action=='provision' and not t.report.get('success') and not manifest_path().exists() and (
                t.images or t.loops or t.mapper or t.mounted):
            try:t.cleanup()
            except Exception as error:t.report['cleanup_error']=str(error)[:2000]
        try:
            t.save('persistent pilot '+action+' finished')
            destination=identity['output'] if identity else output
            if destination:base.atomic_json(base.output_path(destination,OWNER),t.report,OWNER,OWNER)
        finally:os.close(lock)
    return 0 if t.report.get('success') else 1


def service_text(script):
    # Unit files preserve escaped unit names directly, unlike systemd-run's
    # command-line dependency assignments. A real systemd regression checks it.
    mount=base.run('systemd-escape','--path','--suffix=mount','/srv/media-box')
    return '\n'.join(['[Unit]','Description=QQ native cache pilot (HDD data, writethrough SSD cache)',
        'RequiresMountsFor=/srv/media-box','BindsTo='+mount,'After='+mount,'',
        '[Service]','Type=oneshot','RemainAfterExit=yes',
        'ExecStart=/usr/bin/python3 '+str(script)+' --worker start',
        'ExecStop=/usr/bin/python3 '+str(script)+' --worker stop',
        'CPUQuota=10%','MemoryMax=512M','MemorySwapMax=0','TasksMax=32','IOWeight=10','IOAccounting=yes',
        'IOReadBandwidthMax=/dev/sda 8M','IOReadBandwidthMax=/dev/sdb 8M',
        'IOWriteBandwidthMax=/dev/sda 8M','IOWriteBandwidthMax=/dev/sdb 8M',
        'TimeoutStartSec=180','TimeoutStopSec=150','UMask=0077','',
        '[Install]','WantedBy=multi-user.target',''])


def install_service():
    base.private_directory(LIBRARY)
    files=('native-cache-volume.py','native-cache-startup.py','native-cache-trial.py')
    source=Path(__file__).resolve().parent
    digest=hashlib.sha256(b''.join((source/name).read_bytes() for name in files)).hexdigest()
    release=LIBRARY/digest[:16];base.private_directory(release)
    for name in files:
        target=release/name
        if target.exists():
            s=target.lstat()
            if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o077:
                raise ValueError('Unexpected pinned root script ownership')
            if target.read_bytes()!=(source/name).read_bytes():raise ValueError('Pinned root release differs')
        else:
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as f:f.write((source/name).read_bytes());f.flush();os.fsync(f.fileno())
    content=service_text(release/'native-cache-volume.py')
    if os.path.lexists(UNIT):
        s=UNIT.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or UNIT.read_text()!=content:
            raise ValueError('Existing pilot unit differs; preserve its pinned release')
    else:
        fd=os.open(UNIT,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,'w') as f:f.write(content);f.flush();os.fsync(f.fileno())
    base.run('systemctl','daemon-reload')
    base.run('systemctl','enable','--now',SERVICE,timeout=200)


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output');parser.add_argument('--worker',choices=('provision','start','stop'))
    args=parser.parse_args()
    if os.geteuid()!=0:raise ValueError('Persistent pilot requires sudo')
    if args.worker:return worker(args.worker,args.output)
    if int(os.environ.get('SUDO_UID','0'))!=OWNER or not args.output:
        raise ValueError('Invoke through the operator sudo wrapper')
    output=base.output_path(args.output,OWNER)
    if any(not value for value in base.TOOLS.values()):raise ValueError('Required host tool missing')
    base.verified_host_mounts();base.private_directory(base.SSD_BASE)
    lock=os.open(base.SSD_BASE/'install.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if not manifest_path().exists():
        command=[base.TOOLS['systemd-run'],'--quiet','--collect','--scope','--unit='+SCOPE.removesuffix('.scope')]
        for setting in startup.properties():
            if setting.startswith(('RequiresMountsFor=','BindsTo=','After=','RuntimeMaxSec=')):continue
            command.append('--property='+setting)
        command+=['/usr/bin/python3',str(Path(__file__).resolve()),'--worker','provision','--output',str(output)]
        result=subprocess.run(command,timeout=360)
        if result.returncode:raise RuntimeError('Provisioning failed; inspect '+str(output))
    else:read_manifest()
    install_service()
    print('Persistent pilot ready:',MOUNT,'(no user paths migrated)')
    print('Saved report:',output)
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,RuntimeError,OSError) as error:raise SystemExit(str(error))
