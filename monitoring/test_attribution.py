"""Fixture-only checks for incident evidence collected at the time of failure."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

health = module('health_attribution', 'host-health.py')
bridge = module('bridge_attribution', 'alert-bridge.py')


class AttributionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.policy = health.load_policy()

    def tearDown(self):
        self.tmp.cleanup()

    def process(self, ticks, start=100, written=1000):
        base = self.root / '123'
        base.mkdir(exist_ok=True)
        fields = ['0'] * 22
        fields[0], fields[1], fields[11], fields[19] = 'R', '1', str(ticks), str(start)
        (base / 'stat').write_text('123 (name with ) parens) ' + ' '.join(fields))
        (base / 'io').write_text(f'read_bytes: 0\nwrite_bytes: {written}\n')
        (base / 'cgroup').write_text('0::/qqjobs.slice/job.scope')
        if not (base / 'cwd').exists():
            (base / 'cwd').symlink_to(self.root)

    def test_interval_rates_and_pid_reuse(self):
        activity = health.ProcessActivity()
        self.process(100)
        cpu, _, coverage = activity.sample(self.root, self.policy, 10)
        self.assertEqual(cpu, [])
        self.assertTrue(coverage['process_activity_baseline'])
        self.process(100 + os.sysconf('SC_CLK_TCK') * 5, written=11000)
        cpu, io_rows, coverage = activity.sample(self.root, self.policy, 20)
        self.assertEqual(cpu[0]['cpu_percent'], 50)
        self.assertEqual(io_rows[0]['write_bytes_per_second'], 1000)
        self.assertEqual(cpu[0]['comm'], 'name with ) parens')
        self.assertIn('job.scope', cpu[0]['cgroup'])
        self.process(99999, start=200)
        self.assertEqual(activity.sample(self.root, self.policy, 30)[0], [])

    def test_unreadable_io_does_not_invent_zero_rate(self):
        activity = health.ProcessActivity()
        self.process(100)
        (self.root / '123/io').unlink()
        activity.sample(self.root, self.policy, 10)
        cpu, io_rows, coverage = activity.sample(self.root, self.policy, 20)
        self.assertIsNone(cpu[0]['write_bytes_per_second'])
        self.assertEqual(io_rows, [])
        self.assertEqual(coverage['process_activity_io_unavailable'], 1)

    def test_disk_growth_hardlinks_and_symlink_exclusion(self):
        project = self.root / 'projects/test'
        project.mkdir(parents=True)
        blob = project / 'artifact'
        blob.write_bytes(b'x' * 4096)
        os.link(blob, project / 'duplicate')
        (project / 'outside').symlink_to('/proc')
        self.policy.update(disk_path=str(self.root), disk_scan_roots=[str(self.root)])
        scanner = health.DiskScanner(self.policy, monotonic=lambda: 0)
        first = scanner.sample(1000, 0)
        self.assertTrue(first['complete'])
        self.assertEqual(len(first['largest_files']), 1)
        blob.write_bytes(b'x' * 16384)
        second = scanner.sample(1301, 301)
        row = next(row for row in second['growing_directories'] if row['path'] == str(project))
        self.assertGreater(row['growth_bytes'], 0)
        self.assertEqual(second['comparison_finished_at'], 1000)

    def test_disk_scan_yields_and_limits_are_explicit(self):
        (self.root / 'a').mkdir()
        for i in range(5):
            (self.root / f'a/{i}').write_text('x')
        self.policy.update(disk_path=str(self.root), disk_scan_roots=[str(self.root)], disk_scan_max_entries_per_sample=1)
        scanner = health.DiskScanner(self.policy, monotonic=lambda: 0)
        self.assertTrue(scanner.sample(1000, 0)['in_progress'])
        for i in range(1, 10):
            result = scanner.sample(1000 + i, i)
        self.assertTrue(result['complete'])
        self.assertFalse(result['in_progress'])
        self.policy['disk_scan_max_inodes'] = 1
        limited = health.DiskScanner(self.policy, monotonic=lambda: 0).sample(2000, 0)
        self.assertFalse(limited['complete'])
        self.assertGreater(limited['errors_or_limit_hits'], 0)

    def test_peak_and_recovery_preserve_original_cpu_context(self):
        engine = health.IncidentEngine(self.root, self.policy)
        original = {'top_cpu_processes': [{'pid': 123, 'cpu_percent': 180}]}
        engine.open('temperature', 'warning', 'hot', {'value': 90, 'context': original}, 10, 'host', 'boot')
        engine.open('temperature', 'warning', 'hot', {'value': 86, 'context': {}}, 20, 'host', 'boot')
        engine.resolve('temperature', 30, 'cool', {'value': 40})
        incident = json.loads(next((self.root / 'incidents').glob('*.json')).read_text())
        self.assertEqual(incident['peak_value'], 90)
        self.assertEqual(incident['peak_evidence']['context'], original)
        self.assertEqual(incident['initial_evidence']['context'], original)
        self.assertEqual(incident['resolution_evidence']['value'], 40)

    def test_storage_message_and_nearby_context_survive_matching(self):
        records = [{'__CURSOR': str(i), '__REALTIME_TIMESTAMP': str(100000000 + i),
                    '_TRANSPORT': 'kernel', 'MESSAGE': message}
                   for i, message in enumerate(['ata1.00: failed command: WRITE FPDMA QUEUED', 'ata1: hard resetting link'])]
        def runner(*args, **kwargs):
            return {'ok': True, 'stdout': b'\n'.join(json.dumps(row).encode() for row in records), 'error': None}
        reader = health.JournalReader(self.root, self.policy, runner)
        reader.state = {'boot_id': 'boot', 'initialized': True, 'cursor': 'old'}
        events, _, _ = reader.poll('boot', 101)
        self.assertEqual(events[-1]['evidence']['message'], records[-1]['MESSAGE'])
        self.assertIn('WRITE FPDMA', events[-1]['evidence']['kernel_context'][0]['message'])

    def test_netdata_clear_has_clear_evidence_and_preserves_active_snapshot(self):
        (self.root / 'incidents').mkdir()
        bridge.atomic_json(self.root / 'metrics.json', {'timestamp': 1000, 'top_cpu_processes': [{'pid': 123}]})
        now = [1000]
        collector = bridge.Bridge(self.root, {}, clock=lambda: now[0])
        status = ['WARNING']
        def response(*args, **kwargs):
            return io.BytesIO(json.dumps({'alarms': {'disk': {'status': status[0], 'value': 4, 'name': 'disk'}}}).encode())
        with patch.object(bridge.urllib.request, 'urlopen', side_effect=response):
            for _ in range(3):
                collector.netdata()
                now[0] += 31
            status[0] = 'CLEAR'
            collector.netdata()
        incident = json.loads(next((self.root / 'incidents').glob('netdata-*.json')).read_text())
        self.assertEqual(incident['evidence']['status'], 'CLEAR')
        self.assertEqual(incident['last_active_evidence']['status'], 'WARNING')
        self.assertEqual(incident['initial_evidence']['context']['top_cpu_processes'][0]['pid'], 123)

if __name__ == '__main__':
    unittest.main()
