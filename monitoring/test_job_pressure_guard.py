"""Deterministic fixtures only: no live process signals or memory allocations."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("job_pressure_guard", Path(__file__).with_name("job-pressure-guard.py"))
guard_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard_module)
GIB = guard_module.GIB


class FixtureGuard(guard_module.Guard):
    def __init__(self, *args, **kwargs):
        self.fixture_clock = 0
        kwargs.setdefault("monotonic", lambda: self.fixture_clock)
        super().__init__(*args, **kwargs)

    def tick(self, now=None, dry_run=False, monotonic_now=None):
        self.fixture_clock = now if monotonic_now is None else monotonic_now
        return super().tick(now, dry_run, self.fixture_clock)


def process(pid, ppid, argv, executable="/usr/bin/node", rss=0, start=None, uid=42):
    return {"pid": pid, "ppid": ppid, "start_ticks": start or pid + 1000, "comm": Path(executable).name,
            "uid": uid, "effective_uid": uid, "rss_bytes": rss, "executable": executable,
            "argv": argv, "cgroup": "0::/user.slice/user-42.slice/user@42.service/app.slice/paseo.service", "cwd": "/project"}


def fixture(rss=5 * GIB, available=16 * GIB, psi=0):
    rows = {
        10: process(10, 1, ["codex", "app-server"], "/opt/codex/codex"),
        20: process(20, 10, ["node", "--import", "tsx", "--test", "test/practice-wraparound-choices.test.ts"]),
        30: process(30, 20, ["node", "--import", "tsx", "test/practice-wraparound-choices.test.ts"], rss=rss),
    }
    return {"processes": rows, "complete": True, "scan_processes": 3, "scan_seconds": .01,
            "host": {"memory_total_bytes": 32 * GIB, "memory_available_bytes": available,
                     "swap_total_bytes": 8 * GIB, "swap_free_bytes": 8 * GIB,
                     "memory_psi_some": psi, "memory_psi_full": 0,
                     "memory_stall_some_microseconds": 0, "memory_stall_full_microseconds": 0}}


class EligibilityTests(unittest.TestCase):
    def test_exact_prior_incident_argv_recognized_through_native_test_runner(self):
        snapshot = fixture()
        worker = snapshot["processes"][30]
        classification = guard_module.eligibility(worker, snapshot["processes"], 42)
        self.assertEqual(classification["classification"], "node-test-file-worker")
        self.assertEqual(classification["appserver_pid"], 10)
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][20], snapshot["processes"], 42))

    def test_test_words_paths_or_script_arguments_are_not_enough(self):
        for argv in (["node", "server.js", "--test"], ["node", "test"], ["node", "test/my.test.ts"]):
            snapshot = fixture()
            snapshot["processes"][30]["argv"] = argv
            snapshot["processes"][30]["ppid"] = 10
            self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))
        snapshot = fixture()
        snapshot["processes"][30]["argv"] = ["node", "persistent.js", "unrelated.test.ts"]
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_node_option_values_do_not_hide_real_native_test_flag(self):
        runner = process(1, 0, ["node", "--import", "tsx", "--require", "fixture", "--test", "test.js"])
        self.assertTrue(guard_module.node_test_runner(runner))
        runner["argv"] = ["node", "--import", "tsx", "server.js", "--test"]
        self.assertFalse(guard_module.node_test_runner(runner))

    def test_value_options_cannot_disguise_daemon_script_as_test_worker(self):
        for option in ("--title", "--redirect-warnings", "--icu-data-dir", "--unknown-future-value-option"):
            snapshot = fixture()
            snapshot["processes"][30]["argv"] = ["node", option, "test/harness.test.ts", "/opt/paseo/daemon.js"]
            self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_equal_form_v8_flags_and_import_preserve_exact_incident_recognition(self):
        snapshot = fixture()
        snapshot["processes"][30]["argv"] = ["node", "--max-old-space-size=16384", "--stack_size=1024",
                                               "--import", "tsx", "test/practice-wraparound-choices.test.ts"]
        self.assertEqual(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42)["classification"], "node-test-file-worker")

    def test_full_captured_node_26_worker_defaults_match_actual_runaway(self):
        snapshot = fixture()
        snapshot["processes"][30]["argv"] = [
            "node", "--test-coverage-functions=0", "--test-concurrency=2", "--experimental-addon-modules",
            "--inspect-publish-uid=stderr,http", "--inspect-port=127.0.0.1:9229", "--stack-trace-limit=10",
            "--report-signal=SIGUSR2", "--test-coverage-lines=0", "--test-isolation=process", "--heap-prof-interval=524288",
            "--cpu-prof-interval=1000", "--import=tsx", "--trace-event-file-pattern=node_trace.${rotation}.log",
            "--secure-heap-min=2", "--test-coverage-branches=0", "--tls-cipher-list=CAPTURED_PUBLIC_TLS_CIPHER_LIST",
            "--max-http-header-size=16384", "--use-largepages=off", "--test-timeout=0", "--node-snapshot",
            "--secure-heap=0", "--watch-kill-signal=SIGTERM", "--v8-pool-size=4",
            "--network-family-autoselection-attempt-timeout=500", "--heapsnapshot-near-heap-limit=0", "--import", "tsx",
            "test/practice-wraparound-choices.test.ts",
        ]
        classification = guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42)
        self.assertEqual(classification["classification"], "node-test-file-worker")

    def test_trailing_script_arguments_make_native_file_worker_ambiguous(self):
        snapshot = fixture()
        snapshot["processes"][30]["argv"] += ["server.js"]
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_watch_or_server_roles_rejected(self):
        for flag in ("--watch", "--watchAll", "--listen=8080", "dev", "app-server", "--inspect"):
            snapshot = fixture()
            snapshot["processes"][20]["argv"].append(flag)
            self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_studios_daemons_browsers_emulators_compilers_not_eligible(self):
        for executable in ("/usr/bin/codex", "/opt/studio/studio", "/usr/bin/qemu-system-x86_64",
                           "/usr/bin/rustc", "/usr/bin/cargo", "/usr/bin/chromium", "/usr/bin/ardour"):
            snapshot = fixture()
            worker = snapshot["processes"][30]
            worker["executable"] = executable
            self.assertIsNone(guard_module.eligibility(worker, snapshot["processes"], 42))
        snapshot = fixture()
        snapshot["processes"][30]["argv"] = ["node", "/opt/paseo/daemon.js"]
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_no_codex_ancestor_or_different_uid_rejected(self):
        snapshot = fixture()
        snapshot["processes"][10]["argv"] = ["codex", "unrelated"]
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))
        snapshot = fixture()
        snapshot["processes"][30]["uid"] = 99
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_any_child_process_excludes_parent_runner_from_signals(self):
        snapshot = fixture()
        snapshot["processes"][40] = process(40, 30, ["studio"], "/opt/studio/studio")
        self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))

    def test_known_jest_and_vitest_worker_require_corresponding_runner(self):
        cases = (
            (["node", "/project/node_modules/jest/bin/jest.js"], ["node", "/project/node_modules/jest-worker/build/workers/processChild.js"], "jest-worker"),
            (["node", "/project/node_modules/vitest/vitest.mjs", "run"], ["node", "/project/node_modules/tinypool/dist/entry/process.js"], "vitest-worker"),
        )
        for runner, worker, expected in cases:
            snapshot = fixture()
            snapshot["processes"][20]["argv"], snapshot["processes"][30]["argv"] = runner, worker
            self.assertEqual(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42)["classification"], expected)
            snapshot["processes"][20]["argv"] = ["node", "generic-build.js"]
            self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))


class InterventionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.policy = copy.deepcopy(guard_module.DEFAULT_POLICY)
        self.policy["state_directory"] = self.temporary.name
        self.snapshot = fixture()
        self.signals, self.opens = [], []
        self.guard = FixtureGuard(self.policy, uid=42, scanner=lambda: copy.deepcopy(self.snapshot),
                                        pidfd_open=self.open_pidfd, sender=self.send)
        self.addCleanup(self.guard.close)

    def open_pidfd(self, pid, flags):
        self.opens.append(pid)
        return os.open("/dev/null", os.O_RDONLY)

    def send(self, fd, signum, siginfo, flags):
        self.signals.append((self.opens[-1], signum))

    def incidents(self):
        return [json.loads(path.read_text()) for path in (Path(self.temporary.name) / "incidents").glob("*.json")]

    def test_budget_catches_two_samples_even_with_abundant_ram_and_no_psi(self):
        self.guard.tick(100)
        self.assertEqual(self.signals, [])
        self.guard.tick(101)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.guard.tick(103)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.guard.tick(104)
        self.assertEqual(self.signals, [(30, signal.SIGTERM), (30, signal.SIGKILL)])
        self.assertEqual(len(self.incidents()), 1)
        self.assertEqual(self.incidents()[0]["evidence"]["intervention_reason"], "rss_budget")

    def test_transient_growth_duplicate_tick_and_partial_scan_do_not_signal(self):
        self.guard.tick(100)
        self.guard.tick(100)
        self.assertEqual(self.signals, [])
        self.snapshot["processes"][30]["rss_bytes"] = GIB
        self.guard.tick(101)
        self.snapshot["processes"][30]["rss_bytes"] = 5 * GIB
        self.guard.tick(102)
        self.snapshot["complete"] = False
        self.guard.tick(103)
        self.assertEqual(self.signals, [])

    def test_kill_skipped_when_worker_releases_memory_or_makes_progress(self):
        self.guard.tick(100)
        self.guard.tick(101)
        self.snapshot["processes"][30]["rss_bytes"] = int(4.4 * GIB)
        self.guard.tick(104)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.assertIn("meaningfully decreased", self.incidents()[0]["evidence"]["outcome"])

    def test_pressure_requires_memory_stalls_and_reserve_shortage(self):
        self.snapshot = fixture(rss=GIB, available=GIB, psi=0)
        self.guard.tick(100)
        self.guard.tick(101)
        self.assertEqual(self.signals, [])
        self.snapshot["host"]["memory_psi_some"] = 20
        self.guard.tick(102)
        self.guard.tick(103)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.snapshot["host"]["memory_available_bytes"] = 16 * GIB
        self.guard.tick(106)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])

    def test_pid_reuse_after_pidfd_open_prevents_signal(self):
        original_open = self.guard.pidfd_open

        def reused(pid, flags):
            fd = original_open(pid, flags)
            self.snapshot["processes"][30]["start_ticks"] += 1
            return fd

        self.guard.pidfd_open = reused
        self.guard.tick(100)
        self.guard.tick(101)
        self.assertEqual(self.signals, [])
        self.assertIn("skipped", self.incidents()[0]["evidence"]["outcome"])

    def test_revalidation_checks_executable_cgroup_lineage_and_budget(self):
        for key, value in (("executable", "/usr/bin/other"), ("cgroup", "0::/different"), ("ppid", 1), ("rss_bytes", GIB)):
            self.snapshot = fixture()
            guard = FixtureGuard(self.policy, uid=42, scanner=lambda: copy.deepcopy(self.snapshot), sender=self.send,
                                        pidfd_open=self.open_pidfd)
            guard.tick(100)
            original_open = guard.pidfd_open

            def changed(pid, flags):
                fd = original_open(pid, flags)
                self.snapshot["processes"][30][key] = value
                return fd

            guard.pidfd_open = changed
            guard.tick(101)
            guard.close()
        self.assertEqual(self.signals, [])

    def test_incidents_private_no_arguments_or_environment_and_quiet_resolution(self):
        self.snapshot["processes"][30]["argv"][1:1] = ["--title", "SECRET_TOKEN_DO_NOT_WRITE"]
        self.guard.tick(100)
        self.guard.tick(101)
        path = next((Path(self.temporary.name) / "incidents").glob("*.json"))
        self.assertNotIn("SECRET_TOKEN_DO_NOT_WRITE", path.read_text())
        self.assertNotIn('"argv"', path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.snapshot["processes"].pop(30)
        self.guard.tick(102)
        self.guard.tick(703)
        self.assertEqual(self.incidents()[0]["status"], "resolved")

    def test_operator_cwd_budget_exception(self):
        self.policy["rss_limits_by_cwd"] = {"/project": 8 * GIB}
        self.guard.tick(100)
        self.guard.tick(101)
        self.assertEqual(self.signals, [])

    def test_dry_run_does_not_signal_or_create_intervention(self):
        self.guard.tick(100, dry_run=True)
        result = self.guard.tick(101, dry_run=True)
        self.assertEqual(result["eligible_triggers"], 1)
        self.assertEqual(self.signals, [])
        self.assertEqual(self.incidents(), [])

    def test_incomplete_post_term_scan_retains_pidfd_and_defers_escalation(self):
        self.guard.tick(100)
        self.guard.tick(101)
        held = self.guard.pending["pidfd"]
        self.snapshot["complete"] = False
        self.guard.tick(104)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.assertEqual(self.guard.pending["pidfd"], held)
        self.assertIn("scan incomplete", self.incidents()[0]["evidence"]["outcome"])
        self.snapshot["complete"] = True
        self.guard.tick(105)
        self.assertEqual(self.signals, [(30, signal.SIGTERM), (30, signal.SIGKILL)])

    def test_wall_clock_jump_cannot_shorten_grace_or_cooldown(self):
        self.guard.tick(100, monotonic_now=1)
        self.guard.tick(101, monotonic_now=2)
        self.guard.tick(10000, monotonic_now=3)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.guard.tick(10001, monotonic_now=5)
        self.assertEqual(self.signals, [(30, signal.SIGTERM), (30, signal.SIGKILL)])
        self.guard.tick(20000, monotonic_now=6)
        self.guard.tick(20001, monotonic_now=7)
        self.assertEqual(len(self.signals), 2)

    def test_slow_signal_path_does_not_consume_worker_grace_period(self):
        def slow_send(fd, signum, siginfo, flags):
            self.signals.append((self.opens[-1], signum))
            if signum == signal.SIGTERM:
                self.guard.fixture_clock += 4

        self.guard.sender = slow_send
        self.guard.tick(100)
        self.guard.tick(101)
        self.guard.tick(106)
        self.assertEqual(self.signals, [(30, signal.SIGTERM)])
        self.guard.tick(108)
        self.assertEqual(self.signals, [(30, signal.SIGTERM), (30, signal.SIGKILL)])


class ManagedBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.policy = copy.deepcopy(guard_module.DEFAULT_POLICY)
        self.snapshot = fixture(rss=6 * GIB)
        self.worker = self.snapshot["processes"][30]
        self.path = "/user.slice/user-42.slice/user@42.service/qqjobs.slice/qq-job-11111111222233334444555555555555.scope"
        self.worker["cgroup"] = "0::" + self.path
        self.leaf = self.root / self.path.lstrip("/")
        self.leaf.mkdir(parents=True)
        for directory, memory, swap in ((self.leaf, 8 * GIB, GIB // 2), (self.leaf.parent, 12 * GIB, GIB)):
            (directory / "memory.max").write_text(str(memory))
            (directory / "memory.swap.max").write_text(str(swap))

    def test_finite_managed_profile_disables_fallback_rss_budget(self):
        budget = guard_module.managed_budget(self.worker, self.policy, self.root)
        self.assertEqual(budget["job_memory_max_bytes"], 8 * GIB)
        self.worker["managed_budget"] = budget
        self.assertIsNone(guard_module.rss_budget(self.worker, self.policy))

    def test_canonical_hyphenated_uuid_scope_also_accepted(self):
        canonical = self.path.replace("11111111222233334444555555555555", "11111111-2222-3333-4444-555555555555")
        self.leaf.rename(self.root / canonical.lstrip("/"))
        self.worker["cgroup"] = "0::" + canonical
        self.assertIsNotNone(guard_module.managed_budget(self.worker, self.policy, self.root))

    def test_managed_looking_name_with_unlimited_missing_or_oversized_limits_gets_fallback(self):
        for value in ("max", str(13 * GIB), "not-a-number"):
            (self.leaf / "memory.max").write_text(value)
            self.assertIsNone(guard_module.managed_budget(self.worker, self.policy, self.root))
        (self.leaf / "memory.max").write_text(str(8 * GIB))
        (self.leaf.parent / "memory.swap.max").unlink()
        self.assertIsNone(guard_module.managed_budget(self.worker, self.policy, self.root))

    def test_path_escape_alias_or_other_user_not_accepted(self):
        for path in (self.path + "/../other", self.path.replace("user-42", "user-99"), self.path.replace("qqjobs.slice", "qqjobs.slice/..")):
            self.worker["cgroup"] = "0::" + path
            self.assertIsNone(guard_module.managed_budget(self.worker, self.policy, self.root))
        self.worker["cgroup"] = "0::" + self.path.replace("11111111222233334444555555555555", "------------------------------------")
        self.assertIsNone(guard_module.managed_budget(self.worker, self.policy, self.root))

    def test_guard_respects_actual_eight_gib_managed_job_profile(self):
        self.policy["state_directory"] = str(self.root / "state")
        signals = []
        guard = FixtureGuard(self.policy, uid=42, scanner=lambda: copy.deepcopy(self.snapshot), cgroup_root=self.root,
                                  pidfd_open=lambda *_: os.open("/dev/null", os.O_RDONLY), sender=lambda *args: signals.append(args))
        self.addCleanup(guard.close)
        guard.tick(100)
        result = guard.tick(101)
        self.assertEqual(signals, [])
        self.assertEqual(result["managed_workers"][0]["budget"]["job_memory_max_bytes"], 8 * GIB)
        (self.leaf / "memory.max").write_text("max")
        guard.tick(102)
        guard.tick(103)
        self.assertEqual(len(signals), 1)


class QuotaBudgetTests(unittest.TestCase):
    def test_focused_revalidation_checks_every_worker_thread_for_child_processes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = fixture()["processes"]
            (root / "1").mkdir()
            (root / "1/comm").write_text("systemd\n")
            for pid, row in rows.items():
                base = root / str(pid)
                base.mkdir()
                fields = ["R", str(row["ppid"])] + ["0"] * 17 + [str(row["start_ticks"])]
                (base / "stat").write_text(str(pid) + " (" + row["comm"] + ") " + " ".join(fields))
                (base / "status").write_text("Uid:\t42\t42\t42\t42\nVmRSS:\t" + str(row["rss_bytes"] // 1024) + " kB\n")
                (base / "cmdline").write_bytes(b"\0".join(word.encode() for word in row["argv"]))
                (base / "exe").symlink_to(row["executable"])
                (base / "cwd").symlink_to("/project")
                (base / "cgroup").write_text(row["cgroup"])
            (root / "30/task/30").mkdir(parents=True)
            (root / "30/task/30/children").write_text("")
            (root / "30/task/31").mkdir()
            (root / "30/task/31/children").write_text("")
            policy = copy.deepcopy(guard_module.DEFAULT_POLICY)
            with patch.object(guard_module, "read_host", return_value=fixture()["host"]):
                snapshot = guard_module.target_snapshot(root, 30, policy, 42)
                self.assertTrue(snapshot["complete"])
                self.assertIsNotNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))
                (root / "30/task/31/children").write_text("40 ")
                snapshot = guard_module.target_snapshot(root, 30, policy, 42)
                self.assertIsNone(guard_module.eligibility(snapshot["processes"][30], snapshot["processes"], 42))
                (root / "30/task/31/children").unlink()
                snapshot = guard_module.target_snapshot(root, 30, policy, 42)
                self.assertFalse(snapshot["complete"])

    def test_full_scan_survives_throttled_wall_time_without_unbounding_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for pid in (1, 20, 30):
                (root / str(pid)).mkdir()
            (root / "1/comm").write_text("systemd\n")
            policy = copy.deepcopy(guard_module.DEFAULT_POLICY)
            rows = fixture()["processes"]
            rows[1] = process(1, 0, ["systemd"], "/usr/lib/systemd/systemd", uid=0)
            elapsed = iter((0, .3, .5, .6, .65))
            with patch.object(guard_module, "process_info", side_effect=lambda _proc, pid, _uid: rows.get(pid)), patch.object(guard_module, "read_host", return_value=fixture()["host"]):
                snapshot = guard_module.scan(root, policy, uid=42, monotonic=lambda: next(elapsed))
            self.assertEqual(snapshot["scan_processes"], 3)
            self.assertAlmostEqual(snapshot["scan_seconds"], .65)
            self.assertTrue(snapshot["complete"])
            policy["scan_budget_seconds"] = .25
            elapsed = iter((0, .3, .31))
            with patch.object(guard_module, "process_info", side_effect=lambda _proc, pid, _uid: rows.get(pid)), patch.object(guard_module, "read_host", return_value=fixture()["host"]):
                incomplete = guard_module.scan(root, policy, uid=42, monotonic=lambda: next(elapsed))
            self.assertFalse(incomplete["complete"])
            self.assertEqual(incomplete["scan_processes"], 0)


class HealthReportingTests(unittest.TestCase):
    def test_health_transitions_heartbeat_and_age_without_extra_sampling(self):
        reporter = guard_module.HealthReporter()
        report = reporter.update({"scan_complete": False, "scan_processes": 312, "scan_seconds": .757}, False, 100)
        self.assertIsNone(report["last_complete_age_seconds"])
        self.assertFalse(report["scan_complete"])
        report = reporter.update({"scan_complete": True, "scan_processes": 611, "scan_seconds": .034}, False, 101)
        self.assertEqual(report["last_complete_age_seconds"], 0)
        self.assertIsNone(reporter.update({"scan_complete": True, "scan_processes": 611, "scan_seconds": .033}, False, 102))
        report = reporter.update({"pending": True}, True, 103)
        self.assertTrue(report["pending"])
        self.assertEqual(report["last_complete_age_seconds"], 1)
        self.assertIsNone(reporter.update({"pending": True}, True, 104))
        report = reporter.update({"pending": True}, True, 133)
        self.assertEqual(report["last_complete_age_seconds"], 31)
        self.assertEqual(set(report), {"event", "scan_complete", "scan_processes", "scan_seconds", "pending", "last_complete_age_seconds"})


if __name__ == "__main__":
    unittest.main()
