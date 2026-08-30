"""Offline tests for the controlled Grok reviewer benchmark."""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import io
import os
from pathlib import Path
import tempfile
import unittest
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
    def test_config_contains_exactly_the_settled_three_arms(self) -> None:
        config = benchmark.validate_config(HERE / "config.json")
        self.assertEqual(tuple(arm["id"] for arm in config["arms"]), benchmark.EXPECTED_ARMS)
        weakened = copy.deepcopy(config)
        weakened["arms"][0]["required_trees"] = {}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weakened.json"
            path.write_text(json.dumps(weakened), encoding="utf-8")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "source-tree pin"):
                benchmark.validate_config(path)
        modified = copy.deepcopy(config)
        modified["arms"].append(copy.deepcopy(modified["arms"][0]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(modified), encoding="utf-8")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "exactly these three arms"):
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


class UsageTests(unittest.TestCase):
    def test_child_environment_removes_credentials_and_stale_benchmark_paths(self) -> None:
        previous = {name: os.environ.get(name) for name in ("BENCH_TRUTH_PATH", "GROK_BENCH_API_KEY", "AWS_SECRET_ACCESS_KEY")}
        os.environ.update({"BENCH_TRUTH_PATH": "/secret/truth", "GROK_BENCH_API_KEY": "secret", "AWS_SECRET_ACCESS_KEY": "secret"})
        try:
            child = benchmark.sanitized_child_environment()
            self.assertNotIn("BENCH_TRUTH_PATH", child)
            self.assertNotIn("GROK_BENCH_API_KEY", child)
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
            for arm_id in benchmark.EXPECTED_ARMS:
                artifact = Path("cases") / "positive" / arm_id
                target = run / artifact; target.mkdir(parents=True)
                normalized = {
                    "schema": benchmark.NORMALIZED_SCHEMA, "arm_id": arm_id, "case_id": "positive",
                    "wall_clock_seconds": 2.0, "failure": None,
                    "result": {"usage": complete_usage, "findings": [{
                        "path": "file.txt", "line": 1, "body": "Concrete trigger and bad behavior",
                        "severity": "high", "confidence": 0.9, "blocks_merge": True,
                    }]},
                }
                benchmark.write_json(target / "normalized.json", normalized)
                run_rows.append({"artifact": str(artifact), "case_id": "positive", "arm_id": arm_id})
            benchmark.write_json(run / "run.json", {"results": run_rows})
            blind = root / "blind"
            benchmark.command_blind(argparse.Namespace(run=run, output=blind, seed=7))
            packet = benchmark.read_json(blind / "packet.json")
            mapping = {item["blind_id"]: item for item in benchmark.read_json(blind / "blind-map.json")["entries"]}
            self.assertEqual(len(packet["entries"]), 3)
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
                self.assertEqual(value["arms"][arm_id]["processed_tokens_per_valid_blocker"], 20.0)


if __name__ == "__main__":
    unittest.main()
