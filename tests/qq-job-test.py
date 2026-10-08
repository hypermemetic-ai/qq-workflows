#!/usr/bin/env python3
"""Bounded launcher tests. No systemd units are started.

One tiny subprocess proves inheritable-pipe handling by reading seven bytes.

The separate operator-run live proof uses --profile oom-proof for a disposable
ArrayBuffer allocation, then checks that the unit and its descendants are gone.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("qq_job", Path(__file__).resolve().parents[1] / "scripts/qq-job.py")
JOB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JOB)
UNIT = "qq-job-" + "1" * 32 + ".scope"


class JobTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.policy = copy.deepcopy(JOB.DEFAULT_POLICY)
        self.policy["state_dir"] = str(self.directory / "state")
        self.policy["monitor_state_dir"] = str(self.directory / "monitor")
        self.profile = self.policy["profiles"]["default"]

    def cgroup(self, unit=UNIT):
        aggregate = self.directory / "cgroup" / "qqjobs.slice"
        path = aggregate / unit
        path.mkdir(parents=True, exist_ok=True)
        for filename, setting in [("memory.high", "memory_high_bytes"),
                                  ("memory.max", "memory_max_bytes"),
                                  ("memory.swap.max", "memory_swap_max_bytes")]:
            (path / filename).write_text(str(self.profile[setting]))
            (aggregate / filename).write_text(str(self.policy["aggregate"][setting]))
        for filename, value in {"pids.max": self.profile["tasks_max"], "cpu.weight": 50,
                                "memory.oom.group": 1, "cgroup.events": "populated 0\nfrozen 0\n"}.items():
            (path / filename).write_text(str(value))
        return path

    def record(self, unit=UNIT):
        record = {"unit": unit, "cwd": "/private/project", "executable": "/usr/bin/node",
                  "profile": "default", "limits": self.profile, "status": "starting",
                  "scope_start_requested": False}
        JOB.atomic_json(JOB.job_record_path(self.policy, unit), record)
        return record

    def fake_bus(self, calls):
        class Bus:
            def start_scope(self, unit, properties):
                calls.append((unit, properties))

            def close(self):
                calls.append("closed")
        return Bus

    def test_default_budgets_and_explicit_small_proof(self):
        JOB.validate_policy(self.policy)
        self.assertEqual(self.profile["memory_max_bytes"], 4 * JOB.GIB)
        self.assertEqual(self.profile["memory_swap_max_bytes"], 256 * JOB.MIB)
        self.assertEqual(self.policy["profiles"]["oom-proof"]["memory_max_bytes"], 64 * JOB.MIB)
        self.assertEqual(self.policy["profiles"]["oom-proof"]["memory_high_bytes"], 64 * JOB.MIB)
        self.assertEqual(self.policy["profiles"]["oom-proof"]["memory_swap_max_bytes"], 0)

    def test_profile_increases_require_operator_configuration(self):
        with self.assertRaisesRegex(JOB.ContainmentError, "not approved"):
            JOB.profile_for(self.policy, "unapproved-large")
        self.policy["profiles"]["larger"] = dict(self.profile, memory_max_bytes=6 * JOB.GIB)
        JOB.validate_policy(self.policy)
        self.assertEqual(JOB.profile_for(self.policy, "larger")[1]["memory_max_bytes"], 6 * JOB.GIB)

    def test_policy_refuses_unlimited_and_above_aggregate_budgets(self):
        for value in ["max", True, 0, -1, 2 ** 64]:
            with self.subTest(value=value):
                policy = copy.deepcopy(self.policy)
                policy["profiles"]["default"]["memory_max_bytes"] = value
                with self.assertRaises(JOB.ContainmentError):
                    JOB.validate_policy(policy)
        self.profile["memory_swap_max_bytes"] = 2 * JOB.GIB
        with self.assertRaisesRegex(JOB.ContainmentError, "aggregate"):
            JOB.validate_policy(self.policy)

    def test_operator_policy_rejects_group_write(self):
        path = self.directory / "policy.json"
        path.write_text(json.dumps(self.policy))
        path.chmod(0o660)
        with self.assertRaisesRegex(JOB.ContainmentError, "operator-owned"):
            JOB.load_policy(path)
        path.chmod(0o600)
        self.assertEqual(JOB.load_policy(path)["slice"], "qqjobs.slice")

    def test_sender_pid_is_zero_even_in_a_pid_namespace(self):
        with mock.patch.object(JOB.os, "getpid", return_value=3):
            properties = JOB.scope_properties(self.policy, self.profile)
        self.assertIn(("PIDs", "au", [0]), properties)
        self.assertIn(("OOMPolicy", "s", "kill"), properties)
        names = [row[0] for row in properties]
        self.assertNotIn("ExecStart", names)
        self.assertNotIn("CPUQuotaPerSecUSec", names)
        self.assertNotIn("IOWeight", names)

    def test_verified_gate_executes_literal_arguments_with_caller_environment(self):
        calls, execution = [], []
        path = self.cgroup()
        self.record()
        cwd = os.getcwd()
        command = ["/bin/echo", "$HOME", "a b", "$(touch /tmp/never-created)"]
        with mock.patch.dict(os.environ, {"QQ_JOB_TEST_SENTINEL": "preserved"}):
            JOB.child_gate(UNIT, "default", command, self.policy, self.fake_bus(calls),
                           lambda: path, lambda *args: execution.append(args))
        self.assertEqual(os.getcwd(), cwd)
        self.assertEqual(execution[0][:2], (command[0], command))
        self.assertEqual(execution[0][2]["QQ_JOB_TEST_SENTINEL"], "preserved")
        self.assertEqual(calls[0][0], UNIT)
        self.assertEqual(calls[-1], "closed")
        self.assertEqual(JOB.bounded_json(JOB.job_record_path(self.policy, UNIT))["status"], "running")

    def test_gate_never_executes_when_kernel_limits_are_missing_or_unlimited(self):
        path = self.cgroup()
        self.record()
        for broken in ["max", str(self.profile["memory_max_bytes"] + 1), None]:
            with self.subTest(broken=broken):
                limit = path / "memory.max"
                limit.unlink(missing_ok=True)
                if broken is not None:
                    limit.write_text(broken)
                execute = mock.Mock()
                with self.assertRaises(JOB.ContainmentError):
                    JOB.child_gate(UNIT, "default", ["/bin/true"], self.policy,
                                   self.fake_bus([]), lambda: path, execute)
                execute.assert_not_called()

    def test_gate_never_executes_if_scope_attachment_is_denied(self):
        self.record()
        execute = mock.Mock()
        bus = mock.Mock()
        bus.start_scope.side_effect = JOB.ContainmentError("sandbox denied bus access")
        with self.assertRaisesRegex(JOB.ContainmentError, "sandbox denied"):
            JOB.child_gate(UNIT, "default", ["/bin/true"], self.policy, lambda: bus,
                           lambda: self.cgroup(), execute)
        execute.assert_not_called()
        bus.close.assert_called_once()
        record = JOB.bounded_json(JOB.job_record_path(self.policy, UNIT))
        self.assertEqual(record["status"], "starting")
        self.assertTrue(record["scope_start_requested"])
        with self.assertRaisesRegex(JOB.ContainmentError, "capacity"):
            JOB.prune_records(JOB.job_record_path(self.policy, UNIT).parent, 0)

    def test_bus_connection_denial_is_durably_refused_and_reclaimable(self):
        self.record()
        execute = mock.Mock()
        connect = mock.Mock(side_effect=PermissionError("sandbox denied bus connection"))
        with self.assertRaisesRegex(PermissionError, "denied bus connection"):
            JOB.child_gate(UNIT, "default", ["/bin/true"], self.policy, connect, execute=execute)
        execute.assert_not_called()
        record_path = JOB.job_record_path(self.policy, UNIT)
        record = JOB.bounded_json(record_path)
        self.assertEqual(record["status"], "refused")
        self.assertEqual(record["refusal_phase"], "before_start")
        self.assertIs(record["scope_start_requested"], False)
        self.assertEqual(record["exit_status"], JOB.FAILURE)
        self.assertEqual(JOB.prune_records(record_path.parent, 0), 0)
        self.assertFalse(record_path.exists())

    def test_parent_completes_pre_start_refusal_without_manager_access(self):
        policy = self.policy

        class RefusedChild:
            def __init__(self, argv, **kwargs):
                unit = argv[3]
                path = JOB.job_record_path(policy, unit)
                record = JOB.bounded_json(path)
                record.update(status="refused", refusal_phase="before_start",
                              scope_start_requested=False, exit_status=JOB.FAILURE)
                JOB.atomic_json(path, record)

            def poll(self):
                return JOB.FAILURE

            def wait(self):
                return JOB.FAILURE

        with mock.patch.object(JOB, "control_unit", side_effect=JOB.ContainmentError("manager access denied")) as control:
            self.assertEqual(JOB.launch(["/bin/true"], policy, popen=RefusedChild), JOB.FAILURE)
        control.assert_not_called()
        record = JOB.status_report(policy)["jobs"][0]
        self.assertEqual(record["status"], "refused")
        self.assertEqual(record["exit_status"], JOB.FAILURE)

    def test_gate_requires_aggregate_and_group_oom_limits(self):
        path = self.cgroup()
        (path.parent / "memory.max").write_text("max")
        with self.assertRaises(JOB.ContainmentError):
            JOB.verify_limits(path, UNIT, self.policy, self.profile)
        (path.parent / "memory.max").write_text(str(self.policy["aggregate"]["memory_max_bytes"]))
        (path / "memory.oom.group").write_text("0")
        with self.assertRaisesRegex(JOB.ContainmentError, "group OOM"):
            JOB.verify_limits(path, UNIT, self.policy, self.profile)

    def test_only_own_unique_units_can_be_controlled(self):
        with mock.patch.object(JOB.subprocess, "run") as run:
            with self.assertRaisesRegex(JOB.ContainmentError, "non-job"):
                JOB.control_unit("paseo.service", "stop")
            run.assert_not_called()

    def test_cgroup_path_rejects_escape_and_requires_v2(self):
        proc, mount = self.directory / "proc", self.directory / "mount"
        (proc / "self").mkdir(parents=True)
        for content in ["1:memory:/job\n", "0::/../escaped\n"]:
            (proc / "self/cgroup").write_text(content)
            with self.assertRaises(JOB.ContainmentError):
                JOB.cgroup_path(proc, mount)
        (proc / "self/cgroup").write_text("0::/user.slice/qqjobs.slice/" + UNIT + "\n")
        self.assertEqual(JOB.cgroup_path(proc, mount), mount / "user.slice/qqjobs.slice" / UNIT)

    def test_shell_string_is_passed_once_without_requoting(self):
        command = "printf '%s' '$HOME'; exit 19"
        self.assertEqual(JOB.shell_argv(command), ["/bin/bash", "-lc", command])
        self.assertEqual(JOB.shell_argv(command, "/bin/zsh", False), ["/bin/zsh", "-c", command])
        with self.assertRaises(JOB.ContainmentError):
            JOB.shell_argv(command, "bash")

    def test_launch_preserves_exit_stream_inheritance_and_fast_command_record(self):
        self.assert_launch_result(23, 23)

    def test_launch_preserves_signal_status_and_forwards_before_attachment(self):
        self.assert_launch_result(-signal.SIGTERM, 128 + signal.SIGTERM, early_signal=True)

    def test_gate_launch_preserves_an_inheritable_pipe(self):
        # Exercise an actual inheritable descriptor, as used by make's jobserver.
        # The fixture child reads a fixed seven bytes and exits; no scope starts.
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, read_fd)
        os.set_inheritable(read_fd, True)
        os.write(write_fd, b"literal")
        os.close(write_fd)

        def spawn(argv, **kwargs):
            self.assertEqual(kwargs, {"close_fds": False})
            unit = argv[3]
            path = self.cgroup(unit)
            record_path = JOB.job_record_path(self.policy, unit)
            record = JOB.bounded_json(record_path)
            record.update(status="running", cgroup=str(path))
            JOB.atomic_json(record_path, record)
            return subprocess.Popen([sys.executable, "-c",
                                     "import os,sys; sys.exit(0 if os.read(int(sys.argv[1]),7)==b'literal' else 7)",
                                     str(read_fd)], **kwargs)

        with mock.patch.object(JOB, "control_unit", return_value=subprocess.CompletedProcess([], 0, "Result=success\n", "")):
            self.assertEqual(JOB.launch(["/fixture"], self.policy, popen=spawn), 0)

    def assert_launch_result(self, child_status, expected, early_signal=False):
        calls, controls, sent = [], [], []
        policy = self.policy
        fixture = self.cgroup

        class Child:
            def __init__(self, argv, *, close_fds):
                self_test.assertIs(close_fds, False)
                calls.append(argv)
                unit = argv[3]
                path = fixture(unit)
                record_path = JOB.job_record_path(policy, unit)
                record = JOB.bounded_json(record_path)
                record.update(status="running", cgroup=str(path))
                JOB.atomic_json(record_path, record)
                self.first = True
                self.forwarding = False

            def poll(self):
                if early_signal and self.first:
                    self.first = False
                    self.forwarding = True
                    signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                    self.forwarding = False
                if self.forwarding:
                    return None
                return child_status

            def wait(self):
                return child_status

            def send_signal(self, number):
                sent.append(number)

        def control(unit, *args):
            controls.append((unit, args))
            return subprocess.CompletedProcess([], 1 if args[0] == "kill" else 0,
                                               "Result=success\nMemoryPeak=123\n", "not loaded" if args[0] == "kill" else "")

        # Reentrant poll from signal forwarding must not emit the same signal.
        self_test = self
        command = ["/bin/echo", "literal $HOME", "two words"]
        with mock.patch.object(JOB, "control_unit", side_effect=control):
            result = JOB.launch(command, policy, popen=Child)
        self.assertEqual(result, expected)
        self.assertEqual(calls[0][7:], command)
        self.assertIn((calls[0][3], ("stop",)), controls)
        rows = JOB.status_report(policy)["jobs"]
        self.assertEqual(rows[0]["status"], "finished")
        self.assertEqual(rows[0]["exit_status"], expected)
        if early_signal:
            self.assertEqual(sent, [signal.SIGTERM])

    def test_cleanup_detects_remaining_descendants(self):
        path = self.cgroup()
        (path / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        with mock.patch.object(JOB, "control_unit", return_value=subprocess.CompletedProcess([], 0, "", "")), \
             mock.patch.object(JOB.time, "monotonic", side_effect=[0, 4]):
            with self.assertRaisesRegex(JOB.ContainmentError, "descendants remain"):
                JOB.cleanup_scope(UNIT, path)

    def test_oom_incident_is_private_bounded_and_excludes_arguments_and_environment(self):
        self.policy["max_job_records"] = 1
        record = self.record()
        record.update(argv=["SECRET_ARGUMENT"], environment={"token": "SECRET_ENV"})
        JOB.record_oom(self.policy, record, {"events": {"oom_kill": 1}}, "oom-kill")
        directory = self.directory / "monitor/incidents"
        path = next(directory.glob("*.json"))
        text = path.read_text()
        self.assertNotIn("SECRET", text)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        record["unit"] = "qq-job-" + "2" * 32 + ".scope"
        JOB.record_oom(self.policy, record, {}, "oom-kill")
        self.assertEqual(len(list(directory.glob("*.json"))), 1)

    def test_normal_failure_is_not_reported_as_oom(self):
        JOB.record_oom(self.policy, self.record(), {}, "exit-code")
        self.assertFalse((self.directory / "monitor/incidents").exists())

    def test_pruning_keeps_running_jobs_and_newest_completed_records(self):
        path = JOB.job_record_path(self.policy, UNIT)
        for number, status in [(1, "finished"), (2, "finished"), (3, "running")]:
            unit = "qq-job-" + str(number) * 32 + ".scope"
            JOB.atomic_json(path.parent / (unit + ".json"), {"status": status, "finished_at": number})
        JOB.prune_records(path.parent, 2)
        self.assertEqual(len(list(path.parent.glob("*.json"))), 2)

    def test_prior_boot_records_are_reclaimed_even_when_status_is_running(self):
        path = JOB.job_record_path(self.policy, UNIT)
        prior = "00000000-0000-0000-0000-000000000001"
        current = "00000000-0000-0000-0000-000000000002"
        JOB.atomic_json(path, {"status": "running", "boot_id": prior})
        self.assertEqual(JOB.prune_records(path.parent, 0, current), 0)
        self.assertFalse(path.exists())

    def test_full_live_record_registry_refuses_before_spawning_and_preserves_records(self):
        self.policy["max_job_records"] = 1
        record = self.record()
        record.update(status="running", boot_id=JOB.boot_id())
        path = JOB.job_record_path(self.policy, UNIT)
        JOB.atomic_json(path, record)
        spawn = mock.Mock()
        with self.assertRaisesRegex(JOB.ContainmentError, "capacity"):
            JOB.launch(["/bin/true"], self.policy, popen=spawn)
        spawn.assert_not_called()
        self.assertEqual(JOB.bounded_json(path), record)
        self.assertEqual(len(list(path.parent.glob("*.json"))), 1)

    def test_unknown_records_also_consume_capacity(self):
        path = JOB.job_record_path(self.policy, UNIT)
        path.write_text("not valid JSON")
        with self.assertRaisesRegex(JOB.ContainmentError, "capacity"):
            JOB.prune_records(path.parent, 0)
        self.assertEqual(path.read_text(), "not valid JSON")

    def test_new_records_include_boot_identifier_and_reclaim_completed_capacity(self):
        self.policy["max_job_records"] = 1
        path = JOB.job_record_path(self.policy, UNIT)
        JOB.atomic_json(path, {"status": "finished", "boot_id": JOB.boot_id(), "finished_at": 1})
        unit = "qq-job-" + "2" * 32 + ".scope"
        new_path = JOB.create_job_record(self.policy, unit, {"status": "starting", "boot_id": JOB.boot_id()})
        self.assertFalse(path.exists())
        self.assertEqual(JOB.bounded_json(new_path)["boot_id"], JOB.boot_id())
        self.assertEqual(len(list(path.parent.glob("*.json"))), 1)

    def test_atomic_record_fsyncs_file_then_parent_directory(self):
        path = self.directory / "record.json"
        observed = []
        actual = os.fsync

        def sync(fd):
            observed.append("directory" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
            actual(fd)

        with mock.patch.object(JOB.os, "fsync", side_effect=sync):
            JOB.atomic_json(path, {"durable": True})
        self.assertEqual(observed, ["file", "directory"])
        self.assertEqual(JOB.bounded_json(path), {"durable": True})

    def test_dry_run_never_spawns_and_does_not_disclose_arguments(self):
        out = io.StringIO()
        with mock.patch.object(JOB, "load_policy", return_value=self.policy), \
             mock.patch.object(JOB, "launch") as launch, contextlib.redirect_stdout(out):
            self.assertEqual(JOB.main(["--dry-run", "--", "/bin/echo", "SECRET_ARGUMENT"]), 0)
        launch.assert_not_called()
        self.assertNotIn("SECRET_ARGUMENT", out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["mode"], "sandbox-preserving-scope")


if __name__ == "__main__":
    unittest.main()
