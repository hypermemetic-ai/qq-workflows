import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('startup_drill',Path(__file__).with_name('native-cache-startup.py'))
startup=importlib.util.module_from_spec(spec);spec.loader.exec_module(startup)
ID='123456abcdef'


class StartupSafety(unittest.TestCase):
    def test_foreign_unit_and_dependency_names_are_refused(self):
        for identifier,phase in [('../../other','cleanup'),(ID,'ssh'),(ID,'/bin/true')]:
            with self.assertRaises(ValueError):startup.unit_name(identifier,phase)
        with self.assertRaisesRegex(ValueError,'Unexpected drill dependency'):
            startup.properties('ssh.service')

    def test_missing_cache_never_formats_or_attaches_a_new_filesystem(self):
        t=startup.StartupTrial(ID,'cold-start');t.images=[t.hdd/'origin.img',t.ssd/'metadata.img']
        with patch.object(startup.base,'run') as command:
            with self.assertRaisesRegex(ValueError,'all three'):t.startup()
        command.assert_not_called()

    def test_recovery_adopts_existing_mount_without_reformatting(self):
        t=startup.StartupTrial(ID,'resume')
        t.images=[t.hdd/'origin.img',t.ssd/'cache.img',t.ssd/'metadata.img']
        t.loops={'origin':'/dev/loop24','cache':'/dev/loop25','metadata':'/dev/loop26'}
        t.mapper=True;t.mounted=True
        with patch.object(startup.base,'run') as command:t.startup()
        command.assert_not_called();self.assertTrue(t.report['adopted_existing_mount'])

    def test_hdd_fallback_is_read_only_without_journal_replay(self):
        with tempfile.TemporaryDirectory() as d:
            t=startup.StartupTrial(ID,'fallback');t.ssd=Path(d);t.hdd=Path(d)/'hdd'
            t.loops={'origin':'/dev/loop24'}
            with patch.object(t,'check_loop'),patch.object(t,'save'),patch.object(startup.base,'run') as command:
                t.startup(fallback=True)
            self.assertEqual(command.call_args.args,('mount','-t','ext4','-o','ro,noload,noatime','/dev/loop24',t.mountpoint))
            self.assertTrue(t.report['fallback_read_only'])

    def test_physical_device_cannot_be_used_for_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            t=startup.StartupTrial(ID,'fallback');t.ssd=Path(d);t.loops={'origin':'/dev/sda'}
            with patch.object(startup.base,'run') as command:
                with self.assertRaisesRegex(ValueError,'verified origin loop'):t.startup(fallback=True)
            command.assert_not_called()

    def test_ambiguous_offline_cache_does_not_replace_online_image(self):
        with tempfile.TemporaryDirectory() as d,patch.object(startup.base,'SSD_BASE',Path(d)):
            root=Path(d)/ID;root.mkdir();(root/'cache.img').write_bytes(b'online');(root/'cache.offline').write_bytes(b'offline')
            with patch.object(startup.base,'run') as command:
                with self.assertRaisesRegex(ValueError,'Ambiguous'):startup.restore_cache(ID)
            command.assert_not_called();self.assertEqual((root/'cache.img').read_bytes(),b'online')

    def test_denial_is_not_confused_with_a_worker_configuration_failure(self):
        result=subprocess.CompletedProcess([],1,'','')
        with patch.object(startup,'properties',return_value=[]),patch.object(startup.subprocess,'run',return_value=result),\
                patch.object(startup,'read_record',return_value={'drill_phase':'denied','worker_started':True}):
            with self.assertRaisesRegex(ValueError,'worker ran despite'):startup.run_phase(ID,'denied',startup.unit_name(ID,'block'))

    def test_unexpected_signal_does_not_pass_the_controller_crash_check(self):
        result=subprocess.CompletedProcess([],143,'','')
        with patch.object(startup,'properties',return_value=[]),patch.object(startup.subprocess,'run',return_value=result),\
                patch.object(startup,'read_record',return_value={'drill_phase':'crash','crash_ready':True}),\
                patch.object(startup,'unit_result',return_value={'ExecMainCode':'2','ExecMainStatus':'15'}):
            with self.assertRaisesRegex(ValueError,'deliberate SIGKILL'):startup.run_phase(ID,'crash')

    def test_active_unit_prevents_concurrent_image_cleanup(self):
        with patch.object(startup.subprocess,'run'),patch.object(startup.base,'run',return_value='owned unit active'):
            with self.assertRaisesRegex(ValueError,'refuse concurrent'):startup.stop_units(ID)

    def test_acknowledged_data_and_database_handles_survive_and_close(self):
        with tempfile.TemporaryDirectory() as d,patch.object(startup.base,'DATA_MIB',1):
            t=startup.StartupTrial(ID,'crash');t.mountpoint=Path(d)
            startup.base.populate(t.mountpoint)
            with patch.object(t,'status',return_value={'dirty_blocks':0}):t.acknowledge()
            t.verify_data(acknowledged=True)
            for fd in Path('/proc/self/fd').iterdir():
                try:target=os.readlink(fd)
                except FileNotFoundError:continue
                self.assertFalse(target.startswith(str(t.mountpoint)+'/'),'acknowledgement left a database handle open')
            with startup.closing(startup.base.sqlite3.connect(t.mountpoint/'example.sqlite')) as db:
                db.execute('update evidence set value=? where id=2',('corrupt acknowledgement',));db.commit()
            with self.assertRaisesRegex(ValueError,'Acknowledged transaction changed'):t.verify_data(acknowledged=True)


class SystemdBehavior(unittest.TestCase):
    def setUp(self):
        available=subprocess.run(['systemctl','--user','show-environment'],capture_output=True,timeout=5)
        if available.returncode:self.skipTest('User systemd manager unavailable; preserve the sandbox')
        self.prefix='qq-cache-drill-test-'+uuid.uuid4().hex[:12]
        self.names=[]
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.stop_units)

    def launch(self,suffix,command,extra=(),collect=True,service_type='exec'):
        name=self.prefix+'-'+suffix+'.service';self.names.append(name)
        args=['systemd-run','--user','--quiet','--wait','--service-type='+service_type,'--unit='+name,
              '--property=CPUQuota=10%','--property=MemoryMax=64M','--property=MemorySwapMax=0',
              '--property=TasksMax=16','--property=RuntimeMaxSec=20']
        if collect:args.append('--collect')
        args.extend('--property='+p for p in extra);args.extend(command)
        return subprocess.run(args,capture_output=True,text=True,timeout=30)

    def stop_units(self):
        for name in self.names:
            for action in ('stop','reset-failed'):
                subprocess.run(['systemctl','--user',action,name],capture_output=True,timeout=10)
        active=subprocess.run(['systemctl','--user','list-units','--no-legend','--no-pager',
                              '--state=active,activating,deactivating',self.prefix+'-*.service'],capture_output=True,text=True,timeout=10)
        self.assertEqual(active.stdout.strip(),'','temporary test units must finish and be stopped')

    def test_actual_systemd_reports_sigkill_independently_of_waiter_code(self):
        result=self.launch('crash',['/usr/bin/python3','-c','import os,signal; os.kill(os.getpid(),signal.SIGKILL)'],collect=False)
        self.assertNotEqual(result.returncode,0,result.stderr[-500:])
        actual=subprocess.check_output(['systemctl','--user','show',self.prefix+'-crash.service',
                                        '--property=ExecMainCode','--property=ExecMainStatus'],text=True)
        fields=dict(line.split('=',1) for line in actual.splitlines())
        self.assertEqual(fields,{'ExecMainCode':'2','ExecMainStatus':'9'})

    def test_failed_requirement_blocks_a_valid_worker(self):
        # oneshot activation waits for the prerequisite to finish. Type=exec
        # declares readiness at execve, before /usr/bin/false can fail.
        failed=self.launch('block',['/usr/bin/false'],extra=('RemainAfterExit=yes',),collect=False,service_type='oneshot')
        self.assertNotEqual(failed.returncode,0)
        marker=Path(self.temporary.name)/'worker-started'
        worker=['/usr/bin/python3','-c','from pathlib import Path; import sys; Path(sys.argv[1]).write_text("started")',str(marker)]
        dependency=self.prefix+'-block.service'
        denied=self.launch('denied',worker,extra=('Requires='+dependency,'After='+dependency))
        # systemd-run can return zero when the dependency prevented execution.
        # Observe the worker marker and failed dependency state directly.
        self.assertFalse(marker.exists(),denied.stderr[-500:])
        actual=subprocess.check_output(['systemctl','--user','show',dependency,
                                        '--property=ActiveState','--property=Result'],text=True)
        self.assertEqual(dict(line.split('=',1) for line in actual.splitlines()),
                         {'ActiveState':'failed','Result':'exit-code'})
        permitted=self.launch('control',worker)
        self.assertEqual(permitted.returncode,0,permitted.stderr[-500:]);self.assertEqual(marker.read_text(),'started')


if __name__=='__main__':unittest.main()
