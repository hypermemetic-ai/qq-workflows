"""Run with: python3 -m unittest discover -s monitoring -p 'test_host_health.py'."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("host_health", Path(__file__).with_name("host-health.py"))
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)


def sample(now=100, **metrics):
    values = {"memory_available_ratio": .5, "memory_psi_some": 0, "memory_psi_full": 0,
              "cpu_psi_some": 0, "io_psi_full": 0, "disk_used_ratio": .2, "disk_inode_used_ratio": .2,
              "inotify_watches": 0, "inotify_watch_limit": 1000, "inotify_instances": 0,
              "inotify_instance_limit": 128, "temperature_c": 40, "gpu_bar1_used_ratio": None,
              "gpu_temperature_c": None, "gpu_query_ok": None}
    values.update(metrics)
    return {"schema": 1, "timestamp": now, "boot_id": "boot-a", "host": "fixture-host", "metrics": values,
            "top_watchers": [], "services": [], "coverage": {"watchers_complete": True,
                                                               "journal_available": True, "services_available": True}}


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.policy = health.load_policy()
        self.engine = health.IncidentEngine(self.directory, self.policy)

    def tearDown(self):
        self.temp.cleanup()

    def incidents(self, event_type=None):
        values = [json.loads(path.read_text()) for path in (self.directory / "incidents").glob("*.json")]
        return [value for value in values if event_type is None or value["type"] == event_type]

    def test_sustained_warning_escalation_hysteresis_and_recovery(self):
        for now in (100, 110):
            self.engine.evaluate(sample(now, inotify_watches=750))
        self.assertEqual(self.incidents("inotify_watches"), [])
        self.engine.evaluate(sample(120, inotify_watches=750))
        incident_id = self.incidents("inotify_watches")[0]["id"]
        for now in (130, 140, 150):
            self.engine.evaluate(sample(now, inotify_watches=950))
        incident = self.incidents("inotify_watches")[0]
        self.assertEqual((incident["id"], incident["severity"], incident["last_seen"]), (incident_id, "critical", 150))
        for now in (160, 170, 180):
            self.engine.evaluate(sample(now, inotify_watches=650))
        self.assertEqual(self.incidents("inotify_watches")[0]["status"], "open")
        for now in (190, 200, 210):
            self.engine.evaluate(sample(now, inotify_watches=500))
        self.assertEqual(self.incidents("inotify_watches")[0]["status"], "resolved")
        for now in (220, 230, 240):
            self.engine.evaluate(sample(now, inotify_watches=750))
        self.assertEqual(len(self.incidents("inotify_watches")), 2)

    def test_missing_metric_does_not_resolve_open_incident(self):
        for now in (100, 110, 120):
            self.engine.evaluate(sample(now, disk_used_ratio=.96))
        for now in (130, 140, 150):
            self.engine.evaluate(sample(now, disk_used_ratio=None))
        self.assertEqual(self.incidents("disk")[0]["status"], "open")

    def test_memory_requires_pressure_and_real_recovery(self):
        for now in (100, 110, 120):
            self.engine.evaluate(sample(now, memory_available_ratio=.01))
        self.assertEqual(self.incidents("memory"), [])
        for now in (130, 140, 150):
            self.engine.evaluate(sample(now, memory_available_ratio=.03, memory_psi_some=10))
        self.assertEqual(self.incidents("memory")[0]["severity"], "critical")
        for now in (160, 170, 180):
            self.engine.evaluate(sample(now, memory_available_ratio=.06, memory_psi_some=0))
        self.assertEqual(self.incidents("memory")[0]["status"], "open")

    def test_restart_preserves_open_incident_and_delivery(self):
        for now in (100, 110, 120):
            self.engine.evaluate(sample(now, io_psi_full=25))
        incident = self.incidents("io_pressure")[0]
        incident["delivery"] = {"bridge": "delivered"}
        health.atomic_json(self.directory / "incidents" / (incident["id"] + ".json"), incident)
        restarted = health.IncidentEngine(self.directory, self.policy)
        restarted.evaluate(sample(130, io_psi_full=25))
        current = self.incidents("io_pressure")[0]
        self.assertEqual(current["id"], incident["id"])
        self.assertEqual(current["delivery"], {"bridge": "delivered"})

    def test_cached_readings_are_not_three_distinct_samples(self):
        for now in (100, 110, 120):
            snapshot = sample(now, inotify_watches=950)
            snapshot["coverage"]["watcher_sample_timestamp"] = 100
            self.engine.evaluate(snapshot)
        self.assertEqual(self.incidents("inotify_watches"), [])
        for now in (130, 160):
            snapshot = sample(now, inotify_watches=950)
            snapshot["coverage"]["watcher_sample_timestamp"] = now
            self.engine.evaluate(snapshot)
        self.assertEqual(len(self.incidents("inotify_watches")), 1)

    def test_events_immediate_deduplicated_and_quiet_resolution(self):
        event = {"type": "kernel_oom", "severity": "critical", "summary": "Kernel OOM",
                 "evidence": {"journal_cursor": "cursor-one"}}
        self.engine.evaluate(sample(100), [event])
        self.engine.evaluate(sample(110), [event])
        self.assertEqual(len(self.incidents("kernel_oom")), 1)
        self.assertEqual(self.incidents("kernel_oom")[0]["occurrences"], 1)
        event["evidence"]["journal_cursor"] = "cursor-two"
        self.engine.evaluate(sample(120), [event])
        self.assertEqual(self.incidents("kernel_oom")[0]["occurrences"], 2)
        self.engine.evaluate(sample(721))
        self.assertEqual(self.incidents("kernel_oom")[0]["status"], "resolved")

    def test_crash_before_rule_state_write_keeps_deterministic_event_id(self):
        event = {"type": "nvidia_xid", "severity": "critical", "summary": "GPU Xid",
                 "evidence": {"journal_cursor": "gpu-cursor"}}
        self.engine.open(event["type"], event["severity"], event["summary"], event["evidence"], 100, "fixture-host", "boot-a", event=True)
        restarted = health.IncidentEngine(self.directory, self.policy)
        restarted.evaluate(sample(110), [event])
        self.assertEqual(len(self.incidents("nvidia_xid")), 1)
        self.assertEqual(self.incidents("nvidia_xid")[0]["occurrences"], 1)

    def test_partial_watcher_scan_cannot_clear_existing_incident(self):
        for now in (100, 110, 120):
            self.engine.evaluate(sample(now, inotify_watches=950))
        for now in (130, 140, 150):
            snapshot = sample(now, inotify_watches=0)
            snapshot["coverage"]["watchers_complete"] = False
            self.engine.evaluate(snapshot)
        self.assertEqual(self.incidents("inotify_watches")[0]["status"], "open")

    def test_reboot_resolves_old_resource_incident_and_records_reboot(self):
        for now in (100, 110, 120):
            self.engine.evaluate(sample(now, io_psi_full=60))
        new_boot = sample(130)
        new_boot["boot_id"] = "boot-b"
        self.engine.evaluate(new_boot)
        self.assertEqual(self.incidents("io_pressure")[0]["status"], "resolved")
        self.assertEqual(self.incidents("host_restarted")[0]["status"], "open")

    def test_service_failed_immediate_and_exit_status_kept(self):
        snapshot = sample()
        snapshot["services"] = [{"scope": "user", "unit": "paseo.service", "active_state": "failed", "exit_status": "9"}]
        self.engine.evaluate(snapshot)
        incident = self.incidents("service_failed:user:paseo.service")[0]
        self.assertEqual(incident["evidence"]["exit_status"], "9")

    def test_large_process_rss_opens_alert_after_three_distinct_samples(self):
        for now in (100, 110, 120):
            snapshot = sample(now, largest_process_memory_ratio=.31)
            snapshot["top_memory_processes"] = [{"pid": 198182, "rss_bytes": 13000000000, "comm": "node"}]
            snapshot["coverage"].update(process_memory_complete=True, process_memory_sample_timestamp=now)
            self.engine.evaluate(snapshot)
        incident = self.incidents("process_memory")[0]
        self.assertEqual(incident["severity"], "critical")
        self.assertEqual(incident["evidence"]["top_memory_processes"][0]["comm"], "node")


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.policy = health.load_policy()
        self.calls = []
        self.records = []
        self.ok, self.error = True, None

    def tearDown(self):
        self.temp.cleanup()

    def runner(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return {"ok": self.ok, "error": self.error,
                "stdout": b"\n".join(json.dumps(record).encode() for record in self.records)}

    def record(self, cursor="a", message="Out of memory: Killed process 123", transport="kernel"):
        return {"__CURSOR": cursor, "_BOOT_ID": "boot-a", "_TRANSPORT": transport, "MESSAGE": message}

    def test_initial_baseline_restart_cursor_and_new_boot_no_replay(self):
        reader = health.JournalReader(self.temp.name, self.policy, self.runner)
        self.records = [self.record("old")]
        events, coverage, state = reader.poll("boot-a", 100)
        self.assertEqual(events, [])
        self.assertTrue(coverage["journal_baseline"])
        reader.commit(state)
        reader = health.JournalReader(self.temp.name, self.policy, self.runner)
        self.records = [self.record("new")]
        events, coverage, state = reader.poll("boot-a", 110)
        self.assertEqual(events[0]["type"], "kernel_oom")
        self.assertIn("--after-cursor=old", self.calls[-1][0])
        self.assertIn("--lines=+200", self.calls[-1][0])
        reader.commit(state)
        events, coverage, state = reader.poll("boot-b", 120)
        self.assertEqual(events, [])
        self.assertIn("--lines=1", self.calls[-1][0])

    def test_query_error_keeps_explicit_coverage_and_does_not_replay(self):
        reader = health.JournalReader(self.temp.name, self.policy, self.runner)
        reader.state = {"boot_id": "boot-a", "initialized": True, "cursor": "rotated", "since": 100}
        self.ok, self.error = False, "exit_1"
        events, coverage, state = reader.poll("boot-a", 120)
        self.assertEqual(events, [])
        self.assertFalse(coverage["journal_available"])
        self.assertIsNone(state["cursor"])
        self.assertEqual(state["since"], 120)
        reader.commit(state)
        reader.poll("boot-a", 130)
        self.assertIn("--since=@120", self.calls[-1][0])

    def test_timeout_does_not_advance_cursor(self):
        reader = health.JournalReader(self.temp.name, self.policy, self.runner)
        reader.state = {"boot_id": "boot-a", "initialized": True, "cursor": "last", "since": 100}
        self.ok, self.error = False, "timeout"
        _, coverage, state = reader.poll("boot-a", 120)
        self.assertEqual(state["cursor"], "last")
        self.assertEqual(coverage["journal_error"], "timeout")

    def test_burst_drains_capped_oldest_first_batch(self):
        self.policy["journal_max_events"] = 2
        reader = health.JournalReader(self.temp.name, self.policy, self.runner)
        reader.state = {"boot_id": "boot-a", "initialized": True, "cursor": "before", "since": 100}
        self.records = [self.record("one"), self.record("two"), self.record("three")]
        events, coverage, state = reader.poll("boot-a", 120)
        self.assertEqual(len(events), 2)
        self.assertTrue(coverage["journal_backlog"])
        self.assertEqual(state["cursor"], "two")

    def test_only_allowlisted_service_and_recognized_kernel_errors(self):
        self.policy["important_user_units"] = ["paseo.service"]
        record = {"SYSLOG_IDENTIFIER": "systemd", "MESSAGE": "unrelated.service failed with secrets here"}
        self.assertIsNone(health.classify_journal(record, self.policy))
        record["USER_UNIT"] = "paseo.service"
        event = health.classify_journal(record, self.policy)
        self.assertEqual(event["type"], "service_failed:user:paseo.service")
        self.assertNotIn("MESSAGE", event["evidence"])
        self.assertIsNone(health.classify_journal(self.record(message="ordinary startup"), self.policy))
        xid = health.classify_journal(self.record(message="NVRM: Xid (PCI:0000:01:00): 31"), self.policy)
        self.assertEqual(xid["type"], "nvidia_xid")

    def test_incidents_written_before_journal_cursor_commit(self):
        calls = []
        sampler = mock.Mock()
        sampler.policy = self.policy
        sampler.sample.return_value = sample()
        journal = mock.Mock()
        journal.poll.return_value = ([], {"journal_available": True}, {"cursor": "next"})
        journal.commit.side_effect = lambda _: calls.append("cursor")
        engine = mock.Mock()
        engine.evaluate.side_effect = lambda *_: calls.append("incidents")
        health.collect_once(sampler, journal, engine, self.temp.name)
        self.assertEqual(calls, ["incidents", "cursor"])

    def test_kernel_uuid_dashes_removed_for_journalctl_boot_argument(self):
        reader = health.JournalReader(self.temp.name, self.policy, self.runner)
        reader.poll("8b77197b-0af4-4798-be9a-4523bc37273f", 100)
        self.assertIn("--boot=8b77197b0af44798be9a4523bc37273f", self.calls[-1][0])


class SamplingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.policy = health.load_policy()

    def tearDown(self):
        self.temp.cleanup()

    def process(self, pid, watches, uid=42):
        base = self.directory / str(pid)
        (base / "fd").mkdir(parents=True)
        (base / "fdinfo").mkdir()
        (base / "status").write_text("Name:\tfixture\nPPid:\t1\nUid:\t" + str(uid) + "\n")
        (base / "comm").write_text("fixture\n")
        (base / "cgroup").write_text("0::/user.slice/fixture\n")
        (base / "fd" / "3").symlink_to("anon_inode:inotify")
        (base / "fdinfo" / "3").write_text("pos: 0\n" + "inotify wd:1 ino:1\n" * watches)
        (base / "fd" / "4").symlink_to("/dev/null")
        return base

    def test_watchers_attributed_per_uid_and_inherited_duplicates_explained(self):
        self.process(101, 3)
        self.process(102, 2)
        self.process(103, 100, uid=99)
        values, rows, coverage = health.collect_watchers(self.directory, self.policy, uid=42)
        self.assertEqual(values, {"inotify_watches": 5, "inotify_instances": 2})
        self.assertEqual([row["pid"] for row in rows], [101, 102])
        self.assertTrue(coverage["watchers_complete"])
        self.assertIn("repeatedly", coverage["watcher_measurement"])
        self.assertNotIn("cmdline", rows[0])

    def test_fd_byte_and_process_budgets_report_partial(self):
        self.process(101, 100)
        self.process(102, 100)
        self.policy["watcher_max_bytes"] = 100
        values, rows, coverage = health.collect_watchers(self.directory, self.policy, uid=42)
        self.assertFalse(coverage["watchers_complete"])
        self.assertTrue(coverage["watcher_budget_exceeded"])
        self.assertLess(values["inotify_watches"], 100)
        self.policy = health.load_policy()
        self.policy["watcher_max_processes"] = 1
        _, _, coverage = health.collect_watchers(self.directory, self.policy, uid=42)
        self.assertFalse(coverage["watchers_complete"])

    def test_missing_proc_is_partial_not_false_complete(self):
        values, _, coverage = health.collect_watchers(self.directory / "absent", self.policy, uid=42)
        self.assertEqual(values["inotify_watches"], 0)
        self.assertFalse(coverage["watchers_complete"])

    def test_denied_fd_access_is_partial(self):
        self.process(101, 3)
        real_scandir = os.scandir

        def scandir(path):
            if str(path).endswith("/fd"):
                raise PermissionError("fixture")
            return real_scandir(path)

        with mock.patch.object(health.os, "scandir", side_effect=scandir):
            _, _, coverage = health.collect_watchers(self.directory, self.policy, uid=42)
        self.assertFalse(coverage["watchers_complete"])
        self.assertEqual(coverage["watchers_denied"], 1)

    def test_psi_known_sensors_and_sensor_unavailable(self):
        pressure = self.directory / "pressure"
        pressure.write_text("some avg10=12.34 avg60=1.00 total=1\nfull avg10=5.00 total=2\n")
        self.assertEqual(health.psi_value(pressure, "some"), 12.34)
        self.assertIsNone(health.psi_value(self.directory / "absent", "full"))
        for index, (name, temperature) in enumerate((("coretemp", 88000), ("nvme", 99000))):
            base = self.directory / "class/hwmon" / ("hwmon" + str(index))
            base.mkdir(parents=True)
            (base / "name").write_text(name)
            (base / "temp1_input").write_text(str(temperature))
        temperature, sensors = health.collect_temperature(self.directory)
        self.assertEqual(temperature, 88)
        self.assertEqual(len(sensors), 1)

    def test_gpu_query_bounded_xml_no_process_names(self):
        xml = b"<nvidia_smi_log><gpu><bar1_memory_usage><total>100 MiB</total><used>90 MiB</used></bar1_memory_usage><fb_memory_usage><total>200 MiB</total><used>50 MiB</used></fb_memory_usage><temperature><gpu_temp>75 C</gpu_temp></temperature><processes><process_info><pid>42</pid><process_name>private path</process_name><type>C</type><used_memory>30 MiB</used_memory></process_info></processes></gpu></nvidia_smi_log>"
        runner = mock.Mock(return_value={"ok": True, "error": None, "stdout": xml})
        with mock.patch.object(health.shutil, "which", return_value="/usr/bin/nvidia-smi"):
            metrics, coverage, rows = health.collect_gpu(self.policy, runner)
        self.assertEqual(metrics["gpu_bar1_used_ratio"], .9)
        self.assertEqual(metrics["gpu_vram_used_ratio"], .25)
        self.assertEqual(metrics["gpu_temperature_c"], 75)
        self.assertNotIn("process_name", rows[0])
        self.assertEqual(runner.call_args.kwargs["max_bytes"], 512 * 1024)
        self.assertEqual(runner.call_args.kwargs["timeout"], 3)

    def test_gpu_timeout_is_gap_not_zero_temperature(self):
        runner = mock.Mock(return_value={"ok": False, "error": "timeout", "stdout": b""})
        with mock.patch.object(health.shutil, "which", return_value="/usr/bin/nvidia-smi"):
            metrics, coverage, _ = health.collect_gpu(self.policy, runner)
        self.assertIsNone(metrics["gpu_temperature_c"])
        self.assertFalse(metrics["gpu_query_ok"])
        self.assertEqual(coverage["gpu_query_error"], "timeout")

    def test_bounded_command_limits_output_and_time_and_reaps(self):
        result = health.bounded_command([sys.executable, "-c", "print('a' * 100000)"], max_bytes=1024)
        self.assertEqual(result["error"], "output_budget")
        self.assertLessEqual(len(result["stdout"]), 1024)
        for _ in range(100):
            pending = health._PENDING_COMMANDS.get(sys.executable)
            if pending is None or pending.poll() is not None:
                break
            time.sleep(.01)
        result = health.bounded_command([sys.executable, "-c", "import time; time.sleep(30)"], timeout=.1)
        self.assertEqual(result["error"], "timeout")
        pending = health._PENDING_COMMANDS.pop(sys.executable, None)
        if pending is not None:
            pending.wait(timeout=1)  # Test process is killable; collector never blocks here.

    def test_unkillable_probe_is_retained_without_wait_or_duplicate_spawn(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        process = mock.Mock(pid=99999999, stdout=os.fdopen(stdout_read, "rb"), stderr=os.fdopen(stderr_read, "rb"))
        process.poll.return_value = None
        try:
            with mock.patch.object(health.subprocess, "Popen", return_value=process) as spawn, mock.patch.object(health.os, "killpg"):
                result = health.bounded_command(["blocked-fixture"], timeout=.01)
                self.assertEqual(result["error"], "timeout")
                self.assertIs(health._PENDING_COMMANDS["blocked-fixture"], process)
                second = health.bounded_command(["blocked-fixture"], timeout=.01)
                self.assertEqual(second["error"], "previous_probe_pending")
                self.assertEqual(spawn.call_count, 1)
                process.wait.assert_not_called()
        finally:
            os.close(stdout_write)
            os.close(stderr_write)
            health._PENDING_COMMANDS.pop("blocked-fixture", None)

    def test_atomic_files_private_and_corrupt_state_fallback(self):
        path = self.directory / "metrics.json"
        health.atomic_json(path, {"schema": 1})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(path.read_text()), {"schema": 1})
        self.assertEqual(list(self.directory.glob(".metrics.json.*")), [])
        path.write_text("partial{")
        self.assertEqual(health.read_json(path, {"fallback": True}), {"fallback": True})

    def test_policy_rejects_invalid_unit_and_threshold_order(self):
        path = self.directory / "policy.json"
        path.write_text(json.dumps({"important_user_units": ["--danger"]}))
        with self.assertRaises(ValueError):
            health.load_policy(path)
        path.write_text(json.dumps({"thresholds": {"disk": {"clear": .99}}}))
        with self.assertRaises(ValueError):
            health.load_policy(path)
        path.write_text(json.dumps({"journal_max_events": 1.5}))
        with self.assertRaises(ValueError):
            health.load_policy(path)

    def test_process_rss_attribution_has_no_command_lines(self):
        base = self.process(101, 1)
        with (base / "status").open("a") as stream:
            stream.write("VmRSS:\t13000000 kB\n")
        (base / "exe").symlink_to("/usr/bin/node")
        ratio, rows, coverage = health.collect_process_memory(self.directory, self.policy, 32000000 * 1024)
        self.assertAlmostEqual(ratio, 13 / 32)
        self.assertEqual(rows[0]["rss_bytes"], 13000000 * 1024)
        self.assertEqual(rows[0]["executable"], "/usr/bin/node")
        self.assertNotIn("cmdline", rows[0])
        self.assertTrue(coverage["process_memory_complete"])

    def test_history_is_private_and_bounded_across_restart(self):
        self.policy.update(history_max_bytes=128, history_files=3)
        for now in range(20):
            health.append_history(self.directory, {"timestamp": now, "example": "x" * 50}, self.policy)
        paths = list(self.directory.glob("samples*.jsonl"))
        self.assertEqual(len(paths), 3)
        self.assertTrue(all(path.stat().st_size <= 128 for path in paths))
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in paths))
        latest = json.loads((self.directory / "samples.jsonl").read_text().splitlines()[-1])
        self.assertEqual(latest["timestamp"], 19)


if __name__ == "__main__":
    unittest.main()
