"""Offline tests for the controlled Grok reviewer benchmark."""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from contextlib import redirect_stdout

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("grok_benchmark", HERE / "benchmark.py")
assert SPEC and SPEC.loader
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)
PROXY_SPEC = importlib.util.spec_from_file_location("grok_capture_proxy", HERE / "capture_proxy.py")
assert PROXY_SPEC and PROXY_SPEC.loader
proxy = importlib.util.module_from_spec(PROXY_SPEC)
PROXY_SPEC.loader.exec_module(proxy)


def make_repo(root: Path, content: str = "base\n") -> tuple[Path, str]:
    repo = root
    environment = benchmark.git_environment()
    environment.update({
        "GIT_AUTHOR_NAME": "benchmark-test", "GIT_AUTHOR_EMAIL": "benchmark@test",
        "GIT_COMMITTER_NAME": "benchmark-test", "GIT_COMMITTER_EMAIL": "benchmark@test",
    })
    import subprocess
    subprocess.run(["git", "init", "--quiet", str(repo)], env=environment, check=True)
    (repo / "file.txt").write_text(content, encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "file.txt"], env=environment, check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "--quiet", "-m", "base"], env=environment, check=True)
    head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], env=environment, text=True).strip()
    return repo, head


class FrozenIdentityTests(unittest.TestCase):
    def test_config_contains_exactly_the_requested_two_arms(self) -> None:
        config = benchmark.validate_config(HERE / "config.json")
        self.assertEqual(benchmark.EXPECTED_ARMS, ("qq-mini-qa", "pr-agent"))
        self.assertEqual(tuple(arm["id"] for arm in config["arms"]), benchmark.EXPECTED_ARMS)
        self.assertEqual(config["execution"]["mode"], "sequential-case-waves-concurrent-arms")
        self.assertEqual(tuple(config["execution"]["arm_wave"]), benchmark.EXPECTED_ARMS)
        self.assertEqual(config["execution"]["max_concurrent_arms"], 2)
        endpoints = config["provider"]["external_arm_endpoints"]
        self.assertEqual(tuple(endpoints), ("pr-agent",))
        self.assertNotIn("qq-mini-qa", endpoints)
        readiness = config["provider"]["auth_readiness"]
        self.assertEqual(readiness["mode"], "trusted-serial-before-wave-barrier-release")
        weakened = copy.deepcopy(config)
        weakened["arms"][0]["required_trees"] = {}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weakened.json"
            path.write_text(json.dumps(weakened), encoding="utf-8")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "source-tree pin"):
                benchmark.validate_config(path)
        lowered = copy.deepcopy(config)
        lowered["provider"]["reasoning_effort_target"] = "low"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lowered.json"
            path.write_text(json.dumps(lowered), encoding="utf-8")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "reasoning target"):
                benchmark.validate_config(path)
        modified = copy.deepcopy(config)
        modified["arms"].append(copy.deepcopy(modified["arms"][0]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(modified), encoding="utf-8")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "exactly these two arms"):
                benchmark.validate_config(path)

    def test_tracked_corpus_files_have_exact_hashes_and_no_truth(self) -> None:
        corpus = benchmark.validate_corpus(HERE / "corpus" / "smoke.json")
        self.assertEqual([case["id"] for case in corpus["cases"]], ["smoke-001", "smoke-002", "smoke-003"])
        self.assertNotIn("truth", corpus)
        rendered = json.dumps(corpus)
        self.assertNotIn("known_defects", rendered)
        self.assertNotIn("20d03800690c7f9ab7b11efeeb26237111c944c1", rendered)
        self.assertNotIn("437fde1a29cf1885b0e379d821f21dbbafb3e820", rendered)
        self.assertEqual(corpus["cases"][0]["head"], "2904675f2025d0c8bf8a597d055ea4ddd927f645")
        self.assertEqual(corpus["cases"][1]["head"], "c4247153a775407b6c9295b6f1c0b27710d5c317")
        self.assertEqual(corpus["cases"][2]["head"], "20baa457fe65fdc24dbdd1c203c6a308611b2e4f")
        truth = benchmark.read_json(HERE / "corpus" / "truth.smoke.json")
        self.assertEqual(truth["cases"]["smoke-001"]["known_defects"][0]["line"], 2178)
        self.assertEqual(truth["cases"]["smoke-002"]["known_defects"][0]["line"], 205)

    def test_git_commands_ignore_inherited_host_geometry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, first_head = make_repo(root / "first", "first\n")
            second, second_head = make_repo(root / "second", "second\n")
            previous = {name: os.environ.get(name) for name in ("GIT_DIR", "GIT_WORK_TREE")}
            os.environ["GIT_DIR"] = str(second / ".git")
            os.environ["GIT_WORK_TREE"] = str(second)
            try:
                self.assertEqual(benchmark.git(first, "rev-parse", "HEAD").strip(), first_head)
                self.assertNotEqual(first_head, second_head)
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value

    def test_case_integrity_detects_task_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, base = make_repo(root / "repo")
            environment = benchmark.git_environment()
            environment.update({
                "GIT_AUTHOR_NAME": "benchmark-test", "GIT_AUTHOR_EMAIL": "benchmark@test",
                "GIT_COMMITTER_NAME": "benchmark-test", "GIT_COMMITTER_EMAIL": "benchmark@test",
            })
            import subprocess
            (repo / "file.txt").write_text("head\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "commit", "-qam", "head"], env=environment, check=True)
            head = benchmark.git(repo, "rev-parse", "HEAD").strip()
            task = root / "task.md"; task.write_text("exact task\n", encoding="utf-8")
            standards = root / "standards.md"; standards.write_text("", encoding="utf-8")
            diff = benchmark.git(repo, "diff", "--binary", "--full-index", "--no-ext-diff", base, head, text=False)
            case = {
                "id": "case-1", "repository_id": "repo", "repository_env": "TEST_REPO",
                "base": base, "head": head,
                "base_tree": benchmark.git(repo, "rev-parse", f"{base}^{{tree}}").strip(),
                "head_tree": benchmark.git(repo, "rev-parse", f"{head}^{{tree}}").strip(),
                "diff_sha256": benchmark.sha256_bytes(diff), "changed_lines": 2, "changed_files": 1,
                "task": {"path": "task.md", "sha256": benchmark.sha256_file(task)},
            }
            corpus_path = root / "corpus.json"
            corpus_path.write_text(json.dumps({
                "schema": benchmark.CORPUS_SCHEMA, "name": "test",
                "standards": {"path": "standards.md", "sha256": benchmark.sha256_file(standards)},
                "cases": [case],
            }), encoding="utf-8")
            benchmark.validate_corpus(corpus_path)
            report = benchmark.case_integrity(case, corpus_path, repo)
            self.assertEqual(report["diff_sha256"], case["diff_sha256"])
            task.write_text("tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "task hash mismatch"):
                benchmark.validate_corpus(corpus_path)


class ProcessCancellationTests(unittest.TestCase):
    @staticmethod
    def assert_not_live(test: unittest.TestCase, pid: int) -> None:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2]
            except (FileNotFoundError, ProcessLookupError):
                return
            if state == "Z":
                return
            time.sleep(0.02)
        test.fail(f"process {pid} remained live after cancellation")

    def test_registry_cancels_descendant_group_and_closes_registration_race(self) -> None:
        registry = benchmark.ProcessGroupRegistry(grace_seconds=0.15)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "pids.json"
            script = (
                "import json, os, pathlib, signal, subprocess, sys, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "ready = pathlib.Path(sys.argv[1] + '.child-ready')\n"
                'child_code = "import pathlib,signal,sys,time; '
                'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                'pathlib.Path(sys.argv[1]).write_text(\'ready\'); time.sleep(60)"\n'
                "child = subprocess.Popen([sys.executable, '-c', child_code, str(ready)])\n"
                "while not ready.is_file(): time.sleep(0.01)\n"
                "pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(), child.pid]))\n"
                "time.sleep(60)\n"
            )
            process = subprocess.Popen(
                [sys.executable, "-c", script, str(marker)],
                start_new_session=True,
            )
            registry.register(process)
            deadline = time.monotonic() + 2
            while not marker.is_file() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.is_file())
            pids = json.loads(marker.read_text(encoding="utf-8"))
            registry.cancel()
            process.wait(timeout=2)
            registry.stop(process)
            for pid in pids:
                self.assert_not_live(self, pid)

            # A spawn racing just behind cancellation must not escape after the
            # one-shot watchdog has reached its KILL deadline.
            time.sleep(0.2)
            late = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
            registry.register(late)
            late.wait(timeout=2)
            registry.stop(late)
            self.assertLess(late.returncode, 0)


class ConcurrentWaveTests(unittest.TestCase):
    def test_selected_case_repeats_both_arms_and_writes_reports(self) -> None:
        active = 0
        max_active = 0
        lock = threading.Lock()

        def fake_run_one(*arguments, pass_index=1, start_barrier=None, **_kwargs):
            nonlocal active, max_active
            case = arguments[3]
            arm = arguments[4]
            final_directory = arguments[8]
            self.assertIsNotNone(start_barrier)
            start_barrier.wait(timeout=2)
            started_ns = time.monotonic_ns()
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.04)
            with lock:
                active -= 1
            usage = {field: pass_index * 10 for field in benchmark.TOKEN_FIELDS}
            usage["input_tokens"] = pass_index * 4
            usage["output_tokens"] = pass_index * 6
            normalized = {
                "schema": benchmark.NORMALIZED_SCHEMA,
                "pass_index": pass_index,
                "started_at": f"2026-01-01T00:00:0{pass_index}Z",
                "started_monotonic_ns": started_ns,
                "wall_clock_seconds": float(pass_index),
                "failure": None,
                "case_id": case["id"], "arm_id": arm["id"],
                "result": {
                    "usage": usage,
                    "telemetry": {"request_count": pass_index, "retries": 0, "failures": 0,
                                  "truncation_events": 0, "context_events": 0},
                    "native_verdict": None, "normalized_verdict": "fail",
                    "findings": [{"path": "file.txt", "line": 1, "body": f"Recurring {arm['id']}",
                                  "severity": None, "confidence": None, "blocks_merge": None}],
                },
            }
            final_directory.mkdir(parents=True)
            benchmark.write_json(final_directory / "normalized.json", normalized)
            return normalized

        readiness = {"commands": {arm_id: ["fake-reviewer", arm_id] for arm_id in benchmark.EXPECTED_ARMS}}
        args = argparse.Namespace(
            config=HERE / "config.json", corpus=HERE / "corpus" / "smoke.json",
            case=["smoke-001"], arm=None, run_id="concurrent-test", output=None, repeat_count=2,
        )
        config = benchmark.validate_config(HERE / "config.json")
        config["execution"]["cooldown_seconds"] = 0
        with tempfile.TemporaryDirectory() as directory:
            args.output = Path(directory) / "run"
            output = io.StringIO()
            with (
                mock.patch.object(benchmark, "validate_config", return_value=config),
                mock.patch.object(benchmark, "runtime_readiness", return_value=readiness),
                mock.patch.object(benchmark, "arm_source", return_value=Path(directory)),
                mock.patch.object(benchmark, "case_repository", return_value=Path(directory)),
                mock.patch.object(benchmark, "run_one", side_effect=fake_run_one),
                mock.patch.object(benchmark, "provider_auth_readiness", return_value={
                    "status": "ready", "model": "grok-4.6", "checked_at": "2026-01-01T00:00:00Z",
                    "forced": True, "refreshed": True, "fresh": True, "elapsed_seconds": 0.01,
                }) as auth_ready,
                redirect_stdout(output),
            ):
                self.assertEqual(benchmark.command_run(args), 0)
            manifest = json.loads(output.getvalue())
            aggregate = benchmark.read_json(args.output / "aggregate.json")
            report = benchmark.read_json(args.output / "report.json")
            markdown = (args.output / "report.md").read_text(encoding="utf-8")

        self.assertEqual(max_active, 2)
        self.assertFalse(manifest["serial"])
        self.assertEqual(manifest["execution_mode"], "repeated-sequential-case-waves-concurrent-paired-arms")
        self.assertEqual(manifest["repeat_count"], 2)
        self.assertEqual([wave["pass_index"] for wave in manifest["waves"]], [1, 2])
        self.assertTrue(all(tuple(wave["arm_ids"]) == benchmark.EXPECTED_ARMS for wave in manifest["waves"]))
        self.assertEqual(auth_ready.call_count, 2)
        self.assertTrue(all(wave["within_start_skew_target"] for wave in manifest["waves"]))
        self.assertEqual([(item["pass_index"], item["case_id"], item["arm_id"]) for item in manifest["results"]], [
            (pass_index, "smoke-001", arm_id)
            for pass_index in (1, 2) for arm_id in benchmark.EXPECTED_ARMS
        ])
        self.assertEqual(aggregate["observation_count"], 4)
        self.assertEqual(aggregate["per_arm_case"][0]["tokens"]["processed_tokens"]["median"], 15.0)
        self.assertEqual(aggregate["per_arm_case"][0]["finding_recurrence"][0]["pass_recurrence"], 2)
        self.assertEqual(report["repeat_count"], 2)
        self.assertIn("does not establish statistical significance", markdown)

    def test_provider_auth_readiness_requires_fresh_token_evidence(self) -> None:
        config = benchmark.validate_config(HERE / "config.json")
        spec = config["provider"]["auth_readiness"]
        environment = {
            spec["url_env"]: "http://127.0.0.1:8765/_qq/auth/ready",
            spec["api_key_env"]: "admin-" + "x" * 48,
        }
        base = {
            "schema": "qq.grok-xai-auth-readiness/v1", "status": "ready",
            "model": "grok-4.6", "forced": True, "refreshed": True,
        }
        with (
            mock.patch.dict(os.environ, environment, clear=False),
            mock.patch.object(benchmark, "urlopen", return_value=io.StringIO(json.dumps(base))),
            self.assertRaisesRegex(benchmark.BenchmarkError, "outside the refresh window"),
        ):
            benchmark.provider_auth_readiness(config)

        response = io.StringIO(json.dumps({**base, "fresh": True}))
        with (
            mock.patch.dict(os.environ, environment, clear=False),
            mock.patch.object(benchmark, "urlopen", return_value=response),
        ):
            evidence = benchmark.provider_auth_readiness(config)
        self.assertTrue(evidence["forced"])
        self.assertTrue(evidence["refreshed"])
        self.assertTrue(evidence["fresh"])

    def test_auth_readiness_failure_breaks_wave_before_any_generation(self) -> None:
        generations = 0

        def fake_run_one(*_arguments, start_barrier=None, **_kwargs):
            nonlocal generations
            self.assertIsNotNone(start_barrier)
            start_barrier.wait(timeout=2)
            generations += 1
            self.fail("generation must not start after failed auth readiness")

        readiness = {"commands": {arm_id: ["fake", arm_id] for arm_id in benchmark.EXPECTED_ARMS}}
        args = argparse.Namespace(
            config=HERE / "config.json", corpus=HERE / "corpus" / "smoke.json",
            case=["smoke-001"], arm=None, run_id="failed-readiness", output=None, repeat_count=1,
        )
        with tempfile.TemporaryDirectory() as directory:
            args.output = Path(directory) / "run"
            with (
                mock.patch.object(benchmark, "runtime_readiness", return_value=readiness),
                mock.patch.object(benchmark, "arm_source", return_value=Path(directory)),
                mock.patch.object(benchmark, "case_repository", return_value=Path(directory)),
                mock.patch.object(benchmark, "run_one", side_effect=fake_run_one),
                mock.patch.object(
                    benchmark, "provider_auth_readiness",
                    side_effect=benchmark.BenchmarkError("forced refresh failed"),
                ) as auth_ready,
                self.assertRaisesRegex(benchmark.BenchmarkError, "infrastructure failure"),
            ):
                benchmark.command_run(args)
            manifest = benchmark.read_json(args.output / "run.json")
        self.assertEqual(auth_ready.call_count, 1)
        self.assertEqual(generations, 0)
        self.assertEqual(manifest["waves"][0]["status"], "infrastructure-failure")


class UsageTests(unittest.TestCase):
    def test_child_environment_removes_credentials_and_stale_benchmark_paths(self) -> None:
        names = (
            "BENCH_TRUTH_PATH", "GROK_BENCH_API_KEY", "GROK_BENCH_PR_AGENT_API_KEY",
            "GROK_BENCH_PR_AGENT_BASE_URL", "AWS_SECRET_ACCESS_KEY",
        )
        previous = {name: os.environ.get(name) for name in names}
        os.environ.update({
            "BENCH_TRUTH_PATH": "/secret/truth", "GROK_BENCH_API_KEY": "secret",
            "GROK_BENCH_PR_AGENT_API_KEY": "synthetic-secret",
            "GROK_BENCH_PR_AGENT_BASE_URL": "http://127.0.0.1:9999/v1",
            "AWS_SECRET_ACCESS_KEY": "secret",
        })
        try:
            child = benchmark.sanitized_child_environment()
            self.assertNotIn("BENCH_TRUTH_PATH", child)
            self.assertNotIn("GROK_BENCH_API_KEY", child)
            self.assertNotIn("GROK_BENCH_PR_AGENT_API_KEY", child)
            self.assertNotIn("GROK_BENCH_PR_AGENT_BASE_URL", child)
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", child)
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_openai_reasoning_is_not_double_counted(self) -> None:
        usage = proxy.normalize_usage({
            "prompt_tokens": 100,
            "completion_tokens": 40,
            "total_tokens": 140,
            "prompt_tokens_details": {"cached_tokens": 25},
            "completion_tokens_details": {"reasoning_tokens": 30},
        })
        self.assertEqual(usage, {
            "input_tokens": 75, "output_tokens": 40,
            "cache_read_tokens": 25, "cache_write_tokens": 0,
            "reasoning_tokens": 30, "processed_tokens": 140,
        })

    def test_disjoint_provider_usage_matches_live_adapter_example(self) -> None:
        usage = proxy.normalize_usage({
            "prompt_tokens": 221,
            "completion_tokens": 69,
            "total_tokens": 290,
            "prompt_tokens_details": {"cached_tokens": 128},
            "completion_tokens_details": {"reasoning_tokens": 66},
        })
        self.assertEqual(usage, {
            "input_tokens": 93, "output_tokens": 69,
            "cache_read_tokens": 128, "cache_write_tokens": 0,
            "reasoning_tokens": 66, "processed_tokens": 290,
        })

    def test_proxy_requests_stream_usage_without_changing_generation_inputs(self) -> None:
        source = json.dumps({"model": "grok-4.6", "stream": True, "messages": [{"role": "user", "content": "x"}]}).encode()
        forwarded, changed = proxy.ensure_stream_usage(source)
        self.assertTrue(changed)
        value = json.loads(forwarded)
        self.assertTrue(value["stream_options"]["include_usage"])
        self.assertEqual(value["messages"], [{"role": "user", "content": "x"}])
        plain = json.dumps({"model": "grok-4.6", "stream": False}).encode()
        self.assertEqual(proxy.ensure_stream_usage(plain), (plain, False))

    def test_proxy_rejects_credentials_or_query_in_upstream_url(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "must not contain"):
                proxy.CaptureState("https://user:secret@example.test/v1", "key", Path(directory))
            with self.assertRaisesRegex(ValueError, "must not contain"):
                proxy.CaptureState("https://example.test/v1?secret=value", "key", Path(directory))

    def test_streaming_parser_uses_complete_cumulative_usage(self) -> None:
        body = b"\n".join([
            b'data: {"model":"grok-4.6","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
            b'data: {"model":"grok-4.6","usage":{"prompt_tokens":10,"completion_tokens":7,"total_tokens":17,"completion_tokens_details":{"reasoning_tokens":5}}}',
            b"data: [DONE]",
        ])
        model, usage = proxy.parse_response_body(body, "text/event-stream")
        self.assertEqual(model, "grok-4.6")
        self.assertEqual(usage["processed_tokens"], 17)
        self.assertEqual(usage["reasoning_tokens"], 5)

    def test_complete_usage_rejects_double_counted_reasoning(self) -> None:
        with self.assertRaisesRegex(benchmark.BenchmarkError, "reasoning is not added twice"):
            benchmark.normalize_usage({
                "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 0,
                "cache_write_tokens": 0, "reasoning_tokens": 3, "processed_tokens": 18,
            }, complete=True)

    def test_failed_external_observation_retains_attempt_telemetry_without_inventing_tokens(self) -> None:
        arm = benchmark.validate_config(HERE / "config.json")["arms"][1]
        records = [{
            "request_model": "grok-4.6", "response_model": None, "status": 503,
            "usage": None, "finish_reasons": [], "context_event": False,
        }]
        value = benchmark.observation_attempt_data(arm, Path("/unused"), None, None, records)
        self.assertEqual(value["telemetry"], {
            "request_count": 1, "retries": 1, "failures": 1,
            "truncation_events": 0, "context_events": 0,
        })
        self.assertEqual(value["provider_evidence"]["request_models"], ["grok-4.6"])
        self.assertTrue(all(item is None for item in value["usage"].values()))
        self.assertEqual(value["findings"], [])
        self.assertIsNone(value["normalized_verdict"])

    def test_arm_result_requires_exact_model_mode_and_isolation(self) -> None:
        config = benchmark.validate_config(HERE / "config.json")
        arm = config["arms"][0]
        case = benchmark.validate_corpus(HERE / "corpus" / "smoke.json")["cases"][0]
        value = {
            "schema": benchmark.RESULT_SCHEMA, "arm_id": arm["id"], "case_id": case["id"],
            "model": arm["client_model"], "provider_model": "grok-4.6", "mode": arm["mode"],
            "effective_config": {"reasoning_effort": "high"},
            "provider_evidence": {"request_models": ["grok-4.6"], "response_models": ["grok-4.6"]},
            "native_verdict": None, "normalized_verdict": "pass",
            "verdict_source": "adapter_findings", "findings": [],
            "usage": {"host_captured": {
                "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 0,
                "cache_write_tokens": 0, "reasoning_tokens": 3, "processed_tokens": 15,
            }},
            "telemetry": {"request_count": 1, "retries": 0, "failures": 0,
                          "truncation_events": 0, "context_events": 0},
            "isolation": {"prior_findings_visible": False, "publishing": False},
        }
        normalized = benchmark.validate_arm_result(value, arm, case, None, None)
        self.assertEqual(normalized["usage"]["processed_tokens"], 15)
        value["effective_config"]["reasoning_effort"] = "low"
        with self.assertRaisesRegex(benchmark.BenchmarkError, "high reasoning"):
            benchmark.validate_arm_result(value, arm, case, None, None)
        value["effective_config"]["reasoning_effort"] = "high"
        value["model"] = "other-model"
        with self.assertRaisesRegex(benchmark.BenchmarkError, "exact configured model"):
            benchmark.validate_arm_result(value, arm, case, None, None)


class AdjudicationTests(unittest.TestCase):
    def test_blinding_and_cluster_scoring(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "run"; run.mkdir()
            run_rows = []
            complete_usage = {field: 10 for field in benchmark.TOKEN_FIELDS}
            complete_usage["processed_tokens"] = 20
            complete_usage["input_tokens"] = 10; complete_usage["output_tokens"] = 10
            for pass_index in (1, 2):
                for arm_id in benchmark.EXPECTED_ARMS:
                    artifact = Path("passes") / f"pass-{pass_index:03d}" / "cases" / "positive" / arm_id
                    target = run / artifact; target.mkdir(parents=True)
                    normalized = {
                        "schema": benchmark.NORMALIZED_SCHEMA, "pass_index": pass_index,
                        "arm_id": arm_id, "case_id": "positive",
                        "wall_clock_seconds": 2.0, "failure": None,
                        "result": {"usage": complete_usage, "findings": [{
                            "path": "file.txt", "line": 1, "body": "Concrete trigger and bad behavior",
                            "severity": "high", "confidence": 0.9, "blocks_merge": True,
                        }]},
                    }
                    benchmark.write_json(target / "normalized.json", normalized)
                    run_rows.append({"pass_index": pass_index, "artifact": str(artifact),
                                     "case_id": "positive", "arm_id": arm_id})
            benchmark.write_json(run / "run.json", {"results": run_rows})
            blind = root / "blind"
            benchmark.command_blind(argparse.Namespace(run=run, output=blind, seed=7))
            packet = benchmark.read_json(blind / "packet.json")
            mapping = {item["blind_id"]: item for item in benchmark.read_json(blind / "blind-map.json")["entries"]}
            self.assertEqual(len(packet["entries"]), 4)
            for entry in packet["entries"]:
                self.assertNotIn("arm_id", entry)
                self.assertIn(entry["blind_id"], mapping)
                entry["rubric"] = {
                    "introduced_by_diff": True, "concrete_reproducible_trigger": True,
                    "behavior_claim_correct": True, "actionable_path_line": True,
                    "nonduplicate": True, "cluster_id": "cluster-1", "known_defect_id": "kd-1",
                    "severity": "blocker", "confidence": 5, "notes": "",
                }
            completed = root / "completed.json"; benchmark.write_json(completed, packet)
            truth = root / "truth.json"; benchmark.write_json(truth, {
                "cases": {"positive": {"known_defects": [{"id": "kd-1"}]}}
            })
            score = root / "score.json"
            with redirect_stdout(io.StringIO()):
                benchmark.command_score(argparse.Namespace(
                    run=run, truth=truth, adjudication=completed,
                    blind_map=blind / "blind-map.json", output=score,
                ))
            value = benchmark.read_json(score)
            for arm_id in benchmark.EXPECTED_ARMS:
                self.assertEqual(value["arms"][arm_id]["defect_cluster_precision"], 1.0)
                self.assertEqual(value["arms"][arm_id]["known_defect_recall"], 1.0)
                self.assertEqual(value["arms"][arm_id]["blocker_precision"], 1.0)
                self.assertEqual(value["arms"][arm_id]["observation_count"], 2)
                self.assertEqual(value["arms"][arm_id]["processed_tokens_per_valid_blocker"], 40.0)


if __name__ == "__main__":
    unittest.main()
