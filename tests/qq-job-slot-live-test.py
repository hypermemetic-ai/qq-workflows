#!/usr/bin/env python3
"""Live qq-job routing through the real slot script.

Each test starts a few tiny jobs (true, cut, sleep) through slot with a private
queue (SLOT_DIR in a temporary directory, SLOT_COUNT=1), so the shared slots
are never taken (SLOT_KINDS keeps slot's history private too); the jobs still
get real scopes in app-slot.slice. Run as the desktop user with
XDG_RUNTIME_DIR set. Skipped without slot or a user scope.
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SLOT = "/home/qqp/.local/bin/slot"
RUNNER = """
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("qq_job", sys.argv[1])
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)
policy = job.validate_policy(json.load(open(sys.argv[2])))
job.load_policy = lambda: policy
sys.exit(job.main(sys.argv[3:]))
"""


def user_scope_available():
    if os.geteuid() == 0 or not os.access(SLOT, os.X_OK):
        return False
    environment = dict(os.environ, XDG_RUNTIME_DIR=os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}")
    return subprocess.run(["systemd-run", "--user", "--scope", "-q", "true"], env=environment,
                          capture_output=True).returncode == 0


@unittest.skipUnless(user_scope_available(), "needs slot and a user systemd scope")
class LiveSlotRoutingTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.work = self.directory / "work"
        self.work.mkdir()
        self.slot_dir = self.directory / "locks"
        policy = json.loads((ROOT / "config/qq-job/policy.example.json").read_text())
        policy["state_dir"] = str(self.directory / "state")
        policy["monitor_state_dir"] = str(self.directory / "monitor")
        policy["slot_routing"] = {"slot": SLOT, "path_prefixes": [str(self.work) + "/"]}
        self.policy_path = self.directory / "policy.json"
        self.policy_path.write_text(json.dumps(policy))
        self.runner = self.directory / "runner.py"
        self.runner.write_text(RUNNER)
        self.env = {key: value for key, value in os.environ.items()
                    if key not in ("SLOT", "FGX_SLOT", "SLOT_LANE", "FGX_SLOT_LANE", "SLOT_MEM", "FGX_SLOT_MEM",
                                   "SLOT_GPU", "SLOT_GPU_HELD", "SLOT_GPU_GRANT")}
        # A private history too: slot rebuilds its table from the log it is given.
        self.env.update(SLOT_DIR=str(self.slot_dir), SLOT_COUNT="1", SLOT_KINDS=str(self.directory / "kinds"),
                        XDG_RUNTIME_DIR=os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}")

    def start(self, *argv, env=None, cwd=None):
        return subprocess.Popen([sys.executable, str(self.runner), str(ROOT / "scripts/qq-job.py"),
                                 str(self.policy_path), *argv], cwd=cwd or self.work, env=env or self.env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def run_job(self, *argv, **kwargs):
        process = self.start(*argv, **kwargs)
        out, err = process.communicate(timeout=60)
        return process.returncode, out, err

    def log(self):
        path = self.slot_dir / "log"
        return path.read_text().splitlines() if path.exists() else []

    def wait_for(self, path, limit=20):
        deadline = time.monotonic() + limit
        while not path.exists():
            self.assertLess(time.monotonic(), deadline, f"{path} never appeared")
            time.sleep(0.05)

    def hold_the_slot(self):
        started = self.directory / "holder-started"
        holder = subprocess.Popen([SLOT, "sh", "-c", f"touch {started}; exec sleep 30.25"], env=self.env,
                                  cwd=self.directory, start_new_session=True, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def release():
            for _ in range(2):
                try:
                    os.killpg(holder.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                subprocess.run(["pkill", "-TERM", "-f", "sleep 30.25"], capture_output=True)
                try:
                    holder.wait(timeout=10)
                    return
                except subprocess.TimeoutExpired:
                    pass

        self.addCleanup(release)
        self.wait_for(started)
        return release

    def test_job_runs_in_its_own_slot_scope_with_slots_cap_or_large_and_no_swap(self):
        probe = "p=$(cut -d: -f3 /proc/self/cgroup); echo $p; cat /sys/fs/cgroup$p/memory.max /sys/fs/cgroup$p/memory.swap.max"
        # The private queue has one slot, slot 1, whose own cap is 9G; large sets 8G.
        for profile, cap in [("default", str(9 << 30)), ("large", str(8 << 30))]:
            status, out, err = self.run_job("--profile", profile, "--shell-command", probe)
            self.assertEqual(status, 0, err)
            cgroup, memory_max, swap_max = out.split()
            self.assertIn("/app-slot.slice/slot-slot1-", cgroup)
            self.assertEqual((memory_max, swap_max), (cap, "0"))
        lines = self.log()
        self.assertEqual(len(lines), 2)
        self.assertIn(f"slot=1 cwd={self.work} cmd=/bin/bash -lc p=", lines[0])
        # A record shows the kernel's cap once it saw the scope (a short job may end unseen).
        expected = {"default": ("9G", "slot default"), "large": ("8G", "profile")}
        for path in (self.directory / "state/jobs").glob("*.json"):
            row = json.loads(path.read_text())
            # None only when the scope was gone before qq-job could read it.
            if row.get("cgroup") and row["slot_memory_max"] is not None:
                self.assertEqual((row["slot_memory_max"], row["slot_memory_source"]), expected[row["profile"]])
            self.assertEqual(row["slot_memory_source"], expected[row["profile"]][1])

    def test_exit_status_and_streams_are_the_jobs(self):
        status, out, err = self.run_job("--", "/bin/sh", "-c", "echo out; echo err >&2; exit 7")
        self.assertEqual((status, out), (7, "out" + chr(10)))
        self.assertTrue(err.endswith("err" + chr(10)), err)

    def test_not_3sen_keeps_the_qqjobs_path(self):
        status, out, err = self.run_job("--dry-run", "--", "/bin/true", cwd=self.directory)
        self.assertEqual(json.loads(out)["mode"], "sandbox-preserving-scope")
        status, out, err = self.run_job("--dry-run", "--", "/bin/true")
        self.assertEqual(json.loads(out)["mode"], "routed-to-slot")

    def assert_signal_while_queued(self, number):
        release = self.hold_the_slot()
        ran = self.directory / "ran"
        job = self.start("--shell-command", f"touch {ran}")
        time.sleep(1.5)
        self.assertIsNone(job.poll())
        job.send_signal(number)
        out, err = job.communicate(timeout=20)
        self.assertEqual(job.returncode, 128 + number, err)
        release()
        time.sleep(1.5)
        self.assertFalse(ran.exists())
        self.assertEqual([line for line in self.log() if str(ran) in line], [])

    def test_term_while_queued_cancels_the_job(self):
        self.assert_signal_while_queued(signal.SIGTERM)

    def test_int_while_queued_cancels_the_job(self):
        self.assert_signal_while_queued(signal.SIGINT)

    def test_term_while_running_stops_the_job(self):
        started = self.directory / "started"
        job = self.start("--shell-command", f"touch {started}; sleep 30.5")
        self.wait_for(started)
        time.sleep(0.3)
        began = time.monotonic()
        job.send_signal(signal.SIGTERM)
        out, err = job.communicate(timeout=20)
        self.assertEqual(job.returncode, 128 + signal.SIGTERM, err)
        self.assertLess(time.monotonic() - began, 5)
        self.assertEqual(subprocess.run(["pgrep", "-f", "sleep 30.5"], capture_output=True).returncode, 1)

    def test_job_that_handles_term_keeps_its_own_status(self):
        started = self.directory / "started"
        job = self.start("--shell-command", f"trap 'exit 0' TERM; touch {started}; sleep 30.75 & wait")
        self.wait_for(started)
        time.sleep(0.3)
        job.send_signal(signal.SIGTERM)
        out, err = job.communicate(timeout=20)
        self.assertEqual(job.returncode, 0, err)

    def test_leftovers_are_stopped_when_the_job_ends(self):
        status, out, err = self.run_job("--shell-command", "setsid sleep 61.5 < /dev/null > /dev/null 2>&1 & echo ok")
        self.assertEqual((status, out), (0, "ok" + chr(10)), err)
        # slot names what it finds (bash, setsid or sleep, as far as the fork got).
        self.assertIn("left=", self.log()[-1])
        time.sleep(0.2)
        self.assertEqual(subprocess.run(["pgrep", "-f", "sleep 61.5"], capture_output=True).returncode, 1)

    def test_nested_in_a_slot_job_runs_in_place(self):
        # qq-job started by a real slot job: the command stays in that job's scope and cap.
        probe = "p=$(cut -d: -f3 /proc/self/cgroup); echo $p; cat /sys/fs/cgroup$p/memory.max; echo $SLOT_MEM"
        process = subprocess.Popen([SLOT, sys.executable, str(self.runner), str(ROOT / "scripts/qq-job.py"),
                                    str(self.policy_path), "--profile", "large", "--shell-command", probe],
                                   cwd=self.work, env=self.env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = process.communicate(timeout=60)
        self.assertEqual(process.returncode, 0, err)
        cgroup, memory_max, slot_mem = out.split()
        self.assertIn("/app-slot.slice/slot-slot1-", cgroup)
        self.assertEqual((memory_max, slot_mem), (str(9 << 30), "9G"))
        self.assertEqual(len(self.log()), 1)
        row = next((self.directory / "state/jobs").glob("*.json"))
        self.assertTrue(json.loads(row.read_text())["nested_in_slot"])

    def test_slot_set_outside_a_slot_scope_keeps_the_qqjobs_path(self):
        # A stray SLOT would make slot run the job in place, uncapped.
        environment = dict(self.env, SLOT="1")
        outside = ["systemd-run", "--user", "--scope", "-q", "--", sys.executable, str(self.runner),
                   str(ROOT / "scripts/qq-job.py"), str(self.policy_path)]
        result = subprocess.run([*outside, "--dry-run", "--", "/bin/true"], cwd=self.work, env=environment,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(result.stdout)["mode"], "sandbox-preserving-scope", result.stderr)
        # (The qqjobs path itself is unchanged; its gate reads the operator policy,
        # so this test stops at the routing decision.)
        result = subprocess.run([*outside, "--dry-run", "--", "/bin/true"], cwd=self.work,
                                env=dict(environment, SLOT="", FGX_SLOT="1"), capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(result.stdout)["mode"], "sandbox-preserving-scope", result.stderr)
        self.assertEqual(self.log(), [])

    def test_a_job_over_its_inherited_slot_mem_gets_137(self):
        environment = dict(self.env, SLOT_MEM="64M")
        status, out, err = self.run_job("--", sys.executable, "-c", "x = bytearray(400 << 20); x[::4096] = b'y' * len(x[::4096])",
                                        env=environment)
        self.assertEqual(status, 137, err)
        self.assertEqual(len(self.log()), 1)

    def test_no_gpu_grant_in_time_passes_75_through_without_running(self):
        # A private card whose gate this test holds closed, as an alone job would.
        registry = self.directory / "gpus"
        registry.write_text("FAKE tokens=1 classes=share,alone" + chr(10))
        gate = self.slot_dir / "gpu" / "FAKE" / "gate"
        gate.parent.mkdir(parents=True)
        ran = self.directory / "ran"
        with gate.open("w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            environment = dict(self.env, SLOT_GPU_REGISTRY=str(registry), SLOT_GPU="share",
                               SLOT_GPU_SHARE_WAIT_MAX="1")
            status, out, err = self.run_job("--", "/usr/bin/touch", str(ran), env=environment)
        self.assertEqual(status, 75, err)
        self.assertIn("no grant for the card FAKE", err)
        self.assertFalse(ran.exists())

    def test_a_command_that_already_calls_slot_takes_one_slot(self):
        status, out, err = self.run_job("--", SLOT, "sh", "-c", "cut -d: -f3 /proc/self/cgroup; echo $SLOT_MEM")
        self.assertEqual(status, 0, err)
        cgroup, memory = out.split()
        self.assertIn("/app-slot.slice/slot-slot1-", cgroup)
        self.assertEqual(memory, "9G")
        self.assertEqual(len(self.log()), 1)

    def test_no_user_scope_refuses_and_never_runs_the_job(self):
        ran = self.directory / "ran"
        environment = {key: value for key, value in self.env.items() if key != "DBUS_SESSION_BUS_ADDRESS"}
        environment["XDG_RUNTIME_DIR"] = "/nonexistent"
        status, out, err = self.run_job("--", "/usr/bin/touch", str(ran), env=environment)
        self.assertEqual(status, 125)
        self.assertIn("without a memory cap", err)
        self.assertFalse(ran.exists())
        self.assertEqual(self.log(), [])


if __name__ == "__main__":
    unittest.main()
