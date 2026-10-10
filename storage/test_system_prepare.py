import importlib.util
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

    def test_collector_install_is_pinned_read_only_and_repeated_safely(self):
        library=self.root/'refs';socket=self.root/'refs.socket';service=self.root/'refs.service'
        with patch.object(m,'BROKER_LIBRARY',library),patch.object(m,'BROKER_SOCKET',socket),patch.object(m,'BROKER_SERVICE',service),\
             patch.object(m.base,'run',return_value='active') as run:
            m.reference_collector();m.reference_collector()
        content=service.read_text();self.assertIn('ProtectSystem=strict',content)
        self.assertIn('CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE',content)
        self.assertNotIn('ExecStop',content)
        self.assertEqual([call.args[:2] for call in run.call_args_list],
                         [('systemctl','daemon-reload'),('systemctl','enable'),('systemctl','is-active')]*2)

    def test_unknown_collector_unit_is_preserved(self):
        socket=self.root/'refs.socket';socket.write_text('operator owned')
        with patch.object(m,'BROKER_LIBRARY',self.root/'refs'),patch.object(m,'BROKER_SOCKET',socket),patch.object(m.base,'run') as run:
            with self.assertRaisesRegex(ValueError,'Unrecognized'):m.reference_collector()
        self.assertEqual(socket.read_text(),'operator owned');run.assert_not_called()
