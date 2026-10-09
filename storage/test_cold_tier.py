import importlib.util
import contextlib
import os
from pathlib import Path
import subprocess
import sys
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
        # Fixture copies live on the host root filesystem; do not flush unrelated
        # host writers during tests. Failure/order tests exercise this boundary.
        self.flush_patch = patch.object(m, 'flush_copy'); self.flush = self.flush_patch.start()
    def tearDown(self):
        self.flush_patch.stop(); self.mount.stop(); self.store.db.close(); self.tmp.cleanup()
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
    @contextlib.contextmanager
    def running_watch(self):
        code="""import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('tier',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c=json.loads(sys.argv[2]);m.mount_ready=lambda cfg:Path(cfg['archive'])
m.watch(m.Store(sys.argv[3]),c)
"""
        child=subprocess.Popen([sys.executable,'-c',code,str(Path(m.__file__).resolve()),m.json.dumps(self.cfg),str(self.store.state)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:yield child
        finally:
            child.terminate()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.wait()
    def await_coverage(self,key):
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            if self.store.root(key)['coverage']:return
            time.sleep(.05)
        self.fail('watch coverage was not established')
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
    def test_block_cached_root_stays_in_place_when_demand_and_latency_would_promote(self):
        key, _, _, now = self.root()
        for _ in range(150): self.store.activity(key, 'build/hot.bin', m.ACCESS, now)
        self.store.db.execute('INSERT INTO latency VALUES (?,?,?,?,?)', (key, 'matched task', 400, 200, now))
        self.cfg['block_cached_mounts'] = [str(self.archive)]
        decision = m.decisions(self.store, self.cfg, now)[0]
        self.assertEqual(decision['decision'], 'block_cache'); self.assertTrue(decision['block_cached'])
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
    def test_native_default_route_preserves_old_open_handles_and_new_writes(self):
        source = self.home/'cache'; source.mkdir(); (source/'old').mkdir()
        (source/'old/data').write_text('keep')
        parent = m.bridge_parent(self.store,self.cfg,source); m.adopt_defaults(self.store,self.cfg)
        old = Path(parent['hdd']); (old/'hdd-existing').write_text('hdd data')
        fd = os.open(old,os.O_DIRECTORY)
        new = self.base/'native'; new.mkdir()
        try:
            with patch.object(m,'mount_ready',return_value=new):
                m.route_defaults(self.store,self.cfg)
                self.assertEqual((source/'old/data').read_text(),'keep')
                self.assertEqual((source/'hdd-existing').read_text(),'hdd data')
                (source/'fresh').write_text('native data')
                late = os.open('late',os.O_CREAT|os.O_WRONLY,0o600,dir_fd=fd)
                os.write(late,b'old FD data');os.close(late)
                m.adopt_defaults(self.store,self.cfg)
                self.assertEqual((source/'late').read_text(),'old FD data')
                self.assertTrue((new/'defaults'/m.hashlib.sha256(str(source).encode()).hexdigest()[:16]/'fresh').is_file())
                self.assertFalse((old/'fresh').exists())
                self.assertEqual(self.store.root(str(source/'late'))['location'],'hdd')
                m.route_defaults(self.store,self.cfg) # idempotent
        finally:os.close(fd)
    def test_native_route_recovers_interruption_after_exchange(self):
        source=self.home/'cache';source.mkdir();(source/'data').write_text('keep')
        m.bridge_parent(self.store,self.cfg,source)
        new=self.base/'native';new.mkdir();real=m.recover_default_route;calls=[]
        def interrupted(store):
            calls.append(1)
            if len(calls)==2:raise OSError('interrupted after publication')
            return real(store)
        with patch.object(m,'mount_ready',return_value=new),patch.object(m,'recover_default_route',side_effect=interrupted):
            with self.assertRaises(OSError):m.route_defaults(self.store,self.cfg)
        self.assertTrue((self.store.state/'default-route-operation.json').exists())
        m.recover_default_route(self.store)
        self.assertEqual(source.resolve(),Path(self.store.get('defaults')[0]['hdd']))
        self.assertEqual((source/'data').read_text(),'keep')
        self.assertFalse((self.store.state/'default-route-operation.json').exists())
    def test_migration_staging_is_not_adopted_as_user_data(self):
        source=self.home/'cache';source.mkdir();m.bridge_parent(self.store,self.cfg,source)
        (source/'.data.qq-tier-original').write_text('temporary')
        m.adopt_defaults(self.store,self.cfg);self.assertEqual(self.store.roots(),[])
    def test_partition_preserves_busy_child_inodes_and_admits_idle_siblings(self):
        source=self.home/'cache';source.mkdir();(source/'mixed').mkdir()
        (source/'mixed/busy').mkdir();(source/'mixed/busy/data').write_text('open data')
        (source/'mixed/idle').mkdir();(source/'mixed/idle/data').write_text('idle data')
        m.bridge_parent(self.store,self.cfg,source);m.adopt_defaults(self.store,self.cfg)
        root=self.store.root(str(source/'mixed'));fd=os.open(source/'mixed/busy/data',os.O_RDONLY)
        try:
            m.partition_root(self.store,self.cfg,root['id'])
            self.assertEqual(os.read(fd,50),b'open data')
            physical=Path(root['hot'])
            managed={p['backing'] for p in self.store.get('defaults')}
            self.assertFalse(any(r['hot'] in managed for r in self.store.roots()))
            self.assertFalse((source/'.mixed-qq-ssd').exists())
            idle=self.store.root(str(physical/'idle'))
            self.assertEqual(idle['location'],'ssd')
            with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,physical/'idle',demoting=idle)
            self.assertEqual((source/'mixed/idle/data').read_text(),'idle data')
            self.assertEqual((source/'mixed/busy/data').read_text(),'open data')
        finally:os.close(fd)
    def test_previously_admitted_backing_is_retired_without_touching_its_files(self):
        source=self.home/'cache';source.mkdir();(source/'data').mkdir()
        m.bridge_parent(self.store,self.cfg,source);m.adopt_defaults(self.store,self.cfg)
        root=self.store.root(str(source/'data'));m.partition_root(self.store,self.cfg,root['id'])
        backing=Path(self.store.get('defaults')[-1]['backing']);(backing/'keep').write_text('keep')
        proxy=source/backing.name;proxy.symlink_to(backing)
        duplicate=self.store.register(proxy,self.archive/'unused','ssd',hot=backing)
        m.adopt_defaults(self.store,self.cfg)
        self.assertEqual((backing/'keep').read_text(),'keep')
        self.assertIsNone(self.store.db.execute('SELECT 1 FROM roots WHERE id=?',(duplicate,)).fetchone())
    def test_late_parent_writes_are_admitted_while_migration_lock_is_held(self):
        source=self.home/'cache';source.mkdir();parent=m.bridge_parent(self.store,self.cfg,source)
        (Path(parent['backing'])/'late').write_text('keep')
        with m.lock(self.store.state/'move.lock'),self.running_watch():
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if self.store.db.execute('SELECT 1 FROM roots WHERE source=?',(str(source/'late'),)).fetchone():break
                time.sleep(.05)
            self.assertIsNotNone(self.store.db.execute('SELECT 1 FROM roots WHERE source=?',(str(source/'late'),)).fetchone())
            self.assertEqual((source/'late').read_text(),'keep')
    def test_new_hdd_root_reclaims_watch_budget_from_already_admitted_ssd(self):
        self.cfg['max_watches']=10
        hot=self.home/'hot-data';hot.mkdir()
        for n in range(9):(hot/str(n)).mkdir()
        ssd=self.store.register(hot,self.archive/'unused','ssd',hot=hot)
        with self.running_watch():
            self.await_coverage(ssd)
            cold=self.archive/'cold';cold.mkdir();(cold/'child').mkdir()
            public=self.home/'cold';public.symlink_to(cold)
            hdd=self.store.register(public,cold)
            self.await_coverage(hdd)
            self.assertEqual(self.store.root(ssd)['coverage'],0)
            self.assertEqual(self.store.root(ssd)['since'],0)
            self.assertTrue(hot.is_dir());self.assertTrue(cold.is_dir())
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
    def test_failed_durability_check_retains_original_and_does_not_publish(self):
        source = self.home/'artifact'; source.mkdir(); (source/'data').write_text('keep')
        self.flush.side_effect = subprocess.CalledProcessError(1, 'sync')
        with patch.object(m,'references',return_value=[]),patch.object(m,'exchange') as exchange:
            with self.assertRaises(subprocess.CalledProcessError):m.migrate(self.store,self.cfg,source)
        exchange.assert_not_called(); self.assertFalse(source.is_symlink())
        self.assertEqual((source/'data').read_text(),'keep'); self.assertEqual(self.store.roots(),[])
        self.assertFalse((self.store.state/'operation.json').exists())
    def test_durable_copy_precedes_publication_and_original_retirement(self):
        source = self.home/'artifact'; source.mkdir(); (source/'data').write_text('keep')
        synced = []
        def flush(destination):
            self.assertFalse(source.is_symlink()); self.assertEqual((source/'data').read_text(),'keep')
            self.assertEqual((destination/'data').read_text(),'keep'); synced.append(destination)
        self.flush.side_effect = flush
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,source)
        self.assertEqual(source.resolve(),synced[0]); self.assertTrue(source.is_symlink())
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
            physical=Path(root['hot'])
            m.migrate(self.store,self.cfg,source/'artifact',demoting=root)
            cold=self.store.root(root['id']); self.assertEqual(cold['location'],'hdd')
            self.assertTrue(physical.is_symlink());self.assertEqual((physical/'data').read_text(),'keep')
            hot=self.home/'hot';hot.mkdir()
            with patch.object(m,'hot_ready',return_value=hot): m.migrate(self.store,self.cfg,source/'artifact',restoring=cold)
        self.assertEqual((source/'artifact/data').read_text(),'keep')
        self.assertEqual(self.store.root(root['id'])['location'],'ssd')
        self.assertTrue(Path(self.store.root(root['id'])['target']).is_dir())
        self.assertEqual(physical.resolve(),(source/'artifact').resolve())
    def test_writer_opening_original_during_publication_preserves_retired_copy(self):
        source=self.home/'artifact';source.mkdir();(source/'data').write_text('keep')
        real=m.exchange;handle=[]
        def publishing(a,b):
            handle.append((source/'data').open('a'))
            handle[-1].write('late write');handle[-1].flush();real(a,b)
        try:
            with patch.object(m,'references',return_value=[]),patch.object(m,'exchange',side_effect=publishing):
                with self.assertRaisesRegex(ValueError,'retired original became active'):
                    m.migrate(self.store,self.cfg,source)
            record=m.bounded_json(self.store.state/'operation.json')
            self.assertEqual((Path(record['staged'])/'data').read_text(),'keeplate write')
            self.assertEqual((Path(record['destination'])/'data').read_text(),'keep')
        finally:
            for f in handle:f.close()
    def test_atomic_save_supersedes_old_ssd_proxy(self):
        source=self.home/'cache'; source.mkdir(); (source/'a').write_text('old')
        with patch.object(m,'references',return_value=[]): m.bridge_parent(self.store,self.cfg,source)
        m.adopt_defaults(self.store,self.cfg); (source/'temp').write_text('new'); (source/'temp').replace(source/'a')
        m.adopt_defaults(self.store,self.cfg)
        row=self.store.root(str(source/'a'));self.assertEqual(row['location'],'hdd')
        self.assertEqual(Path(row['target']).read_text(),'new')
        self.assertEqual(Path(row['hot']).read_text(),'old')
    def test_old_hdd_atomic_save_is_adopted_after_destination_changes_filesystem(self):
        try: tmp = tempfile.TemporaryDirectory(dir='/dev/shm')
        except OSError: self.skipTest('Separate temporary filesystem unavailable')
        with tmp as d:
            new_archive = Path(d)
            if new_archive.stat().st_dev == self.archive.stat().st_dev:
                self.skipTest('Temporary filesystem is not separate')
            source=self.home/'cache'; source.mkdir(); (source/'a').write_text('old')
            with patch.object(m,'references',return_value=[]): m.bridge_parent(self.store,self.cfg,source)
            m.adopt_defaults(self.store,self.cfg)
            (source/'temp').write_text('new'); (source/'temp').replace(source/'a')
            with patch.object(m,'mount_ready',return_value=new_archive): m.adopt_defaults(self.store,self.cfg)
            row=self.store.root(str(source/'a'))
            self.assertEqual(row['location'],'hdd'); self.assertEqual(Path(row['target']).read_text(),'new')
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
    def test_immutable_scope_copies_internal_links_and_preserves_external_alias(self):
        source=self.home/'sdk';source.mkdir();(source/'library').write_text('immutable bytes')
        os.link(source/'library',source/'inside');os.link(source/'library',self.home/'outside')
        old=(self.home/'outside').stat().st_ino
        self.cfg['immutable_hardlink_scopes']=[str(source)]
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,source)
        self.assertEqual((source/'library').read_text(),'immutable bytes')
        self.assertEqual((self.home/'outside').stat().st_ino,old)
        self.assertNotEqual((source/'library').stat().st_ino,old)
        self.assertEqual((source/'library').stat().st_ino,(source/'inside').stat().st_ino)
        receipt=m.json.loads((self.store.state/'moves.jsonl').read_text())
        self.assertEqual(receipt['detached_immutable_links'][0]['inside'],2)
    def test_external_alias_mutation_before_publish_retains_original(self):
        source=self.home/'sdk';source.mkdir();(source/'library').write_text('before')
        os.link(source/'library',self.home/'outside')
        self.cfg['immutable_hardlink_scopes']=[str(source)]
        self.flush.side_effect=lambda dest:(self.home/'outside').write_text('changed outside')
        with patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'source mutation'):m.migrate(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink());self.assertEqual((source/'library').read_text(),'changed outside')
        self.assertFalse((self.store.state/'operation.json').exists())
    def test_inventory_allocated_size_does_not_count_shared_inodes_twice(self):
        source=self.home/'sdk';source.mkdir();(source/'library').write_bytes(b'x'*8192)
        os.link(source/'library',source/'inside')
        _,size=m.inventory(source,100)
        self.assertEqual(size,(source.stat().st_blocks+(source/'library').stat().st_blocks)*512)
    def test_lookup_environment_is_not_an_open_reference_but_data_environment_is(self):
        source=self.home/'sdk';source.mkdir()
        script='import sys; print("ready",flush=True); sys.stdin.read()'
        for variable,expected in [('PATH',False),('APPLICATION_DATA',True)]:
            env=dict(os.environ);env[variable]=str(source)
            child=subprocess.Popen([sys.executable,'-c',script],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'ready')
                self.assertEqual(child.pid in m.references([source]),expected)
            finally:
                child.terminate();child.wait(timeout=5);child.stdin.close();child.stdout.close()
    def test_protected_descendant_prevents_entire_registered_tree_migration(self):
        source=self.home/'mixed';source.mkdir();protected=source/'paid';protected.mkdir()
        (protected/'source').write_text('preserve')
        key=self.store.register(source,self.archive/'unused','ssd',hot=source)
        self.cfg['excluded'].append(str(protected))
        with patch.object(m.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'protected data'):
                m.migrate(self.store,self.cfg,source,demoting=self.store.root(key))
            with self.assertRaisesRegex(ValueError,'protected data'):
                m.partition_root(self.store,self.cfg,key)
        run.assert_not_called();self.assertEqual((protected/'source').read_text(),'preserve')
        self.assertEqual(m.decisions(self.store,self.cfg)[0]['decision'],'protected')
    def test_regeneration_scope_containing_protected_file_cannot_be_pruned(self):
        _,_,target,now=self.root();self.cfg['excluded'].append(str(target/'build/hot.bin'))
        with patch.object(m,'references',return_value=[]):
            result=m.gc(self.store,self.cfg,apply=True,now=now,barrier=lambda:None)
        self.assertEqual(result['deleted_files'],0);self.assertTrue((target/'build/cold.bin').exists())
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
    def test_watch_rebuild_drains_removal_notifications_and_retains_other_root(self):
        large=self.home/'large';large.mkdir()
        for n in range(200):(large/str(n)).mkdir()
        other=self.home/'other';other.mkdir();(other/'data').write_text('keep')
        watcher=m.Inotify(250);watcher.tree(large,'large');watcher.tree(other,'other');watcher.events()
        drains=[]
        def progress():
            events=watcher.events();drains.append(len(events))
            self.assertFalse(any(mask&m.OVERFLOW for _,_,mask in events))
        watcher.on_progress=progress
        try:
            watcher.remove_root('large')
            self.assertGreaterEqual(len(drains),3);self.assertNotIn('large',watcher.by_root)
            self.assertIn(other,watcher.by_path);(other/'data').read_text()
            self.assertTrue(any(key=='other' and mask&m.ACCESS for key,_,mask in watcher.events()))
            watcher.tree(large,'large');self.assertEqual(len(watcher.paths),202)
        finally:watcher.close()
    def test_flat_leaf_scan_does_not_overflow_its_own_kernel_event_queue(self):
        queued=int(Path('/proc/sys/fs/inotify/max_queued_events').read_text())
        count=queued//2+512
        if count>10000:self.skipTest('Kernel event queue exceeds bounded fixture size')
        root=self.home/'leaves';root.mkdir()
        for n in range(count):(root/str(n)).mkdir()
        watcher=m.Inotify(count+1);overflow=[]
        def drain():
            overflow.extend(e for e in watcher.events() if e[2]&m.OVERFLOW)
        watcher.on_progress=drain
        try:
            watcher.tree(root,'leaves');drain()
            self.assertEqual(overflow,[])
            self.assertEqual(len(watcher.paths),count+1)
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
