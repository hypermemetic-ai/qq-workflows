import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('git_pilot',Path(__file__).with_name('native-cache-git-pilot.py'))
pilot=importlib.util.module_from_spec(spec);spec.loader.exec_module(pilot)


class GitPilot(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.source=self.root/'source';self.source.mkdir()
        self.mount=self.root/'mount';self.mount.mkdir()
        self.env={'PATH':'/usr/bin:/bin','HOME':str(self.root),'GIT_CONFIG_NOSYSTEM':'1',
                  'GIT_CONFIG_GLOBAL':'/dev/null','LC_ALL':'C'}
        self.command('init','--quiet','--initial-branch=main')
        (self.source/'storage').mkdir();(self.source/'storage/cache.txt').write_text('cache evidence\n')
        self.command('add','storage/cache.txt')
        self.command('-c','user.name=Pilot test','-c','user.email=pilot@example.invalid','commit','--quiet','-m','fixture')
        self.work=pilot.GitWorkload(self.mount,self.source,os.getuid())

    def command(self,*args):
        return subprocess.check_output(['/usr/bin/git','-C',str(self.source),*args],env=self.env,stderr=subprocess.PIPE)

    def test_independent_snapshot_preserves_live_repository_and_handles(self):
        original=self.command('rev-parse','HEAD');config=(self.source/'.git/config').read_bytes()
        (self.source/'storage/cache.txt').write_text('uncommitted operator change\n')
        self.work.prepare();self.work.measure('hdd_baseline');self.work.measure('hdd_without_cache')
        self.assertEqual(self.command('rev-parse','HEAD'),original)
        self.assertEqual((self.source/'.git/config').read_bytes(),config)
        self.assertEqual((self.source/'storage/cache.txt').read_text(),'uncommitted operator change\n')
        self.assertFalse((self.work.snapshot/'objects/info/alternates').exists())
        self.assertEqual(self.work.head(self.work.snapshot),original.decode().strip())
        self.assertEqual(self.work.report['hdd_baseline']['samples'][0]['source_search']['output_sha256'],
                         self.work.report['hdd_without_cache']['samples'][0]['source_search']['output_sha256'])
        for fd in Path('/proc/self/fd').iterdir():
            try:target=os.readlink(fd)
            except FileNotFoundError:continue
            self.assertFalse(target.startswith(str(self.mount)+'/'),'Git workload left a trial file open')

    def test_inherited_git_configuration_and_object_store_are_ignored(self):
        poisoned={'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'core.bare','GIT_CONFIG_VALUE_0':'nonsense',
                  'GIT_OBJECT_DIRECTORY':str(self.root/'missing'),'GIT_ALTERNATE_OBJECT_DIRECTORIES':str(self.root/'missing')}
        with patch.dict(os.environ,poisoned):
            self.work.prepare();result=self.work.sample()
        self.assertGreater(result['source_search']['output_bytes'],0)

    def test_changed_source_head_aborts_without_modifying_live_data(self):
        original=self.command('rev-parse','HEAD');head=self.work.head
        def changed(directory):
            if directory==self.source and self.work.snapshot.exists():return '0'*40
            return head(directory)
        with patch.object(self.work,'head',side_effect=changed):
            with self.assertRaisesRegex(ValueError,'Source HEAD changed'):self.work.prepare()
        self.assertEqual(self.command('rev-parse','HEAD'),original)

    def test_preexisting_snapshot_is_not_replaced(self):
        self.work.snapshot.mkdir();(self.work.snapshot/'keep').write_text('preserve')
        with self.assertRaisesRegex(ValueError,'already exists'):self.work.prepare()
        self.assertEqual((self.work.snapshot/'keep').read_text(),'preserve')

    def test_snapshot_symlink_cannot_evict_unrelated_host_file(self):
        self.work.prepare();outside=self.root/'outside';outside.write_text('keep')
        (self.work.snapshot/'foreign').symlink_to(outside)
        with patch.object(pilot.os,'posix_fadvise') as advise:
            with self.assertRaisesRegex(ValueError,'linked or special'):self.work.evict()
        advise.assert_not_called();self.assertEqual(outside.read_text(),'keep')

    def test_source_budget_rejects_before_clone(self):
        with patch.object(pilot,'MAX_BYTES',1):
            with self.assertRaisesRegex(ValueError,'Source Git object budget'):self.work.prepare()
        self.assertFalse(self.work.snapshot.exists())

    def test_changed_git_output_cannot_pass_cross_phase_verification(self):
        self.work.prepare();self.work.sample()
        original=self.work.git
        def altered(directory,*args):
            data=original(directory,*args)
            return data+b'changed\n' if args==pilot.COMMANDS['history'] else data
        with patch.object(self.work,'git',side_effect=altered):
            with self.assertRaisesRegex(ValueError,'Git result changed'):self.work.sample()


if __name__=='__main__':unittest.main()
