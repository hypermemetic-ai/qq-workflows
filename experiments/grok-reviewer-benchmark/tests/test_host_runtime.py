"""Offline tests for the sanctioned host runner and xai-auth bridge."""
from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parents[1]
RUNNER_SPEC = importlib.util.spec_from_file_location("grok_host_runner", HERE / "host" / "runner.py")
assert RUNNER_SPEC and RUNNER_SPEC.loader
runner = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(runner)
QQ_LAUNCHER_SPEC = importlib.util.spec_from_file_location(
    "grok_qq_launcher", HERE / "adapters" / "run_qq_mini_qa.py",
)
assert QQ_LAUNCHER_SPEC and QQ_LAUNCHER_SPEC.loader
qq_launcher = importlib.util.module_from_spec(QQ_LAUNCHER_SPEC)
QQ_LAUNCHER_SPEC.loader.exec_module(qq_launcher)
BRIDGE = HERE / "host" / "xai_openai_bridge.mjs"
FAKE = HERE / "tests" / "fixtures" / "fake_grok_adapter.mjs"
USAGE = HERE / "adapters" / "qq-arm-plugin" / "usage.mjs"


class HostProvisionTests(unittest.TestCase):
    def test_exact_local_object_provision_ignores_inherited_git_geometry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            subprocess.run(["git", "init", "--quiet", str(source)], env=runner.git_environment(), check=True)
            environment = runner.git_environment()
            environment.update({
                "GIT_AUTHOR_NAME": "benchmark", "GIT_AUTHOR_EMAIL": "benchmark@test",
                "GIT_COMMITTER_NAME": "benchmark", "GIT_COMMITTER_EMAIL": "benchmark@test",
            })
            (source / "file.txt").write_text("frozen\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "file.txt"], env=environment, check=True)
            subprocess.run(["git", "-C", str(source), "commit", "--quiet", "-m", "frozen"], env=environment, check=True)
            commit = runner.git(source, "rev-parse", "HEAD").strip()
            previous = {name: os.environ.get(name) for name in ("GIT_DIR", "GIT_WORK_TREE")}
            os.environ.update({"GIT_DIR": str(HERE / ".git"), "GIT_WORK_TREE": str(HERE)})
            try:
                state = runner.provision_object_repository("qq-ui", [commit], root / "objects.git", [source])
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
            self.assertTrue(runner.object_exists(Path(state["path"]), commit))

    def test_production_qq_task_renderer_materializes_packet_without_dirtying_repo(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            environment = runner.git_environment()
            environment.update({
                "GIT_AUTHOR_NAME": "benchmark", "GIT_AUTHOR_EMAIL": "benchmark@test",
                "GIT_COMMITTER_NAME": "benchmark", "GIT_COMMITTER_EMAIL": "benchmark@test",
            })
            subprocess.run(["git", "init", "--quiet", str(repo)], env=environment, check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "--quiet", "--allow-empty", "-m", "base"], env=environment, check=True)
            base = runner.git(repo, "rev-parse", "HEAD").strip()
            (repo / "file.txt").write_text("head\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "file.txt"], env=environment, check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "--quiet", "-m", "head"], env=environment, check=True)
            head = runner.git(repo, "rev-parse", "HEAD").strip()
            task = root / "task.md"; task.write_text("Implement exact behavior.\n", encoding="utf-8")
            rendered = root / "rendered.md"
            child = environment.copy()
            child.update({
                "BENCH_TOOL_SOURCE": str(HERE.parents[1]), "BENCH_REPOSITORY": str(repo),
                "BENCH_TASK_PATH": str(task), "BENCH_BASE": base, "BENCH_HEAD": head,
                "BENCH_QQ_RENDERED_TASK_PATH": str(rendered),
            })
            subprocess.run(["node", str(HERE / "adapters" / "render_qq_task.mjs")], env=child, check=True)
            text = rendered.read_text(encoding="utf-8")
            self.assertIn("Please review this change: Exact task artifact:", text)
            self.assertIn("Changed files: 1 total", text)
            self.assertIn(f"Base revision: {base}", text)
            self.assertIn(f"Head revision: {head}", text)
            self.assertEqual((repo / ".git" / "qq-workflows" / "task.md").read_text(), task.read_text())
            self.assertEqual(runner.git(repo, "status", "--porcelain").strip(), "")

    def test_host_request_is_exact_and_contains_no_credential_handoff(self) -> None:
        args = type("Args", (), {"root": Path("/tmp/frozen-smoke"), "output": None})()
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(runner.command_request(args), 0)
        value = json.loads(output.getvalue())
        self.assertEqual(value["schema"], runner.REQUEST_SCHEMA)
        self.assertEqual(value["pinned_sources"]["pr-agent"]["pin"], runner.SOURCES["pr-agent"]["pin"])
        self.assertEqual(value["host_command"][2], "smoke")
        self.assertEqual(value["followup"], "none: the smoke command provisions, pilots all arms, and runs the serial matrix")
        self.assertTrue(runner.PR_AGENT_LAUNCHER.is_file())
        self.assertTrue(runner.MISOSPACE_LAUNCHER.is_file())
        rendered = json.dumps(value).lower()
        self.assertNotIn("paste", rendered)
        self.assertNotIn("bearer", rendered)
        self.assertIn("provider api key argument", rendered)


class QqMiniQaAdapterTests(unittest.TestCase):
    def test_private_profile_mounts_production_qq_core_before_headless_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = root / "qq-core"
            models = root / "qq-models"
            profile = root / "dsh-home" / "profiles" / qq_launcher.PROFILE_NAME
            core.mkdir()
            models.mkdir()
            (core / "package.json").write_text(
                json.dumps({"name": qq_launcher.CORE_PACKAGE}), encoding="utf-8",
            )
            host_patch = core / "host.patch.yml"
            host_patch.write_text("- insert:\n    - id: qq-core\n", encoding="utf-8")

            self.assertEqual(qq_launcher.validate_core_source(core), host_patch)
            headless_patch = qq_launcher.materialize_profile(profile, core, models)
            manifest = json.loads((profile / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["dependencies"][qq_launcher.CORE_PACKAGE], f"link:{core}",
            )
            self.assertEqual(
                (profile / "node_modules" / "@hypermemetic-ai" / "qq-core").resolve(),
                core.resolve(),
            )
            self.assertIn("id: hmr\n  disabled: true", headless_patch.read_text())
            self.assertIn("id: qq-webserver\n  disabled: true", headless_patch.read_text())

            command = qq_launcher.dsh_command(
                Path("/runtime/dsh"), Path("/runtime/compat.mjs"),
                host_patch, headless_patch, "review exact diff",
            )
            self.assertEqual(command[-1], "review exact diff")
            self.assertEqual(
                command[command.index("--patch") + 1:command.index("--patch") + 4],
                [str(host_patch), "--patch", str(headless_patch)],
            )

    def test_plugin_requires_qq_core_and_binds_isolation_from_official_mini(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "tool" / "src"
            output = root / "output"
            repository = root / "repository"
            source.mkdir(parents=True)
            output.mkdir()
            (repository / ".git").mkdir(parents=True)
            (source / "mini-qa.mjs").write_text(
                "export function miniQaSetup() { globalThis.calls.push('mini-qa-setup'); }\n"
                "export function bindMiniQaSubmit() { globalThis.calls.push('submit-binding'); }\n",
                encoding="utf-8",
            )
            (source / "official-mini.mjs").write_text(
                "export function bindMiniShellIsolation(_agent, isolate) {\n"
                "  globalThis.calls.push('shell-binding');\n"
                "  if (isolate('printf inspected') !== 'isolated-command') throw new Error('bad isolation');\n"
                "}\n",
                encoding="utf-8",
            )
            (source / "repo-oracle.mjs").write_text(
                "export class RepoOracle { constructor() { globalThis.calls.push('oracle'); } }\n",
                encoding="utf-8",
            )
            (source / "child-isolation.mjs").write_text(
                "export function pinChildSandbox() { globalThis.calls.push('sandbox-pin'); }\n"
                "export function assertChildSandbox() { globalThis.calls.push('sandbox-assert'); }\n"
                "export function isolatedShellCommand(options) {\n"
                "  if (options.writable !== false || options.command !== 'printf inspected') throw new Error('broad shell');\n"
                "  globalThis.calls.push('isolated-command'); return 'isolated-command';\n"
                "}\n",
                encoding="utf-8",
            )
            (source / "approval-policy.mjs").write_text(
                "export function pinNonInteractiveApproval() { globalThis.calls.push('approval'); }\n",
                encoding="utf-8",
            )
            plugin = HERE / "adapters" / "qq-arm-plugin" / "plugin.mjs"
            program = f"""
              globalThis.calls = [];
              const plugin = await import({json.dumps(plugin.as_uri() + '?adapter-regression')});
              if (JSON.stringify(plugin.inject) !== JSON.stringify(['agents', 'qq-core'])) {{
                throw new Error('qq-core is not a required plugin injection');
              }}
              const handlers = new Map();
              plugin.apply({{on(name, handler) {{ handlers.set(name, handler); return () => {{}}; }}}});
              handlers.get('agent/created')({{agent: {{ctx: {{}}, session: {{id: 'session-test'}}}}}});
              process.stdout.write(JSON.stringify(globalThis.calls));
            """
            environment = runner.secret_free_environment()
            environment.update({
                "BENCH_TOOL_SOURCE": str(source.parent),
                "BENCH_REPOSITORY": str(repository),
                "BENCH_BASE": "base", "BENCH_HEAD": "head",
                "BENCH_RESULT_PATH": str(output / "result.json"),
                "BENCH_OUTPUT_DIR": str(output),
            })
            calls = json.loads(subprocess.check_output(
                ["node", "--input-type=module", "-e", program],
                env=environment, text=True,
            ))
            self.assertEqual(calls, [
                "mini-qa-setup", "approval", "sandbox-pin", "sandbox-assert",
                "oracle", "submit-binding", "shell-binding", "isolated-command",
            ])
            self.assertEqual((output / "session-id.txt").read_text(), "session-test\n")


class BridgeTests(unittest.TestCase):
    def start_bridge(self, root: Path) -> tuple[subprocess.Popen[bytes], str, str]:
        key = "synthetic-" + "a" * 48
        ready = root / "ready.json"
        environment = runner.secret_free_environment()
        environment["GROK_BENCH_BRIDGE_KEY"] = key
        process = subprocess.Popen([
            "node", str(BRIDGE), "--adapter-module", str(FAKE),
            "--ready-file", str(ready), "--log", str(root / "bridge.jsonl"),
        ], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not ready.is_file() and process.poll() is None:
            time.sleep(0.02)
        self.assertTrue(ready.is_file(), f"bridge exited before ready: {process.returncode}")
        return process, json.loads(ready.read_text())["base_url"], key

    def test_bridge_nonstream_usage_and_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, base, key = self.start_bridge(root)
            try:
                body = json.dumps({
                    "model": "grok-4.6",
                    "messages": [{"role": "system", "content": "review"}, {"role": "user", "content": "diff"}],
                    "reasoning_effort": "high", "temperature": 0.2,
                    "max_tokens": 8192,
                }).encode()
                request = Request(f"{base}/chat/completions", data=body, headers={
                    "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                })
                value = json.load(urlopen(request, timeout=3))
                self.assertEqual(value["model"], "grok-4.6")
                self.assertEqual(value["choices"][0]["message"]["content"], "review complete")
                self.assertEqual(value["usage"]["prompt_tokens"], 15)
                self.assertEqual(value["usage"]["total_tokens"], 22)
                self.assertEqual(value["usage"]["completion_tokens_details"]["reasoning_tokens"], 5)
                with self.assertRaises(HTTPError) as raised:
                    urlopen(Request(f"{base}/models", headers={"Authorization": "Bearer wrong"}), timeout=3)
                self.assertEqual(raised.exception.code, 401)
                raised.exception.close()
                log = (root / "bridge.jsonl").read_text(encoding="utf-8")
                self.assertNotIn(key, log)
                self.assertNotIn("Authorization", log)
                records = [json.loads(line) for line in log.splitlines() if line.strip()]
                record = next(item for item in records if item["status"] == 200)
                self.assertEqual(record["controls"], {
                    "reasoning_effort_requested": "high",
                    "reasoning_effort_forwarded": "high",
                    "temperature_requested": 0.2,
                    "temperature_forwarded": False,
                    "token_cap_requested": 8192,
                    "token_cap_forwarded": False,
                    "response_format_requested": None,
                })
                self.assertNotIn("hidden", json.dumps(value))
            finally:
                process.terminate()
                process.wait(timeout=3)

    def test_bridge_rejects_response_format_instead_of_silently_ignoring_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, base, key = self.start_bridge(root)
            try:
                body = json.dumps({
                    "model": "grok-4.6",
                    "messages": [{"role": "user", "content": "diff"}],
                    "response_format": {"type": "json_object"},
                }).encode()
                request = Request(f"{base}/chat/completions", data=body, headers={
                    "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                })
                with self.assertRaises(HTTPError) as raised:
                    urlopen(request, timeout=3)
                self.assertEqual(raised.exception.code, 400)
                error = json.load(raised.exception)
                self.assertIn("response_format is unsupported", error["error"]["message"])
                raised.exception.close()
            finally:
                process.terminate()
                process.wait(timeout=3)

    def test_qq_provider_attempt_log_is_strict_and_counts_transport_retries(self) -> None:
        program = f"""
          import {{ providerAttempts }} from {json.dumps(USAGE.as_uri())};
          const rows = providerAttempts([
            JSON.stringify({{schema:'qq.grok-provider-attempt/v1',model:'grok-4.6',status:401,ok:false}}),
            JSON.stringify({{schema:'qq.grok-provider-attempt/v1',model:'grok-4.6',status:200,ok:true}}),
          ].join(String.fromCharCode(10)));
          process.stdout.write(JSON.stringify(rows));
        """
        rows = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", program], text=True))
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(not row["ok"] for row in rows), 1)
        invalid = f"""
          import {{ providerAttempts }} from {json.dumps(USAGE.as_uri())};
          providerAttempts('{{"schema":"qq.grok-provider-attempt/v1","model":"other","status":200,"ok":true}}');
        """
        result = subprocess.run(["node", "--input-type=module", "-e", invalid], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_native_qq_usage_is_provider_proven_and_not_double_counted(self) -> None:
        program = f"""
          import {{ usageFrom }} from {json.dumps(USAGE.as_uri())};
          const value = usageFrom([{{type:'assistant/message',data:{{
            message:{{source:{{kind:'model',provider:'xai-auth',model:'grok-4.6'}}}},
            usage:{{inputTokens:10,outputTokens:7,cacheReadTokens:3,cacheWriteTokens:2,reasoningTokens:5}}
          }}}}]);
          process.stdout.write(JSON.stringify(value));
        """
        value = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", program], text=True))
        self.assertEqual(value["usage"]["input_tokens"], 10)
        self.assertEqual(value["usage"]["processed_tokens"], 22)
        self.assertEqual(value["usage"]["reasoning_tokens"], 5)
        self.assertEqual(value["responseModels"], ["grok-4.6"])

class ExternalLauncherTests(unittest.TestCase):
    @staticmethod
    def load(name: str, path: Path):
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_pr_agent_preserves_unknown_severity_and_unlocated_issue(self) -> None:
        module = self.load("grok_pr_agent_launcher", HERE / "adapters" / "run_pr_agent.py")
        native = {
            "review": {"key_issues_to_review": [
                {"issue_header": "Bug", "issue_content": "Concrete failure", "relevant_file": " src/a.py ", "start_line": "12"},
                {"issue_content": "Repository-wide concern"},
            ]},
            "usage": {"prompt_tokens": 221, "completion_tokens": 69, "total_tokens": 290},
        }
        findings = module.normalize_findings(native)
        self.assertEqual(findings[0], {
            "path": "src/a.py", "line": 12, "body": "Bug: Concrete failure",
            "severity": None, "confidence": None, "blocks_merge": None,
        })
        self.assertIsNone(findings[1]["path"])
        self.assertIsNone(findings[1]["line"])
        self.assertEqual(module.normalize_usage(native), {
            "input_tokens": None, "output_tokens": 69, "cache_read_tokens": None,
            "cache_write_tokens": None, "reasoning_tokens": None, "processed_tokens": 290,
        })

    def test_misospace_preserves_native_verdict_without_requiring_findings(self) -> None:
        module = self.load("grok_misospace_launcher", HERE / "adapters" / "run_misospace.py")
        previous = {name: os.environ.get(name) for name in (
            "BENCH_ARM_ID", "BENCH_CASE_ID", "BENCH_CLIENT_MODEL", "BENCH_PROVIDER_MODEL",
        )}
        os.environ.update({
            "BENCH_ARM_ID": "misospace-pr-reviewer", "BENCH_CASE_ID": "smoke-001",
            "BENCH_CLIENT_MODEL": "grok-4.6", "BENCH_PROVIDER_MODEL": "grok-4.6",
        })
        try:
            result = module.build_result({"verdict": "request_changes", "findings": []})
            self.assertEqual(result["native_verdict"], "request_changes")
            self.assertEqual(result["normalized_verdict"], "fail")
            self.assertEqual(result["verdict_source"], "native")
            self.assertEqual(result["findings"], [])
            findings = module.normalize_findings({"findings": [{
                "message": "Global blocker", "severity": "blocker", "file": None, "line": None,
            }, {"message": "Minor", "severity": "minor"}]})
            self.assertTrue(findings[0]["blocks_merge"])
            self.assertFalse(findings[1]["blocks_merge"])
            self.assertIsNone(findings[0]["path"])
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_host_pilot_gate_rejects_control_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "cases" / "smoke-001" / "misospace-pr-reviewer"
            provider = artifact / "provider"; provider.mkdir(parents=True)
            (artifact / "normalized.json").write_text(json.dumps({
                "failure": None,
                "result": {
                    "provider_evidence": {"request_models": ["grok-4.6"], "response_models": ["grok-4.6"]},
                    "telemetry": {"request_count": 1},
                },
            }), encoding="utf-8")
            request = {
                "model": "grok-4.6", "stream": True, "temperature": 0.1,
                "max_tokens": 8192, "stream_options": {"include_usage": True},
                "messages": [{"role": "user", "content": "review"}],
            }
            path = provider / "request-0001.request.bin"
            path.write_text(json.dumps(request), encoding="utf-8")
            evidence = runner.validate_pilot(root, "misospace-pr-reviewer")
            self.assertEqual(evidence["captured_request_count"], 1)
            request["temperature"] = 0.2
            path.write_text(json.dumps(request), encoding="utf-8")
            with self.assertRaisesRegex(runner.HostRunnerError, "stock defaults"):
                runner.validate_pilot(root, "misospace-pr-reviewer")

    def test_misospace_gh_fixture_rejects_every_unexpected_call(self) -> None:
        module = self.load("grok_misospace_launcher_shim", HERE / "adapters" / "run_misospace.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "files.json"; fixture.write_text("[]\n", encoding="utf-8")
            shim = module.make_gh_shim(root)
            environment = os.environ.copy()
            environment.update({"MISOSPACE_FILES_FIXTURE": str(fixture), "MISOSPACE_GH_LOG": str(root / "calls.jsonl")})
            accepted = subprocess.run(
                [str(shim / "gh"), "api", "repos/benchmark/local/pulls/1/files?per_page=100"],
                env=environment, stdout=subprocess.PIPE, text=True, check=False,
            )
            self.assertEqual(accepted.returncode, 0)
            self.assertEqual(accepted.stdout, "[]\n")
            rejected = subprocess.run(
                [str(shim / "gh"), "api", "user"], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
            )
            self.assertEqual(rejected.returncode, 97)


if __name__ == "__main__":
    unittest.main()
