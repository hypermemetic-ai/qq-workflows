"""Bounded local fixtures for authentication, persistence and outage detection."""

import contextlib
import importlib.util
import io
import json
import os
from email.message import Message
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("offbox_watchdog", Path(__file__).with_name("offbox-watchdog.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class Clock:
    def __init__(self):
        self.wall = 1700000000.0
        self.mono = 500.0

    def advance(self, seconds):
        self.wall += seconds
        self.mono += seconds


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "state"
        self.clock = Clock()
        self.watchdog = self.load()

    def load(self, **kwargs):
        return module.Watchdog(self.directory, wall=lambda: self.clock.wall,
                               monotonic=lambda: self.clock.mono, boot_id="observer-boot", **kwargs)

    def payload(self, **changes):
        return {"host": "qq-box", "boot_id": "host-boot", "timestamp": self.clock.wall,
                "metrics": {"available_memory_bytes": 2048, "gpu": {"bar1_used_bytes": 1024}}, **changes}

    def events(self):
        path = self.directory / "incidents.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class WatchdogTest(Fixture):

    def test_warning_escalation_and_one_recovery(self):
        self.watchdog.receive(self.payload())
        self.clock.advance(89)
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["status"], "healthy")
        self.clock.advance(1)
        self.watchdog.tick()
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["status"], "warning")
        self.clock.advance(30)
        self.watchdog.tick()
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["status"], "critical")
        self.watchdog.receive(self.payload())
        self.clock.advance(1)
        self.watchdog.receive(self.payload())
        self.assertEqual([event["event"] for event in self.events()], ["outage", "escalation", "recovery"])
        latest = self.watchdog.status()["latest_outage"]
        self.assertEqual(latest["gap_seconds"], 120)
        self.assertEqual(latest["peak_level"], "critical")
        self.assertEqual(self.watchdog.status()["status"], "healthy")

    def test_missing_host_startup_grace_survives_restart(self):
        self.clock.advance(119)
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["status"], "unknown")
        self.watchdog = self.load()
        self.clock.advance(1)
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["status"], "critical")
        self.assertEqual([event["event"] for event in self.events()], ["outage"])
        self.assertIsNone(self.events()[0]["outage"]["last_seen"])

    def test_restart_preserves_last_seen_active_outage_and_sampling(self):
        self.watchdog.receive(self.payload())
        first_seen = self.watchdog.status()["last_seen"]
        self.clock.advance(91)
        self.watchdog.tick()
        incident = self.watchdog.status()["latest_outage"]["id"]
        self.watchdog = self.load()
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["last_seen"], first_seen)
        self.assertEqual(self.watchdog.status()["latest_outage"]["id"], incident)
        self.watchdog.receive(self.payload())
        self.assertEqual([event["event"] for event in self.events()], ["outage", "recovery"])
        self.watchdog = self.load()
        self.clock.advance(1)
        self.watchdog.receive(self.payload())
        self.assertEqual(len((self.directory / "snapshots.jsonl").read_text().splitlines()), 2)

    def test_monotonic_age_ignores_wall_clock_changes(self):
        self.watchdog.receive(self.payload())
        self.clock.mono += 100
        self.clock.wall -= 5000
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["age_seconds"], 100)
        self.assertEqual(self.watchdog.status()["status"], "warning")
        self.watchdog = self.load()
        self.watchdog.receive(self.payload())
        self.assertEqual(self.watchdog.status()["latest_outage"]["gap_seconds"], 100)

    def test_observer_reboot_bootstraps_wall_age_then_uses_monotonic(self):
        self.watchdog.receive(self.payload())
        self.clock.advance(60)
        self.clock.mono = 2
        watchdog = module.Watchdog(self.directory, wall=lambda: self.clock.wall,
                                   monotonic=lambda: self.clock.mono, boot_id="new-observer-boot")
        self.clock.wall += 10000
        self.clock.mono += 30
        watchdog.tick()
        self.assertEqual(watchdog.status()["age_seconds"], 90)
        self.assertEqual(watchdog.status()["status"], "warning")

    def test_private_atomic_files_and_corrupt_state(self):
        self.watchdog.receive(self.payload())
        for name in ["heartbeat.json", "watchdog-state.json", "snapshots.jsonl"]:
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertFalse(list(self.directory.glob(".watchdog-*")))
        (self.directory / "watchdog-state.json").write_text("{broken")
        with self.assertRaises(ValueError):
            self.load()

    def test_invalid_payloads_do_not_advance_heartbeat(self):
        invalid = [self.payload(host="other-host"), self.payload(timestamp=self.clock.wall - 121),
                   self.payload(timestamp=self.clock.wall + 121), self.payload(timestamp=float("nan")),
                   self.payload(metrics={"gpu_usage": float("inf")}), self.payload(metrics={"cmdline": "private"}),
                   self.payload(metrics={"gpu_usage": 10**400}), self.payload(metrics=[]), self.payload(extra=True)]
        for payload in invalid:
            with self.subTest(payload=list(payload)):
                with self.assertRaises((module.InvalidHeartbeat, ValueError)):
                    self.watchdog.receive(payload)
        self.assertIsNone(self.watchdog.status()["last_seen"])
        for encoded in [b'{"host":"qq-box","host":"other"}', b'NaN', b'\xff']:
            with self.assertRaises(module.InvalidHeartbeat):
                module.decode_heartbeat(encoded, "qq-box", self.clock.wall)

    def test_replayed_heartbeat_does_not_clear_outage(self):
        previous = self.payload()
        self.watchdog.receive(previous)
        self.clock.advance(90)
        self.watchdog.tick()
        with self.assertRaises(module.InvalidHeartbeat):
            self.watchdog.receive(previous)
        self.assertEqual(self.watchdog.status()["status"], "warning")

    def test_snapshots_sample_at_most_once_per_interval(self):
        for seconds in [0, 10, 10, 10, 10]:
            self.clock.advance(seconds)
            self.watchdog.receive(self.payload())
        lines = (self.directory / "snapshots.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("metrics", json.loads(lines[0]))

    def test_bounded_rotation_and_age_retention(self):
        archive = module.JSONLArchive(self.directory / "fixture.jsonl", max_total=600, max_file=240, days=7)
        for index in range(30):
            self.clock.advance(1)
            archive.append({"sample": index, "padding": "x" * 80}, self.clock.wall)
        self.assertLessEqual(sum(path.stat().st_size for path in archive.files()), 600)
        self.assertGreater(len(archive.files()), 1)
        self.clock.advance(7 * 86400 + 1)
        archive.prune(self.clock.wall)
        self.assertEqual(archive.files(), [])

    def test_outbox_restart_does_not_duplicate_an_appended_incident(self):
        self.watchdog.receive(self.payload())
        self.clock.advance(90)
        save = self.watchdog._save

        def interrupted_checkpoint():
            if self.watchdog.state["latest_outage"] and self.watchdog.state.get("pending_event") is None:
                raise OSError("fixture interruption after append")
            save()

        self.watchdog._save = interrupted_checkpoint
        with self.assertRaises(OSError):
            self.watchdog.tick()
        self.watchdog = self.load()
        self.watchdog.tick()
        self.assertEqual([event["event"] for event in self.events()], ["outage"])
        self.assertIsNone(self.watchdog.state.get("pending_event"))

    def test_restart_finishes_recovery_after_heartbeat_was_saved(self):
        self.watchdog.receive(self.payload())
        self.clock.advance(100)
        self.watchdog.tick()
        save = self.watchdog._save

        def interrupted_recovery():
            if (self.watchdog.state.get("pending_event") or {}).get("event") == "recovery":
                raise OSError("fixture interruption before recovery outbox save")
            save()

        self.watchdog._save = interrupted_recovery
        with self.assertRaises(OSError):
            self.watchdog.receive(self.payload())
        self.watchdog = self.load()
        self.watchdog.tick()
        self.assertEqual(self.watchdog.status()["status"], "healthy")
        self.assertEqual([event["event"] for event in self.events()], ["outage", "recovery"])
        self.assertEqual(self.watchdog.status()["latest_outage"]["gap_seconds"], 100)


class HTTPTest(Fixture):
    def setUp(self):
        super().setUp()
        self.token = "fixture-private-token"

    def request(self, method, path, body=None, authenticated=True, headers=None):
        request_headers = {"Authorization": "Bearer " + self.token} if authenticated else {}
        request_headers.update(headers or {})
        encoded = body or b""
        request_headers.setdefault("Content-Length", str(len(encoded)))
        handler = module.HeartbeatHandler.__new__(module.HeartbeatHandler)
        handler.server = SimpleNamespace(watchdog=self.watchdog, token=self.token.encode())
        handler.path = path
        handler.headers = Message()
        for key, value in request_headers.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(encoded)
        responses = []
        handler.reply = lambda code, payload: responses.append((code, payload))
        getattr(handler, "do_" + method)()
        self.assertEqual(len(responses), 1)
        return responses[0]

    def test_authentication_body_limit_and_status(self):
        body = module.json_bytes(self.payload())
        self.assertEqual(self.request("GET", "/status", authenticated=False)[0], 401)
        self.assertEqual(self.request("POST", "/heartbeat", body, headers={"Authorization": "Bearer incorrect"})[0], 401)
        self.assertEqual(self.request("POST", "/heartbeat", b" " * (module.BODY_LIMIT + 1))[0], 413)
        self.assertEqual(self.request("POST", "/heartbeat", b"NaN")[0], 400)
        self.assertEqual(self.request("POST", "/heartbeat", module.json_bytes(self.payload(timestamp=self.clock.wall - 121)))[0], 400)
        self.assertEqual(self.request("POST", "/heartbeat", body)[0], 200)
        code, status = self.request("GET", "/status")
        self.assertEqual(code, 200)
        self.assertEqual(status["status"], "healthy")
        self.assertNotIn("metrics", status)
        self.assertNotIn(self.token, json.dumps(status))
        self.assertEqual(self.request("GET", "/other")[0], 404)

    def test_http_storage_failure_is_not_acknowledged(self):
        previous = module.atomic_private_json
        try:
            module.atomic_private_json = lambda *_: (_ for _ in ()).throw(OSError("fixture disk full"))
            code, _ = self.request("POST", "/heartbeat", module.json_bytes(self.payload()))
            self.assertEqual(code, 503)
            self.assertIsNotNone(self.watchdog.status()["storage_error"])
        finally:
            module.atomic_private_json = previous


class CLITest(unittest.TestCase):
    def test_tls_pair_token_permissions_and_explicit_private_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            token.write_text("fixture-private-token\n")
            token.chmod(0o600)
            base = ["--listen", "10.99.0.66", "--token-file", str(token), "--state-dir", directory]
            self.assertEqual(module.arguments(base).port, 19997)
            invalid = [base + ["--tls-cert", "certificate"], base + ["--tls-key", str(token)],
                       base + ["--check-every", "nan"], base + ["--listen", "0.0.0.0"],
                       base + ["--listen", "8.8.8.8"], base + ["--critical-after", "80"]]
            for argv in invalid:
                with self.subTest(argv=argv[-2:]), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        module.arguments(argv)
            token.chmod(0o644)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                module.arguments(base)


if __name__ == "__main__":
    unittest.main()
