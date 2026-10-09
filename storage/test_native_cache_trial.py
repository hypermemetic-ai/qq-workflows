import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cache_trial',Path(__file__).with_name('native-cache-trial.py'))
trial=importlib.util.module_from_spec(spec);spec.loader.exec_module(trial)


class TrialSafety(unittest.TestCase):
    def test_existing_image_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'image';p.write_bytes(b'preserve existing data')
            with self.assertRaises(FileExistsError):trial.new_image(p,4096)
            self.assertEqual(p.read_bytes(),b'preserve existing data')

    def test_image_cannot_follow_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'existing';p.write_bytes(b'keep');link=Path(d)/'image';link.symlink_to(p)
            with self.assertRaises(FileExistsError):trial.new_image(link,4096)
            self.assertEqual(p.read_bytes(),b'keep');self.assertTrue(link.is_symlink())

    def test_failed_allocation_removes_only_new_image(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'image'
            with patch.object(trial.os,'posix_fallocate',side_effect=OSError('no space')):
                with self.assertRaises(OSError):trial.new_image(p,4096)
            self.assertFalse(p.exists())

    def test_physical_devices_and_duplicate_loops_rejected(self):
        for devices in [('/dev/sda','/dev/loop1','/dev/loop2'),
                        ('/dev/nvme0n1','/dev/loop1','/dev/loop2'),
                        ('/dev/loop0','/dev/loop0','/dev/loop2')]:
            with self.assertRaises(ValueError):trial.cache_table(*devices)

    def test_dirty_writeback_or_damaged_status_rejected(self):
        valid='0 1048576 cache 8 3/4096 64 20/2048 100 20 30 4 0 20 0 2 writethrough metadata2 2 migration_threshold 2048 smq 0 rw -'
        self.assertEqual(trial.cache_status(valid)['read_hits'],100)
        for bad in [valid.replace('writethrough','writeback'),valid.replace('20 0 2 writethrough','20 1 2 writethrough'),
                    valid.replace('rw -','rw needs_check'),'0 1048576 cache Fail']:
            with self.assertRaises(ValueError):trial.cache_status(bad)

    def test_real_direct_reads_check_contents(self):
        with tempfile.TemporaryDirectory() as d,patch.object(trial,'DATA_MIB',1):
            p=Path(d)/'data';p.write_bytes(trial.payload(0))
            result=trial.direct_reads(p,count=8)
            self.assertTrue(result['direct_io']);self.assertEqual(result['bytes'],32768)
            p.write_bytes(b'\0'*trial.MIB)
            with self.assertRaisesRegex(ValueError,'data mismatch'):trial.direct_reads(p,count=8)

    def test_integrity_detects_database_change(self):
        with tempfile.TemporaryDirectory() as d,patch.object(trial,'DATA_MIB',1):
            p=Path(d);expected=trial.populate(p);trial.verify(p,expected)
            with trial.sqlite3.connect(p/'example.sqlite') as db:
                db.execute('update evidence set value=?',('changed',));db.commit()
            with self.assertRaisesRegex(ValueError,'Committed row changed'):trial.verify(p,expected)

    def test_database_handles_close_before_unmount(self):
        with tempfile.TemporaryDirectory() as d,patch.object(trial,'DATA_MIB',1):
            p=Path(d)
            def handles():
                result=[]
                for fd in Path('/proc/self/fd').iterdir():
                    try:
                        target=os.readlink(fd)
                        if target.startswith(str(p)+'/'):result.append(target)
                    except FileNotFoundError:pass
                return result
            expected=trial.populate(p)
            self.assertEqual(handles(),[],'population must release every file handle')
            trial.verify(p,expected)
            self.assertEqual(handles(),[],'verification must release every file handle')

    def test_recovery_refuses_unexpected_host_mount(self):
        with tempfile.TemporaryDirectory() as d:
            t=trial.Trial('123456abcdef');t.ssd=Path(d);t.hdd=Path(d)/'absent';t.mountpoint=Path(d)/'mount'
            found=json.dumps({'filesystems':[{'source':'/dev/sda3','target':str(t.mountpoint),'fstype':'ext4','maj:min':'8:3'}]})
            with patch.object(trial,'private_directory'),patch.object(Path,'is_mount',return_value=True),patch.object(trial,'run',return_value=found) as command:
                with self.assertRaisesRegex(ValueError,'does not belong'):t.recover_resources()
            self.assertFalse(t.mounted);self.assertFalse(t.mapper)
            self.assertEqual(command.call_args.args[0],'findmnt')

    def test_recovery_refuses_other_users_image(self):
        with tempfile.TemporaryDirectory() as d:
            t=trial.Trial('123456abcdef');t.ssd=Path(d);t.hdd=Path(d)/'absent'
            (Path(d)/'cache.img').write_bytes(b'not a root-created trial image')
            with patch.object(trial,'private_directory'),patch.object(trial,'run') as command:
                with self.assertRaisesRegex(ValueError,'Unexpected retained'):t.recover_resources()
            command.assert_not_called()

    def test_dirty_cache_retains_all_images(self):
        with tempfile.TemporaryDirectory() as d:
            t=trial.Trial('123456abcdef');t.ssd=Path(d);t.mountpoint=Path(d)/'mount';t.mountpoint.mkdir()
            p=Path(d)/'cache.img';p.write_bytes(b'copy');t.images=[p];t.mapper=True
            with patch.object(t,'status',side_effect=ValueError('dirty cache')),patch.object(trial,'run') as command:
                t.cleanup()
            command.assert_not_called();self.assertTrue(p.exists());self.assertFalse(t.report['cleanup_complete'])

    def test_lazy_loop_detach_retains_associated_image(self):
        with tempfile.TemporaryDirectory() as d:
            t=trial.Trial('123456abcdef');t.ssd=Path(d);t.mountpoint=Path(d)/'mount';t.mountpoint.mkdir()
            p=Path(d)/'cache.img';p.write_bytes(b'copy');t.images=[p];t.loops={'cache':'/dev/loop123'}
            def command(name,*args,**kw):
                if name=='losetup' and '--json' in args:
                    return json.dumps({'loopdevices':[{'name':'/dev/loop123','back-file':str(p),'dio':True}]})
                return ''
            with patch.object(trial,'run',side_effect=command):t.cleanup()
            self.assertTrue(p.exists());self.assertFalse(t.report['cleanup_complete'])

    def test_unexpected_loop_backing_is_rejected(self):
        t=trial.Trial('123456abcdef');t.loops={'cache':'/dev/loop123'}
        wrong=json.dumps({'loopdevices':[{'name':'/dev/loop123','back-file':'/existing/user-data','dio':True}]})
        with patch.object(trial,'run',return_value=wrong):
            with self.assertRaises(ValueError):t.check_loop('cache',t.ssd/'cache.img')


if __name__=='__main__':unittest.main()
