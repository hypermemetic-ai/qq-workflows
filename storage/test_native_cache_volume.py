import importlib.util
from collections import namedtuple
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('native_volume',Path(__file__).with_name('native-cache-volume.py'))
volume=importlib.util.module_from_spec(spec);spec.loader.exec_module(volume)


class VolumeSafety(unittest.TestCase):
    def test_hdd_with_room_for_old_pilot_cannot_allocate_the_terabyte_volume(self):
        Usage=namedtuple('Usage','total used free')
        def usage(path):
            return Usage(2*10**12,0,64*1024**3 if path=='/' else 100*1024**3)
        with patch.object(volume,'manifest_path',return_value=Path('/missing-volume-test-manifest')),\
                patch.object(Path,'is_mount',return_value=False),patch.object(volume.shutil,'disk_usage',side_effect=usage),\
                patch.object(volume.base,'new_image') as allocate,patch.object(volume.base,'run') as command:
            with self.assertRaisesRegex(ValueError,'Insufficient HDD reserve'):
                volume.Volume().provision(Path('/report'))
        allocate.assert_not_called();command.assert_not_called()

    def test_old_eight_gib_manifest_cannot_be_adopted_by_terabyte_helper(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'volume.json'
            path.write_text(json.dumps({'schema':1,'owner':1000,'filesystem_uuid':str(uuid.uuid4()),
                'image_bytes':{'origin.img':8*1024**3,'cache.img':256*volume.base.MIB,'metadata.img':16*volume.base.MIB},
                'output':str(Path(d)/'report')}));path.chmod(0o600)
            actual=path.stat()
            with patch.object(volume,'manifest_path',return_value=path),patch.object(Path,'lstat') as ls,\
                    patch.object(volume.base,'output_path') as output:
                ls.return_value=type('RootStat',(),{'st_mode':actual.st_mode,'st_uid':0,'st_nlink':1})()
                with self.assertRaisesRegex(ValueError,'Unexpected persistent-volume identity'):volume.read_manifest()
            output.assert_not_called()

    def test_committed_volume_cannot_be_reformatted(self):
        with tempfile.TemporaryDirectory() as d,patch.object(volume.base,'SSD_BASE',Path(d)):
            root=Path(d)/volume.IDENTIFIER;root.mkdir();(root/'volume.json').write_text('{}')
            with patch.object(volume.base,'run') as command:
                with self.assertRaisesRegex(ValueError,'never reformat'):volume.Volume().provision(Path(d)/'report')
            command.assert_not_called()

    def test_provisioning_cannot_stack_over_an_existing_mount(self):
        with patch.object(volume,'manifest_path',return_value=Path('/missing-volume-test-manifest')),\
                patch.object(Path,'is_mount',return_value=True),patch.object(volume.base,'run') as command:
            with self.assertRaisesRegex(ValueError,'existing mount'):volume.Volume().provision(Path('/report'))
        command.assert_not_called()

    def test_startup_requires_existing_validated_images(self):
        t=volume.Volume()
        with patch.object(t,'recover_resources'),patch.object(volume.base,'run') as command:
            with self.assertRaisesRegex(ValueError,'all three existing'):t.start({'filesystem_uuid':'unused'})
        command.assert_not_called()

    def test_startup_refuses_changed_filesystem_identity(self):
        t=volume.Volume();t.images=[Path('/image')]*3
        t.loops={'origin':'/dev/loop21','cache':'/dev/loop22','metadata':'/dev/loop23'}
        with patch.object(t,'recover_resources'),patch.object(t,'origin_uuid',return_value='different'),\
                patch.object(t,'mapped') as mapped,patch.object(t,'mount') as mount:
            with self.assertRaisesRegex(ValueError,'UUID changed'):t.start({'filesystem_uuid':'expected'})
        mapped.assert_not_called();mount.assert_not_called()

    def test_startup_never_accepts_a_direct_hdd_mount_as_the_cached_volume(self):
        t=volume.Volume();t.images=[Path('/image')]*3;t.mounted=True
        t.loops={'origin':'/dev/loop21','cache':'/dev/loop22','metadata':'/dev/loop23'}
        with patch.object(t,'recover_resources'),patch.object(t,'origin_uuid',return_value='expected'),\
                patch.object(t,'mapped') as mapped:
            with self.assertRaisesRegex(ValueError,'cache-free'):t.start({'filesystem_uuid':'expected'})
        mapped.assert_not_called()

    def test_existing_cached_mount_is_verified_without_formatting(self):
        t=volume.Volume();t.images=[Path('/image')]*3;t.mounted=True;t.mapper=True
        t.loops={'origin':'/dev/loop21','cache':'/dev/loop22','metadata':'/dev/loop23'}
        with patch.object(t,'recover_resources'),patch.object(t,'origin_uuid',return_value='expected'),\
                patch.object(t,'health'),patch.object(t,'status'),patch.object(volume,'idle_evidence',return_value={}),\
                patch.object(volume.base,'run') as command:
            t.start({'filesystem_uuid':'expected'})
        command.assert_not_called();self.assertTrue(t.report['ready'])

    def test_manifest_cannot_substitute_device_sizes_or_owner(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'volume.json'
            for value in ({'schema':1,'owner':0},{'schema':1,'owner':1000,'image_bytes':{'origin.img':1}}):
                path.write_text(json.dumps(value));path.chmod(0o600)
                with patch.object(volume,'manifest_path',return_value=path),\
                        patch.object(os,'geteuid',return_value=0),patch.object(Path,'lstat') as ls:
                    actual=path.stat();ls.return_value=type('RootStat',(),{
                        'st_mode':actual.st_mode,'st_uid':0,'st_nlink':1})()
                    with self.assertRaisesRegex(ValueError,'Unexpected persistent-volume identity'):volume.read_manifest()

    def test_unmounted_path_cannot_be_a_symlink_or_a_writable_spill_directory(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);target=root/'mount';target.mkdir()
            with patch.object(volume,'MOUNT',target):
                with self.assertRaisesRegex(ValueError,'mode 000'):volume.mountpoint_ready()
            link=root/'link';link.symlink_to(target)
            with patch.object(volume,'MOUNT',link):
                with self.assertRaisesRegex(ValueError,'mode 000'):volume.mountpoint_ready()

    def test_failed_preflight_never_cleans_an_unvalidated_mountpoint(self):
        with tempfile.TemporaryDirectory() as d,patch.object(volume.base,'SSD_BASE',Path(d)),\
                patch.object(volume.base,'private_directory'),patch.object(volume.startup,'verified_limits',side_effect=ValueError('bad limits')),\
                patch.object(volume,'manifest_path',return_value=Path(d)/'absent-manifest'),\
                patch.object(volume.Volume,'cleanup') as cleanup,patch.object(volume.Volume,'save'),\
                patch.object(volume.base,'output_path',return_value=Path(d)/'report'),patch.object(volume.base,'atomic_json'):
            self.assertEqual(volume.worker('provision',str(Path(d)/'report')),1)
        cleanup.assert_not_called()

    def test_idle_check_detects_a_process_reference_without_emitting_commands(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'zig';source.mkdir();proc=root/'proc';proc.mkdir()
            process=proc/'999999999';process.mkdir();(process/'fd').mkdir()
            (process/'cmdline').write_text('private-command '+str(source))
            with patch.object(volume,'SOURCE',source),patch.object(volume,'PROC',proc):r=volume.idle_evidence()
            self.assertFalse(r['idle_verified']);self.assertEqual(r['references'],[999999999])
            self.assertNotIn('private-command',json.dumps(r))

    def test_idle_check_fails_closed_on_unreadable_process_state(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'zig';source.mkdir();proc=root/'proc';proc.mkdir()
            process=proc/'999999999';process.mkdir();(process/'fd').mkdir()
            original=Path.open
            def guarded(path,*args,**kwargs):
                if path==process/'maps':raise PermissionError('protected process')
                return original(path,*args,**kwargs)
            with patch.object(volume,'SOURCE',source),patch.object(volume,'PROC',proc),patch.object(Path,'open',guarded):
                r=volume.idle_evidence()
            self.assertFalse(r['idle_verified']);self.assertEqual(r['unknown'],[999999999])


class UnitFileRoundTrip(unittest.TestCase):
    def test_unit_file_preserves_escaped_dependency_and_cleans_up(self):
        if subprocess.run(['systemctl','--user','show-environment'],capture_output=True,timeout=5).returncode:
            self.skipTest('User systemd manager unavailable; preserve sandbox')
        prefix='qq-volume-unit-test-'+uuid.uuid4().hex[:12]
        dependency=prefix+r'-mount\x2dguard.service';service=prefix+'-pilot.service'
        names=[service,dependency]
        unitdir=Path.home()/'.config/systemd/user'
        def cleanup():
            for name in names:
                for action in ('stop','reset-failed'):
                    subprocess.run(['systemctl','--user',action,name],capture_output=True,timeout=10)
                link=unitdir/name
                if link.is_symlink() and Path(os.readlink(link)).parent==Path(temp.name):link.unlink()
            subprocess.run(['systemctl','--user','daemon-reload'],capture_output=True,timeout=10)
            active=subprocess.check_output(['systemctl','--user','list-units','--no-legend','--no-pager',
                                            '--state=active,activating,deactivating',prefix+'-*.service'],text=True)
            self.assertEqual(active.strip(),'')
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.addCleanup(cleanup)
        root=Path(temp.name)
        (root/dependency).write_text('[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/true\nCPUQuota=10%\nMemoryMax=64M\nMemorySwapMax=0\nTasksMax=16\n')
        with patch.object(volume.base,'run',return_value=dependency):content=volume.service_text(Path('/unused'))
        lines=[]
        for line in content.splitlines():
            if line.startswith(('RequiresMountsFor=','ExecStop=')):continue
            lines.append('ExecStart=/usr/bin/true' if line.startswith('ExecStart=') else line)
        content='\n'.join(lines)+'\n'
        (root/service).write_text(content)
        subprocess.run(['systemctl','--user','link',str(root/dependency),str(root/service)],check=True,capture_output=True,timeout=10)
        subprocess.run(['systemctl','--user','start',service],check=True,capture_output=True,timeout=15)
        actual=subprocess.check_output(['systemctl','--user','show',service,'--property=After','--property=BindsTo','--property=ActiveState'],text=True)
        fields=dict(line.split('=',1) for line in actual.splitlines())
        self.assertEqual(fields['ActiveState'],'active')
        for key in ('After','BindsTo'):self.assertIn(dependency,volume.startup.dependency_names(fields[key]))


if __name__=='__main__':unittest.main()
