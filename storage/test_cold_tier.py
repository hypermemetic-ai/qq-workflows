import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cold_tier', Path(__file__).with_name('cold-tier.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class ColdTierTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.base = Path(self.tmp.name)
        self.home = self.base / 'home'; self.home.mkdir()
        self.archive = self.base / 'hdd'; self.archive.mkdir()
        self.store = m.Store(self.home / 'control')
        self.cfg = dict(m.DEFAULT, source_roots=[str(self.home)], excluded=[str(self.store.state)],
                        archive=str(self.archive), hdd_mount=str(self.archive), hot_storage=str(self.home / 'hot'),
                        copy_kib_per_second=1024*1024, verify_bytes_per_second=1024**3)
        self.mount = patch.object(m, 'mount_ready', return_value=self.archive); self.mount.start()
    def tearDown(self):
        self.mount.stop(); self.store.db.close(); self.tmp.cleanup()
    def root(self):
        target = self.archive / 'mixed'; target.mkdir()
        (target / 'build').mkdir(); (target / 'build/cold.bin').write_bytes(b'cold')
        (target / 'build/hot.bin').write_bytes(b'hot')
        (target / 'source.py').write_text('unique source')
        (target / 'lock.json').write_text('{"version":1}')
        source = self.home / 'mixed'; source.symlink_to(target)
        key = self.store.register(source, target)
        now = time.time()
        self.store.db.execute('UPDATE roots SET since=?,coverage=1,error=\'\' WHERE id=?', (now-31*m.DAY, key))
        for p in target.rglob('*'): os.utime(p, (now-31*m.DAY, now-31*m.DAY))
        self.store.put('heartbeat', now); self.store.db.commit()
        m.record_scope(self.store, key, 'build', 'fixture: reproduce build from lock.json', target / 'lock.json')
        return key, source, target, now
    def test_hot_file_does_not_retain_cold_sibling_or_delete_source(self):
        key, source, target, now = self.root()
        self.store.activity(key, 'build/hot.bin', m.ACCESS, now); self.store.db.commit()
        with patch.object(m, 'references', return_value=[]):
            result = m.gc(self.store, self.cfg, apply=True, now=now, barrier=lambda: None)
        self.assertEqual(result['deleted_files'], 1)
        self.assertFalse((target / 'build/cold.bin').exists())
        self.assertTrue((target / 'build/hot.bin').exists())
        self.assertEqual((source / 'source.py').read_text(), 'unique source')
    def test_stale_coverage_prevents_gc(self):
        _, _, target, now = self.root(); self.store.put('heartbeat', now-120)
        self.assertEqual(m.gc(self.store, self.cfg, now=now)['eligible_files'], 0)
        self.assertTrue((target / 'build/cold.bin').exists())
    def test_no_deletion_without_live_event_barrier(self):
        self.root()
        with self.assertRaises(ValueError): m.gc(self.store, self.cfg, apply=True)
    def test_queued_read_at_deletion_barrier_preserves_file(self):
        key, _, target, now = self.root()
        def barrier(): self.store.activity(key, 'build/cold.bin', m.ACCESS, now)
        with patch.object(m, 'references', return_value=[]): m.gc(self.store, self.cfg, apply=True, now=now, barrier=barrier)
        self.assertTrue((target / 'build/cold.bin').exists())
    def test_changed_regeneration_proof_prevents_gc(self):
        _, _, target, now = self.root(); (target / 'lock.json').write_text('changed')
        self.assertEqual(m.gc(self.store, self.cfg, now=now)['eligible_files'], 0)
    def test_no_follow_gc_symlink(self):
        _, _, target, now = self.root()
        outside = self.home / 'unique'; outside.write_text('keep')
        (target / 'build/link').symlink_to(outside)
        with patch.object(m, 'references', return_value=[]): m.gc(self.store, self.cfg, apply=True, now=now, barrier=lambda:None)
        self.assertEqual(outside.read_text(), 'keep')
        self.assertTrue((target / 'build/link').is_symlink())
    def test_new_subtree_resets_its_clock_only(self):
        key, _, target, now = self.root()
        self.store.activity(key, 'build', m.MODIFY, now)
        root = self.store.root(key)
        self.assertFalse(m.quiet(self.store, root, 'build/cold.bin', (target/'build/cold.bin').stat(), now, 30))
        self.assertTrue(m.quiet(self.store, root, 'source.py', (target/'source.py').stat(), now, 30))
    def test_frequency_alone_does_not_promote(self):
        key, _, _, now = self.root()
        for _ in range(150): self.store.activity(key, 'build/hot.bin', m.ACCESS, now)
        self.assertEqual(m.decisions(self.store, self.cfg, now)[0]['decision'], 'measure_task_latency')
        self.store.db.execute('INSERT INTO latency VALUES (?,?,?,?,?)', (key, 'matched task', 400, 200, now))
        self.assertEqual(m.decisions(self.store, self.cfg, now)[0]['decision'], 'promote')
    def test_overflow_invalidates_quiet_clock(self):
        key, _, _, _ = self.root()
        class Events:
            def events(self): return [(None, None, m.OVERFLOW)]
        self.assertTrue(m.consume_events(self.store, Events(), self.store.roots()))
        self.assertEqual(self.store.root(key)['coverage'], 0)
        self.assertEqual(self.store.root(key)['since'], 0)
    def test_atomic_defaults_preserve_open_handles_and_route_new_files(self):
        source = self.home / 'cache'; source.mkdir(); (source/'old').mkdir(); (source/'old/data').write_text('original')
        fd = os.open(source/'old/data', os.O_RDONLY)
        try:
            parent = m.bridge_parent(self.store, self.cfg, source)
            self.assertEqual(os.read(fd, 50), b'original')
            self.assertEqual((source/'old/data').read_text(), 'original')
            (source/'new').write_text('new data')
            self.assertEqual((Path(parent['hdd'])/'new').read_text(), 'new data')
            self.assertFalse((Path(parent['backing'])/'new').exists())
            m.adopt_defaults(self.store, self.cfg)
            self.assertEqual({r['location'] for r in self.store.roots()}, {'hdd','ssd'})
        finally: os.close(fd)
    def test_parent_fd_write_is_admitted_after_cutover(self):
        source = self.home / 'cache'; source.mkdir(); fd = os.open(source, os.O_DIRECTORY)
        try:
            parent = m.bridge_parent(self.store, self.cfg, source)
            newfd = os.open('late', os.O_WRONLY|os.O_CREAT, 0o600, dir_fd=fd)
            os.write(newfd,b'late'); os.close(newfd)
            m.adopt_defaults(self.store, self.cfg)
            self.assertEqual((source/'late').read_text(), 'late')
            self.assertEqual((Path(parent['backing'])/'late').read_text(), 'late')
        finally: os.close(fd)
    def test_migration_verifies_and_preserves_links(self):
        source = self.home/'artifact'; source.mkdir(); (source/'data').write_bytes(b'x'*1024)
        (source/'link').symlink_to('data'); os.link(source/'data',source/'hard')
        with patch.object(m,'references',return_value=[]): m.migrate(self.store,self.cfg,source)
        self.assertTrue(source.is_symlink()); self.assertEqual((source/'data').read_bytes(),b'x'*1024)
        self.assertEqual((source/'data').stat().st_ino,(source/'hard').stat().st_ino)
        self.assertEqual(os.readlink(source/'link'),'data')
        self.assertFalse((self.store.state/'operation.json').exists())
    def test_failed_copy_retains_original(self):
        source = self.home/'artifact'; source.mkdir(); (source/'data').write_text('keep')
        with patch.object(m,'references',return_value=[]), patch.object(m.subprocess,'run',side_effect=subprocess.CalledProcessError(1,'rsync')):
            with self.assertRaises(subprocess.CalledProcessError): m.migrate(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink()); self.assertEqual((source/'data').read_text(),'keep')
    def test_mutating_copy_retains_original(self):
        source = self.home/'artifact'; source.mkdir(); (source/'data').write_text('keep')
        def mutation(args, **kwargs):
            destination = Path(args[-1]); destination.mkdir(exist_ok=True)
            (destination/'data').write_text('keep'); (source/'data').write_text('new value')
        with patch.object(m,'references',return_value=[]), patch.object(m.subprocess,'run',side_effect=mutation):
            with self.assertRaises(ValueError): m.migrate(self.store,self.cfg,source)
        self.assertEqual((source/'data').read_text(),'new value'); self.assertFalse(source.is_symlink())
    def test_live_reference_defers_before_copy(self):
        source = self.home/'artifact'; source.mkdir()
        with patch.object(m,'references',return_value=[123]):
            with self.assertRaisesRegex(ValueError,'live process'): m.migrate(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink())
    def test_mount_absent_refuses_root_disk_fallback(self):
        with patch.object(Path,'is_mount',return_value=False):
            with self.assertRaises(ValueError): self.mount.stop(); m.mount_ready(self.cfg)
        self.mount.start()
    def test_no_size_cutoff_in_discovery(self):
        base = self.home/'data'; base.mkdir(); (base/'tiny').write_text('small')
        (base/'many-small').mkdir(); (base/'many-small/a').write_bytes(b'x'*100)
        rows = m.discover(self.cfg,[base])
        self.assertEqual(len(rows),2); self.assertTrue(all(r['allocated_bytes']>0 for r in rows))
    def test_real_inotify_reports_access(self):
        root = self.home/'data'; root.mkdir(); f = root/'a'; f.write_text('a')
        watcher = m.Inotify(10)
        try:
            watcher.tree(root,'fixture'); f.read_text()
            self.assertTrue(any(mask & m.ACCESS and path==f for _,path,mask in watcher.events()))
        finally: watcher.close()
    def test_verified_scope_cannot_contain_its_proof(self):
        key, _, target, _ = self.root()
        with self.assertRaises(ValueError): m.record_scope(self.store,key,'build','recipe',target/'build/cold.bin')
    def test_external_relative_links_keep_their_original_target(self):
        source = self.home/'artifact'; source.mkdir(); (self.home/'shared').write_text('external')
        (source/'external').symlink_to('../shared')
        with patch.object(m,'references',return_value=[]): m.migrate(self.store,self.cfg,source)
        self.assertEqual((source/'external').read_text(),'external')
        self.assertEqual(os.readlink(source/'external'),str(self.home/'shared'))
    def test_default_child_moves_then_restores_without_changing_public_path(self):
        source=self.home/'cache'; source.mkdir(); (source/'artifact').mkdir(); (source/'artifact/data').write_text('keep')
        with patch.object(m,'references',return_value=[]):
            m.bridge_parent(self.store,self.cfg,source); m.adopt_defaults(self.store,self.cfg)
            root=self.store.root(str(source/'artifact'))
            m.migrate(self.store,self.cfg,source/'artifact',demoting=root)
            cold=self.store.root(root['id']); self.assertEqual(cold['location'],'hdd')
            hot=self.home/'hot';hot.mkdir()
            with patch.object(m,'hot_ready',return_value=hot): m.migrate(self.store,self.cfg,source/'artifact',restoring=cold)
        self.assertEqual((source/'artifact/data').read_text(),'keep')
        self.assertEqual(self.store.root(root['id'])['location'],'ssd')
        self.assertTrue(Path(self.store.root(root['id'])['target']).is_dir())
    def test_atomic_save_supersedes_old_ssd_proxy(self):
        source=self.home/'cache'; source.mkdir(); (source/'a').write_text('old')
        with patch.object(m,'references',return_value=[]): m.bridge_parent(self.store,self.cfg,source)
        m.adopt_defaults(self.store,self.cfg); (source/'temp').write_text('new'); (source/'temp').replace(source/'a')
        m.adopt_defaults(self.store,self.cfg)
        row=self.store.root(str(source/'a'));self.assertEqual(row['location'],'hdd')
        self.assertEqual(Path(row['target']).read_text(),'new')
        self.assertEqual(Path(row['hot']).read_text(),'old')
    def test_active_root_file_defers_parent_cutover(self):
        source=self.home/'db';source.mkdir();(source/'live.sqlite').write_text('db')
        with patch.object(m,'references',return_value=[123]):
            with self.assertRaises(ValueError):m.bridge_parent(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink())
    def test_external_hard_link_is_deferred(self):
        source=self.home/'artifact';source.mkdir();(source/'data').write_text('shared')
        os.link(source/'data',self.home/'other')
        with self.assertRaisesRegex(ValueError,'hard links extend'):m.inventory(source,100)
        self.assertEqual((source/'data').stat().st_ino,(self.home/'other').stat().st_ino)
    def test_exchange_failure_preserves_both_copies_and_journal(self):
        source=self.home/'artifact';source.mkdir();(source/'data').write_text('keep')
        with patch.object(m,'references',return_value=[]),patch.object(m,'exchange',side_effect=OSError('failed')):
            with self.assertRaises(OSError):m.migrate(self.store,self.cfg,source)
        self.assertEqual((source/'data').read_text(),'keep')
        journal=m.bounded_json(self.store.state/'operation.json')
        self.assertEqual((Path(journal['destination'])/'data').read_text(),'keep')
    def test_watch_admission_drains_its_own_directory_events(self):
        path=self.home/'tree';path.mkdir()
        for n in range(150):(path/str(n)).mkdir()
        watcher=m.Inotify(200);calls=[]
        def progress():calls.append(1);self.assertEqual(watcher.events(),[])
        watcher.on_progress=progress
        try:
            watcher.tree(path,'root');self.assertGreaterEqual(len(calls),2)
            self.assertEqual(len(watcher.paths),151)
        finally:watcher.close()
    def test_dynamic_subtree_admission_keeps_other_retention_clocks(self):
        key,_,target,now=self.root();watcher=m.Inotify(50)
        try:
            watcher.tree(target,key);watcher.events()
            new=target/'fresh';new.mkdir()
            m.consume_events(self.store,watcher,self.store.roots())
            self.assertIn(new,watcher.by_path)
            root=self.store.root(key);self.assertEqual(root['coverage'],1)
            self.assertTrue(m.quiet(self.store,root,'build/cold.bin',(target/'build/cold.bin').stat(),now,30))
            new.rmdir();m.consume_events(self.store,watcher,self.store.roots())
            self.assertNotIn(new,watcher.by_path)
            self.assertEqual(self.store.root(key)['coverage'],1)
        finally:watcher.close()
    def test_mutation_guard_ignores_verification_reads(self):
        path=self.home/'artifact';path.mkdir();(path/'a').write_text('a')
        guard=m.Inotify(10,mask=m.MODIFY|m.ATTRIB|m.CREATE|m.DELETE)
        try:
            guard.tree(path,'move');(path/'a').read_text();self.assertEqual(guard.events(),[])
            (path/'a').write_text('changed')
            self.assertTrue(any(mask&m.MODIFY for _,_,mask in guard.events()))
        finally:guard.close()


if __name__=='__main__': unittest.main()
