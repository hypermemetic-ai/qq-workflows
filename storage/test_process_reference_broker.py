import importlib.util
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
