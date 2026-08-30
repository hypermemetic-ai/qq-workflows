#!/usr/bin/env python3
"""Host-side provisioning and execution for the frozen Grok reviewer smoke.

This command is intentionally run by the normal qq host runner, not from a
network-isolated implementation/QA shell. It never accepts or prints a provider
bearer token. The xai-auth bridge reads the normal host OAuth store itself and
exposes only a random, run-scoped synthetic key to benchmark.py.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import time
from typing import Any, Iterable

HERE = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = HERE / "benchmark.py"
BRIDGE_PATH = Path(__file__).with_name("xai_openai_bridge.mjs")
SCHEMA = "qq.grok-reviewer-host-state/v1"
REQUEST_SCHEMA = "qq.grok-reviewer-host-request/v1"
QQ_MODELS_PIN = "c236efd1ff41169e51a04933328ffdd062e49b96"
QQ_MODELS_SRC_TREE = "12bc406fe94f907026743255287b1a8bcef14a1d"
QQ_CORE_PIN = "cd2388e549768593747d18dcb5be940eb7ed94a2"
QQ_CORE_DSH_LOCK_BLOB = "6cc438db64245fd77daa974dc2b9416a3ef9f1ee"
QQ_LAUNCHER = HERE / "adapters" / "run_qq_mini_qa.py"
SOURCES = {
    "qq-mini-qa": {
        "url": "https://github.com/hypermemetic-ai/qq-workflows.git",
        "pin": "54966c350fe7c7fc57af76f4bc449abef68b9d55",
        "directory": "qq-workflows",
    },
    "pr-agent": {
        "url": "https://github.com/The-PR-Agent/pr-agent.git",
        "pin": "1b6925ba8cc3ef6be09dec704a374da53091926c",
        "directory": "pr-agent",
    },
    "misospace-pr-reviewer": {
        "url": "https://github.com/misospace/pr-reviewer-action.git",
        "pin": "54dfb1aac20e1e410ad8f71dc3681b888500a1ec",
        "directory": "pr-reviewer-action",
    },
}
REPOSITORIES = {
    "qq-ui": {
        "url": "https://github.com/hypermemetic-ai/qq-ui.git",
        "directory": "qq-ui.git",
    },
    "qq-index": {
        "url": "https://github.com/hypermemetic-ai/qq-index.git",
        "directory": "qq-index.git",
    },
}
CREDENTIAL_NAMES = {
    "XAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
    "GROK_BENCH_API_KEY", "GROK_BENCH_PROXY_API_KEY", "GROK_BENCH_BRIDGE_KEY",
}


class HostRunnerError(RuntimeError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def write_json(path: Path, value: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(canonical(value), encoding="utf-8")
    os.chmod(temporary, mode)
    temporary.replace(path)


def git_environment() -> dict[str, str]:
    value = {name: item for name, item in os.environ.items() if not name.startswith("GIT_")}
    value.update({
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "cat",
    })
    return value


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None,
        capture: bool = True, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command, cwd=cwd, env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True, check=False,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "command failed").strip()
        raise HostRunnerError(f"{command[0]} failed ({result.returncode}): {detail}")
    return result


def git(repository: Path, *arguments: str, check: bool = True) -> str:
    return run(["git", "-C", str(repository), *arguments], env=git_environment(), check=check).stdout


def object_exists(repository: Path, oid: str) -> bool:
    return run(
        ["git", "-C", str(repository), "cat-file", "-e", f"{oid}^{{commit}}"],
        env=git_environment(), check=False,
    ).returncode == 0


def load_benchmark():
    spec = importlib.util.spec_from_file_location("grok_reviewer_benchmark_host", BENCHMARK_PATH)
    if not spec or not spec.loader:
        raise HostRunnerError("cannot load benchmark.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def network_isolated_shell() -> bool:
    try:
        command = Path("/proc/1/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return "bwrap" in command and "--unshare-net" in command


def secret_free_environment() -> dict[str, str]:
    value = os.environ.copy()
    for name in list(value):
        upper = name.upper()
        if (
            name in CREDENTIAL_NAMES
            or upper.endswith(("_API_KEY", "_TOKEN", "_PASSWORD", "_SECRET"))
            or upper.startswith(("AWS_", "AZURE_", "GOOGLE_"))
            or upper in {"SSH_AUTH_SOCK", "DOCKER_AUTH_CONFIG", "NETRC"}
        ):
            value.pop(name, None)
    return value


def clone_exact(url: str, pin: str, destination: Path, local_source: Path | None = None) -> dict[str, str]:
    if destination.exists():
        actual = git(destination, "rev-parse", "HEAD^{commit}").strip()
        if actual != pin:
            raise HostRunnerError(f"existing source has wrong pin: {destination}: {actual}")
        if git(destination, "status", "--porcelain", "--untracked-files=no").strip():
            raise HostRunnerError(f"existing pinned source has tracked modifications: {destination}")
        return {"path": str(destination), "pin": actual, "origin": git(destination, "remote", "get-url", "origin").strip()}
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    run(["git", "init", "--quiet", str(temporary)], env=git_environment())
    origin = str(local_source.resolve()) if local_source else url
    git(temporary, "remote", "add", "origin", origin)
    try:
        # Exact-object fetch avoids moving branch names and gives a detached,
        # reproducible source even if upstream main advances during provisioning.
        git(temporary, "fetch", "--no-tags", "--depth=1", "origin", pin)
        git(temporary, "checkout", "--quiet", "--detach", "FETCH_HEAD")
        actual = git(temporary, "rev-parse", "HEAD^{commit}").strip()
        if actual != pin:
            raise HostRunnerError(f"source pin mismatch for {url}: {actual}")
        temporary.replace(destination)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {"path": str(destination), "pin": pin, "origin": url}


def candidate_repositories(roots: Iterable[Path]) -> list[Path]:
    found: set[Path] = set()
    for root in roots:
        root = root.expanduser().resolve()
        if not root.exists():
            continue
        if (root / ".git").exists() or (root / "HEAD").is_file() and (root / "objects").is_dir():
            found.add(root)
        # This is a public object inventory only. It never reads working files,
        # config values, credential stores, or session logs.
        if root.is_dir():
            for marker in root.rglob(".git"):
                found.add(marker.parent)
    return sorted(found)


def provision_object_repository(
    repository_id: str,
    commits: list[str],
    destination: Path,
    sources: list[Path],
) -> dict[str, Any]:
    config = REPOSITORIES[repository_id]
    if destination.exists() and all(object_exists(destination, oid) for oid in commits):
        return {"path": str(destination), "commits": commits, "origin": config["url"], "reused": True}
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    run(["git", "init", "--bare", "--quiet", str(temporary)], env=git_environment())
    try:
        missing = []
        for oid in commits:
            source = next((item for item in sources if object_exists(item, oid)), None)
            if source is None:
                missing.append(oid)
            else:
                git(temporary, "fetch", "--no-tags", str(source), oid)
        if missing:
            git(temporary, "remote", "add", "origin", config["url"])
            # Fetch advertised branches/tags once. This supplies landed controls
            # and historical bases without guessing branch names.
            git(temporary, "fetch", "--no-recurse-submodules", "origin",
                "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")
            for oid in missing:
                if not object_exists(temporary, oid):
                    # Some hosts permit an exact reachable SHA even when no
                    # retained branch currently names it.
                    git(temporary, "fetch", "--no-tags", "origin", oid, check=False)
        absent = [oid for oid in commits if not object_exists(temporary, oid)]
        if absent:
            raise HostRunnerError(f"{repository_id} origin did not supply frozen commits: {', '.join(absent)}")
        if destination.exists():
            shutil.rmtree(destination)
        temporary.replace(destination)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {"path": str(destination), "commits": commits, "origin": config["url"], "reused": False}


def verify_models_source(path: Path) -> dict[str, str]:
    path = path.expanduser().resolve()
    pin = git(path, "rev-parse", "HEAD^{commit}").strip()
    tree = git(path, "rev-parse", "HEAD:src").strip()
    if pin != QQ_MODELS_PIN or tree != QQ_MODELS_SRC_TREE:
        raise HostRunnerError(
            f"qq-models source mismatch: expected {QQ_MODELS_PIN}/src {QQ_MODELS_SRC_TREE}, got {pin}/src {tree}"
        )
    return {"path": str(path), "pin": pin, "src_tree": tree}


def command_provision(args: argparse.Namespace) -> int:
    if network_isolated_shell():
        raise HostRunnerError(
            "provision requires the normal host network namespace; run this exact command outside the "
            f"implementation sandbox: {sys.executable} {Path(__file__).resolve()} provision --root {args.root.resolve()}"
        )
    root = args.root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    benchmark = load_benchmark()
    corpus_path = HERE / "corpus" / "smoke.json"
    corpus = benchmark.validate_corpus(corpus_path)

    local_qq = args.qq_workflows_source.expanduser().resolve() if args.qq_workflows_source else None
    source_states = {}
    for arm_id, source in SOURCES.items():
        source_states[arm_id] = clone_exact(
            source["url"], source["pin"], root / "sources" / source["directory"],
            local_source=local_qq if arm_id == "qq-mini-qa" else None,
        )

    object_roots = list(args.object_root)
    object_roots.extend([Path.home() / "projects" / ".qq-worktrees", Path.home() / "projects"])
    candidates = candidate_repositories(object_roots)
    repo_states = {}
    repo_paths = {}
    for repository_id, repository in REPOSITORIES.items():
        commits = sorted({
            case[key]
            for case in corpus["cases"] if case["repository_id"] == repository_id
            for key in ("base", "head")
        })
        destination = root / "repositories" / repository["directory"]
        repo_states[repository_id] = provision_object_repository(repository_id, commits, destination, candidates)
        repo_paths[repository_id] = destination

    integrity = [benchmark.case_integrity(case, corpus_path, repo_paths[case["repository_id"]]) for case in corpus["cases"]]
    state = {
        "schema": SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "sources": source_states,
        "repositories": repo_states,
        "integrity": integrity,
        "provider": {"family": "Grok", "model": "grok-4.6", "bridge": "xai-auth-loopback"},
    }
    write_json(root / "state.json", state)
    print(canonical(state), end="")
    return 0


def load_state(root: Path) -> dict[str, Any]:
    path = root / "state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HostRunnerError(f"cannot read provisioned state {path}: {error}") from error
    if value.get("schema") != SCHEMA or Path(value.get("root", "")).resolve() != root:
        raise HostRunnerError("host state root/schema mismatch; rerun provision")
    return value


def launcher_command(path: Path) -> str:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise HostRunnerError(f"approved stock launcher is missing: {path}")
    if path.suffix == ".py":
        command = [sys.executable, str(path)]
    elif os.access(path, os.X_OK):
        command = [str(path)]
    else:
        raise HostRunnerError(f"approved stock launcher is not executable: {path}")
    return json.dumps(command, separators=(",", ":"))


def wait_ready(process: subprocess.Popen[bytes], ready: Path, timeout: float = 10) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ready.is_file():
            try:
                value = json.loads(ready.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise HostRunnerError(f"xai-auth bridge wrote invalid readiness evidence: {error}") from error
            if value.get("schema") != "qq.grok-xai-bridge-ready/v1" or value.get("model") != "grok-4.6":
                raise HostRunnerError("xai-auth bridge returned invalid readiness evidence")
            return value
        if process.poll() is not None:
            raise HostRunnerError(f"xai-auth bridge exited before readiness ({process.returncode})")
        time.sleep(0.05)
    raise HostRunnerError("xai-auth bridge readiness timed out")


@contextmanager
def bridge(models_source: Path, directory: Path):
    synthetic_key = secrets.token_urlsafe(48)
    ready = directory / "bridge-ready.json"
    log = directory / "bridge.jsonl"
    stdout = (directory / "bridge.stdout").open("wb")
    stderr = (directory / "bridge.stderr").open("wb")
    environment = secret_free_environment()
    # The bridge needs the host's normal HOME/DSH_HOME path resolution, but no
    # provider token is copied into this environment.
    for name in ("HOME", "XDG_STATE_HOME", "DSH_HOME", "QQ_DSH_HOME", "PATH"):
        if name in os.environ:
            environment[name] = os.environ[name]
    environment["GROK_BENCH_BRIDGE_KEY"] = synthetic_key
    try:
        process = subprocess.Popen([
            "node", str(BRIDGE_PATH), "--models-source", str(models_source),
            "--ready-file", str(ready), "--log", str(log),
        ], env=environment, stdout=stdout, stderr=stderr, start_new_session=True)
    except BaseException:
        stdout.close()
        stderr.close()
        raise
    try:
        evidence = wait_ready(process, ready)
        yield evidence["base_url"], synthetic_key, evidence
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        stdout.close()
        stderr.close()


def execution_environment(args: argparse.Namespace, state: dict[str, Any], base_url: str, key: str) -> dict[str, str]:
    environment = secret_free_environment()
    environment.update({
        "GROK_BENCH_REPO_QQ_UI": state["repositories"]["qq-ui"]["path"],
        "GROK_BENCH_REPO_QQ_INDEX": state["repositories"]["qq-index"]["path"],
        "GROK_BENCH_QQ_SOURCE": state["sources"]["qq-mini-qa"]["path"],
        "GROK_BENCH_QQ_CORE_SOURCE": str(args.qq_core_source.expanduser().resolve()),
        "GROK_BENCH_QQ_MODELS_SOURCE": str(args.qq_models_source.expanduser().resolve()),
        "GROK_BENCH_QQ_DSH_HOME": str(args.qq_dsh_home.expanduser().resolve()),
        "GROK_BENCH_PR_AGENT_SOURCE": state["sources"]["pr-agent"]["path"],
        "GROK_BENCH_MISOSPACE_SOURCE": state["sources"]["misospace-pr-reviewer"]["path"],
        "GROK_BENCH_QQ_COMMAND_JSON": launcher_command(args.qq_launcher),
        "GROK_BENCH_PR_AGENT_COMMAND_JSON": launcher_command(args.pr_agent_launcher),
        "GROK_BENCH_MISOSPACE_COMMAND_JSON": launcher_command(args.misospace_launcher),
        "GROK_BENCH_BASE_URL": base_url,
        # This is a synthetic loopback key, not provider auth. benchmark.py
        # keeps it out of all reviewer child environments via capture_proxy.py.
        "GROK_BENCH_API_KEY": key,
    })
    return environment


def verify_core_source(path: Path) -> dict[str, str]:
    path = path.expanduser().resolve()
    pin = git(path, "rev-parse", "HEAD^{commit}").strip()
    lock_blob = git(path, "rev-parse", "HEAD:dsh/package-lock.json").strip()
    if pin != QQ_CORE_PIN or lock_blob != QQ_CORE_DSH_LOCK_BLOB:
        raise HostRunnerError(
            f"qq-core runtime mismatch: expected {QQ_CORE_PIN}/lock {QQ_CORE_DSH_LOCK_BLOB}, "
            f"got {pin}/lock {lock_blob}"
        )
    return {"path": str(path), "pin": pin, "dsh_lock_blob": lock_blob}


def command_run(args: argparse.Namespace) -> int:
    if network_isolated_shell():
        raise HostRunnerError(
            "live smoke cannot run in this bwrap --unshare-net shell. Execute host/runner.py run "
            "through the normal qq host command boundary; no API key argument is required."
        )
    root = args.root.expanduser().resolve()
    state = load_state(root)
    models_state = verify_models_source(args.qq_models_source)
    core_state = verify_core_source(args.qq_core_source)
    dsh_home = args.qq_dsh_home.expanduser().resolve()
    auth_marker = dsh_home / ".qq-grok-auth.json"
    if not auth_marker.is_file():
        raise HostRunnerError(f"normal host xai-auth login marker is unavailable: {auth_marker}")
    live = root / "live" / (args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    live.mkdir(parents=True, exist_ok=False, mode=0o700)
    with bridge(Path(models_state["path"]), live) as (base_url, key, evidence):
        args.qq_launcher = QQ_LAUNCHER
        args.qq_core_source = Path(core_state["path"])
        args.qq_dsh_home = dsh_home
        environment = execution_environment(args, state, base_url, key)
        doctor = run([sys.executable, str(BENCHMARK_PATH), "doctor"], env=environment, check=False)
        (live / "doctor.stdout").write_text(doctor.stdout, encoding="utf-8")
        (live / "doctor.stderr").write_text(doctor.stderr, encoding="utf-8")
        os.chmod(live / "doctor.stdout", 0o600)
        os.chmod(live / "doctor.stderr", 0o600)
        if doctor.returncode != 0:
            raise HostRunnerError(f"benchmark doctor failed ({doctor.returncode}): {doctor.stderr.strip()}")
        command = [sys.executable, str(BENCHMARK_PATH), "run", "--output", str(live / "run")]
        result = run(command, env=environment, capture=False, check=False)
        if result.returncode != 0:
            raise HostRunnerError(f"benchmark smoke failed ({result.returncode}); inspect {live}")
        write_json(live / "host-evidence.json", {
            "schema": "qq.grok-reviewer-host-evidence/v1",
            "state_sha256": hashlib.sha256((root / "state.json").read_bytes()).hexdigest(),
            "qq_models": models_state,
            "qq_core": core_state,
            "qq_dsh_home": str(dsh_home),
            "bridge": evidence,
            "commands": {
                "qq-mini-qa": json.loads(environment["GROK_BENCH_QQ_COMMAND_JSON"]),
                "pr-agent": json.loads(environment["GROK_BENCH_PR_AGENT_COMMAND_JSON"]),
                "misospace-pr-reviewer": json.loads(environment["GROK_BENCH_MISOSPACE_COMMAND_JSON"]),
            },
            "provider_secret_exposed_to_reviewer": False,
        })
    print(canonical({"status": "complete", "run": str(live / "run")}), end="")
    return 0


def command_request(args: argparse.Namespace) -> int:
    root = args.root.expanduser().resolve()
    command = [sys.executable, str(Path(__file__).resolve()), "provision", "--root", str(root)]
    value = {
        "schema": REQUEST_SCHEMA,
        "reason": "current command shell is bwrap --unshare-net and cannot reach the host xai-auth route or public Git",
        "host_command": command,
        "required_host_capabilities": [
            "normal outbound HTTPS for public Git/dependency provisioning",
            "read/write access to the normal qq xai-auth store by the bridge process",
            "loopback TCP shared by runner, capture proxy, and reviewer children",
        ],
        "forbidden_inputs": ["provider API key argument", "copied OAuth file", "GitHub token argument"],
        "pinned_sources": SOURCES,
        "frozen_repositories": REPOSITORIES,
        "followup": (
            "After provision, run host/runner.py run with three approved stock launcher paths. "
            "The runner itself starts the credential-shielding xai-auth bridge."
        ),
    }
    if args.output:
        write_json(args.output.resolve(), value, mode=0o644)
    print(canonical(value), end="")
    return 0


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    sub = value.add_subparsers(dest="command", required=True)
    child = sub.add_parser("request", help="emit the exact secret-free host execution request")
    child.add_argument("--root", type=Path, required=True)
    child.add_argument("--output", type=Path)
    child.set_defaults(function=command_request)
    child = sub.add_parser("provision", help="fetch and verify exact pinned sources and frozen Git objects")
    child.add_argument("--root", type=Path, required=True)
    child.add_argument("--qq-workflows-source", type=Path)
    child.add_argument("--object-root", type=Path, action="append", default=[])
    child.set_defaults(function=command_provision)
    child = sub.add_parser("run", help="start xai-auth bridge, doctor, and serial smoke")
    child.add_argument("--root", type=Path, required=True)
    child.add_argument("--qq-models-source", type=Path, required=True)
    child.add_argument("--qq-core-source", type=Path, required=True)
    child.add_argument("--qq-dsh-home", type=Path, required=True)
    child.add_argument("--pr-agent-launcher", type=Path, required=True)
    child.add_argument("--misospace-launcher", type=Path, required=True)
    child.add_argument("--run-id")
    child.set_defaults(function=command_run)
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        return args.function(args)
    except HostRunnerError as error:
        print(f"HOST RUNNER BLOCKED: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
