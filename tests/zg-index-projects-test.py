#!/usr/bin/env python3
"""All indexing is mocked; fixtures never contact the live zg daemon."""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("scheduler", Path(__file__).parent.parent / "scripts/zg-index-projects.py")
scheduler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduler)

IDLE = {"memoryAvailableBytes": 16 * 1024**3, "swapUsedBytes": 0, "loadPerCpu": 0,
        "cpuBusyPercent": 0, "cpuSomeAvg10": 0, "ioSomeAvg10": 0, "memorySomeAvg10": 0}


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="zg-scheduler-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.projects = self.root / "projects"
        self.projects.mkdir()
        self.state = self.root / "state"
        self.state.mkdir()
        self.policy = json.loads((Path(__file__).parent.parent / "config/zg-index-projects/policy.json").read_text())
        self.policy["projectsDirectory"] = self.projects
        self.policy["projects"] = ["one"]
        self.policy["jobTimeoutSeconds"] = 2
        self.config = self.root / "policy.json"
        self.binary = self.root / "mock zg"
        self.calls = self.root / "calls.jsonl"
        self.binary.write_text("""#!/usr/bin/python3
import json,os,pathlib,sys,time
root=pathlib.Path(__file__).parent
with (root/'calls.jsonl').open('a') as stream:
 stream.write(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd(),
  'deviceEnv':os.environ.get('VK_DRIVER_FILES'),'embeddingEnv':os.environ.get('ZVEC_GREP_EMBEDDING'),
  'nice':os.getpriority(os.PRIO_PROCESS,0),'affinity':len(os.sched_getaffinity(0))})+'\\n')
mode=(root/'mode').read_text() if (root/'mode').exists() else 'success'
if mode=='timeout':
 (root/'pid').write_text(str(os.getpid()));time.sleep(10)
elif mode=='failed':
 print('Workspace index: failed');sys.exit(1)
elif mode=='submitted':
 print('Workspace index: submitted')
elif mode=='crash':
 sys.exit(3)
else:
 print('Workspace index: succeeded')
""")
        self.binary.chmod(0o700)
        self.make_project("one")

    def make_project(self, name, root=None):
        project = self.projects / name
        project.mkdir()
        index = project / ".zvec-grep"
        index.mkdir()
        manifest = {"path": str(index), "rootPaths": [{"absolutePath": str(root or project),
                    "recursive": True, "maxFileSizeBytes": 512000,
                    "globs": ["!node_modules/**"]}], "indexPolicy": "enabled",
                    "embedding": {"provider": "local", "model": "existing-model"}}
        (index / "manifest.json").write_text(json.dumps(manifest))
        return project

    def update(self, name="one", **changes):
        file = self.projects / name / ".zvec-grep/manifest.json"
        data = json.loads(file.read_text())
        data.update(changes)
        file.write_text(json.dumps(data))

    def invoke(self, sample=lambda: dict(IDLE), dry=False):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = scheduler.sweep(self.policy, self.state, str(self.binary), sample, dry)
        return code, output.getvalue()

    def captured_calls(self):
        return [json.loads(l) for l in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_local_root_with_spaces_and_selection_preserved(self):
        project = self.make_project("project with spaces")
        self.policy["projects"] = [project.name]
        before = (project / ".zvec-grep/manifest.json").read_bytes()
        with patch.dict(os.environ, {"VK_DRIVER_FILES": "forced-gpu", "ZVEC_GREP_EMBEDDING": "different-model"}):
            code, output = self.invoke()
        self.assertEqual(code, 0)
        call = self.captured_calls()[0]
        self.assertEqual(call["argv"], ["index", str(project), "--mode", "server", "--device", "cpu", "--runtime-ephemeral", "--embedding-concurrency", "1"])
        self.assertEqual(call["cwd"], str(project))
        self.assertIsNone(call["deviceEnv"])
        self.assertIsNone(call["embeddingEnv"])
        self.assertGreaterEqual(call["nice"], 15)
        self.assertEqual(call["affinity"], 1)
        self.assertEqual((project / ".zvec-grep/manifest.json").read_bytes(), before)
        self.assertIn('"succeeded": 1', output)
        self.assertFalse((self.state / "uncertain-job.json").exists())

    def test_missing_manifest_never_falls_back_to_parent(self):
        (self.projects / "one/.zvec-grep/manifest.json").unlink()
        (self.projects / ".zvec-grep").mkdir()
        (self.projects / ".zvec-grep/manifest.json").write_text("{}")
        code, output = self.invoke()
        self.assertEqual(code, 0)
        self.assertIn("explicitly initialize", output)
        self.assertEqual(self.captured_calls(), [])

    def test_narrower_cap_and_additional_selection_are_preserved(self):
        project = self.projects / "one"
        self.update(rootPaths=[{"absolutePath": str(project), "maxFileSizeBytes": 1024,
                               "globs": ["src/**", "!src/private/**"], "maxDepth": 2, "hidden": False}])
        before = (project / ".zvec-grep/manifest.json").read_bytes()
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual((project / ".zvec-grep/manifest.json").read_bytes(), before)

    def test_parent_root_and_multiroot_rejected(self):
        roots = [{"absolutePath": str(self.projects), "maxFileSizeBytes": 512000}]
        for value in (roots, roots + [{"absolutePath": str(self.projects / "one")}], []):
            with self.subTest(roots=value):
                self.update(rootPaths=value)
                self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.captured_calls(), [])

    def test_project_and_manifest_symlink_aliases_rejected(self):
        alias = self.projects / "alias"
        alias.symlink_to(self.projects / "one", target_is_directory=True)
        self.policy["projects"] = ["alias"]
        self.assertEqual(self.invoke()[0], 1)
        self.policy["projects"] = ["one"]
        file = self.projects / "one/.zvec-grep/manifest.json"
        moved = self.root / "external.json"
        file.rename(moved)
        file.symlink_to(moved)
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.captured_calls(), [])

    def test_stored_root_alias_or_external_symlink_follow_rejected(self):
        self.update(rootPaths=[{"absolutePath": str(self.projects / "one/.."), "maxFileSizeBytes": 512000}])
        self.assertEqual(self.invoke()[0], 1)
        self.update(rootPaths=[{"absolutePath": str(self.projects / "one"), "maxFileSizeBytes": 512000, "follow": True}])
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.captured_calls(), [])

    def test_caps_known_exclusions_and_disabled_indexes_fail_closed(self):
        project = self.make_project("sts2-companion")
        self.policy["projects"] = [project.name]
        for cap, globs in [(None, ["!data/**"]), (999999, ["!data/**"]), (512000, []), (512000, ["!data/**", "**"])]:
            with self.subTest(cap=cap, globs=globs):
                self.update(project.name, rootPaths=[{"absolutePath": str(project), "maxFileSizeBytes": cap, "globs": globs}])
                self.assertEqual(self.invoke()[0], 1)
        self.update(project.name, indexPolicy="disabled")
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.captured_calls(), [])

    def test_dangling_link_requires_explicit_stored_exclusion(self):
        (self.projects / "one/broken link").symlink_to(self.root / "missing")
        self.assertEqual(self.invoke()[0], 1)
        self.update(rootPaths=[{"absolutePath": str(self.projects / "one"), "maxFileSizeBytes": 512000, "globs": ["!broken link"]}])
        self.assertEqual(self.invoke(dry=True)[0], 0)
        self.assertEqual(self.captured_calls(), [])

    def test_path_escape_config_rejected_without_submission(self):
        for name in ("../one", "/tmp", ".hidden", ".."):
            with self.subTest(name=name):
                self.policy["projects"] = [name]
                self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.captured_calls(), [])

    def test_pressure_defers_entire_sweep_and_rechecks_between_jobs(self):
        for metric in IDLE:
            with self.subTest(metric=metric):
                busy = dict(IDLE)
                busy[metric] = 0 if metric == "memoryAvailableBytes" else self.policy["pressureGates"][metric] + 1
                self.assertEqual(self.invoke(lambda: busy)[0], 75)
        self.assertEqual(self.captured_calls(), [])
        self.make_project("two")
        self.policy["projects"] = ["one", "two"]
        samples = iter([dict(IDLE), {**IDLE, "ioSomeAvg10": 99}])
        code, output = self.invoke(lambda: next(samples))
        self.assertEqual(code, 75)
        self.assertEqual(len(self.captured_calls()), 1)
        self.assertIn('"nextProject": "two"', output)

    def test_missing_pressure_or_invalid_metric_defers(self):
        self.assertEqual(self.invoke(lambda: {})[0], 75)
        self.assertEqual(self.invoke(lambda: {**IDLE, "cpuBusyPercent": float("nan")})[0], 75)
        self.assertEqual(self.invoke(lambda: {**IDLE, "swapUsedBytes": -1})[0], 75)
        self.assertEqual(self.invoke(lambda: {**IDLE, "memorySomeAvg10": False})[0], 75)
        def unavailable():
            raise OSError("no PSI")
        self.assertEqual(self.invoke(unavailable)[0], 75)
        self.assertEqual(self.captured_calls(), [])

    def test_timeout_persists_handoff_kills_client_and_blocks_retry(self):
        (self.root / "mode").write_text("timeout")
        self.policy["jobTimeoutSeconds"] = 0.2
        code, output = self.invoke()
        self.assertEqual(code, 1)
        self.assertIn("daemon job may still be running", output)
        self.assertTrue((self.state / "uncertain-job.json").exists())
        pid = int((self.root / "pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertEqual(self.invoke()[0], 75)
        self.assertEqual(len(self.captured_calls()), 1)

    def test_failure_does_not_continue_and_zero_exit_submitted_is_uncertain(self):
        self.make_project("two")
        self.policy["projects"] = ["one", "two"]
        (self.root / "mode").write_text("failed")
        self.assertEqual(self.invoke()[0], 1)
        self.assertFalse((self.state / "uncertain-job.json").exists())
        self.assertEqual(len(self.captured_calls()), 1)
        (self.root / "mode").write_text("submitted")
        self.assertEqual(self.invoke()[0], 1)
        self.assertTrue((self.state / "uncertain-job.json").exists())

    def test_abnormal_client_exit_retains_handoff(self):
        (self.root / "mode").write_text("crash")
        code, output = self.invoke()
        self.assertEqual(code, 1)
        self.assertIn("no terminal daemon result; client exit 3", output)
        self.assertEqual(self.invoke()[0], 75)
        self.assertEqual(len(self.captured_calls()), 1)

    def test_exception_reading_launched_client_result_retains_handoff_and_blocks_retry(self):
        output_path = self.state / "last-client.log"
        real_open = Path.open

        def open_path(path, *args, **kwargs):
            mode = args[0] if args else kwargs.get("mode", "r")
            if path == output_path and mode == "r":
                raise OSError("terminal result cannot be read")
            return real_open(path, *args, **kwargs)

        with patch.object(Path, "open", open_path):
            code, output = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.captured_calls()), 1)  # The client actually launched.
        marker = json.loads((self.state / "uncertain-job.json").read_text())
        self.assertIn("cannot confirm daemon completion", marker["reason"])
        self.assertNotIn("client did not start", output)
        self.assertEqual(self.invoke()[0], 75)
        self.assertEqual(len(self.captured_calls()), 1)

    def test_subprocess_exception_after_launch_keeps_pre_submission_marker(self):
        process = Mock()
        process.wait.side_effect = subprocess.SubprocessError("lost client wait status")
        with patch.object(scheduler.subprocess, "Popen", return_value=process) as launch:
            code, output = self.invoke()
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(code, 1)
        self.assertIn("handoff-required", output)
        self.assertTrue((self.state / "uncertain-job.json").exists())
        self.assertEqual(self.invoke()[0], 75)

    def test_launcher_error_retains_conservative_handoff_without_claiming_no_job(self):
        with patch.object(scheduler.subprocess, "Popen", side_effect=OSError("ambiguous launcher failure")):
            code, output = self.invoke()
        self.assertEqual(code, 1)
        self.assertNotIn("client did not start", output)
        self.assertTrue((self.state / "uncertain-job.json").exists())
        self.assertEqual(self.invoke()[0], 75)

    def test_lock_prevents_overlap_and_dry_run_never_calls_zg(self):
        config = {**self.policy, "projectsDirectory": str(self.projects)}
        self.config.write_text(json.dumps(config))
        argv = ["--config", str(self.config), "--state-dir", str(self.state), "--zg-bin", str(self.binary)]
        with (self.state / "sweep.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scheduler.main(argv), 75)
        with patch.object(scheduler, "read_pressure", return_value=dict(IDLE)), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scheduler.main(argv + ["--dry-run"]), 0)
        self.assertEqual(self.captured_calls(), [])

    def test_policy_rejects_missing_gates_and_symlink_base(self):
        config = {**self.policy, "projectsDirectory": str(self.projects), "pressureGates": {}}
        self.config.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            scheduler.load_policy(self.config)
        alias = self.root / "projects alias"
        alias.symlink_to(self.projects, target_is_directory=True)
        config["projectsDirectory"] = str(alias)
        self.config.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            scheduler.load_policy(self.config)


if __name__ == "__main__":
    unittest.main()
