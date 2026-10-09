#!/usr/bin/env python3
"""Temporary systemd startup and controller-recovery drill; no live cutover."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import stat
import subprocess
import sys
import time
import uuid

spec=importlib.util.spec_from_file_location('startup_trial',Path(__file__).with_name('native-cache-trial.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.SSD_BASE=Path('/var/lib/qq-native-cache-startup')
base.HDD_BASE=Path('/srv/media-box/.qq-native-cache-startup')
base.TOOLS.update({name:shutil.which(name,path='/usr/sbin:/usr/bin:/sbin:/bin') for name in
                   ('systemctl','systemd-escape')})
PHASES=('prepare','cold-start','crash','resume','fallback','reattach','cleanup')
ACK=b'qq-cache-startup-drill-ack\n'


def unit_name(identifier,phase):
    if not re.fullmatch(r'[0-9a-f]{12}',identifier) or phase not in PHASES+('denied','block'):
        raise ValueError('Invalid startup unit identity')
    return 'qq-cache-startup-'+identifier+'-'+phase+'.service'


def properties(dependency=None):
    if dependency and not re.fullmatch(r'qq-cache-startup-[0-9a-f]{12}-block\.service',dependency):
        raise ValueError('Unexpected drill dependency')
    # systemd-run parses backslash escapes in dependency assignments. Preserve
    # the literal escape in srv-media\\x2dbox.mount through that extra parser.
    mount=base.run('systemd-escape','--path','--suffix=mount','/srv/media-box').replace('\\','\\\\')
    result=['CPUQuota=10%','MemoryMax=512M','MemorySwapMax=0','TasksMax=32',
            'IOWeight=10','IOAccounting=yes','RuntimeMaxSec=120',
            'RequiresMountsFor=/srv/media-box','BindsTo='+mount,
            'After='+mount+(' '+dependency if dependency else '')]
    for device in ('/dev/sda','/dev/sdb'):
        result += ['IOReadBandwidthMax='+device+' 8M','IOWriteBandwidthMax='+device+' 8M']
    if dependency:result += ['Requires='+dependency]
    return result


def dependency_names(raw):
    # systemctl show quotes and doubles literal backslashes in unit lists.
    return shlex.split(raw)


def verified_limits(expected,verify_dependencies=True):
    raw=Path('/proc/self/cgroup').read_text().strip()
    if raw.split('/')[-1]!=expected:raise ValueError('Startup worker is outside its declared unit')
    cg=Path('/sys/fs/cgroup')/raw.split('::',1)[1].lstrip('/')
    limits={name:(cg/name).read_text().strip() for name in
            ('cpu.max','memory.max','memory.swap.max','pids.max','io.max')}
    quota,period=limits['cpu.max'].split()
    if quota=='max' or int(quota)/int(period)>.1 or int(limits['memory.max'])>512*base.MIB or limits['memory.swap.max']!='0' or int(limits['pids.max'])>32:
        raise ValueError('Startup resource limits were not applied')
    devices={line.split()[0]:dict(item.split('=') for item in line.split()[1:]) for line in limits['io.max'].splitlines()}
    for path in ('/dev/sda','/dev/sdb'):
        device=os.stat(path).st_rdev;settings=devices.get(f'{os.major(device)}:{os.minor(device)}',{})
        if any(settings.get(key,'max')=='max' or int(settings[key])>8*base.MIB for key in ('rbps','wbps')):
            raise ValueError('Startup I/O limits were not applied')
    if not verify_dependencies:return limits,{}
    actual=dict(line.split('=',1) for line in base.run('systemctl','show',expected,
            '--property=RequiresMountsFor','--property=Requires','--property=After','--property=BindsTo').splitlines())
    mount=base.run('systemd-escape','--path','--suffix=mount','/srv/media-box')
    if '/srv/media-box' not in dependency_names(actual.get('RequiresMountsFor','')) or any(
            mount not in dependency_names(actual.get(key,'')) for key in ('Requires','After','BindsTo')):
        raise ValueError('HDD startup dependencies were not applied')
    return limits,actual


def expected_payload():
    digest=hashlib.sha256()
    for index in range(base.DATA_MIB):digest.update(base.payload(index))
    return digest.hexdigest()


class StartupTrial(base.Trial):
    def __init__(self,identifier,phase):
        unit_name(identifier,phase)
        super().__init__(identifier)
        self.name='qq-cache-startup-'+identifier
        self.report.update(drill_phase=phase,controller_crash_only=True,
                           actual_reboot_tested=False,power_loss_tested=False)

    def detach(self):
        self.remove_cache()
        for key,device in list(self.loops.items()):
            path=self.hdd/'origin.img' if key=='origin' else self.ssd/(key+'.img')
            self.check_loop(key,path);base.run('losetup','--detach',device)
            base.run('udevadm','settle',timeout=10)
            if json.loads(base.run('losetup','--json','--list','--associated',path) or '{"loopdevices":[]}')['loopdevices']:
                raise ValueError('Startup loop remains associated; images retained')
            del self.loops[key]
        self.report['detached']=True;self.save('startup resources detached')

    def prepare(self):
        if shutil.disk_usage('/').free<10*1024**3+base.SIZES['cache.img']+base.SIZES['metadata.img']:
            raise ValueError('Preserve 10 GiB free on SSD')
        if shutil.disk_usage('/srv/media-box').free<1024**3+base.SIZES['origin.img']:
            raise ValueError('Insufficient HDD reserve')
        base.private_directory(base.HDD_BASE);self.hdd.mkdir(mode=0o700)
        self.mountpoint.mkdir(mode=0o700)
        base.run('modprobe','dm_cache');base.run('modprobe','dm_cache_smq')
        for key,root in (('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd)):
            path=root/(key+'.img');base.new_image(path,base.SIZES[key+'.img']);self.images.append(path)
            self.attach(key,path)
        self.check_loop('origin',self.hdd/'origin.img')
        base.run('mkfs.ext4','-q','-F','-m','0','-L','qq-startup-drill','-E',
                 'lazy_itable_init=0,lazy_journal_init=0,nodiscard',self.loops['origin'])
        self.mount(self.loops['origin']);base.populate(self.mountpoint)

    def acknowledge(self):
        with (self.mountpoint/'acknowledged.txt').open('xb') as f:
            f.write(ACK);f.flush();os.fsync(f.fileno())
        with closing(base.sqlite3.connect(self.mountpoint/'example.sqlite')) as db:
            db.execute('insert into evidence values (2, ?)',(ACK.decode().strip(),));db.commit()
        fd=os.open(self.mountpoint,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
        self.status()

    def verify_data(self,acknowledged=False):
        base.verify(self.mountpoint,expected_payload())
        if acknowledged:
            if (self.mountpoint/'acknowledged.txt').read_bytes()!=ACK:
                raise ValueError('Acknowledged file changed after controller failure')
            with closing(base.sqlite3.connect('file:'+str(self.mountpoint/'example.sqlite')+'?mode=ro',uri=True)) as db:
                if db.execute('select value from evidence where id=2').fetchone()!=(ACK.decode().strip(),):
                    raise ValueError('Acknowledged transaction changed after controller failure')
        self.report['integrity']=True
        self.report['acknowledged_data_verified']=acknowledged

    def startup(self,fallback=False):
        # The worker has already reconstructed and validated every resource.
        if not fallback and len(self.images)!=3:
            raise ValueError('Startup requires all three validated images')
        self.report['adopted_existing_mount']=self.mounted
        if fallback:
            if self.mapper or self.mounted or (self.ssd/'cache.img').exists():
                raise ValueError('Fallback requires absent cache and fully detached resources')
            if 'origin' not in self.loops:self.attach('origin',self.hdd/'origin.img')
            if not re.fullmatch(r'/dev/loop[0-9]+',self.loops['origin']):
                raise ValueError('Fallback accepts only its verified origin loop')
            self.check_loop('origin',self.hdd/'origin.img')
            # noload also prevents journal replay from writing beneath an offline
            # cache. A writable bypass would require invalidating its metadata.
            base.run('mount','-t','ext4','-o','ro,noload,noatime',self.loops['origin'],self.mountpoint)
            self.mounted=True;self.report['fallback_read_only']=True;self.save('read-only HDD fallback')
        else:
            for key,root in (('origin',self.hdd),('cache',self.ssd),('metadata',self.ssd)):
                if key not in self.loops:self.attach(key,root/(key+'.img'))
            if not self.mapper:self.mapped()
            if not self.mounted:self.mount('/dev/mapper/'+self.name)


def worker(identifier,phase):
    base.private_directory(base.SSD_BASE);base.private_directory(base.SSD_BASE/identifier)
    trial=StartupTrial(identifier,phase);can_detach=phase=='prepare'
    def interrupted(signum,frame):raise InterruptedError('Startup worker interrupted: '+str(signum))
    for s in (signal.SIGTERM,signal.SIGINT,signal.SIGALRM):signal.signal(s,interrupted)
    signal.alarm(90)
    try:
        trial.report['worker_started']=True;trial.save('startup worker began')
        limits,deps=verified_limits(unit_name(identifier,phase))
        trial.report.update(verified_resource_limits=limits,verified_dependencies=deps,host_mounts=base.verified_host_mounts())
        if phase=='prepare':trial.prepare()
        else:
            trial.recover_resources();can_detach=True
            if phase!='cleanup':
                trial.startup(fallback=phase=='fallback')
                trial.verify_data(acknowledged=phase in ('resume','fallback','reattach'))
                if phase=='crash':
                    trial.acknowledge();trial.report['crash_ready']=True;trial.save('intentional controller crash armed')
                    os.kill(os.getpid(),signal.SIGKILL)
        trial.report['success']=True
    except Exception as error:
        trial.report.update(success=False,error=str(error)[:2000])
    finally:
        signal.alarm(0)
        if can_detach:
            try:
                if phase=='cleanup':trial.cleanup()
                else:trial.detach()
            except Exception as error:trial.report.update(success=False,detach_error=str(error)[:2000])
        trial.save('startup phase finished')
    return 0 if trial.report.get('success') else 1


def read_record(identifier):
    path=base.SSD_BASE/identifier/'result.json'
    with path.open('rb') as f:return json.loads(f.read(256*1024))


def unit_result(name):
    return dict(line.split('=',1) for line in base.run('systemctl','show',name,
            '--property=ActiveState','--property=Result',
            '--property=ExecMainCode','--property=ExecMainStatus').splitlines())


def run_phase(identifier,phase,dependency=None):
    command=[base.TOOLS['systemd-run'],'--quiet','--wait','--service-type=exec',
             '--unit='+unit_name(identifier,phase)]
    if phase not in ('crash','denied'):command.append('--collect')
    command += ['--property='+value for value in properties(dependency)]
    command += ['/usr/bin/python3',str(Path(__file__).resolve()),'--worker',identifier,'--phase',phase]
    result=subprocess.run(command,capture_output=True,text=True,timeout=150)
    diagnostic=(result.stderr or result.stdout).strip()[-2000:]
    try:report=read_record(identifier)
    except (OSError,ValueError) as error:
        raise RuntimeError('Startup '+phase+' did not produce a worker report (launcher exit '+
                           str(result.returncode)+'): '+(diagnostic or str(error))) from error
    if phase=='denied':
        if report.get('drill_phase')=='denied':
            raise ValueError('Startup worker ran despite its failed dependency')
        failed=unit_result(dependency)
        if failed.get('ActiveState')!='failed' or failed.get('Result')!='exit-code':
            raise ValueError('The required dependency did not remain in its deliberately failed state')
        return {'worker_started':False,'waiter_exit_code':result.returncode,'failed_dependency':failed}
    if report.get('drill_phase')!=phase:
        raise RuntimeError('Startup '+phase+' did not publish its phase result (launcher exit '+
                           str(result.returncode)+'): '+(diagnostic or 'only an earlier phase report exists'))
    report['unit_exit_code']=result.returncode
    if phase=='crash':
        actual=unit_result(unit_name(identifier,phase));report['unit_result']=actual
        if actual.get('ExecMainCode')!='2' or actual.get('ExecMainStatus')!=str(signal.SIGKILL) or not report.get('crash_ready'):
            raise ValueError('Controller crash was not the deliberate SIGKILL')
    elif result.returncode or not report.get('success'):
        raise RuntimeError(report.get('error') or report.get('detach_error') or result.stderr[-1500:] or 'Startup unit failed')
    return report


def validate_offline(path):
    s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_size!=base.SIZES['cache.img']:
        raise ValueError('Unexpected offline cache image')
    if json.loads(base.run('losetup','--json','--list','--associated',path) or '{"loopdevices":[]}')['loopdevices']:
        raise ValueError('Offline cache is still attached')


def restore_cache(identifier):
    root=base.SSD_BASE/identifier;offline=root/'cache.offline';cache=root/'cache.img'
    if os.path.lexists(offline):
        if os.path.lexists(cache):raise ValueError('Ambiguous online and offline cache images')
        validate_offline(offline);offline.rename(cache)


def assert_detached(identifier):
    t=StartupTrial(identifier,'cleanup');t.recover_resources()
    if t.loops or t.mapper or t.mounted:raise ValueError('Startup resources are unexpectedly attached')


def stop_units(identifier):
    for phase in PHASES+('denied','block'):
        name=unit_name(identifier,phase)
        # Only this drill's exact units; already-collected units are harmless.
        for action in ('stop','reset-failed'):
            subprocess.run([base.TOOLS['systemctl'],action,name],capture_output=True,timeout=30)
    active=base.run('systemctl','list-units','--no-legend','--no-pager',
                   '--state=active,activating,deactivating','qq-cache-startup-'+identifier+'-*.service')
    if active:raise ValueError('Drill unit remains active; refuse concurrent resource cleanup')


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output');parser.add_argument('--worker');parser.add_argument('--phase',choices=PHASES+('denied',))
    args=parser.parse_args()
    if os.geteuid()!=0:raise ValueError('Startup drill requires sudo')
    if args.worker:
        if not args.phase:raise ValueError('Worker phase required')
        return worker(args.worker,args.phase)
    uid=int(os.environ.get('SUDO_UID','0'));gid=int(os.environ.get('SUDO_GID','0'))
    if uid<=0 or not args.output:raise ValueError('Invoke through the operator sudo wrapper')
    output=base.output_path(args.output,uid)
    if any(not path for path in base.TOOLS.values()):raise ValueError('Required host tool missing')
    base.verified_host_mounts();base.private_directory(base.SSD_BASE)
    lock=os.open(base.SSD_BASE/'drill.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    active=base.run('systemctl','list-units','--no-legend','--no-pager','--state=active,activating,deactivating','qq-cache-startup-*.service')
    if active:raise ValueError('A previous startup worker is still active; let its bounded unit finish')
    previous=list(base.SSD_BASE.iterdir())
    if len(previous)>64:raise ValueError('Startup record budget exceeded')
    for old in previous:
        if not re.fullmatch(r'[0-9a-f]{12}',old.name):continue
        base.private_directory(old)
        if any(os.path.lexists(p) for p in (old/'cache.img',old/'cache.offline',old/'metadata.img',base.HDD_BASE/old.name/'origin.img')) or (old/'mount').is_mount():
            stop_units(old.name);restore_cache(old.name);run_phase(old.name,'cleanup')
        stop_units(old.name)
    identifier=uuid.uuid4().hex[:12];(base.SSD_BASE/identifier).mkdir(mode=0o700)
    report={'schema':1,'trial_id':identifier,'started':time.time(),'success':False,
            'changes_existing_paths':False,'nvme_excluded':True,'actual_reboot_tested':False,
            'power_loss_tested':False,'controller_crash_only':True,'phases':{},'checks':{}}
    try:
        report['phases']['prepare']=run_phase(identifier,'prepare')
        assert_detached(identifier)
        # A failed temporary helper dependency stands in for an unavailable
        # prerequisite. The real HDD mount is never stopped or unmounted.
        # oneshot readiness waits for the prerequisite's exit; Type=exec would
        # release dependent jobs before /usr/bin/false reports its failure.
        block=unit_name(identifier,'block')
        blocked=subprocess.run([base.TOOLS['systemd-run'],'--quiet','--wait','--service-type=oneshot',
                '--unit='+block,'--property=RemainAfterExit=yes','--property=CPUQuota=10%',
                '--property=MemoryMax=64M','--property=MemorySwapMax=0','--property=TasksMax=16',
                '--property=RuntimeMaxSec=10','/usr/bin/false'],capture_output=True,timeout=30)
        if blocked.returncode==0:raise ValueError('Required-dependency failure injection did not fail')
        report['phases']['denied']=run_phase(identifier,'denied',dependency=block)
        assert_detached(identifier);report['checks']['failed_dependency_blocks_mount']=True
        report['phases']['cold-start']=run_phase(identifier,'cold-start')
        report['checks']['systemd_startup_and_hdd_ordering']=True
        report['phases']['crash']=run_phase(identifier,'crash')
        report['phases']['resume']=run_phase(identifier,'resume')
        if not report['phases']['resume'].get('adopted_existing_mount'):
            raise ValueError('Resume did not reconstruct the crashed controller resources')
        report['checks']['acknowledged_data_survives_controller_crash']=True
        assert_detached(identifier)
        cache=base.SSD_BASE/identifier/'cache.img';validate_offline(cache)
        cache.rename(cache.with_name('cache.offline'))
        report['phases']['fallback']=run_phase(identifier,'fallback')
        report['checks']['cache_unavailable_readonly_hdd_access']=True
        restore_cache(identifier)
        report['phases']['reattach']=run_phase(identifier,'reattach')
        report['checks']['cache_reattach_after_readonly_fallback']=True
        report['success']=True
    except Exception as error:report['error']=str(error)[:2000]
    finally:
        try:
            stop_units(identifier);restore_cache(identifier)
            report['phases']['cleanup']=run_phase(identifier,'cleanup')
            report['cleanup_complete']=report['phases']['cleanup'].get('cleanup_complete',False)
        except Exception as error:report.update(cleanup_complete=False,cleanup_error=str(error)[:2000],success=False)
        try:stop_units(identifier)
        except Exception as error:report.update(cleanup_complete=False,unit_cleanup_error=str(error)[:2000],success=False)
        if not report.get('cleanup_complete'):report['success']=False
        report['finished']=time.time();base.atomic_json(output,report,uid,gid)
    print('Startup/recovery drill:', 'PASS' if report['success'] else 'FAIL', 'cleanup:',report['cleanup_complete'])
    print('Saved report:',output)
    return 0 if report['success'] else 1


if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,RuntimeError,OSError) as error:raise SystemExit(str(error))
