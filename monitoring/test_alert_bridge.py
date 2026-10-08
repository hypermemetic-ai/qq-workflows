import importlib.util
import io
import json
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import unittest
from unittest.mock import patch

# Lightweight fixture-only review: no live daemon, model, or real host indexing.
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
if hasattr(os, "sched_getaffinity"):
    os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("alert-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        (self.state / "incidents").mkdir()
        self.now = 1_000
        self.calls = []
        self.running = False
        self.send_failure = False

        def run(args, **kwargs):
            self.calls.append(args)
            if args[1] == "inspect":
                return subprocess.CompletedProcess(args, 0, json.dumps({"Status": "running" if self.running else "idle"}), "")
            if self.send_failure:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, "accepted", "")
        self.run = run
        self.config = {"paseo_agent_id": "owned-agent", "desktop_notifications": False,
                       "investigator_cooldown_seconds": 600, "investigator_max_seconds": 180}
        self.bridge = bridge.Bridge(self.state, self.config, runner=run, clock=lambda: self.now)
        self.incident = {"id": "test", "type": "memory_pressure", "status": "open", "severity": "critical",
                         "first_seen": 990, "summary": "A real resource threshold crossed."}
        bridge.atomic_json(self.state / "incidents/test.json", self.incident)

    def tearDown(self):
        self.tmp.cleanup()

    def test_retry_survives_failed_acceptance_and_restart(self):
        self.send_failure = True
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(len(self.bridge.pending()), 1)
        self.send_failure = False
        self.now = self.bridge.dispatch["retry_after"] + 1
        recovered = bridge.Bridge(self.state, self.config, runner=self.run, clock=lambda: self.now)
        recovered.investigator(recovered.pending())
        self.assertEqual(recovered.pending(), [])
        restarted = bridge.Bridge(self.state, self.config, runner=self.run, clock=lambda: self.now)
        self.assertEqual(restarted.pending(), [])

    def test_busy_agent_and_cooldown_do_not_overlap_turns(self):
        self.running = True
        self.bridge.investigator(self.bridge.pending())
        self.assertFalse(any(c[1] == "send" for c in self.calls))
        self.running = False
        self.bridge.investigator(self.bridge.pending())
        self.incident.update(status="resolved")
        bridge.atomic_json(self.state / "incidents/test.json", self.incident)
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(sum(c[1] == "send" for c in self.calls), 1)
        self.now += 601
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(sum(c[1] == "send" for c in self.calls), 2)

    def test_only_owned_dispatch_can_be_timed_out(self):
        self.running = True
        self.bridge.investigator(self.bridge.pending())
        self.assertFalse(any(c[1] == "stop" for c in self.calls))
        self.bridge.dispatch["active_since"] = self.now - 181
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual([c for c in self.calls if c[1] == "stop"], [["paseo", "stop", "owned-agent"]])

    def test_paseo_only_and_untrusted_payload(self):
        self.bridge.desktop(self.bridge.pending())
        self.assertEqual(self.calls, [])
        prompt = bridge.prepare_prompt([self.incident], self.state)
        self.assertIn("untrusted diagnostic data", prompt)
        self.assertIn("Do not modify", prompt)

    def test_export_invalid_or_stale_values_and_private_evidence(self):
        text = bridge.prometheus({"timestamp": 900, "metrics": {"normal": 1, "bad": float("nan"), "x y": 4}}, self.now)
        self.assertIn("qq_monitor_collector_up 0", text)
        self.assertNotIn("qq_monitor_bad", text)
        self.assertNotIn("qq_monitor_x y", text)
        self.bridge.export({"timestamp": self.now, "metrics": {"normal": 1}})
        self.assertEqual((self.state / "export").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.state / "export/metrics.prom").stat().st_mode & 0o777, 0o644)

    def test_stale_collector_deduplicates_recovers_and_reopens(self):
        self.bridge.bridge_incident("collector_stale", True, "stale")
        incident = bridge.read_json(self.state / "incidents/bridge-collector_stale.json")
        self.bridge.dispatch["deliveries"]["bridge-collector_stale"] = {"paseo": bridge.revision(incident)}
        self.bridge.bridge_incident("collector_stale", True, "stale")
        self.assertEqual(len(self.bridge.pending()), 1)  # original fixture only
        self.bridge.bridge_incident("collector_stale", False, "recovered")
        self.assertEqual(len(self.bridge.pending()), 2)
        self.bridge.bridge_incident("collector_stale", True, "stale again")
        self.assertNotIn("bridge-collector_stale", self.bridge.dispatch["deliveries"])

    def test_uncertain_accepted_send_has_durable_runtime_owner_after_restart(self):
        def accepted_then_timeout(args, **kwargs):
            if args[1] == "send":
                self.running = True
                raise subprocess.TimeoutExpired(args, 8)
            return self.run(args, **kwargs)
        self.bridge.runner = accepted_then_timeout
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(len(self.bridge.pending()), 1)
        self.assertEqual(bridge.read_json(self.state / "dispatch-state.json")["active_since"], self.now)
        restarted = bridge.Bridge(self.state, self.config, runner=self.run, clock=lambda: self.now)
        self.now += 181
        restarted.investigator(restarted.pending())
        self.assertTrue(any(c[1] == "stop" for c in self.calls))

    def test_outage_backoff_is_bounded_and_does_not_discard_incidents(self):
        self.send_failure = True
        self.bridge.investigator(self.bridge.pending())
        count = len(self.calls)
        self.now += 10
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(len(self.calls), count)
        for _ in range(8):
            self.now = self.bridge.dispatch["retry_after"] + 1
            self.bridge.investigator(self.bridge.pending())
            self.assertLessEqual(self.bridge.dispatch["retry_after"] - self.now, 600)
        self.assertEqual(len(self.bridge.pending()), 1)
        self.send_failure = False
        self.now = self.bridge.dispatch["retry_after"] + 1
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(self.bridge.pending(), [])

    def test_pending_reads_all_retained_incidents_and_prunes_orphan_ledger(self):
        self.bridge.dispatch["deliveries"]["removed"] = {"paseo": "old"}
        for index in range(230):
            identity = f"{index:03d}"
            incident = {**self.incident, "id": identity, "first_seen": index,
                        "evidence": {"large": "x" * 1024}}
            bridge.atomic_json(self.state / "incidents" / (identity + ".json"), incident)
        pending = self.bridge.pending()
        self.assertEqual(len(pending), 231)
        self.assertEqual(pending[0]["id"], "000")
        self.assertTrue(all("evidence" not in i for i in pending))
        self.assertNotIn("removed", self.bridge.dispatch["deliveries"])
        self.assertNotIn("removed", bridge.read_json(self.state / "dispatch-state.json")["deliveries"])

    def test_same_id_new_occurrence_is_deliverable_after_undelivered_recovery(self):
        self.bridge.investigator(self.bridge.pending())
        self.incident.update(status="resolved")
        bridge.atomic_json(self.state / "incidents/test.json", self.incident)
        self.incident.update(status="open", first_seen=self.now + 20)
        bridge.atomic_json(self.state / "incidents/test.json", self.incident)
        self.assertEqual(len(self.bridge.pending()), 1)
        first = bridge.revision(self.incident)
        self.incident["occurrences"] = 2
        self.assertNotEqual(bridge.revision(self.incident), first)

    def test_desktop_defaults_off_and_nonidle_paseo_state_is_not_dispatched(self):
        self.bridge.config.pop("desktop_notifications")
        self.bridge.desktop(self.bridge.pending())
        self.assertEqual(self.calls, [])
        self.bridge.runner = lambda args, **kwargs: subprocess.CompletedProcess(args, 0, '{"Status":"needs_input"}', "")
        self.bridge.investigator(self.bridge.pending())
        self.assertEqual(len(self.bridge.pending()), 1)
        self.assertGreater(self.bridge.dispatch["retry_after"], self.now)

    def test_atomic_state_flushes_directory_and_cleans_failed_temporaries(self):
        original = bridge.os.fsync
        fsync_modes = []
        def tracked(fd):
            fsync_modes.append(os.fstat(fd).st_mode)
            original(fd)
        with patch.object(bridge.os, "fsync", side_effect=tracked):
            bridge.atomic_json(self.state / "durable.json", {"ok": True})
        import stat
        self.assertTrue(any(stat.S_ISDIR(mode) for mode in fsync_modes))
        with self.assertRaises(ValueError):
            bridge.atomic_json(self.state / "bad.json", {"value": float("nan")})
        self.assertFalse(any(p.name.startswith("tmp") for p in self.state.iterdir()))

    def test_netdata_reopen_uses_new_occurrence_identity(self):
        status = ["CRITICAL"]
        def response(*args, **kwargs):
            return io.BytesIO(json.dumps({"alarms": {"alarm-key": {"status": status[0], "hostname": "local", "name": "memory"}}}).encode())
        with patch.object(bridge.urllib.request, "urlopen", side_effect=response):
            for _ in range(3):
                self.bridge.netdata()
                self.now += 31
            netdata = [i for i in self.bridge.pending() if i["id"].startswith("netdata-")][0]
            self.bridge.dispatch["deliveries"][netdata["id"]] = {"paseo": bridge.revision(netdata)}
            status[0] = "CLEAR"
            self.bridge.netdata()
            self.now += 31
            status[0] = "CRITICAL"
            for _ in range(3):
                self.bridge.netdata()
                self.now += 31
        reopened = [i for i in self.bridge.pending() if i["id"] == netdata["id"]]
        self.assertEqual(len(reopened), 1)
        self.assertGreater(reopened[0]["first_seen"], netdata["first_seen"])

    def test_watchdog_schema_failure_outage_and_recovery_are_durable(self):
        token = self.state / "token"
        token.write_text("fixture-private-token")
        self.bridge.config.update(watchdog_url="https://watchdog.invalid", watchdog_token_file=str(token))
        sample = {"host": "fixture-host", "boot_id": "boot-a", "timestamp": self.now,
                  "metrics": {"memory_available_ratio": .5}}
        bodies = []
        outage = {"id": "stable-outage", "opened_at": 800, "recovered_at": 990, "peak_level": "critical"}
        def response(req, **kwargs):
            if req.full_url.endswith("/heartbeat"):
                bodies.append(json.loads(req.data))
                return io.BytesIO(b"{}")
            return io.BytesIO(json.dumps({"host": "fixture-host", "latest_outage": outage}).encode())
        with patch.object(bridge.urllib.request, "urlopen", side_effect=OSError("unreachable")):
            for _ in range(3):
                sample["timestamp"] = self.now
                self.bridge.heartbeat(sample)
                self.now += 21
        file = self.state / "incidents/bridge-watchdog_unavailable.json"
        self.assertEqual(bridge.read_json(file)["status"], "open")
        restarted = bridge.Bridge(self.state, self.bridge.config, runner=self.run, clock=lambda: self.now)
        self.assertEqual(restarted.dispatch["watchdog_failures"], 3)
        with patch.object(bridge.urllib.request, "urlopen", side_effect=response):
            sample["timestamp"] = self.now
            restarted.heartbeat(sample)
            self.now += 21
            outage["gap_seconds"] = 190  # same offbox ID, additional evidence is not another alert
            sample["timestamp"] = self.now
            restarted.heartbeat(sample)
        self.assertEqual(bridge.read_json(file)["status"], "resolved")
        self.assertEqual(len(list((self.state / "incidents").glob("remote-outage-*.json"))), 1)
        self.assertEqual(set(bodies[0]), {"host", "boot_id", "timestamp", "metrics"})
        self.assertNotIn("fixture-private-token", json.dumps(bodies))

    def test_invalid_watchdog_status_is_counted_without_crashing(self):
        token = self.state / "token"
        token.write_text("fixture-token")
        self.bridge.config.update(watchdog_url="https://watchdog.invalid", watchdog_token_file=str(token))
        sample = {"host": "fixture-host", "boot_id": "boot-a", "timestamp": self.now, "metrics": {}}
        def response(req, **kwargs):
            return io.BytesIO(b"{}" if req.full_url.endswith("/heartbeat") else b"[]")
        with patch.object(bridge.urllib.request, "urlopen", side_effect=response):
            self.bridge.heartbeat(sample)
        self.assertEqual(self.bridge.dispatch["watchdog_failures"], 1)

    def test_invalid_netdata_schema_is_an_unavailable_incident_after_three_checks(self):
        with patch.object(bridge.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(b'{"alarms":[]}')):
            for _ in range(3):
                self.bridge.netdata()
                self.now += 31
        path = self.state / "incidents/bridge-netdata_unavailable.json"
        self.assertEqual(bridge.read_json(path)["status"], "open")


if __name__ == "__main__":
    unittest.main()
