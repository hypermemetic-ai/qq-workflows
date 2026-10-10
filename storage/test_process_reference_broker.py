import importlib.util
import errno
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('broker',Path(__file__).with_name('process-reference-broker.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class ProcessReferences(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)
        self.proc=self.root/'proc';task=self.proc/'42';task.mkdir(parents=True);self.task=task
        (task/'status').write_text('Name:\tfixture\nKthread:\t0\n')
        (task/'maps').write_text('');(task/'fd').mkdir()
        self.file=self.root/'artifact';self.file.write_bytes(b'data');info=self.file.stat()
        self.key=[info.st_dev,info.st_ino]

    def directory_fixture(self):
        folder=self.root/'snapshot';folder.mkdir();child=folder/'child';child.write_bytes(b'keep')
        info=folder.stat();device=info.st_dev
        (self.task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} / / rw - ext4 /dev/test rw\n')
        return folder,child,[[device,info.st_ino]]

    def test_directory_descendant_descriptor_blocks_but_sibling_does_not(self):
        folder,child,keys=self.directory_fixture()
        (self.task/'fd/9').symlink_to(child)
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])
        (self.task/'fd/9').unlink();(self.task/'fd/9').symlink_to(self.file)
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[])

    def test_directory_reference_translates_container_mount_paths(self):
        folder,child,keys=self.directory_fixture();device=keys[0][0]
        (self.task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} {self.root} /container rw - ext4 /dev/test rw\n')
        (self.task/'maps').write_text('0000-1000 r--p 0000 '+f'{os.major(device):02x}:{os.minor(device):02x} {child.stat().st_ino} /container/snapshot/child (deleted)\n')
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_repeated_mappings_do_not_hide_a_later_descendant(self):
        folder,child,keys=self.directory_fixture();device=keys[0][0]
        def mapping(path):
            return '0000-1000 r--p 0000 '+f'{os.major(device):02x}:{os.minor(device):02x} {path.stat().st_ino} {path}\n'
        (self.task/'maps').write_text(mapping(self.file)*5000+mapping(child))
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_mount_parsing_reuse_keeps_each_task_namespace_and_bind_pins(self):
        folder,child,keys=self.directory_fixture();device=keys[0][0]
        raw=(self.task/'mountinfo').read_bytes()
        for pid in ('43','44'):
            task=self.proc/pid;task.mkdir();(task/'status').write_bytes((self.task/'status').read_bytes())
            (task/'fd').mkdir();(task/'maps').write_text('');(task/'mountinfo').write_bytes(raw)
        task=self.proc/'44'
        (task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} {folder} /container rw - ext4 /dev/test rw\n')
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])
        # A later query must re-read mountinfo rather than retain the pin.
        (task/'mountinfo').write_bytes(raw)
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[])

    def test_time_budget_after_mapping_work_cannot_claim_complete(self):
        folder,_,keys=self.directory_fixture()
        with patch.object(m.time,'monotonic',side_effect=[0,0,26]):
            result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertFalse(result['complete']);self.assertIn('time budget exceeded',result['error'])

    def test_directory_descriptor_access_error_names_the_incomplete_task(self):
        folder,child,keys=self.directory_fixture();fd=self.task/'fd/9';fd.symlink_to(child)
        original=Path.stat
        def denied(path,*args,**kwargs):
            if path==fd:raise PermissionError('denied')
            return original(path,*args,**kwargs)
        with patch.object(Path,'stat',denied):
            result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertFalse(result['complete']);self.assertIn('process 42: descriptor access unavailable',result['error'])

    def test_exited_process_has_no_live_mount_or_file_coverage_to_inspect(self):
        folder,_,keys=self.directory_fixture()
        (self.task/'status').write_text('State:\tZ (zombie)\nKthread:\t0\n')
        (self.task/'mountinfo').unlink();(self.task/'maps').unlink()
        self.assertTrue(m.collect_directories([str(folder)],keys,self.proc)['complete'])
        self.assertTrue(m.collect([self.key],self.proc)['complete'])

    def test_mount_access_exit_race_is_verified_against_process_state(self):
        folder,_,keys=self.directory_fixture();original=Path.open
        def exiting(path,*args,**kwargs):
            if path==self.task/'mountinfo':
                (self.task/'status').write_text('State:\tZ (zombie)\n')
                raise OSError(errno.EINVAL,'Invalid argument')
            return original(path,*args,**kwargs)
        with patch.object(Path,'open',exiting):
            result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete'])

    def test_live_access_failure_stays_incomplete_and_checks_later_tasks(self):
        folder,child,keys=self.directory_fixture();original=Path.open
        later=self.proc/'43';later.mkdir()
        (later/'status').write_text('State:\tS (sleeping)\nKthread:\t0\n')
        (later/'maps').write_text('');(later/'mountinfo').write_bytes((self.task/'mountinfo').read_bytes())
        (later/'fd').mkdir();(later/'fd/9').symlink_to(child)
        def denied(path,*args,**kwargs):
            if path==self.task/'mountinfo':raise OSError(errno.EINVAL,'Invalid argument')
            return original(path,*args,**kwargs)
        with patch.object(Path,'open',denied):
            result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertFalse(result['complete']);self.assertEqual(result['blocked'],[0])
        self.assertEqual(result['processes'],2);self.assertIn('process 42:',result['error'])

    def test_inaccessible_state_cannot_be_assumed_exited(self):
        original=Path.open
        with patch.object(Path,'open',side_effect=PermissionError('denied')):
            self.assertFalse(m.exited_task(self.task))

    def test_diagnostics_are_bounded_while_remaining_processes_are_checked(self):
        folder,_,keys=self.directory_fixture()
        for pid in range(43,75):
            task=self.proc/str(pid);task.mkdir()
            (task/'status').write_text('State:\tS (sleeping)\n')
            (task/'mountinfo').write_text('invalid\n')
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertFalse(result['complete']);self.assertEqual(result['processes'],33)
        self.assertEqual(len(result['errors']),16)

    def test_path_containment_does_not_confuse_prefix_siblings(self):
        self.assertTrue(m.within_path(Path('/candidate/child'),Path('/candidate')))
        self.assertTrue(m.within_path(Path('/candidate'),Path('/candidate')))
        self.assertTrue(m.within_path(Path('/candidate'),Path('/')))
        self.assertFalse(m.within_path(Path('/candidate-old/child'),Path('/candidate')))

    def test_directory_subtree_bind_mount_blocks_without_open_descriptors(self):
        folder,child,keys=self.directory_fixture();device=keys[0][0]
        (self.task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} {child} /container/library rw - ext4 /dev/test rw\n')
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_unrelated_namespace_mount_roots_allow_complete_coverage(self):
        folder,child,keys=self.directory_fixture()
        other=os.makedev(0,4) if keys[0][0]!=os.makedev(0,4) else os.makedev(0,5)
        with (self.task/'mountinfo').open('a') as stream:
            stream.write(f'1505 31 {os.major(other)}:{os.minor(other)} net:[4026531833] /run/docker/netns/default rw shared:975 - nsfs nsfs rw\n')
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[])
        (self.task/'fd/9').symlink_to(child)
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_non_path_mount_root_on_candidate_device_fails_closed(self):
        folder,_,keys=self.directory_fixture();device=keys[0][0]
        (self.task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} net:[4026531833] /namespace rw - nsfs nsfs rw\n')
        self.assertFalse(m.collect_directories([str(folder)],keys,self.proc)['complete'])

    def test_reader_root_rendering_is_retained_with_a_different_task_root(self):
        folder,child,keys=self.directory_fixture();device=keys[0][0]
        (self.task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} /container-root / rw - ext4 /dev/test rw\n')
        (self.task/'fd/9').symlink_to(child)
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_chroot_mapping_matches_reader_file_identity_without_task_mount(self):
        folder,child,keys=self.directory_fixture();device=keys[0][0]
        (self.task/'mountinfo').write_text('')
        for path,blocked in ((self.file,[]),(child,[0])):
            (self.task/'maps').write_text('0000-1000 r--p 0000 '+f'{os.major(device):02x}:{os.minor(device):02x} {path.stat().st_ino} {path}\n')
            result=m.collect_directories([str(folder)],keys,self.proc)
            self.assertTrue(result['complete']);self.assertEqual(result['blocked'],blocked)

    def test_chroot_mapping_cannot_trust_a_reader_path_with_wrong_identity(self):
        folder,_,keys=self.directory_fixture();device=keys[0][0]
        (self.task/'mountinfo').write_text('')
        (self.task/'maps').write_text('0000-1000 r--p 0000 '+f'{os.major(device):02x}:{os.minor(device):02x} {self.file.stat().st_ino+1} {self.file}\n')
        result=m.collect_directories([str(folder)],keys,self.proc)
        self.assertFalse(result['complete']);self.assertIn('process 42: relevant mount coverage unavailable',result['error'])

    def test_directory_coverage_fails_closed_on_unmapped_references_and_limits(self):
        folder,child,keys=self.directory_fixture()
        (self.task/'fd/9').symlink_to(child)
        device=keys[0][0]
        (self.task/'mountinfo').write_text(f'1 0 {os.major(device)}:{os.minor(device)} / /other-root rw - ext4 /dev/test rw\n')
        # The reader's name is also unavailable, so neither namespace can
        # establish the held inode's physical location.
        original=Path.resolve
        def unavailable(path,*args,**kwargs):
            if path==child:raise FileNotFoundError('reader path disappeared')
            return original(path,*args,**kwargs)
        with patch.object(Path,'resolve',unavailable):
            self.assertFalse(m.collect_directories([str(folder)],keys,self.proc)['complete'])
        self.assertFalse(m.collect_directories([str(folder)],keys,self.proc,seconds=-1)['complete'])
        (self.task/'mountinfo').write_bytes(b'x'*262145)
        self.assertFalse(m.collect_directories([str(folder)],keys,self.proc)['complete'])

    def test_directory_validation_refuses_alias_root_file_and_foreign_owner(self):
        folder,_,keys=self.directory_fixture();alias=self.root/'alias';alias.symlink_to(folder)
        self.assertEqual(m.validate_directories([str(folder)],(self.root,),os.getuid()),keys)
        for candidate in (self.root,alias,self.file):
            with self.assertRaises(ValueError):m.validate_directories([str(candidate)],(self.root,),os.getuid())
        with self.assertRaisesRegex(ValueError,'owned SSD'):m.validate_directories([str(folder)],(self.root,),os.getuid()+1)

    def test_mountinfo_escaped_paths_are_decoded(self):
        self.assertEqual(m.decode_mount_path(b'/path\\040with\\134slash'),'/path with\\slash')

    def test_descriptor_identity_detected_without_namespace_path_match(self):
        alias=self.root/'unrelated-name';os.link(self.file,alias);(self.task/'fd/9').symlink_to(alias)
        result=m.collect([self.key],self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_mapping_is_detected_after_descriptor_closed(self):
        dev=self.key[0]
        (self.task/'maps').write_text('0000-1000 r--p 0000 '+f'{os.major(dev):02x}:{os.minor(dev):02x} {self.key[1]} /container/renamed\n')
        result=m.collect([self.key],self.proc)
        self.assertTrue(result['complete']);self.assertEqual(result['blocked'],[0])

    def test_unreadable_process_or_budget_cannot_claim_complete(self):
        original=Path.open
        def denied(p,*args,**kwargs):
            if p==self.task/'maps':raise PermissionError('denied')
            return original(p,*args,**kwargs)
        with patch.object(Path,'open',denied):self.assertFalse(m.collect([self.key],self.proc)['complete'])
        self.assertFalse(m.collect([self.key],self.proc,seconds=-1)['complete'])

    def test_validation_refuses_unmounted_volume_symlink_and_outside_path(self):
        mount=self.root/'mount';mount.mkdir();inside=mount/'file';inside.write_text('data')
        with patch.object(m.os.path,'ismount',return_value=False):
            with self.assertRaisesRegex(ValueError,'unavailable'):m.validate([str(inside)],mount,os.getuid())
        original=Path.stat
        def root_dev(p,*args,**kwargs):
            if p==Path('/'):return SimpleNamespace(st_dev=-1)
            return original(p,*args,**kwargs)
        with patch.object(m.os.path,'ismount',return_value=True),patch.object(Path,'stat',root_dev):
            self.assertEqual(len(m.validate([str(inside)],mount,os.getuid())),1)
            for path in (str(self.file),str(mount/'link')):
                (mount/'link').unlink(missing_ok=True);(mount/'link').symlink_to(inside)
                with self.assertRaisesRegex(ValueError,'outside'):m.validate([path],mount,os.getuid())
