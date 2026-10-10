import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('system_prepare',Path(__file__).with_name('system-prepare.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class SystemPreparation(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)
        self.unit=self.root/'pilot.service';self.unit.write_text('existing pinned unit');self.unit.chmod(0o600)
        self.folder=self.unit.with_name(self.unit.name+'.d')
        real_lstat=Path.lstat
        def root_stat(path):
            s=real_lstat(path)
            return SimpleNamespace(**{k:getattr(s,k) for k in dir(s) if k.startswith('st_') and k!='st_uid'},st_uid=0)
        patches=[patch.object(m.volume,'UNIT',self.unit),patch.object(Path,'lstat',root_stat),
                 patch.object(m.volume,'verify_managed_unit'),
                 patch.object(m.base,'private_directory',side_effect=lambda p:p.mkdir(exist_ok=True,mode=0o700))]
        for p in patches:p.start();self.addCleanup(p.stop)
    def test_ordering_changes_no_live_service_or_pinned_unit_and_is_repeatable(self):
        with patch.object(m.base,'run',return_value='systemd-user-sessions.service user@1000.service') as run:
            m.boot_order();m.boot_order()
        self.assertEqual(self.unit.read_text(),'existing pinned unit')
        self.assertEqual((self.folder/'20-before-user-data.conf').read_text(),m.ORDER)
        self.assertEqual([c.args[:2] for c in run.call_args_list],
                         [('systemctl','daemon-reload'),('systemctl','show')]*2)
        self.assertFalse(list(self.folder.glob('.order-*')))
    def test_unfamiliar_ordering_is_preserved(self):
        self.folder.mkdir();p=self.folder/'20-before-user-data.conf';p.write_text('operator content')
        with patch.object(m.base,'run') as run:
            with self.assertRaisesRegex(ValueError,'Unrecognized ordering'):m.boot_order()
        self.assertEqual(p.read_text(),'operator content');run.assert_not_called()
    def test_ordering_symlink_is_refused_without_touching_target(self):
        self.folder.mkdir();target=self.root/'target';target.write_text(m.ORDER)
        (self.folder/'20-before-user-data.conf').symlink_to(target)
        with patch.object(m.base,'run') as run:
            with self.assertRaisesRegex(ValueError,'Unrecognized ordering'):m.boot_order()
        self.assertEqual(target.read_text(),m.ORDER);run.assert_not_called()
    def test_census_reports_permission_failure_instead_of_claiming_complete(self):
        result=SimpleNamespace(returncode=1,stdout='8192\t/home\n',stderr='permission denied')
        with patch.object(m.subprocess,'run',return_value=result) as run:report=m.census()
        self.assertFalse(report['complete']);self.assertEqual(report['rows'][0]['bytes'],8192)
        self.assertEqual(run.call_args.kwargs['timeout'],600)
    def test_census_excess_output_is_rejected(self):
        result=SimpleNamespace(returncode=0,stdout='x'*262145,stderr='')
        with patch.object(m.subprocess,'run',return_value=result):
            with self.assertRaisesRegex(ValueError,'output bound'):m.census()

    def test_reference_smoke_requires_complete_scan_as_operator(self):
        report={'complete':True,'processes':700,'fds':8000,'blocked':[0]}
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(report))) as run:
            result=m.reference_smoke(self.root)
        self.assertEqual(result,{'complete':True,'processes':700,'fds':8000})
        self.assertEqual(run.call_args.args[0][0:2],['/usr/sbin/runuser','--user'])
        self.assertEqual(run.call_args.kwargs['timeout'],45)

    def test_reference_smoke_reports_incomplete_host_coverage(self):
        report={'complete':False,'error':'process 1014: relevant mount coverage unavailable'}
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(report))):
            with self.assertRaisesRegex(ValueError,'host check failed: process 1014'):
                m.reference_smoke(self.root)

    def test_reference_smoke_rejects_excess_diagnostics(self):
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='x'*262145)):
            with self.assertRaisesRegex(ValueError,'response budget'):
                m.reference_smoke(self.root)

    def test_collector_install_is_pinned_read_only_and_repeated_safely(self):
        library=self.root/'refs';socket=self.root/'refs.socket';service=self.root/'refs.service'
        with patch.object(m,'BROKER_LIBRARY',library),patch.object(m,'BROKER_SOCKET',socket),patch.object(m,'BROKER_SERVICE',service),\
             patch.object(m.base,'run',return_value='active') as run:
            m.reference_collector();m.reference_collector()
        content=service.read_text();self.assertIn('ProtectSystem=strict',content)
        self.assertIn('CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE',content)
        self.assertIn('CAP_CHECKPOINT_RESTORE',content)
        self.assertIn('PrivateTmp=no\nReadOnlyPaths=/tmp',content)
        self.assertNotIn('ExecStop',content)
        self.assertEqual([call.args[:2] for call in run.call_args_list],
                         [('systemctl','daemon-reload'),('systemctl','enable'),('systemctl','is-active')]*2)

    def test_unknown_collector_unit_is_preserved(self):
        socket=self.root/'refs.socket';socket.write_text('operator owned')
        with patch.object(m,'BROKER_LIBRARY',self.root/'refs'),patch.object(m,'BROKER_SOCKET',socket),patch.object(m.base,'run') as run:
            with self.assertRaisesRegex(ValueError,'Unrecognized'):m.reference_collector()
        self.assertEqual(socket.read_text(),'operator owned');run.assert_not_called()

    def test_collector_upgrade_requires_intact_root_pinned_previous_release(self):
        library=self.root/'refs';socket=self.root/'refs.socket';service=self.root/'refs.service'
        raw=b'previous collector';old=library/hashlib.sha256(raw).hexdigest()[:16]/'process-reference-broker.py'
        old.parent.mkdir(parents=True);old.write_bytes(raw);old.chmod(0o600)
        service.write_text(m.broker_service_text(old));service.chmod(0o600)
        with patch.object(m,'BROKER_LIBRARY',library),patch.object(m,'BROKER_SOCKET',socket),patch.object(m,'BROKER_SERVICE',service),\
             patch.object(m.base,'run',return_value='active') as run:
            report=m.reference_collector();again=m.reference_collector()
        self.assertTrue(report['upgraded']);self.assertFalse(again['upgraded'])
        self.assertTrue(report['directory_queries'])
        self.assertEqual(sum(call.args==('systemctl','try-restart','refs.service') for call in run.call_args_list),1)
        self.assertEqual(old.read_bytes(),raw)

    def test_modified_pinned_collector_cannot_be_upgraded(self):
        library=self.root/'refs';service=self.root/'refs.service';old=library/('a'*16)/'process-reference-broker.py'
        old.parent.mkdir(parents=True);old.write_bytes(b'changed');old.chmod(0o600)
        previous=m.broker_service_text(old);service.write_text(previous);service.chmod(0o600)
        with patch.object(m,'BROKER_LIBRARY',library),patch.object(m,'BROKER_SERVICE',service):
            with self.assertRaisesRegex(ValueError,'digest differs'):m.collector_unit(library/'new'/'process-reference-broker.py')
        self.assertEqual(service.read_text(),previous)

    def test_known_previous_capability_template_upgrades_once(self):
        library=self.root/'refs';socket=self.root/'refs.socket';service=self.root/'refs.service'
        raw=b'previous collector';old=library/hashlib.sha256(raw).hexdigest()[:16]/'process-reference-broker.py'
        old.parent.mkdir(parents=True);old.write_bytes(raw);old.chmod(0o600)
        service.write_text(m.broker_service_text(old).replace('PrivateTmp=no\nReadOnlyPaths=/tmp\n','PrivateTmp=yes\n').replace(' CAP_CHECKPOINT_RESTORE',''));service.chmod(0o600)
        with patch.object(m,'BROKER_LIBRARY',library),patch.object(m,'BROKER_SOCKET',socket),patch.object(m,'BROKER_SERVICE',service),\
             patch.object(m.base,'run',return_value='active'):
            report=m.reference_collector();again=m.reference_collector()
        self.assertTrue(report['upgraded']);self.assertFalse(again['upgraded'])
        self.assertIn('CAP_CHECKPOINT_RESTORE',service.read_text())
        self.assertIn('PrivateTmp=no\nReadOnlyPaths=/tmp',service.read_text())
