"""Offline tests for the sanctioned host runner and xai-auth bridge."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest import mock
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


def pilot_observation(arm_id: str, effective_config: dict[str, object]) -> dict[str, object]:
    return {
        "schema": "qq.grok-reviewer-normalized-run/v1",
        "pass_index": 1,
        "arm_id": arm_id,
        "case_id": "smoke-001",
        "model": "xai-auth/grok-4.6" if arm_id == "qq-mini-qa" else "xai/grok-4.6",
        "provider_model": "grok-4.6",
        "source": {"pin": runner.SOURCES[arm_id]["pin"]},
        "wall_clock_seconds": 1.25,
        "failure": None,
        "result": {
            "effective_config": effective_config,
            "native_verdict": None,
            "normalized_verdict": "pass",
            "findings": [],
            "usage": {
                "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 2,
                "cache_write_tokens": 0, "reasoning_tokens": 3, "processed_tokens": 17,
            },
            "provider_evidence": {
                "request_models": ["grok-4.6"], "response_models": ["grok-4.6"],
            },
            "telemetry": {
                "request_count": 1, "retries": 0, "failures": 0,
                "truncation_events": 0, "context_events": 0,
            },
        },
    }


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

    def test_pr_agent_bootstrap_roots_every_tool_cache_under_private_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "private-root"
            source = root / "sources" / "pr-agent"
            source.mkdir(parents=True)
            (source / "uv.lock").write_text("frozen-lock\n", encoding="utf-8")
            poison = Path(directory) / "read-only-host-home"
            poisoned_environment = {
                "HOME": str(poison),
                "XDG_CACHE_HOME": str(poison / ".cache"),
                "XDG_CONFIG_HOME": str(poison / ".config"),
                "XDG_DATA_HOME": str(poison / ".local" / "share"),
                "XDG_STATE_HOME": str(poison / ".local" / "state"),
                "TMPDIR": str(poison / "tmp"),
                "UV_CACHE_DIR": str(poison / "uv"),
                "PIP_CACHE_DIR": str(poison / "pip"),
                "npm_config_cache": str(poison / "npm"),
                "XAI_API_KEY": "must-not-reach-a-child",
            }
            observed: list[dict[str, str]] = []

            def fake_run(command: list[str], **kwargs):
                environment = kwargs.get("env")
                self.assertIsInstance(environment, dict)
                observed.append(environment.copy())
                tools = root / "tools" / "uv"
                if command[1:3] == ["-m", "venv"]:
                    (tools / "bin").mkdir(parents=True, exist_ok=True)
                    (tools / "bin" / "python").write_bytes(b"bootstrap-python")
                    stdout = ""
                elif "pip" in command and "install" in command:
                    (tools / "bin" / "uv").write_bytes(b"uv-binary")
                    stdout = ""
                elif command[-1] == "--version" and Path(command[0]).name == "uv":
                    stdout = f"uv {runner.UV_VERSION}\n"
                elif "sync" in command:
                    runtime = source / ".venv" / "bin"
                    runtime.mkdir(parents=True)
                    (runtime / "python").write_bytes(b"runtime-python")
                    stdout = ""
                elif command[-1] == "--version" and Path(command[0]).name == "python":
                    stdout = "Python 3.12.0\n"
                else:
                    self.fail(f"unexpected bootstrap command: {command}")
                return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

            with mock.patch.dict(os.environ, poisoned_environment, clear=False), mock.patch.object(
                runner, "run", side_effect=fake_run,
            ):
                state = runner.provision_pr_agent_environment(source, root)

            self.assertEqual(len(observed), 5)
            self.assertEqual(state["uv_version"], f"uv {runner.UV_VERSION}")
            rooted_variables = (
                "HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                "XDG_STATE_HOME", "TMPDIR", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR",
                "UV_TOOL_DIR", "UV_TOOL_BIN_DIR", "PIP_CACHE_DIR", "npm_config_cache",
                "NPM_CONFIG_CACHE", "YARN_CACHE_FOLDER", "PNPM_HOME", "BUN_INSTALL",
                "BUN_INSTALL_CACHE_DIR", "PYTHONPYCACHEPREFIX", "CARGO_HOME", "RUSTUP_HOME",
            )
            private_root = root.resolve()
            for environment in observed:
                self.assertNotIn("XAI_API_KEY", environment)
                for name in rooted_variables:
                    value = Path(environment[name]).resolve()
                    self.assertTrue(
                        value.is_relative_to(private_root),
                        f"{name} escaped private root: {value}",
                    )
            self.assertEqual(observed[-2]["UV_PROJECT_ENVIRONMENT"], str(source / ".venv"))
            self.assertNotEqual(observed[0]["HOME"], str(poison))
            self.assertNotEqual(observed[0]["UV_CACHE_DIR"], str(poison / "uv"))

    def test_private_tool_environment_rejects_cache_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "private-root"
            outside = Path(directory) / "outside"
            (root / "tool-runtime").mkdir(parents=True)
            outside.mkdir()
            (root / "tool-runtime" / "cache").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(runner.HostRunnerError, "escapes runtime root"):
                runner.private_tool_environment(root)

    def test_qq_core_verification_pins_runtime_content_not_unrelated_checkout_head(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            core = Path(directory) / "qq-core"
            dsh = core / "dsh" / "node_modules" / ".bin"
            dsh.mkdir(parents=True)
            (dsh / "dsh").write_text("runtime\n", encoding="utf-8")
            (core / "dsh" / "qq-dsh-model-compat.mjs").write_text("compat\n", encoding="utf-8")
            expected = {
                "dsh_tree": "1" * 40, "dsh_lock_blob": "2" * 40,
                "package_blob": "3" * 40, "host_patch_blob": "4" * 40,
            }

            def fake_git(_path: Path, *arguments: str, **_kwargs) -> str:
                expression = arguments[-1]
                values = {
                    "HEAD^{commit}": "f" * 40,
                    "HEAD:dsh": expected["dsh_tree"],
                    "HEAD:dsh/package-lock.json": expected["dsh_lock_blob"],
                    "HEAD:package.json": expected["package_blob"],
                    "HEAD:host.patch.yml": expected["host_patch_blob"],
                    f"{runner.QQ_CORE_PIN}:dsh": expected["dsh_tree"],
                    f"{runner.QQ_CORE_PIN}:dsh/package-lock.json": expected["dsh_lock_blob"],
                    f"{runner.QQ_CORE_PIN}:package.json": expected["package_blob"],
                    f"{runner.QQ_CORE_PIN}:host.patch.yml": expected["host_patch_blob"],
                }
                return values[expression] + "\n"

            patches = (
                mock.patch.object(runner, "QQ_CORE_DSH_TREE", expected["dsh_tree"]),
                mock.patch.object(runner, "QQ_CORE_DSH_LOCK_BLOB", expected["dsh_lock_blob"]),
                mock.patch.object(runner, "QQ_CORE_PACKAGE_BLOB", expected["package_blob"]),
                mock.patch.object(runner, "QQ_CORE_HOST_PATCH_BLOB", expected["host_patch_blob"]),
                mock.patch.object(runner, "git", side_effect=fake_git),
            )
            with patches[0], patches[1], patches[2], patches[3], patches[4]:
                state = runner.verify_core_source(core)
            self.assertEqual(state["pin"], runner.QQ_CORE_PIN)
            self.assertEqual(state["checkout_head"], "f" * 40)
            self.assertEqual(state["dsh_tree"], expected["dsh_tree"])

            def drifted_git(path: Path, *arguments: str, **kwargs) -> str:
                if arguments[-1] == "HEAD:dsh":
                    return "0" * 40 + "\n"
                return fake_git(path, *arguments, **kwargs)

            with patches[0], patches[1], patches[2], patches[3], mock.patch.object(
                runner, "git", side_effect=drifted_git,
            ), self.assertRaisesRegex(runner.HostRunnerError, "runtime content mismatch"):
                runner.verify_core_source(core)

    def test_execution_environment_uses_one_shared_bridge_with_isolated_external_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            source = root / "source"
            core = root / "core"
            models = root / "models"
            dsh_home = root / "dsh-home"
            for path in (repository, source, core, models, dsh_home):
                path.mkdir()
            launcher = root / "launcher.py"
            launcher.write_text("pass\n", encoding="utf-8")
            args = type("Args", (), {
                "qq_core_source": core, "qq_models_source": models, "qq_dsh_home": dsh_home,
                "qq_launcher": launcher, "pr_agent_launcher": launcher,
            })()
            state = {
                "repositories": {"qq-ui": {"path": str(repository)}, "qq-index": {"path": str(repository)}},
                "sources": {
                    "qq-mini-qa": {"path": str(source)}, "pr-agent": {"path": str(source)},
                },
            }
            shared_base = "http://127.0.0.1:8000/v1"
            endpoints = {
                arm_id: (shared_base, f"synthetic-{index}-" + "x" * 40)
                for index, arm_id in enumerate(runner.EXTERNAL_ARM_ENDPOINT_ENVS)
            }
            auth_readiness = ("http://127.0.0.1:8000/_qq/auth/ready", "admin-" + "z" * 48)
            environment = runner.execution_environment(args, state, endpoints, auth_readiness)
            self.assertNotIn("GROK_BENCH_QQ_BASE_URL", environment)
            observed_keys = set()
            for arm_id, (base_name, key_name) in runner.EXTERNAL_ARM_ENDPOINT_ENVS.items():
                self.assertEqual(environment[base_name], shared_base)
                self.assertEqual(environment[key_name], endpoints[arm_id][1])
                observed_keys.add(environment[key_name])
            self.assertEqual(len(observed_keys), 1)
            self.assertEqual(environment[runner.AUTH_READINESS_ENVS[0]], auth_readiness[0])
            self.assertEqual(environment[runner.AUTH_READINESS_ENVS[1]], auth_readiness[1])
            with self.assertRaisesRegex(runner.HostRunnerError, "PR-Agent requires"):
                runner.execution_environment(args, state, {}, auth_readiness)

    def test_host_cli_has_only_staged_fixed_execution_and_matrix_requires_pilot(self) -> None:
        parser = runner.parser()
        self.assertIs(parser.parse_args(["pilot", "--root", "/tmp/root", "--run-id", "paired-v1"]).function,
                      runner.command_pilot)
        matrix = parser.parse_args(["matrix", "--root", "/tmp/root", "--run-id", "paired-v1", "--repeat-count", "3"])
        self.assertIs(matrix.function, runner.command_matrix)
        self.assertEqual(matrix.repeat_count, 3)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(["run", "--root", "/tmp/root"])
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(["smoke", "--root", "/tmp/root"])
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(
            runner.HostRunnerError, "requires a successful paired host-native pilot",
        ):
            runner.require_successful_pilot(Path(directory), "paired-v1")

    def test_host_request_is_exact_and_contains_no_credential_handoff(self) -> None:
        args = type("Args", (), {"root": Path("/tmp/frozen-smoke"), "run_id": "paired-v1", "output": None})()
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(runner.command_request(args), 0)
        value = json.loads(output.getvalue())
        self.assertEqual(value["schema"], runner.REQUEST_SCHEMA)
        self.assertEqual(value["pinned_sources"]["pr-agent"]["pin"], runner.SOURCES["pr-agent"]["pin"])
        self.assertEqual(set(value["pinned_sources"]), {"qq-mini-qa", "pr-agent"})
        self.assertEqual(value["fixed_host_commands"]["pilot"][-1], "pilot")
        self.assertEqual(value["fixed_host_commands"]["matrix"][-1], "matrix")
        self.assertIn("only after", value["staging"])
        self.assertTrue(runner.PR_AGENT_LAUNCHER.is_file())
        rendered = json.dumps(value).lower()
        self.assertNotIn("paste", rendered)
        self.assertNotIn("bearer", rendered)
        self.assertIn("provider api key", rendered)


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
            models_link = profile / "node_modules" / "@hypermemetic-ai" / "qq-models"
            self.assertEqual(models_link.resolve(), qq_launcher.MODELS_WRAPPER.resolve())
            models_manifest = json.loads((models_link / "package.json").read_text(encoding="utf-8"))
            models_patch = models_link / models_manifest["dsh"]["bundle"]["patch"]
            self.assertTrue(models_patch.is_file())
            self.assertIn("id: qq-models", models_patch.read_text(encoding="utf-8"))
            self.assertIn("name: '@hypermemetic-ai/qq-models'", models_patch.read_text(encoding="utf-8"))
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

    def test_dsh_environment_replaces_stale_identity_with_fresh_canonical_sessions(self) -> None:
        first = uuid.UUID("11111111-2222-4333-8444-555555555555")
        second = uuid.UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        with (
            mock.patch.dict(os.environ, {
                "BENCH_QQ_DSH_HOME": "/host-owned/qq",
                "QQ_DSH_SESSION_ID": "session-stale",
            }),
            mock.patch.object(qq_launcher.uuid, "uuid4", side_effect=[first, second]),
        ):
            first_environment = qq_launcher.dsh_environment(
                Path("/private/dsh"), Path("/review/workspace"), Path("/pinned/qq-core"),
            )
            second_environment = qq_launcher.dsh_environment(
                Path("/private/dsh"), Path("/review/workspace"), Path("/pinned/qq-core"),
            )
        self.assertEqual(first_environment["QQ_DSH_SESSION_ID"], f"session-{first}")
        self.assertEqual(second_environment["QQ_DSH_SESSION_ID"], f"session-{second}")
        self.assertNotEqual(
            first_environment["QQ_DSH_SESSION_ID"], second_environment["QQ_DSH_SESSION_ID"],
        )
        for environment in (first_environment, second_environment):
            session_id = environment["QQ_DSH_SESSION_ID"]
            self.assertEqual(str(uuid.UUID(session_id.removeprefix("session-"))), session_id.removeprefix("session-"))
            self.assertEqual(environment["QQ_DSH_PROVIDER"], "xai-auth")
            self.assertEqual(environment["QQ_DSH_MODEL"], "grok-4.6")

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
                "export function bindMiniQaSubmit(_agent, options) { globalThis.calls.push('submit-binding'); globalThis.submitReview = options.submit; }\n",
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
              handlers.get('agent/created')({{agent: {{ctx: {{}}, session: {{id: process.env.QQ_DSH_SESSION_ID}}}}}});
              handlers.get('agent/created')({{agent: {{ctx: {{}}, session: {{id: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}}}}}});
              await globalThis.submitReview({{verdict: {{verdict: 'pass'}}, findings: []}});
              const events = [{{
                type: 'assistant/message',
                data: {{
                  message: {{source: {{provider: 'xai-auth', model: 'grok-4.6'}}}},
                  usage: {{inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, reasoningTokens: 1}},
                }},
              }}];
              handlers.get('session/event')({{events}}, {{type: 'turn/end'}});
              process.stdout.write(JSON.stringify(globalThis.calls));
            """
            (output / "qq-provider-attempts.jsonl").write_text(json.dumps({
                "schema": "qq.grok-provider-attempt/v1", "model": "grok-4.6",
                "ok": True, "status": 200,
            }) + "\n", encoding="utf-8")
            environment = runner.secret_free_environment()
            environment.update({
                "BENCH_TOOL_SOURCE": str(source.parent),
                "BENCH_REPOSITORY": str(repository),
                "BENCH_BASE": "base", "BENCH_HEAD": "head",
                "BENCH_ARM_ID": "qq-mini-qa", "BENCH_CASE_ID": "smoke-001",
                "BENCH_CLIENT_MODEL": "xai-auth/grok-4.6",
                "BENCH_PROVIDER_MODEL": "grok-4.6",
                "BENCH_RESULT_PATH": str(output / "result.json"),
                "BENCH_OUTPUT_DIR": str(output),
                "QQ_DSH_SESSION_ID": "session-12345678-1234-4234-8234-123456789abc",
            })
            calls = json.loads(subprocess.check_output(
                ["node", "--input-type=module", "-e", program],
                env=environment, text=True,
            ))
            self.assertEqual(calls, [
                "mini-qa-setup", "approval", "sandbox-pin", "sandbox-assert",
                "oracle", "submit-binding", "shell-binding", "isolated-command",
            ])
            review_session_id = "session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            self.assertNotEqual(review_session_id, environment["QQ_DSH_SESSION_ID"])
            self.assertEqual((output / "session-id.txt").read_text(), review_session_id + "\n")
            result = json.loads((output / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["effective_config"]["session_id"], review_session_id)
            self.assertEqual(
                result["effective_config"]["launcher_session_id"],
                environment["QQ_DSH_SESSION_ID"],
            )


class BridgeTests(unittest.TestCase):
    def start_bridge(
        self, root: Path, *, delay_ms: int = 0,
    ) -> tuple[subprocess.Popen[bytes], dict[str, object], str, str]:
        key = "synthetic-" + "a" * 48
        other_key = "synthetic-" + "b" * 48
        admin_key = "admin-" + "c" * 48
        ready = root / "ready.json"
        environment = runner.secret_free_environment()
        environment["GROK_BENCH_BRIDGE_KEYS_JSON"] = json.dumps({
            "client-a": key, "client-b": other_key,
        })
        environment["GROK_BENCH_BRIDGE_ADMIN_KEY"] = admin_key
        environment["FAKE_GROK_DELAY_MS"] = str(delay_ms)
        process = subprocess.Popen([
            "node", str(BRIDGE), "--adapter-module", str(FAKE),
            "--ready-file", str(ready), "--log", str(root / "bridge.jsonl"),
        ], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not ready.is_file() and process.poll() is None:
            time.sleep(0.02)
        self.assertTrue(ready.is_file(), f"bridge exited before ready: {process.returncode}")
        return process, json.loads(ready.read_text()), key, admin_key

    def test_bridge_nonstream_usage_and_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, evidence, key, admin_key = self.start_bridge(root)
            base = evidence["base_url"]
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
                ready_request = Request(
                    evidence["auth_ready_url"], data=b"", method="POST",
                    headers={"Authorization": f"Bearer {admin_key}"},
                )
                readiness = json.load(urlopen(ready_request, timeout=3))
                self.assertEqual(readiness["schema"], "qq.grok-xai-auth-readiness/v1")
                self.assertEqual(readiness["status"], "ready")
                self.assertTrue(readiness["forced"])
                self.assertTrue(readiness["fresh"])
                with self.assertRaises(HTTPError) as denied:
                    urlopen(Request(
                        evidence["auth_ready_url"], data=b"", method="POST",
                        headers={"Authorization": f"Bearer {key}"},
                    ), timeout=3)
                self.assertEqual(denied.exception.code, 401)
                denied.exception.close()
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

    def test_bridge_multiplexes_two_overlapping_provider_requests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, evidence, key, _admin_key = self.start_bridge(root, delay_ms=180)
            try:
                base = evidence["base_url"]
                body = json.dumps({
                    "model": "grok-4.6", "messages": [{"role": "user", "content": "diff"}],
                    "reasoning_effort": "high",
                }).encode()

                def request_once() -> dict[str, object]:
                    request = Request(f"{base}/chat/completions", data=body, headers={
                        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                    })
                    return json.load(urlopen(request, timeout=3))

                started = time.monotonic()
                with ThreadPoolExecutor(max_workers=2) as executor:
                    values = list(executor.map(lambda _index: request_once(), range(2)))
                elapsed = time.monotonic() - started
                self.assertEqual([item["model"] for item in values], ["grok-4.6", "grok-4.6"])
                self.assertLess(elapsed, 0.32, "bridge serialized complete provider generations")
            finally:
                process.terminate()
                process.wait(timeout=3)

    def test_auth_coordinator_single_flights_expiry_and_401_rotations(self) -> None:
        program = f"""
          import {{ createSingleFlightAuthCoordinator }} from {json.dumps(BRIDGE.as_uri())};
          const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
          let auth = {{access:'old',refresh:'refresh-old',expires:0}};
          let rotations = 0;
          const store = {{
            pathFor() {{ return '/private/auth'; }},
            read() {{ return {{...auth}}; }},
            present() {{ return true; }},
            write() {{ throw new Error('unused'); }},
            remove() {{ throw new Error('unused'); }},
            needsRefresh(value) {{ return value.expires <= Date.now(); }},
            async accessToken() {{ return {{...auth}}; }},
            async rotate(_connector, refresher) {{
              rotations += 1;
              if (rotations > 1) throw new Error('simulated qq-models 2-second lock timeout');
              await sleep(120);
              auth = await refresher({{...auth}});
              return {{...auth}};
            }},
          }};
          const coordinator = createSingleFlightAuthCoordinator(store);
          const refresh = async () => ({{access:'new',refresh:'refresh-new',expires:Date.now()+60000}});
          const started = Date.now();
          const expiry = await Promise.all([
            coordinator.requestStore().accessToken('grok', refresh),
            coordinator.requestStore().accessToken('grok', refresh),
          ]);
          if (rotations !== 1 || expiry.some((item) => item.access !== 'new')) throw new Error('expiry was not single-flight');
          if (Date.now() - started >= 1000) throw new Error('refresh approached the old 2-second lock timeout');
          rotations = 0;
          const ready = await coordinator.ready('grok', refresh);
          if (rotations !== 1 || ready.forced !== true || ready.refreshed !== true || ready.fresh !== true) throw new Error('readiness did not force one fresh refresh');

          store.needsRefresh = (value) => value.expires - 120000 <= Date.now();
          store.rotate = async (_connector, refresher) => {{
            rotations += 1;
            auth = await refresher({{...auth}});
            return {{...auth}};
          }};
          let rejectedShortToken = false;
          try {{
            await coordinator.ready('grok', async () => ({{
              access:'too-short',refresh:'too-short-refresh',expires:Date.now()+1000,
            }}));
          }} catch (error) {{
            rejectedShortToken = /outside the refresh window/.test(String(error?.message));
          }}
          if (!rejectedShortToken) throw new Error('readiness accepted an already-expiring token');
          store.needsRefresh = (value) => value.expires <= Date.now();

          auth = {{access:'race-old',refresh:'race-refresh',expires:Date.now()+60000}};
          const raceRequest = coordinator.requestStore();
          await raceRequest.accessToken('grok', refresh);
          store.rotate = async () => {{
            await sleep(30);
            auth = {{access:'race-new',refresh:'race-refresh-new',expires:Date.now()+60000}};
            throw new Error('qq-models: timed out locking /private/auth');
          }};
          const recovered = await raceRequest.rotate('grok', refresh);
          if (recovered.access !== 'race-new') throw new Error('new cross-process auth generation was not recovered');

          auth = {{access:'401-old',refresh:'401-refresh',expires:Date.now()+60000}};
          rotations = 0;
          store.rotate = async (_connector, refresher) => {{
            rotations += 1;
            await sleep(100);
            auth = await refresher({{...auth}});
            return {{...auth}};
          }};
          const first = coordinator.requestStore();
          const second = coordinator.requestStore();
          const lateRequest = coordinator.requestStore();
          await Promise.all([
            first.accessToken('grok', refresh), second.accessToken('grok', refresh),
            lateRequest.accessToken('grok', refresh),
          ]);
          const rotated = await Promise.all([first.rotate('grok', refresh), second.rotate('grok', refresh)]);
          if (rotations !== 1 || rotated.some((item) => item.access !== 'new')) throw new Error('401 was not single-flight');
          const late = await lateRequest.rotate('grok', refresh);
          if (rotations !== 1 || late.access !== 'new') throw new Error('late 401 waiter rotated a newer generation');
          console.log(JSON.stringify({{expiry_rotations:1,auth_rotations:rotations}}));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "-e", program],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), {"expiry_rotations": 1, "auth_rotations": 1})

    def test_bridge_rejects_response_format_instead_of_silently_ignoring_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, evidence, key, admin_key = self.start_bridge(root)
            base = evidence["base_url"]
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

    def test_pr_agent_passes_and_records_neutral_ai_timeout(self) -> None:
        module = self.load("grok_pr_agent_timeout_launcher", HERE / "adapters" / "run_pr_agent.py")
        with tempfile.TemporaryDirectory() as directory:
            task = Path(directory) / "task.md"
            task.write_text("Review the exact frozen change.\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {
                "BENCH_OPENAI_BASE_URL": "http://127.0.0.1:12345/v1",
                "OPENAI_API_KEY": "inert-local-key",
            }):
                environment = module.pr_agent_environment(Path("/pinned/pr-agent"), task)
        self.assertEqual(environment["CONFIG__AI_TIMEOUT"], "600")
        self.assertEqual(environment["CONFIG__MODEL"], "xai/grok-4.6")
        result_environment = {
            "BENCH_ARM_ID": "pr-agent", "BENCH_CASE_ID": "smoke-001",
            "BENCH_CLIENT_MODEL": "xai/grok-4.6", "BENCH_PROVIDER_MODEL": "grok-4.6",
        }
        with mock.patch.dict(os.environ, result_environment):
            result = module.build_result({})
        self.assertEqual(result["effective_config"]["ai_timeout_seconds"], 600)

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


    def test_host_pilot_gate_verifies_complete_qq_and_pr_agent_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session_id = "session-12345678-1234-4234-8234-123456789abc"
            launcher_session_id = "session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            base = root / "passes" / "pass-001" / "cases" / "smoke-001"
            qq_artifact = base / "qq-mini-qa"
            (qq_artifact / "output").mkdir(parents=True)
            (qq_artifact / "output" / "session-id.txt").write_text(session_id + "\n", encoding="utf-8")
            qq = pilot_observation("qq-mini-qa", {
                "session_id": session_id, "launcher_session_id": launcher_session_id,
                "reasoning_effort": "high",
            })
            (qq_artifact / "normalized.json").write_text(json.dumps(qq), encoding="utf-8")
            qq_evidence = runner.validate_pilot(root, "qq-mini-qa")
            self.assertEqual(qq_evidence["session_id"], session_id)
            self.assertEqual(qq_evidence["launcher_session_id"], launcher_session_id)
            qq["result"]["usage"].pop("cache_read_tokens")
            (qq_artifact / "normalized.json").write_text(json.dumps(qq), encoding="utf-8")
            with self.assertRaisesRegex(runner.HostRunnerError, "complete provider usage"):
                runner.validate_pilot(root, "qq-mini-qa")

            pr_artifact = base / "pr-agent"
            (pr_artifact / "provider").mkdir(parents=True)
            pr = pilot_observation("pr-agent", {"ai_timeout_seconds": 120, "reasoning_effort": "high"})
            (pr_artifact / "normalized.json").write_text(json.dumps(pr), encoding="utf-8")
            with self.assertRaisesRegex(runner.HostRunnerError, "600-second AI timeout"):
                runner.validate_pilot(root, "pr-agent")
            pr["result"]["effective_config"]["ai_timeout_seconds"] = 600
            (pr_artifact / "normalized.json").write_text(json.dumps(pr), encoding="utf-8")
            (pr_artifact / "provider" / "request-0001.request.bin").write_text(json.dumps({
                "model": "grok-4.6", "stream": False, "temperature": 0.2,
                "reasoning_effort": "high", "messages": [{"role": "user", "content": "review"}],
            }), encoding="utf-8")
            pr_evidence = runner.validate_pilot(root, "pr-agent")
            self.assertEqual(pr_evidence["ai_timeout_seconds"], 600)



if __name__ == "__main__":
    unittest.main()
