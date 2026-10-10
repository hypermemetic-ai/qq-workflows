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
    def test_decision_policy_refreshes_protected_aliases_on_each_pass(self):
        first=self.home/'first';second=self.home/'second';first.mkdir();second.mkdir()
        for p in (first,second):self.store.register(p,self.archive/p.name,'ssd',hot=p)
        protected=self.home/'protected';protected.symlink_to(first);self.cfg['excluded']=[str(protected)]
        decisions={r['source']:r['decision'] for r in m.decisions(self.store,self.cfg)}
        self.assertEqual(decisions[str(first)],'protected');self.assertEqual(decisions[str(second)],'ssd')
        protected.unlink();protected.symlink_to(second)
        decisions={r['source']:r['decision'] for r in m.decisions(self.store,self.cfg)}
        self.assertEqual(decisions[str(first)],'ssd');self.assertEqual(decisions[str(second)],'protected')

    def test_routed_parent_tracking_follows_proven_bridge_without_retiring_old_inode(self):
        source=self.home/'cache';source.mkdir();(source/'item').write_bytes(b'keep')
        parent=m.bridge_parent(self.store,self.cfg,source);previous=Path(parent['hdd']);identity=previous.stat().st_ino
        root=self.store.register(source,previous,'hdd');self.cfg['mirror_layout']=True
        with patch.object(m,'references',return_value=[]):m.route_defaults(self.store,self.cfg)
        row=self.store.root(str(source));self.assertEqual(row['id'],root)
        self.assertEqual(Path(row['target']),source.resolve())
        self.assertEqual(previous.stat().st_ino,identity);self.assertEqual((previous/'item').read_bytes(),b'keep')
        self.assertIn(str(previous),self.store.get('defaults')[0]['previous'])

    def test_unrelated_hdd_root_target_is_not_adopted_as_previous_bridge(self):
        source=self.home/'cache';source.mkdir();(source/'item').write_bytes(b'keep')
        parent=m.bridge_parent(self.store,self.cfg,source);other=self.archive/'unrelated';other.mkdir()
        self.store.register(source,other,'hdd');self.cfg['mirror_layout']=True
        with patch.object(m,'references',return_value=[]):m.route_defaults(self.store,self.cfg)
        self.assertEqual(Path(self.store.root(str(source))['target']),other)

    def test_stale_backing_queue_cannot_partition_machinery_or_break_public_children(self):
        source=self.home/'projects';source.mkdir();(source/'child').mkdir();(source/'child'/'data').write_bytes(b'keep')
        self.cfg.update(mirror_layout=True,automatic_partition=True)
        with patch.object(m,'references',return_value=[]):
            parent=m.bridge_parent(self.store,self.cfg,source);m.adopt_defaults(self.store,self.cfg);m.route_defaults(self.store,self.cfg)
        backing=Path(parent['backing']);identity=backing.stat().st_ino;m.queue_add(self.store,backing)
        def refs(paths,**kwargs):return [42] if any(Path(p)==backing for p in paths) else []
        with patch.object(m,'references',side_effect=refs):m.drain(self.store,self.cfg)
        self.assertEqual(len(self.store.get('defaults')),1)
        self.assertFalse(backing.is_symlink());self.assertEqual(backing.stat().st_ino,identity)
        self.assertEqual((source/'child'/'data').read_bytes(),b'keep')
        self.assertEqual(self.store.root(str(source/'child'))['location'],'hdd')
        row=self.store.db.execute('SELECT status FROM queue WHERE source=?',(str(backing),)).fetchone()
        self.assertEqual(row['status'],'protected')

    def test_nested_mirror_admission_preserves_untouched_sibling_paths(self):
        projects=self.home/'projects';projects.mkdir();group=projects/'worktrees';group.mkdir()
        for name in ('moving','sibling'):
            child=group/name;child.mkdir();(child/'data').write_bytes(name.encode())
        identity=(group/'sibling'/'data').stat().st_ino
        self.cfg['mirror_layout']=True
        with patch.object(m,'references',return_value=[]):
            parent=m.bridge_parent(self.store,self.cfg,projects);m.adopt_defaults(self.store,self.cfg)
            m.route_defaults(self.store,self.cfg)
            physical=Path(parent['backing'])/'worktrees'/'moving'
            m.migrate(self.store,self.cfg,physical)
        self.assertEqual((group/'moving'/'data').read_bytes(),b'moving')
        self.assertEqual((group/'sibling'/'data').read_bytes(),b'sibling')
        self.assertEqual((group/'sibling'/'data').stat().st_ino,identity)
        mirror=m.mirror_path(self.store,self.archive,group/'sibling')
        self.assertEqual(os.readlink(mirror),str(Path(parent['backing'])/'worktrees'/'sibling'))

    def test_admission_releases_writer_before_scanning_the_next_atomic_replacement(self):
        source=self.home/'parent';source.mkdir()
        for name in ('first','second'):(source/name).mkdir()
        with patch.object(m,'references',return_value=[]):
            parent=m.bridge_parent(self.store,self.cfg,source);m.adopt_defaults(self.store,self.cfg)
        first=Path(parent['hdd'])/'first';first.unlink();first.mkdir();(first/'new').write_bytes(b'authoritative')
        other=m.Store(self.store.state);other.db.execute('PRAGMA busy_timeout=0')
        real=Path.resolve;checked=[]
        def resolve(path,*args,**kwargs):
            if path==source/'second':
                other.put('concurrent_heartbeat',123);other.db.commit();checked.append(True)
            return real(path,*args,**kwargs)
        try:
            with patch.object(Path,'resolve',resolve):m.adopt_defaults(self.store,self.cfg)
            self.assertTrue(checked)
            self.assertEqual(self.store.root(str(source/'first'))['location'],'hdd')
            self.assertEqual((source/'first'/'new').read_bytes(),b'authoritative')
        finally:other.db.close()

    def test_conflicting_former_folder_does_not_leave_the_ledger_writer_locked(self):
        source=self.home/'parent';source.mkdir();(source/'child').mkdir()
        (source/'child'/'former').write_bytes(b'preserve')
        with patch.object(m,'references',return_value=[]):
            parent=m.bridge_parent(self.store,self.cfg,source);m.adopt_defaults(self.store,self.cfg)
        proxy=Path(parent['hdd'])/'child';proxy.unlink();proxy.mkdir();(proxy/'new').write_bytes(b'new')
        m.adopt_defaults(self.store,self.cfg)
        other=m.Store(self.store.state);other.db.execute('PRAGMA busy_timeout=0')
        try:
            other.put('concurrent_heartbeat',123);other.db.commit()
            self.assertEqual(self.store.get('defaults_conflict')['former_copy'],str(Path(parent['backing'])/'child'))
            self.assertEqual((Path(parent['backing'])/'child'/'former').read_bytes(),b'preserve')
            self.assertEqual((source/'child'/'new').read_bytes(),b'new')
        finally:other.db.close()

    def test_partition_recovery_finishes_after_child_admission_was_interrupted(self):
        source=self.home/'mixed';source.mkdir();(source/'keep').write_bytes(b'original')
        identity=(source/'keep').stat().st_ino
        key=self.store.register(source,self.archive/'later','ssd',hot=source)
        m.queue_add(self.store,source)
        with patch.object(m,'references',return_value=[]),patch.object(m,'adopt_defaults',side_effect=RuntimeError('interrupted')):
            with self.assertRaisesRegex(RuntimeError,'interrupted'):m.partition_root(self.store,self.cfg,key)
        self.assertTrue((self.store.state/'partition-operation.json').exists())
        with patch.object(m,'references',return_value=[]):m.recover_partition(self.store,self.cfg)
        self.assertFalse((self.store.state/'partition-operation.json').exists())
        self.assertEqual((source/'keep').stat().st_ino,identity)
        child=self.store.root(str(source/'keep'))
        self.assertEqual(child['location'],'ssd')
        self.assertEqual(self.store.db.execute('SELECT status FROM queue WHERE source=?',(child['source'],)).fetchone()[0],'pending')
        self.assertEqual((source/'keep').read_bytes(),b'original')

    def test_partition_recovery_retains_changed_public_path_and_journal(self):
        source=self.home/'mixed';source.mkdir();(source/'keep').write_bytes(b'original')
        key=self.store.register(source,self.archive/'later','ssd',hot=source)
        with patch.object(m,'references',return_value=[]),patch.object(m,'adopt_defaults',side_effect=RuntimeError('interrupted')):
            with self.assertRaises(RuntimeError):m.partition_root(self.store,self.cfg,key)
        parent=self.store.get('defaults')[0];source.unlink();source.mkdir();(source/'new').write_bytes(b'new')
        with self.assertRaisesRegex(ValueError,'paths differ'):m.recover_partition(self.store,self.cfg)
        self.assertTrue((self.store.state/'partition-operation.json').exists())
        self.assertEqual((Path(parent['backing'])/'keep').read_bytes(),b'original')
        self.assertEqual((source/'new').read_bytes(),b'new')

    def test_partition_recovery_keeps_marker_if_admission_fails_again(self):
        source=self.home/'mixed';source.mkdir();(source/'keep').write_bytes(b'original')
        key=self.store.register(source,self.archive/'later','ssd',hot=source)
        with patch.object(m,'references',return_value=[]),patch.object(m,'adopt_defaults',side_effect=RuntimeError('interrupted')):
            with self.assertRaises(RuntimeError):m.partition_root(self.store,self.cfg,key)
            with self.assertRaises(RuntimeError):m.recover_partition(self.store,self.cfg)
        self.assertTrue((self.store.state/'partition-operation.json').exists())
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        self.assertFalse((self.store.state/'partition-operation.json').exists())
        self.assertEqual((source/'keep').read_bytes(),b'original')

    def test_logical_routes_reuse_unchanged_metadata_without_reparsing(self):
        backing=self.home/'.projects-qq-ssd';public=self.home/'projects'
        self.store.put('defaults',[dict(source=str(public),backing=str(backing))]);self.store.db.commit()
        path=backing/'app'/'file';expected=public/'app'/'file'
        self.assertEqual(m.logical_source(self.store,path),expected)
        with patch.object(m.json,'loads',side_effect=AssertionError('reparsed unchanged routes')):
            self.assertEqual(m.logical_source(self.store,path),expected)

    def test_logical_routes_notice_concurrent_default_changes(self):
        backing=self.home/'.projects-qq-ssd';public=self.home/'projects';next_public=self.home/'next'
        self.store.put('defaults',[dict(source=str(public),backing=str(backing))]);self.store.db.commit()
        path=backing/'file';self.assertEqual(m.logical_source(self.store,path),public/'file')
        other=m.Store(self.store.state)
        try:
            other.put('defaults',[dict(source=str(next_public),backing=str(backing))]);other.db.commit()
            self.assertEqual(m.logical_source(self.store,path),next_public/'file')
        finally:other.db.close()

    def test_logical_routes_notice_concurrent_nested_namespace_alias(self):
        backing=self.home/'.projects-qq-ssd';public=self.home/'projects'
        self.store.put('defaults',[dict(source=str(public),backing=str(backing))]);self.store.db.commit()
        path=backing/'app'/'file';self.assertEqual(m.logical_source(self.store,path),public/'app'/'file')
        other=m.Store(self.store.state)
        try:
            other.put('namespace_aliases',[dict(public=str(public/'renamed'),backing=str(backing/'app'))]);other.db.commit()
            self.assertEqual(m.logical_source(self.store,path),public/'renamed'/'file')
        finally:other.db.close()

    def test_automatic_partition_drains_oversized_folder_in_bounded_children(self):
        source=self.home/'large';source.mkdir()
        for name in ('left','right'):
            child=source/name;child.mkdir()
            for n in range(3):(child/str(n)).write_bytes(name.encode())
        identity=(source/'left'/'0').stat().st_ino
        self.cfg.update(automatic_partition=True,max_scan_entries=8)
        m.queue_add(self.store,source)
        with patch.object(m,'references',return_value=[]):
            m.drain(self.store,self.cfg)
            self.assertTrue(source.is_symlink())
            self.assertEqual((source/'left'/'0').stat().st_ino,identity)
            self.assertEqual(len(self.store.roots()),2)
            m.drain(self.store,self.cfg)
        self.assertEqual({r['location'] for r in self.store.roots()},{'hdd'})
        self.assertEqual((source/'left'/'0').read_bytes(),b'left')
        self.assertEqual((source/'right'/'2').read_bytes(),b'right')
        self.assertFalse(list(self.store.state.glob('*operation.json')))

    def test_automatic_partition_preserves_busy_database_and_moves_idle_sibling(self):
        source=self.home/'mixed';source.mkdir()
        busy=source/'busy';busy.mkdir();(busy/'state.db').write_bytes(b'db');(busy/'state.db-wal').write_bytes(b'wal')
        (source/'idle').write_bytes(b'idle');identity=(busy/'state.db').stat().st_ino
        self.store.register(source,self.archive/'later','ssd');m.queue_add(self.store,source)
        self.cfg['automatic_partition']=True
        def refs(paths,strict=False):
            return [42] if any(Path(p)==source or Path(p).name=='busy' for p in paths) else []
        with patch.object(m,'references',side_effect=refs):
            m.drain(self.store,self.cfg);m.drain(self.store,self.cfg)
        self.assertEqual((busy/'state.db').stat().st_ino,identity)
        self.assertEqual((busy/'state.db-wal').read_bytes(),b'wal')
        self.assertEqual(self.store.root(str(source/'idle'))['location'],'hdd')
        self.assertEqual(self.store.root(str(source/'busy'))['location'],'ssd')
        self.assertFalse(list(self.store.state.glob('*operation.json')))

    def test_automatic_partition_keeps_git_administration_together(self):
        source=self.home/'.git';source.mkdir()
        for n in range(3):(source/str(n)).write_bytes(b'git')
        self.cfg.update(automatic_partition=True,max_scan_entries=2);m.queue_add(self.store,source)
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        self.assertFalse(source.is_symlink());self.assertEqual((source/'0').read_bytes(),b'git')
        self.assertEqual(self.store.db.execute('SELECT status FROM queue').fetchone()[0],'deferred')
        self.assertFalse(list(self.store.state.glob('*operation.json')))

    def test_automatic_partition_never_changes_a_folder_with_a_recovery_journal(self):
        source=self.home/'pending';source.mkdir();(source/'data').write_bytes(b'keep')
        self.cfg['automatic_partition']=True;m.queue_add(self.store,source)
        def interrupted(*args,**kwargs):
            m.atomic_json(self.store.state/'operation.json',{'phase':'published','source':str(source)})
            raise ValueError('source mutation during migration')
        with patch.object(m,'migrate',side_effect=interrupted):
            with self.assertRaisesRegex(ValueError,'recovery journal'):m.drain(self.store,self.cfg)
        self.assertFalse(source.is_symlink());self.assertEqual((source/'data').read_bytes(),b'keep')
        self.assertEqual(m.bounded_json(self.store.state/'operation.json')['phase'],'published')
        self.assertFalse((self.store.state/'partition-operation.json').exists())

    def test_repeated_admission_skips_expensive_policy_checks_for_queued_roots(self):
        source=self.home/'cache';source.mkdir();(source/'data').write_bytes(b'keep')
        m.bridge_parent(self.store,self.cfg,source);m.adopt_defaults(self.store,self.cfg)
        before=[dict(r) for r in self.store.db.execute('SELECT * FROM queue')]
        with patch.object(m,'excluded_unit',side_effect=AssertionError('rechecking queued root')):
            m.adopt_defaults(self.store,self.cfg)
        self.assertEqual([dict(r) for r in self.store.db.execute('SELECT * FROM queue')],before)
        # Skipping repeat admission never bypasses the actual mover's policy.
        row=self.store.roots()[0];self.cfg['excluded'].append(str(m.live_path(row)))
        with self.assertRaisesRegex(ValueError,'protected'):m.migrate(self.store,self.cfg,source/'data',demoting=row)
        self.assertEqual((source/'data').read_bytes(),b'keep')

    def test_intake_still_validates_new_children_while_skipping_queued_children(self):
        parent=self.home/'incoming';parent.mkdir()
        known=parent/'known';fresh=parent/'fresh';protected=parent/'protected'
        for p in (known,fresh,protected):p.write_bytes(b'keep')
        m.queue_add(self.store,known)
        self.cfg.update(intake_parents=[str(parent)],intake_min_age_seconds=0)
        self.cfg['excluded'].append(str(protected));checked=[];validate=m.valid_source
        def checked_source(path,cfg):checked.append(path);return validate(path,cfg)
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            archive=Path(d)
            if archive.stat().st_dev==parent.stat().st_dev:self.skipTest('separate destination filesystem unavailable')
            self.cfg['archive']=str(archive)
            with patch.object(m,'mount_ready',return_value=archive),\
                 patch.object(m,'valid_source',side_effect=checked_source):m.adopt_defaults(self.store,self.cfg)
        self.assertNotIn(known,checked);self.assertIn(fresh,checked);self.assertIn(protected,checked)
        self.assertEqual({r[0] for r in self.store.db.execute('SELECT source FROM queue')},{str(known),str(fresh)})
        self.assertEqual(protected.read_bytes(),b'keep')

    def test_competing_default_admission_reuses_live_root_identity(self):
        source=self.home/'cache';source.mkdir();(source/'old').write_bytes(b'old')
        m.bridge_parent(self.store,self.cfg,source)
        (source/'new').write_bytes(b'new')
        competing=m.Store(self.store.state);register=self.store.register;ids=[]
        def raced(public,target,location='hdd',hot=''):
            ids.append(competing.register(public,target,location,hot))
            return register(public,target,location,hot)
        try:
            with patch.object(self.store,'register',side_effect=raced):m.adopt_defaults(self.store,self.cfg)
            self.assertEqual({r['id'] for r in self.store.roots()},set(ids))
            self.assertEqual(len(ids),2)
            self.assertEqual((source/'old').read_bytes(),b'old')
            self.assertEqual((source/'new').read_bytes(),b'new')
        finally: competing.db.close()

    def test_competing_registration_preserves_conflicting_live_mapping(self):
        source=self.home/'data';target=self.archive/'one';other=self.archive/'two'
        target.write_bytes(b'one');other.write_bytes(b'two')
        key=self.store.register(source,target)
        with self.assertRaisesRegex(ValueError,'existing mapping preserved'):
            self.store.register(source,other)
        self.assertEqual(self.store.root(key)['target'],str(target))
        self.assertEqual(target.read_bytes(),b'one');self.assertEqual(other.read_bytes(),b'two')

    def test_summary_is_bounded_for_large_queues_and_does_not_scan_payloads(self):
        self.store.db.executemany('INSERT INTO queue VALUES (?,?,?,?,?)',
            [(str(self.home/('unit-'+str(n))),'move','pending','',1) for n in range(2000)])
        self.store.put('heartbeat',time.time()); self.store.db.commit()
        record = {'source':str(self.home/'bulk'),'phase':'verifying',
                  'verification_entries':100,'verified_entries':70,
                  'verification_read_bytes':1024,'unrelated_payload':'x'*100000}
        m.atomic_json(self.store.state/'operation.json',record)
        with patch.object(m,'inventory',side_effect=AssertionError('payload scan')),\
             patch.object(m,'decisions',side_effect=AssertionError('root evaluation')):
            report=m.status_summary(self.store,self.cfg)
        self.assertEqual(report['queue'],[dict(action='move',status='pending',count=2000)])
        self.assertEqual(report['operation']['verified_entries'],70)
        self.assertLess(len(m.json.dumps(report)),2048)
        self.assertEqual(m.bounded_json(self.store.state/'operation.json'),record)

    def test_summary_reports_unreadable_operation_without_claiming_idle(self):
        journal=self.store.state/'operation.json';journal.write_text('{incomplete')
        report=m.status_summary(self.store,self.cfg)
        self.assertIn('operation_error',report)
        self.assertEqual(journal.read_text(),'{incomplete')

    def test_bounded_container_command_rejects_excess_output(self):
        with self.assertRaisesRegex(ValueError,'output exceeds bound'):
            m.bounded_command([sys.executable,'-c','print("x"*1024)'],limit=64)

    def test_container_sources_ignore_volumes_and_full_root_monitor_views(self):
        mounts=[{'Type':'bind','Source':'/'},{'Type':'bind','Source':str(self.home/'app')},
                {'Type':'volume','Source':'/var/lib/docker/volumes/keep'}]
        with patch.object(m,'bounded_command',side_effect=['a'*64+'\n',m.json.dumps(mounts)+'\n']):
            self.assertEqual(m.docker_mount_sources(),[self.home/'app'])

    def test_container_parent_mount_protects_children_without_open_file_references(self):
        parent=self.home/'bound';parent.mkdir();source=parent/'idle';source.mkdir();(source/'data').write_bytes(b'keep')
        self.cfg['protect_docker_binds']=True
        with patch.object(m,'docker_mount_sources',return_value=[parent]),patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'container bind'):m.migrate(self.store,self.cfg,source)
            with self.assertRaisesRegex(ValueError,'container bind'):m.bridge_parent(self.store,self.cfg,parent)
        self.assertFalse(source.is_symlink());self.assertEqual((source/'data').read_bytes(),b'keep')
        self.assertFalse((self.store.state/'operation.json').exists())

    def test_container_mount_appearing_during_copy_retains_original(self):
        source=self.home/'data';source.write_bytes(b'keep');self.cfg['protect_docker_binds']=True
        with patch.object(m,'docker_mount_sources',side_effect=[[],[source]]),patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'container bind'):m.migrate(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink());self.assertEqual(source.read_bytes(),b'keep')
        self.assertFalse((self.store.state/'operation.json').exists())

    def test_container_metadata_failure_prevents_migration(self):
        source=self.home/'data';source.write_bytes(b'keep');self.cfg['protect_docker_binds']=True
        with patch.object(m,'docker_mount_sources',side_effect=ValueError('coverage incomplete')):
            with self.assertRaisesRegex(ValueError,'coverage incomplete'):m.migrate(self.store,self.cfg,source)
        self.assertEqual(source.read_bytes(),b'keep');self.assertFalse((self.store.state/'operation.json').exists())

    def test_scheduled_drain_retries_busy_lock_without_changing_queue_or_source(self):
        source=self.home/'queued';source.mkdir();(source/'data').write_bytes(b'keep')
        m.queue_add(self.store,source)
        with m.lock(self.store.state/'move.lock'),patch.object(m,'migrate') as move,patch.object(m,'verify_artifacts') as verify:
            m.drain(self.store,self.cfg)
        move.assert_not_called();verify.assert_not_called()
        self.assertEqual(self.store.db.execute('SELECT status FROM queue WHERE source=?',(str(source),)).fetchone()[0],'pending')
        self.assertFalse(source.is_symlink());self.assertEqual((source/'data').read_bytes(),b'keep')

    def test_drain_does_not_hide_an_unfinished_operation_as_a_busy_lock(self):
        m.atomic_json(self.store.state/'operation.json',{'phase':'published'})
        with self.assertRaisesRegex(ValueError,'unfinished operation'):m.drain(self.store,self.cfg)

    def test_scheduled_drain_recovers_published_retirement_and_moves_next_unit(self):
        source=self.home/'published';source.mkdir();(source/'data').write_bytes(b'keep')
        next_source=self.home/'next';next_source.write_bytes(b'next')
        with patch.object(m,'references',return_value=[]),patch.object(m,'remove_retired',side_effect=PermissionError('interrupted')):
            with self.assertRaises(PermissionError):m.migrate(self.store,self.cfg,source)
        m.queue_add(self.store,source);m.queue_add(self.store,next_source)
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        self.assertEqual((source/'data').read_bytes(),b'keep');self.assertEqual(next_source.read_bytes(),b'next')
        self.assertFalse((self.store.state/'operation.json').exists())
        self.assertEqual({r[0] for r in self.store.db.execute('SELECT status FROM queue')},{'complete'})
        self.assertEqual(self.store.get('last_drain')['status'],'complete')

    def test_scheduled_recovery_retains_divergent_original_and_reports_blockage(self):
        source=self.home/'published';source.mkdir();(source/'data').write_bytes(b'keep')
        with patch.object(m,'references',return_value=[]),patch.object(m,'remove_retired',side_effect=PermissionError('interrupted')):
            with self.assertRaises(PermissionError):m.migrate(self.store,self.cfg,source)
        retired=Path(m.bounded_json(self.store.state/'operation.json')['staged'])
        (retired/'data').write_bytes(b'late work')
        with patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'diverged'):m.drain(self.store,self.cfg)
        self.assertEqual((retired/'data').read_bytes(),b'late work');self.assertEqual((source/'data').read_bytes(),b'keep')
        self.assertTrue((self.store.state/'operation.json').exists())
        self.assertIn('diverged',self.store.get('last_drain')['error'])

    def test_scheduled_drain_retries_unit_left_running_before_journaling(self):
        source=self.home/'interrupted';source.write_bytes(b'keep');m.queue_add(self.store,source)
        self.store.db.execute("UPDATE queue SET status='running'");self.store.db.commit()
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        self.assertTrue(source.is_symlink());self.assertEqual(source.read_bytes(),b'keep')
        self.assertEqual(self.store.db.execute('SELECT status FROM queue').fetchone()[0],'complete')

    def test_scheduled_drain_reconciles_requeued_hdd_unit_without_another_copy(self):
        source=self.home/'published';source.write_bytes(b'keep')
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,source)
        target=source.resolve();m.queue_add(self.store,source)
        with patch.object(m,'migrate',side_effect=AssertionError('duplicate copy')):
            m.drain(self.store,self.cfg)
        self.assertEqual(self.store.db.execute('SELECT status FROM queue').fetchone()[0],'complete')
        self.assertEqual(source.resolve(),target);self.assertEqual(source.read_bytes(),b'keep')

    def test_scheduled_drain_preserves_requeued_hdd_unit_with_changed_mapping(self):
        source=self.home/'published';source.write_bytes(b'keep')
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,source)
        target=source.resolve();other=self.home/'changed';other.write_bytes(b'new')
        source.unlink();source.symlink_to(other);m.queue_add(self.store,source)
        with patch.object(m,'migrate',side_effect=AssertionError('changed mapping copied')):
            m.drain(self.store,self.cfg)
        queued=self.store.db.execute('SELECT * FROM queue').fetchone()
        self.assertEqual(queued['status'],'deferred');self.assertIn('differs from ledger',queued['error'])
        self.assertEqual(source.read_bytes(),b'new');self.assertEqual(target.read_bytes(),b'keep')

    def test_queue_priority_moves_large_selected_units_before_older_small_units(self):
        small=self.home/'small';small.write_bytes(b'small')
        bulk=self.home/'bulk';bulk.write_bytes(b'bulk')
        m.queue_add(self.store,small);m.queue_add(self.store,bulk,priority=100)
        # Automatic admission preserves an explicitly recorded priority.
        m.queue_add(self.store,bulk)
        order=[];real=m.migrate
        def moved(store,cfg,source,**kwargs):order.append(source);return real(store,cfg,source,**kwargs)
        with patch.object(m,'references',return_value=[]),patch.object(m,'migrate',side_effect=moved):m.drain(self.store,self.cfg)
        self.assertEqual(order,[bulk,small]);self.assertEqual(small.read_bytes(),b'small');self.assertEqual(bulk.read_bytes(),b'bulk')

    def test_failed_read_only_copy_cleanup_keeps_original_and_initial_error(self):
        source=self.home/'readonly';folder=source/'generated';folder.mkdir(parents=True)
        data=folder/'package-lock.json';data.write_bytes(b'original');folder.chmod(0o555)
        real=m.ReadBudget.digest
        def mismatch(budget,path):return 'mismatch' if self.archive in path.parents else real(budget,path)
        try:
            with patch.object(m,'references',return_value=[]),patch.object(m.ReadBudget,'digest',mismatch):
                with self.assertRaisesRegex(ValueError,'checksum mismatch'):m.migrate(self.store,self.cfg,source)
            self.assertEqual(data.read_bytes(),b'original');self.assertEqual(folder.stat().st_mode&0o777,0o555)
            self.assertFalse((self.store.state/'operation.json').exists());self.assertFalse(list((self.archive/'data').glob('*/*')))
        finally:folder.chmod(0o755)

    def test_unpublished_cleanup_failure_retains_journal_then_recovers_without_source_changes(self):
        source=self.home/'artifact';source.write_bytes(b'original')
        with patch.object(m,'references',return_value=[]),patch.object(m.ReadBudget,'digest',side_effect=ValueError('initial failure')),\
             patch.object(m,'remove_retired',side_effect=PermissionError('cleanup denied')):
            with self.assertRaisesRegex(ValueError,'initial failure.*journal retained'):m.migrate(self.store,self.cfg,source)
        record=m.bounded_json(self.store.state/'operation.json')
        self.assertEqual(record['error'],'initial failure');self.assertEqual(record['phase'],'aborted-cleanup-needed')
        with patch.object(m,'references',return_value=[]):m.abort_unpublished(self.store,self.cfg)
        self.assertEqual(source.read_bytes(),b'original');self.assertFalse(Path(record['destination']).exists())
        self.assertFalse((self.store.state/'operation.json').exists())

    def test_unpublished_abort_refuses_changed_public_source(self):
        source=self.home/'artifact';source.write_bytes(b'original')
        destination=self.archive/'data'/('a'*32)/source.name;destination.parent.mkdir(parents=True);destination.write_bytes(b'copy')
        record={'source':str(source),'original':str(source),'destination':str(destination),'phase':'copying','restore':False}
        m.atomic_json(self.store.state/'operation.json',record);source.unlink();source.symlink_to(destination)
        with self.assertRaisesRegex(ValueError,'authoritative source changed'):m.abort_unpublished(self.store,self.cfg)
        self.assertEqual(destination.read_bytes(),b'copy');self.assertTrue((self.store.state/'operation.json').exists())

    def test_checksum_budget_counts_read_time_and_still_limits_fast_cached_reads(self):
        clock=[0.0]
        with patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),patch.object(m.time,'sleep') as sleep:
            budget=m.ReadBudget(1024**2);clock[0]=2.0
            budget.account(1024**2);sleep.assert_not_called()
            budget.account(1024**2);sleep.assert_called_once_with(1.0)
            self.assertEqual(budget.bytes,2*1024**2)

    def test_internal_hard_links_share_verified_content_without_repeated_reads(self):
        source=self.home/'linked';source.mkdir();p=source/'one';p.write_bytes(b'artifact'*1024)
        os.link(p,source/'two');os.link(p,source/'three');read_bytes=[]
        account=m.ReadBudget.account
        def measured(budget,count):read_bytes.append(count);account(budget,count)
        with patch.object(m,'references',return_value=[]),patch.object(m.ReadBudget,'account',measured):m.migrate(self.store,self.cfg,source)
        target=Path(self.store.root(str(source))['target'])
        self.assertEqual((target/'three').read_bytes(),b'artifact'*1024)
        self.assertTrue(os.path.samefile(target/'one',target/'two'))
        self.assertEqual(sum(read_bytes),2*len(b'artifact'*1024))

    def test_write_through_shared_alias_during_verification_preserves_original(self):
        source=self.home/'linked';source.mkdir();p=source/'one';p.write_bytes(b'artifact')
        alias=source/'two';os.link(p,alias);real=m.ReadBudget.digest;changed=False
        def modifying(budget,path):
            nonlocal changed
            digest=real(budget,path)
            if self.archive in path.parents and not changed:alias.write_bytes(b'new data');changed=True
            return digest
        with patch.object(m,'references',return_value=[]),patch.object(m.ReadBudget,'digest',modifying):
            with self.assertRaisesRegex(ValueError,'source changed'):m.migrate(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink());self.assertEqual(p.read_bytes(),b'new data')
        self.assertFalse((self.store.state/'operation.json').exists())

    def test_verified_artifact_manifest_retains_new_and_changed_files(self):
        key,_,target,now=self.root();module=m.artifact_module()
        cold=target/'build/cold.bin';hot=target/'build/hot.bin'
        proof=self.store.state/'proof.json'
        records={p.name:{'identity':module.identity(p.stat()),'verified_at':now-31*m.DAY} for p in (cold,hot)}
        m.atomic_json(proof,{'schema':'verified-files-v1','scope':'build','files':records})
        m.record_scope(self.store,key,'build','verified-files-v1: test recipe',proof)
        hot.write_bytes(b'user changes');new=target/'build/unique.bin';new.write_bytes(b'unique')
        os.utime(hot,(now-31*m.DAY,now-31*m.DAY));os.utime(new,(now-31*m.DAY,now-31*m.DAY))
        with patch.object(m,'references',return_value=[]):result=m.gc(self.store,self.cfg,apply=True,now=now,barrier=lambda:None)
        self.assertEqual(result['deleted_files'],1);self.assertFalse(cold.exists())
        self.assertEqual(hot.read_bytes(),b'user changes');self.assertEqual(new.read_bytes(),b'unique')

    def test_new_artifact_proof_requires_thirty_days_after_verification(self):
        key,_,target,now=self.root();module=m.artifact_module();p=target/'build/cold.bin'
        proof=self.store.state/'proof.json'
        m.atomic_json(proof,{'schema':'verified-files-v1','scope':'build','files':{
            p.name:{'identity':module.identity(p.stat()),'verified_at':now}}})
        m.record_scope(self.store,key,'build','verified-files-v1: test recipe',proof)
        self.assertEqual(m.gc(self.store,self.cfg,now=now)['eligible_files'],0)

    def test_published_cargo_archives_verified_individually_private_data_retained(self):
        module=m.artifact_module();target=self.archive/'registry';cache=target/'cache/index.crates.io-1949cf8c6b5b557f'
        cache.mkdir(parents=True);p=cache/'example-1.2.3.crate';p.write_bytes(b'published')
        changed=cache/'example-1.2.4.crate';changed.write_bytes(b'user modified')
        private=cache/'private.txt';private.write_bytes(b'unique')
        source=self.home/'registry';source.symlink_to(target);key=self.store.register(source,target)
        with patch.object(module,'checksums',return_value={'1.2.3':m.hashlib.sha256(b'published').hexdigest(),
                                                         '1.2.4':m.hashlib.sha256(b'original').hexdigest()}):
            result=module.verify(self.store,self.cfg,m)
        self.assertEqual((result['verified'],result['retained']),(1,1))
        row=self.store.db.execute('SELECT * FROM scopes WHERE root=?',(key,)).fetchone()
        manifest=m.verified_files(row);self.assertEqual(set(manifest),{p.name})
        old=manifest[p.name]['verified_at']
        with patch.object(module,'checksums',side_effect=OSError('offline')):module.verify(self.store,self.cfg,m)
        self.assertEqual(m.verified_files(self.store.db.execute('SELECT * FROM scopes WHERE root=?',(key,)).fetchone())[p.name]['verified_at'],old)
        self.assertEqual(private.read_bytes(),b'unique')

    def test_missing_reference_coverage_fails_closed_for_entire_batch(self):
        _,_,target,now=self.root()
        with patch.object(m,'broker_references',side_effect=ValueError('coverage incomplete')):
            result=m.gc(self.store,self.cfg,apply=True,now=now,barrier=lambda:None)
        self.assertEqual(result['deleted_files'],0);self.assertIn('coverage incomplete',result['errors'])
        self.assertTrue((target/'build/cold.bin').exists())

    def test_broker_blocked_and_queued_reads_preserve_files(self):
        key,_,target,now=self.root()
        def barrier():self.store.activity(key,'build/cold.bin',m.ACCESS,now)
        with patch.object(m,'broker_references',return_value={1}),patch.object(m,'references',side_effect=AssertionError('unprivileged lookup')):
            result=m.gc(self.store,self.cfg,apply=True,now=now,barrier=barrier)
        self.assertEqual(result['deleted_files'],0)
        self.assertTrue((target/'build/cold.bin').exists());self.assertTrue((target/'build/hot.bin').exists())

    def test_migration_cpu_budget_refuses_unbounded_values_before_placement(self):
        for quota in (0,101,-1,'80',True):
            with self.subTest(quota=quota),self.assertRaisesRegex(ValueError,'1 to 100'):
                m.contain_job(dict(m.DEFAULT,migration_cpu_quota_percent=quota))
        for high in (0,255,2049,'1024',True):
            with self.subTest(high=high),self.assertRaisesRegex(ValueError,'256 to 2048'):
                m.contain_job(dict(m.DEFAULT,migration_memory_high_mib=high))

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
    def test_late_ssd_child_is_automatically_queued_and_completed_on_hdd(self):
        source=self.home/'cache';source.mkdir();fd=os.open(source,os.O_DIRECTORY)
        try:
            m.bridge_parent(self.store,self.cfg,source)
            child=os.open('late',os.O_WRONLY|os.O_CREAT,0o600,dir_fd=fd)
            os.write(child,b'late data');os.close(child)
            m.adopt_defaults(self.store,self.cfg)
            queued=self.store.db.execute('SELECT * FROM queue WHERE source=?',(str(source/'late'),)).fetchone()
            self.assertEqual(queued['status'],'pending')
            with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
            row=self.store.root(str(source/'late'))
            self.assertEqual(row['location'],'hdd');self.assertEqual((source/'late').read_bytes(),b'late data')
        finally:os.close(fd)
    def test_disabled_automatic_migration_keeps_legacy_child_unqueued(self):
        self.cfg['automatic_migration']=False
        source=self.home/'cache';source.mkdir();(source/'old').write_text('keep')
        with patch.object(m,'references',return_value=[]):m.bridge_parent(self.store,self.cfg,source)
        m.adopt_defaults(self.store,self.cfg)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM queue').fetchone()[0],0)
    def test_queued_parent_cutover_routes_new_children_and_migrates_old_child(self):
        source=self.home/'cache';source.mkdir();(source/'old').write_text('old data')
        m.queue_add(self.store,source,'default')
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        (source/'new').write_text('new data')
        parent=self.store.get('defaults')[0]
        self.assertEqual((Path(parent['hdd'])/'new').read_text(),'new data')
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        self.assertEqual(self.store.root(str(source/'old'))['location'],'hdd')
        self.assertEqual((source/'old').read_text(),'old data')
    def test_explicitly_promoted_child_is_not_automatically_returned_to_hdd(self):
        source=self.home/'cache';source.mkdir();(source/'old').write_text('old data')
        with patch.object(m,'references',return_value=[]):m.bridge_parent(self.store,self.cfg,source)
        m.adopt_defaults(self.store,self.cfg);key=self.store.root(str(source/'old'))['id']
        hot=self.home/'promoted';hot.write_text('hot data')
        proxy=Path(self.store.get('defaults')[0]['hdd'])/'old';proxy.unlink();proxy.symlink_to(hot)
        self.store.db.execute('UPDATE roots SET hot=? WHERE id=?',(str(hot),key))
        self.store.db.execute('DELETE FROM queue');self.store.db.commit()
        m.adopt_defaults(self.store,self.cfg)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM queue').fetchone()[0],0)
    def test_queued_partition_moves_idle_child_and_preserves_busy_database_group(self):
        source=self.home/'mixed';source.mkdir()
        for name in ('idle','busy'):
            p=source/name;p.mkdir();(p/'database').write_text(name);(p/'database-wal').write_text(name+' wal')
        key=self.store.register(source,self.archive/'unused','ssd',hot=source)
        m.queue_add(self.store,source,'partition')
        def refs(paths,**kwargs):return [123] if any('/busy' in str(p) for p in paths) else []
        with patch.object(m,'references',side_effect=refs):
            m.drain(self.store,self.cfg);m.drain(self.store,self.cfg)
        parent=self.store.get('defaults')[0]
        self.assertEqual(self.store.root(str(source/'idle'))['location'],'hdd')
        self.assertEqual(self.store.root(str(source/'busy'))['location'],'ssd')
        self.assertEqual((Path(parent['backing'])/'busy/database-wal').read_text(),'busy wal')
    def test_nested_parent_cutovers_run_in_order_and_keep_public_aliases_usable(self):
        parent=self.home/'app';parent.mkdir();nested=parent/'state';nested.mkdir();deep=nested/'history';deep.mkdir()
        (deep/'data').write_text('preserve')
        for p in (deep,nested,parent):m.queue_add(self.store,p,'default')
        with patch.object(m,'references',return_value=[]):m.drain(self.store,self.cfg)
        self.assertEqual((deep/'data').read_text(),'preserve')
        (deep/'new').write_text('new')
        row=self.store.root(str(deep))
        self.assertEqual(row['location'],'hdd');self.assertEqual((Path(row['target'])/'new').read_text(),'new')
    def test_busy_root_file_partition_defers_without_a_false_recovery_journal(self):
        source=self.home/'app';source.mkdir();(source/'open.log').write_text('live')
        key=self.store.register(source,self.archive/'unused','ssd',hot=source)
        with patch.object(m,'references',return_value=[123]):
            with self.assertRaisesRegex(ValueError,'active files'):m.partition_root(self.store,self.cfg,key)
        self.assertFalse((self.store.state/'partition-operation.json').exists());self.assertFalse(source.is_symlink())
    def test_database_at_root_remains_a_directory_unit_and_keeps_sidecars_together(self):
        source=self.home/'app';source.mkdir();(source/'data.sqlite').write_bytes(b'SQLite format 3\0')
        (source/'data.sqlite-wal').write_text('uncheckpointed transactions')
        key=self.store.register(source,self.archive/'unused','ssd',hot=source)
        with patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'database and sidecars'):m.partition_root(self.store,self.cfg,key)
            with self.assertRaisesRegex(ValueError,'database and sidecars'):m.migrate(self.store,self.cfg,source/'data.sqlite')
            m.migrate(self.store,self.cfg,source,demoting=self.store.root(key))
        self.assertEqual((source/'data.sqlite-wal').read_text(),'uncheckpointed transactions')
        self.assertFalse((self.store.state/'partition-operation.json').exists())
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

    def large_shared_artifact(self,name='sdk'):
        source=self.home/name;source.mkdir();outside=self.home/'outside';outside.mkdir()
        for n in range(2000):
            name='library-'+str(n);(source/name).write_bytes(b'immutable')
            os.link(source/name,outside/name)
        self.cfg['immutable_hardlink_scopes']=[str(source)]
        return source,outside

    def test_large_link_receipt_keeps_recovery_journal_bounded_and_recovers_retirement(self):
        source,outside=self.large_shared_artifact()
        with patch.object(m,'references',return_value=[]),patch.object(m,'remove_retired',side_effect=PermissionError('interrupted')):
            with self.assertRaises(PermissionError):m.migrate(self.store,self.cfg,source)
        journal=self.store.state/'operation.json';record=m.bounded_json(journal)
        self.assertLess(journal.stat().st_size,262144)
        self.assertEqual(record['detached_immutable_link_count'],2000)
        self.assertEqual(record['detached_immutable_links'],[])
        receipt=Path(record['detached_immutable_links_receipt'])
        self.assertEqual(len(m.bounded_json(receipt,limit=1024**2)['links']),2000)
        self.assertEqual(m.status_summary(self.store,self.cfg)['operation']['detached_immutable_link_count'],2000)
        with patch.object(m,'references',return_value=[]):m.recover_published(self.store,self.cfg)
        self.assertFalse(journal.exists());self.assertTrue(receipt.exists())
        self.assertEqual((source/'library-0').read_bytes(),b'immutable')
        self.assertEqual((outside/'library-0').read_bytes(),b'immutable')
        self.assertNotEqual((source/'library-0').stat().st_ino,(outside/'library-0').stat().st_ino)

    def test_failed_large_shared_copy_removes_its_audit_receipt_and_keeps_original(self):
        source,outside=self.large_shared_artifact('immutable-links.json')
        with patch.object(m,'references',return_value=[]),patch.object(m.ReadBudget,'digest',side_effect=ValueError('verification failed')):
            with self.assertRaisesRegex(ValueError,'verification failed'):m.migrate(self.store,self.cfg,source)
        self.assertFalse(source.is_symlink());self.assertEqual((source/'library-0').read_bytes(),b'immutable')
        self.assertEqual((source/'library-0').stat().st_ino,(outside/'library-0').stat().st_ino)
        self.assertFalse((self.store.state/'operation.json').exists())
        self.assertFalse(list((self.archive/'data').glob('*/immutable-links*.json')))

    def test_unpublished_abort_rejects_a_receipt_path_outside_its_transaction(self):
        source=self.home/'artifact';source.write_bytes(b'original');other=self.home/'keep';other.write_bytes(b'unique')
        destination=self.archive/'data'/('a'*32)/source.name;destination.parent.mkdir(parents=True);destination.write_bytes(b'copy')
        record=dict(source=str(source),original=str(source),destination=str(destination),phase='copying',restore=False,
                    detached_immutable_links_receipt=str(other))
        m.atomic_json(self.store.state/'operation.json',record)
        with patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'unrecognized immutable link receipt'):m.abort_unpublished(self.store,self.cfg)
        self.assertEqual(other.read_bytes(),b'unique');self.assertEqual(destination.read_bytes(),b'copy')
        self.assertEqual(source.read_bytes(),b'original');self.assertTrue((self.store.state/'operation.json').exists())
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
    def test_original_ssd_watches_can_be_disabled_without_losing_hdd_or_promoted_coverage(self):
        self.cfg['watch_original_ssd']=False;self.cfg['max_watches']=3
        original=self.home/'legacy';original.mkdir();(original/'data').write_text('legacy')
        old=self.store.register(original,self.archive/'unused','ssd',hot=original)
        target=self.archive/'data';target.mkdir();public=self.home/'data';public.symlink_to(target)
        cold=self.store.register(public,target)
        hot=Path(self.cfg['hot_storage'])/'promoted';hot.mkdir(parents=True)
        promoted=self.home/'promoted';promoted.symlink_to(hot)
        warm=self.store.register(promoted,self.archive/'previous','ssd',hot=hot)
        with self.running_watch():
            self.await_coverage(cold);self.await_coverage(warm)
            self.assertFalse(self.store.root(old)['coverage'])
            self.assertEqual(self.store.root(old)['since'],0)
            self.assertIn('migration guard remains active',self.store.root(old)['error'])
    def test_cached_mount_watches_only_regeneration_scopes_with_small_budget(self):
        key,source,target,_=self.root()
        unrelated=target/'source';unrelated.mkdir()
        for n in range(50):(unrelated/str(n)).mkdir()
        self.cfg.update(cached_retention_watches_only=True,block_cached_mounts=[str(self.archive)],max_watches=4)
        self.store.db.execute('UPDATE roots SET coverage=0,since=0 WHERE id=?',(key,));self.store.put('heartbeat',0);self.store.db.commit()
        with self.running_watch():
            self.await_coverage(key)
            self.assertLessEqual(self.store.get('watches'),4)
            (target/'build/cold.bin').read_bytes()
            deadline=time.time()+5
            while time.time()<deadline:
                row=self.store.db.execute('SELECT reads FROM activity WHERE root=? AND path=?',(key,'build/cold.bin')).fetchone()
                if row and row[0]:break
                time.sleep(.1)
            self.assertTrue(row and row[0])
        row=self.store.root(key);signature=m.watch_signature(self.store,row,self.cfg)
        (target/'build').rename(target/'previous-build');(target/'build').mkdir()
        self.assertNotEqual(signature,m.watch_signature(self.store,row,self.cfg))
    def test_cached_unique_data_without_scope_has_no_false_retention_coverage(self):
        target=self.archive/'unique';target.mkdir();(target/'data').write_text('unique')
        source=self.home/'unique';source.symlink_to(target);key=self.store.register(source,target)
        self.cfg.update(cached_retention_watches_only=True,block_cached_mounts=[str(self.archive)])
        with self.running_watch():
            deadline=time.time()+5
            while time.time()<deadline and 'unique data retained' not in self.store.root(key)['error']:time.sleep(.1)
            row=self.store.root(key);self.assertFalse(row['coverage']);self.assertEqual(self.store.get('watches'),0)
            self.assertIn('unique data retained',row['error'])
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
    def test_read_only_archive_directories_are_retired_without_changing_file_modes(self):
        source=self.home/'archive';source.mkdir();nested=source/'frozen';nested.mkdir()
        (nested/'data').write_text('keep');(nested/'data').chmod(0o444);nested.chmod(0o555)
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,source)
        self.assertEqual((source/'frozen/data').read_text(),'keep')
        self.assertEqual((source/'frozen/data').stat().st_mode&0o777,0o444)
        self.assertEqual((source/'frozen').stat().st_mode&0o777,0o555)
        self.assertFalse((self.store.state/'operation.json').exists())
    def mirrored_project(self):
        projects=self.home/'projects';projects.mkdir();project=projects/'app';project.mkdir()
        packages=project/'packages';packages.mkdir();cli=packages/'cli';cli.mkdir()
        (project/'project.json').write_text('{"marker":"works"}')
        modules=project/'node_modules';modules.mkdir();library=modules/'fixture-lib';library.mkdir()
        (library/'index.js').write_text('module.exports=":dependency"')
        (cli/'index.cjs').write_text('module.exports=require("../../project.json").marker+require("fixture-lib")')
        with patch.object(m,'references',return_value=[]):
            m.bridge_parent(self.store,self.cfg,projects);m.adopt_defaults(self.store,self.cfg)
            m.partition_root(self.store,self.cfg,self.store.root(str(project))['id'])
        return project
    def test_mirror_preserves_real_node_imports_across_migrated_siblings(self):
        project=self.mirrored_project();self.cfg['mirror_layout']=True
        with patch.object(m,'references',return_value=[]):
            m.route_defaults(self.store,self.cfg)
            for name in ('packages','node_modules','project.json'):
                row=self.store.root(str(project/name));m.migrate(self.store,self.cfg,row['source'],demoting=row)
        if not m.shutil.which('node'):self.skipTest('Node unavailable')
        output=subprocess.check_output(['node','-e','console.log(require(process.argv[1]))',str(project/'packages/cli/index.cjs')],text=True)
        self.assertEqual(output.strip(),'works:dependency')
        row=self.store.root(str(project/'packages'))
        self.assertEqual(Path(row['target']),m.mirror_path(self.store,self.archive,project/'packages'))
        self.assertEqual((project/'packages/cli/index.cjs').resolve().parent.parent.parent,
                         m.mirror_path(self.store,self.archive,project))
    def test_existing_hdd_rehome_preserves_inodes_and_cached_node_filename(self):
        project=self.mirrored_project();row=self.store.root(str(project/'packages'))
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,row['source'],demoting=row)
        old=self.store.root(row['id']);legacy=Path(old['target'])/'cli/index.cjs';inode=legacy.stat().st_ino
        self.cfg['mirror_layout']=True
        with patch.object(m,'references',return_value=[]):
            m.route_defaults(self.store,self.cfg);m.queue_add(self.store,old['source'],'rehome');m.drain(self.store,self.cfg)
        new=self.store.root(row['id']);self.assertEqual(Path(new['target'])/'cli/index.cjs',legacy.resolve())
        self.assertEqual(legacy.stat().st_ino,inode)
        if not m.shutil.which('node'):self.skipTest('Node unavailable')
        script='const r=require("node:module").createRequire(process.argv[1]);console.log(r("../../project.json").marker+r("fixture-lib"))'
        self.assertEqual(subprocess.check_output(['node','-e',script,str(legacy)],text=True).strip(),'works:dependency')
    def test_active_hdd_rehome_preserves_original_and_public_namespace(self):
        source=self.home/'artifact';source.mkdir();(source/'data').write_text('keep')
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,source)
        row=self.store.root(str(source));target=Path(row['target']);self.cfg['mirror_layout']=True
        with patch.object(m,'references',return_value=[42]):
            with self.assertRaisesRegex(ValueError,'live process'):m.migrate(self.store,self.cfg,source,demoting=row)
        self.assertEqual(source.resolve(),target);self.assertTrue(target.is_dir());self.assertFalse(target.is_symlink())
    def test_verified_legacy_backing_uses_public_hierarchy_without_replacing_real_parent(self):
        public=self.home/'share';public.mkdir();backing=self.home/'.share-ssd';backing.mkdir()
        (backing/'app').mkdir();(backing/'app/data').write_text('keep');(public/'app').symlink_to(backing/'app')
        # A busy application can keep its real parent and inode via a backlink.
        (public/'pinned').mkdir();(backing/'pinned').symlink_to(public/'pinned')
        m.namespace_alias(self.store,self.cfg,public,backing);self.cfg['mirror_layout']=True
        self.assertEqual(m.logical_source(self.store,backing/'app'),public/'app')
        with patch.object(m,'references',return_value=[]):m.migrate(self.store,self.cfg,backing/'app')
        self.assertEqual((public/'app/data').read_text(),'keep');self.assertFalse(public.is_symlink())
        self.assertEqual((public/'app').resolve(),m.mirror_path(self.store,self.archive,public/'app'))
    def test_unrelated_legacy_backing_cannot_rewrite_public_namespace(self):
        public=self.home/'share';public.mkdir();backing=self.home/'.other';backing.mkdir()
        (backing/'data').write_text('unique');(public/'data').write_text('different')
        with self.assertRaisesRegex(ValueError,'children differ'):m.namespace_alias(self.store,self.cfg,public,backing)
        self.assertEqual(self.store.get('namespace_aliases',[]),[])
    def test_hdd_relocation_to_another_filesystem_keeps_external_hardlink_guard(self):
        target=self.archive/'shared';target.mkdir();(target/'data').write_text('shared')
        os.link(target/'data',self.archive/'external')
        source=self.home/'shared';source.symlink_to(target);key=self.store.register(source,target)
        self.cfg['mirror_layout']=True
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            if Path(d).stat().st_dev==target.stat().st_dev:self.skipTest('separate destination filesystem unavailable')
            with patch.object(m,'mount_ready',return_value=Path(d)),patch.object(m,'references',return_value=[]):
                with self.assertRaisesRegex(ValueError,'hard links extend outside'):
                    m.migrate(self.store,self.cfg,source,demoting=self.store.root(key))
        self.assertEqual(source.resolve(),target);self.assertEqual((self.archive/'external').read_text(),'shared')
    def test_real_parent_intake_queues_children_but_preserves_database_family_and_controls(self):
        parent=self.home/'real';parent.mkdir();(parent/'idle').mkdir();(parent/'idle/data').write_text('keep')
        (parent/'application.sqlite').write_text('database');(parent/'application.sqlite-wal').write_text('sidecar')
        (parent/'protected').mkdir();self.cfg['excluded'].append(str(parent/'protected'))
        (parent/'managed').mkdir()
        with patch.object(m,'references',return_value=[]):m.bridge_parent(self.store,self.cfg,parent/'managed')
        self.cfg['intake_parents']=[str(parent)];self.cfg['intake_min_age_seconds']=0
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            if Path(d).stat().st_dev==parent.stat().st_dev:self.skipTest('separate destination filesystem unavailable')
            with patch.object(m,'mount_ready',return_value=Path(d)):m.adopt_defaults(self.store,self.cfg)
        self.assertEqual([r['source'] for r in self.store.db.execute('SELECT * FROM queue')],[str(parent/'idle')])
        self.assertFalse(parent.is_symlink());self.assertEqual((parent/'application.sqlite').read_text(),'database')
    def test_real_parent_intake_defers_new_transient_directories(self):
        parent=self.home/'real';parent.mkdir();(parent/'fresh').mkdir()
        self.cfg['intake_parents']=[str(parent)]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            if Path(d).stat().st_dev==parent.stat().st_dev:self.skipTest('separate destination filesystem unavailable')
            with patch.object(m,'mount_ready',return_value=Path(d)):m.adopt_defaults(self.store,self.cfg)
        self.assertEqual(list(self.store.db.execute('SELECT * FROM queue')),[])
    def test_nested_mirror_route_recovers_interruption_immediately_after_directory_exchange(self):
        project=self.mirrored_project();self.cfg['mirror_layout']=True
        # Publish the outer default, then interrupt the nested route at the first
        # namespace exchange, before its final ledger update or alias exchange.
        real=m.exchange;calls=[]
        def interrupt(a,b):
            real(a,b);calls.append((Path(a),Path(b)))
            if str(b).endswith('/projects/app'):raise OSError('interrupted nested route')
        with patch.object(m,'exchange',side_effect=interrupt):
            with self.assertRaisesRegex(OSError,'interrupted nested'):m.route_defaults(self.store,self.cfg)
        self.assertTrue((self.store.state/'default-route-operation.json').exists())
        m.recover_default_route(self.store);m.route_defaults(self.store,self.cfg)
        self.assertEqual((project/'project.json').read_text(),'{"marker":"works"}')
        self.assertFalse((self.store.state/'default-route-operation.json').exists())
        self.assertFalse(any(p.name.endswith('.qq-tier-default-link') for p in project.parent.resolve().iterdir()))
    def test_published_recovery_finishes_partial_retirement_and_registered_alias(self):
        source=self.home/'cache';source.mkdir();(source/'archive').mkdir()
        (source/'archive/a').write_text('a');(source/'archive/b').write_text('b')
        with patch.object(m,'references',return_value=[]):m.bridge_parent(self.store,self.cfg,source)
        m.adopt_defaults(self.store,self.cfg);row=self.store.root(str(source/'archive'));physical=Path(row['hot'])
        def partial(path,limit):
            (Path(path)/'a').unlink();raise PermissionError('retirement interrupted')
        with patch.object(m,'references',return_value=[]),patch.object(m,'remove_retired',side_effect=partial):
            with self.assertRaises(PermissionError):m.migrate(self.store,self.cfg,source/'archive',demoting=row)
        with patch.object(m,'references',return_value=[]):m.recover_published(self.store,self.cfg)
        self.assertEqual((physical/'a').read_text(),'a');self.assertEqual((source/'archive/b').read_text(),'b')
        self.assertEqual(self.store.root(row['id'])['location'],'hdd')
        self.assertFalse((self.store.state/'operation.json').exists())
    def test_published_recovery_preserves_divergent_or_active_retired_data(self):
        source=self.home/'archive';source.mkdir();(source/'data').write_text('keep')
        with patch.object(m,'references',return_value=[]),patch.object(m,'remove_retired',side_effect=PermissionError('interrupted')):
            with self.assertRaises(PermissionError):m.migrate(self.store,self.cfg,source)
        record=m.bounded_json(self.store.state/'operation.json');retired=Path(record['staged'])
        with patch.object(m,'references',return_value=[42]):
            with self.assertRaisesRegex(ValueError,'remains active'):m.recover_published(self.store,self.cfg)
        (retired/'data').write_text('late work')
        with patch.object(m,'references',return_value=[]):
            with self.assertRaisesRegex(ValueError,'diverged'):m.recover_published(self.store,self.cfg)
        self.assertTrue(retired.exists());self.assertEqual((source/'data').read_text(),'keep')
        self.assertTrue((self.store.state/'operation.json').exists())
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
