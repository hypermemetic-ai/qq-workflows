#!/usr/bin/env python3
"""Controlled paired benchmark for exactly three Grok code-review systems."""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import uuid

HERE = Path(__file__).resolve().parent
EXPECTED_ARMS = ("qq-mini-qa", "pr-agent", "misospace-pr-reviewer")
EXPECTED_PINS = {
    "qq-mini-qa": "54966c350fe7c7fc57af76f4bc449abef68b9d55",
    "pr-agent": "1b6925ba8cc3ef6be09dec704a374da53091926c",
    "misospace-pr-reviewer": "54dfb1aac20e1e410ad8f71dc3681b888500a1ec",
}
EXPECTED_QQ_TREES = {"src": "6df1f5909be6725d043ea5d44a7b10d2c41a5fec"}
QQ_RUNTIME_PATH_ENVS = (
    "GROK_BENCH_QQ_CORE_SOURCE", "GROK_BENCH_QQ_MODELS_SOURCE", "GROK_BENCH_QQ_DSH_HOME",
)
EXPECTED_QQ_BLOBS = {
    "src/mini-qa.mjs": "cef17a94aeb6e4b19e067fbd7315537f7bbd74e4",
    "src/mini-qa-v2.mjs": "64bda8b5967b1928bce788aaee89b0be9041989b",
    "src/official-mini.mjs": "45a1f1e002977f998b45977c1ba7f2d5b602d42b",
}
CONFIG_SCHEMA = "qq.grok-reviewer-benchmark-config/v1"
CORPUS_SCHEMA = "qq.grok-reviewer-corpus/v1"
RESULT_SCHEMA = "qq.grok-reviewer-arm-result/v1"
NORMALIZED_SCHEMA = "qq.grok-reviewer-normalized-run/v1"
TOKEN_FIELDS = (
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "processed_tokens",
)
CREDENTIAL_NAMES = {
    "XAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
    "GROK_BENCH_API_KEY", "GROK_BENCH_PROXY_API_KEY",
}
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class BenchmarkError(RuntimeError):
    pass


class RuntimeUnblock(BenchmarkError):
    def __init__(self, details: Iterable[str]) -> None:
        self.details = tuple(details)
        super().__init__("; ".join(self.details))


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"cannot read JSON {path}: {error}") from error


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_json(value), encoding="utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    try:
        return sha256_bytes(path.read_bytes())
    except OSError as error:
        raise BenchmarkError(f"cannot hash {path}: {error}") from error


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BenchmarkError(message)


def git_environment() -> dict[str, str]:
    """Return deterministic Git environment without inherited repository geometry."""
    environment = os.environ.copy()
    for name in list(environment):
        if name.startswith("GIT_"):
            environment.pop(name, None)
    environment.update({
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "cat",
    })
    return environment


def git(repository: Path, *arguments: str, text: bool = True, check: bool = True) -> Any:
    command = ["git", "-C", str(repository), *arguments]
    result = subprocess.run(
        command,
        env=git_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        check=False,
    )
    if check and result.returncode != 0:
        error = result.stderr if text else result.stderr.decode("utf-8", errors="replace")
        raise BenchmarkError(f"Git command failed in {repository}: {' '.join(arguments)}: {error.strip()}")
    return result.stdout


def resolve_relative(document: Path, relative: str) -> Path:
    require(isinstance(relative, str) and relative, f"invalid relative path in {document}")
    path = Path(relative)
    require(not path.is_absolute() and ".." not in path.parts, f"path escapes corpus: {relative}")
    return document.parent / path


def validate_config(path: Path) -> dict[str, Any]:
    value = read_json(path)
    require(isinstance(value, dict), "config must be an object")
    require(value.get("schema") == CONFIG_SCHEMA, "unsupported benchmark config schema")
    provider = value.get("provider")
    require(isinstance(provider, dict), "config.provider must be an object")
    require(provider.get("family") == "Grok", "all benchmark arms must use Grok")
    require(provider.get("provider_model") == "grok-4.6", "provider model must be exactly grok-4.6")
    arms = value.get("arms")
    require(isinstance(arms, list), "config.arms must be an array")
    ids = tuple(arm.get("id") for arm in arms if isinstance(arm, dict))
    require(ids == EXPECTED_ARMS, f"benchmark must contain exactly these three arms in order: {EXPECTED_ARMS}")
    for arm in arms:
        arm_id = arm["id"]
        require(arm.get("pin") == EXPECTED_PINS[arm_id], f"wrong frozen pin for {arm_id}")
        require(arm.get("provider_model") == "grok-4.6", f"{arm_id} is not configured for Grok 4.6")
        require(isinstance(arm.get("command_env"), str), f"{arm_id} command_env is required")
        require(isinstance(arm.get("source_env"), str), f"{arm_id} source_env is required")
        require(arm.get("mode", {}).get("publishing") is False, f"publishing must be off for {arm_id}")
    require(arms[0].get("required_trees") == EXPECTED_QQ_TREES, "wrong current qq source-tree pin")
    require(arms[0].get("required_blobs") == EXPECTED_QQ_BLOBS, "wrong current qq reviewer blob pins")
    require(arms[0].get("route") == "xai-auth/grok-4.6", "qq must use current xai-auth Grok route")
    require(arms[0].get("client_model") == "xai-auth/grok-4.6", "wrong qq model string")
    require(arms[1].get("client_model") == "xai/grok-4.6", "wrong PR-Agent model string")
    require(arms[1].get("mode", {}).get("plain_diff") is True, "PR-Agent must use plain-diff mode")
    require(arms[1].get("mode", {}).get("json_output") is True, "PR-Agent must emit JSON output")
    require(arms[2].get("client_model") == "grok-4.6", "wrong misospace model string")
    require(arms[2].get("mode", {}).get("tool_mode") == "off", "misospace tool_mode must remain off")
    execution = value.get("execution")
    require(isinstance(execution, dict), "execution config is required")
    require(execution.get("mode") == "sequential-case-waves-concurrent-arms",
            "execution must use sequential case waves with concurrent arms")
    require(tuple(execution.get("arm_wave", ())) == EXPECTED_ARMS,
            "arm_wave must contain exactly the settled three arms")
    require(execution.get("max_concurrent_arms") == len(EXPECTED_ARMS),
            "all three arms must be eligible to launch concurrently")
    skew = execution.get("max_arm_start_skew_seconds")
    require(isinstance(skew, (int, float)) and not isinstance(skew, bool) and skew > 0,
            "max_arm_start_skew_seconds must be positive")
    provider = value.get("provider")
    require(isinstance(provider, dict), "provider config is required")
    endpoints = provider.get("external_arm_endpoints")
    external_arms = EXPECTED_ARMS[1:]
    require(isinstance(endpoints, dict) and tuple(endpoints) == external_arms,
            "provider external_arm_endpoints must contain exactly PR-Agent and misospace")
    for arm_id, endpoint in endpoints.items():
        require(isinstance(endpoint, dict), f"provider endpoint for {arm_id} must be an object")
        require(isinstance(endpoint.get("base_url_env"), str) and endpoint["base_url_env"],
                f"provider endpoint base URL env is required for {arm_id}")
        require(isinstance(endpoint.get("api_key_env"), str) and endpoint["api_key_env"],
                f"provider endpoint API key env is required for {arm_id}")
    require(len({endpoint["api_key_env"] for endpoint in endpoints.values()}) == len(external_arms),
            "external arms require distinct synthetic bridge credential environments")
    readiness = provider.get("auth_readiness")
    require(isinstance(readiness, dict), "provider auth_readiness is required")
    require(readiness.get("mode") == "trusted-serial-before-wave-barrier-release",
            "provider auth readiness must run serially before each wave barrier release")
    require(isinstance(readiness.get("url_env"), str) and readiness["url_env"],
            "provider auth readiness URL environment is required")
    require(isinstance(readiness.get("api_key_env"), str) and readiness["api_key_env"],
            "provider auth readiness key environment is required")
    endpoint_envs = {item for endpoint in endpoints.values() for item in endpoint.values()}
    require(readiness["url_env"] not in endpoint_envs and readiness["api_key_env"] not in endpoint_envs,
            "auth readiness must use a separate trusted channel")
    return value


def validate_corpus(path: Path, *, verify_files: bool = True) -> dict[str, Any]:
    value = read_json(path)
    require(isinstance(value, dict) and value.get("schema") == CORPUS_SCHEMA, "unsupported corpus schema")
    require("truth" not in value and "known_defects" not in value, "execution corpus must not contain truth")
    standards = value.get("standards")
    require(isinstance(standards, dict) and HEX64.fullmatch(str(standards.get("sha256", ""))) is not None,
            "invalid standards record")
    cases = value.get("cases")
    require(isinstance(cases, list) and cases, "corpus needs at least one case")
    ids: set[str] = set()
    for case in cases:
        require(isinstance(case, dict), "case must be an object")
        case_id = case.get("id")
        require(isinstance(case_id, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", case_id) is not None,
                "case id must be neutral and filesystem-safe")
        require(case_id not in ids, f"duplicate case id: {case_id}")
        ids.add(case_id)
        for name in ("base", "head", "base_tree", "head_tree"):
            require(HEX40.fullmatch(str(case.get(name, ""))) is not None, f"invalid {name} for {case_id}")
        require(HEX64.fullmatch(str(case.get("diff_sha256", ""))) is not None,
                f"invalid diff hash for {case_id}")
        require(isinstance(case.get("changed_lines"), int) and case["changed_lines"] >= 0,
                f"invalid changed_lines for {case_id}")
        require(isinstance(case.get("changed_files"), int) and case["changed_files"] >= 0,
                f"invalid changed_files for {case_id}")
        require(isinstance(case.get("repository_env"), str), f"missing repository_env for {case_id}")
        task = case.get("task")
        require(isinstance(task, dict) and HEX64.fullmatch(str(task.get("sha256", ""))) is not None,
                f"invalid task record for {case_id}")
        if verify_files:
            task_path = resolve_relative(path, task["path"])
            require(sha256_file(task_path) == task["sha256"], f"task hash mismatch for {case_id}")
    if verify_files:
        standards_path = resolve_relative(path, standards["path"])
        require(sha256_file(standards_path) == standards["sha256"], "standards hash mismatch")
    return value


def case_repository(case: dict[str, Any]) -> Path:
    raw = os.environ.get(case["repository_env"])
    if not raw:
        raise RuntimeUnblock([f"{case['repository_env']} is not set"])
    return Path(raw).expanduser().resolve()


def case_integrity(case: dict[str, Any], corpus_path: Path, repository: Path) -> dict[str, Any]:
    require(repository.is_dir(), f"repository does not exist: {repository}")
    base = git(repository, "rev-parse", f"{case['base']}^{{commit}}").strip()
    head = git(repository, "rev-parse", f"{case['head']}^{{commit}}").strip()
    require(base == case["base"], f"base commit mismatch for {case['id']}")
    require(head == case["head"], f"head commit mismatch for {case['id']}")
    base_tree = git(repository, "rev-parse", f"{base}^{{tree}}").strip()
    head_tree = git(repository, "rev-parse", f"{head}^{{tree}}").strip()
    require(base_tree == case["base_tree"], f"base tree mismatch for {case['id']}")
    require(head_tree == case["head_tree"], f"head tree mismatch for {case['id']}")
    diff = git(
        repository, "diff", "--binary", "--full-index", "--no-ext-diff", base, head,
        text=False,
    )
    require(sha256_bytes(diff) == case["diff_sha256"], f"exact diff hash mismatch for {case['id']}")
    numstat = git(repository, "diff", "--numstat", base, head)
    changed_lines = 0
    for line in numstat.splitlines():
        columns = line.split("\t", 2)
        if len(columns) >= 2 and columns[0].isdigit() and columns[1].isdigit():
            changed_lines += int(columns[0]) + int(columns[1])
    changed_files = len([name for name in git(repository, "diff", "--name-only", "-z", base, head).split("\0") if name])
    require(changed_lines == case["changed_lines"], f"changed-line count mismatch for {case['id']}")
    require(changed_files == case["changed_files"], f"changed-file count mismatch for {case['id']}")
    task = case["task"]
    task_path = resolve_relative(corpus_path, task["path"])
    standards_path = resolve_relative(corpus_path, validate_corpus(corpus_path)["standards"]["path"])
    return {
        "case_id": case["id"],
        "repository_id": case["repository_id"],
        "base": base,
        "head": head,
        "base_tree": base_tree,
        "head_tree": head_tree,
        "diff_sha256": sha256_bytes(diff),
        "task_sha256": sha256_file(task_path),
        "standards_sha256": sha256_file(standards_path),
        "changed_lines": changed_lines,
        "changed_files": changed_files,
    }


def arm_source(arm: dict[str, Any]) -> Path | None:
    raw = os.environ.get(arm["source_env"])
    if raw:
        return Path(raw).expanduser().resolve()
    if arm["id"] != "qq-mini-qa":
        return None
    candidate = HERE.parent.parent
    if (candidate / ".git").exists():
        return candidate
    # Host task checkouts intentionally omit a .git entry and inject read-only
    # geometry. Use it only to locate the common product checkout for source-blob
    # verification; case Git operations always remain scrubbed and explicit.
    inherited_git_dir = os.environ.get("GIT_DIR")
    if inherited_git_dir:
        result = subprocess.run(
            ["git", "--git-dir", inherited_git_dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
            env=git_environment(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False,
        )
        if result.returncode == 0:
            common = Path(result.stdout.strip())
            if common.name == ".git" and common.parent.is_dir():
                return common.parent
    return None


def verify_arm_source(arm: dict[str, Any], source: Path) -> dict[str, Any]:
    require(source.is_dir(), f"tool source does not exist: {source}")
    pin = arm["pin"]
    resolved = git(source, "rev-parse", f"{pin}^{{commit}}").strip()
    require(resolved == pin, f"pinned commit is unavailable for {arm['id']}")
    actual_head = git(source, "rev-parse", "HEAD^{commit}").strip()
    if arm["id"] != "qq-mini-qa":
        require(actual_head == pin, f"{arm['id']} checkout HEAD must equal its exact pin")
    tracked_status = git(source, "status", "--porcelain", "--untracked-files=no").strip()
    require(tracked_status == "", f"{arm['id']} source checkout has tracked modifications")
    trees: dict[str, str] = {}
    for name, expected in arm.get("required_trees", {}).items():
        pinned_tree = git(source, "rev-parse", f"{pin}:{name}").strip()
        head_tree = git(source, "rev-parse", f"HEAD:{name}").strip()
        require(pinned_tree == expected and head_tree == expected,
                f"current qq source tree changed unexpectedly: {name}")
        trees[name] = head_tree
    blobs: dict[str, str] = {}
    for name, expected in arm.get("required_blobs", {}).items():
        pinned_blob = git(source, "rev-parse", f"{pin}:{name}").strip()
        head_blob = git(source, "rev-parse", f"HEAD:{name}").strip()
        require(pinned_blob == expected and head_blob == expected,
                f"current qq reviewer blob changed unexpectedly: {name}")
        blobs[name] = head_blob
    return {
        "pin": pin, "checkout_head": actual_head,
        "required_trees": trees, "required_blobs": blobs,
    }


def command_for_arm(arm: dict[str, Any]) -> list[str] | None:
    raw = os.environ.get(arm["command_env"])
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise BenchmarkError(f"{arm['command_env']} must be a JSON command array: {error}") from error
    require(isinstance(value, list) and value and all(isinstance(item, str) and item for item in value),
            f"{arm['command_env']} must be a nonempty JSON array of strings")
    upstream_keys = [
        item for name, item in os.environ.items()
        if name.startswith("GROK_BENCH_") and name.endswith("_API_KEY") and item
    ]
    require(all(key not in argument for key in upstream_keys for argument in value),
            "upstream credential must not appear in command")
    return value


def validate_bridge_url(raw: str) -> None:
    parsed = urlsplit(raw)
    require(parsed.scheme in {"http", "https"} and bool(parsed.netloc),
            "Grok bridge base URL must be http(s)")
    require(not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
            "Grok bridge base URL must not contain credentials, query, or fragment")


def runtime_readiness(config: dict[str, Any], corpus: dict[str, Any], corpus_path: Path) -> dict[str, Any]:
    missing: list[str] = []
    repositories: dict[str, Path] = {}
    integrity: list[dict[str, Any]] = []
    for case in corpus["cases"]:
        raw = os.environ.get(case["repository_env"])
        if not raw:
            missing.append(f"missing frozen repository {case['repository_env']}")
            continue
        repository = Path(raw).expanduser().resolve()
        repositories[case["repository_id"]] = repository
        try:
            integrity.append(case_integrity(case, corpus_path, repository))
        except BenchmarkError as error:
            missing.append(str(error))
    sources: dict[str, dict[str, Any]] = {}
    commands: dict[str, list[str]] = {}
    for arm in config["arms"]:
        source = arm_source(arm)
        if source is None:
            missing.append(f"missing pinned source {arm['source_env']}")
        else:
            try:
                sources[arm["id"]] = verify_arm_source(arm, source)
            except BenchmarkError as error:
                missing.append(str(error))
        command = command_for_arm(arm)
        if command is None:
            missing.append(f"missing approved launcher {arm['command_env']}")
        else:
            commands[arm["id"]] = command
    for name in QQ_RUNTIME_PATH_ENVS:
        raw = os.environ.get(name)
        if not raw:
            missing.append(f"missing trusted qq runtime path {name}")
        elif not Path(raw).expanduser().resolve().is_dir():
            missing.append(f"trusted qq runtime path is not a directory: {name}")
    provider = config["provider"]
    endpoints: dict[str, dict[str, str]] = {}
    for arm_id, endpoint in provider["external_arm_endpoints"].items():
        base_name = endpoint["base_url_env"]
        key_name = endpoint["api_key_env"]
        base_url = os.environ.get(base_name)
        api_key = os.environ.get(key_name)
        if not base_url or not api_key:
            missing.append(
                f"missing sanctioned shared Grok bridge endpoint for {arm_id} ({base_name} + {key_name})"
            )
        else:
            try:
                validate_bridge_url(base_url)
                endpoints[arm_id] = {"base_url_env": base_name, "api_key_env": key_name}
            except BenchmarkError as error:
                missing.append(f"{arm_id}: {error}")
    auth_ready = provider["auth_readiness"]
    ready_url = os.environ.get(auth_ready["url_env"])
    ready_key = os.environ.get(auth_ready["api_key_env"])
    if not ready_url or not ready_key:
        missing.append(
            f"missing trusted auth readiness channel ({auth_ready['url_env']} + {auth_ready['api_key_env']})"
        )
    else:
        try:
            validate_bridge_url(ready_url)
        except BenchmarkError as error:
            missing.append(f"auth readiness: {error}")
    if missing:
        raise RuntimeUnblock(missing)
    return {
        "repositories": {key: str(value) for key, value in repositories.items()},
        "integrity": integrity,
        "sources": sources,
        "commands": commands,
        "endpoints": endpoints,
    }


def provider_auth_readiness(config: dict[str, Any]) -> dict[str, Any]:
    """Refresh/read the shared host auth store just before a wave is released."""
    spec = config["provider"]["auth_readiness"]
    url = os.environ.get(spec["url_env"])
    key = os.environ.get(spec["api_key_env"])
    require(bool(url and key), "trusted auth readiness channel is unavailable")
    validate_bridge_url(url)
    started = time.monotonic_ns()
    checked_at = datetime.now(timezone.utc).isoformat()
    request = Request(
        url, data=b"", method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Length": "0"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"trusted pre-wave auth readiness failed: {type(error).__name__}: {error}") from error
    require(payload.get("schema") == "qq.grok-xai-auth-readiness/v1", "auth readiness returned wrong schema")
    require(payload.get("status") == "ready" and payload.get("model") == "grok-4.6",
            "auth readiness did not confirm Grok 4.6")
    require(payload.get("forced") is True, "auth readiness did not force a token rotation")
    require(isinstance(payload.get("refreshed"), bool), "auth readiness omitted refresh evidence")
    require(payload.get("fresh") is True, "auth readiness did not prove a token outside the refresh window")
    return {
        "status": "ready", "model": "grok-4.6", "checked_at": checked_at,
        "forced": True, "refreshed": payload["refreshed"], "fresh": True,
        "elapsed_seconds": round((time.monotonic_ns() - started) / 1_000_000_000, 6),
    }


def print_unblock(error: RuntimeUnblock) -> None:
    print("RUNTIME BLOCKED", file=sys.stderr)
    for detail in error.details:
        print(f"- {detail}", file=sys.stderr)
    print(
        "UNBLOCK: in the normal host namespace run `python3 "
        "experiments/grok-reviewer-benchmark/host/runner.py request --root <private-root>` "
        "and execute its emitted public-Git provision command; no API key input is requested.",
        file=sys.stderr,
    )


def create_sandbox(repository: Path, base: str, head: str, destination: Path) -> None:
    destination.mkdir(parents=True)
    subprocess.run(["git", "init", "--quiet", str(destination)], env=git_environment(), check=True)
    common_git = Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir").strip())
    object_path = (common_git / "objects").resolve()
    require(object_path.is_dir(), f"source object database is unavailable: {object_path}")
    alternates = destination / ".git" / "objects" / "info" / "alternates"
    alternates.parent.mkdir(parents=True, exist_ok=True)
    alternates.write_text(str(object_path) + "\n", encoding="utf-8")
    git(destination, "config", "core.hooksPath", os.devnull)
    git(destination, "checkout", "--quiet", "--detach", head)
    require(git(destination, "rev-parse", "HEAD^{commit}").strip() == head, "sandbox head mismatch")
    # Prove both endpoints are available before the reviewer starts.
    require(git(destination, "rev-parse", f"{base}^{{commit}}").strip() == base, "sandbox base missing")
    require(git(destination, "status", "--porcelain").strip() == "", "sandbox is not clean")


def sanitized_child_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in list(environment):
        upper = name.upper()
        if (
            name in CREDENTIAL_NAMES
            or upper.endswith("_API_KEY") or upper.endswith("_TOKEN")
            or upper.endswith("_PASSWORD") or upper.endswith("_SECRET")
            or upper.startswith(("AWS_", "AZURE_", "GOOGLE_", "GROK_BENCH_", "BENCH_"))
            or upper in {"SSH_AUTH_SOCK", "DOCKER_AUTH_CONFIG", "NETRC", "PYTHONPATH", "OLDPWD"}
        ):
            environment.pop(name, None)
        if name.startswith("GIT_"):
            environment.pop(name, None)
    environment.update({
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_PAGER": "cat",
    })
    return environment


def start_proxy(directory: Path, upstream: str, api_key: str) -> tuple[subprocess.Popen[bytes], str]:
    ready = directory / "proxy-ready.json"
    proxy_output = directory / "provider"
    stdout = (directory / "proxy.stdout").open("wb")
    stderr = (directory / "proxy.stderr").open("wb")
    environment = sanitized_child_environment()
    environment["GROK_BENCH_PROXY_UPSTREAM"] = upstream
    environment["GROK_BENCH_PROXY_API_KEY"] = api_key
    process = subprocess.Popen(
        [sys.executable, str(HERE / "capture_proxy.py"), "--output", str(proxy_output),
         "--ready-file", str(ready)],
        stdout=stdout,
        stderr=stderr,
        env=environment,
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if ready.is_file():
            value = read_json(ready)
            return process, value["base_url"]
        if process.poll() is not None:
            break
        time.sleep(0.05)
    process.terminate()
    raise BenchmarkError("capture proxy did not become ready")


def stop_proxy(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def normalize_usage(value: Any, *, complete: bool) -> dict[str, int | None]:
    require(isinstance(value, dict), "usage must be an object")
    normalized: dict[str, int | None] = {}
    for field in TOKEN_FIELDS:
        item = value.get(field)
        if item is None and not complete:
            normalized[field] = None
        else:
            require(isinstance(item, int) and not isinstance(item, bool) and item >= 0,
                    f"invalid usage field {field}")
            normalized[field] = item
    if complete:
        require(
            normalized["processed_tokens"]
            == normalized["input_tokens"] + normalized["cache_read_tokens"]
            + normalized["cache_write_tokens"] + normalized["output_tokens"],
            "processed_tokens must be uncached input + cache read/write + output; reasoning is not added twice",
        )
    return normalized


def aggregate_proxy_usage(provider_dir: Path, expected_model: str) -> tuple[dict[str, int], list[dict[str, Any]]]:
    log = provider_dir / "responses.jsonl"
    require(log.is_file(), "capture proxy produced no response log")
    records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
    require(records, "capture proxy recorded no requests")
    total = {field: 0 for field in TOKEN_FIELDS}
    usage_records = 0
    for record in records:
        request_model = record.get("request_model")
        response_model = record.get("response_model")
        if request_model is not None:
            require(request_model == expected_model, f"provider request used non-frozen model {request_model}")
        if response_model is not None:
            require(response_model == expected_model, f"provider response identified as {response_model}")
        if record.get("usage") is not None:
            usage = normalize_usage(record["usage"], complete=True)
            for field in TOKEN_FIELDS:
                total[field] += int(usage[field] or 0)
            usage_records += 1
    require(usage_records > 0, "provider responses contained no complete token usage")
    return total, records


def compare_reported_usage(reported: dict[str, int | None], captured: dict[str, int]) -> dict[str, Any]:
    compared: list[str] = []
    mismatches: dict[str, dict[str, int]] = {}
    for field, value in reported.items():
        if value is None:
            continue
        compared.append(field)
        if value != captured[field]:
            mismatches[field] = {"tool_reported": value, "captured": captured[field]}
    return {"compared_fields": compared, "mismatches": mismatches, "verified": not mismatches}


def validate_finding(value: Any) -> dict[str, Any]:
    require(isinstance(value, dict), "finding must be an object")
    path = value.get("path")
    require(path is None or isinstance(path, str) and path and not Path(path).is_absolute(),
            "finding path must be repository-relative or null")
    if path is not None:
        require(".." not in Path(path).parts, "finding path escapes repository")
    line = value.get("line")
    require(line is None or isinstance(line, int) and not isinstance(line, bool) and line >= 1,
            "finding line must be positive or null")
    require(isinstance(value.get("body"), str) and value["body"].strip(), "finding body is required")
    severity = value.get("severity")
    require(severity is None or isinstance(severity, str), "finding severity must be string or null")
    confidence = value.get("confidence")
    require(confidence is None or isinstance(confidence, (int, float)) and not isinstance(confidence, bool),
            "finding confidence must be numeric or null")
    blocks_merge = value.get("blocks_merge")
    require(blocks_merge is None or isinstance(blocks_merge, bool),
            "finding blocks_merge must be boolean or null")
    return {
        "path": path, "line": line, "body": value["body"].strip(),
        "severity": severity, "confidence": confidence, "blocks_merge": blocks_merge,
    }


def validate_arm_result(
    value: Any,
    arm: dict[str, Any],
    case: dict[str, Any],
    proxy_usage: dict[str, int] | None,
    proxy_records: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    require(isinstance(value, dict) and value.get("schema") == RESULT_SCHEMA, "invalid arm result schema")
    require(value.get("arm_id") == arm["id"], "arm result identity mismatch")
    require(value.get("case_id") == case["id"], "arm result case mismatch")
    require(value.get("model") == arm["client_model"], f"{arm['id']} did not identify exact configured model")
    require(value.get("provider_model") == arm["provider_model"], f"{arm['id']} provider is not Grok 4.6")
    require(value.get("mode") == arm["mode"], f"{arm['id']} effective mode differs from frozen mode")
    require(isinstance(value.get("effective_config"), dict), "full effective_config dump is required")
    native_verdict = value.get("native_verdict")
    require(native_verdict in {None, "approve", "request_changes"}, "invalid native_verdict")
    normalized_verdict = value.get("normalized_verdict")
    require(normalized_verdict in {None, "pass", "fail"}, "invalid normalized_verdict")
    verdict_source = value.get("verdict_source")
    require(verdict_source in {"native", "adapter_findings", "none"}, "invalid verdict_source")
    if verdict_source == "native":
        require(native_verdict is not None and normalized_verdict == (
            "pass" if native_verdict == "approve" else "fail"
        ), "native verdict mapping is inconsistent")
    elif verdict_source == "adapter_findings":
        require(native_verdict is None and normalized_verdict is not None,
                "adapter-derived verdict must have no native verdict")
    else:
        require(native_verdict is None and normalized_verdict is None,
                "none verdict source cannot carry a verdict")
    findings = value.get("findings")
    require(isinstance(findings, list), "findings must be an array")
    findings = [validate_finding(item) for item in findings]
    isolation = value.get("isolation")
    require(isinstance(isolation, dict), "isolation attestation is required")
    require(isolation.get("prior_findings_visible") is False, "arm could read prior findings")
    require(isolation.get("publishing") is False, "arm publishing was not disabled")
    provider_evidence = value.get("provider_evidence")
    if arm["id"] == "qq-mini-qa":
        require(isinstance(provider_evidence, dict), "qq host provider model evidence is required")
        for name in ("request_models", "response_models"):
            models = provider_evidence.get(name)
            require(isinstance(models, list) and models, f"provider {name} evidence is required")
            require(all(model == arm["provider_model"] for model in models),
                    f"{arm['id']} {name} contain a non-Grok model")
    elif provider_evidence is not None:
        require(isinstance(provider_evidence, dict), "provider model evidence must be an object")
    telemetry = value.get("telemetry")
    require(isinstance(telemetry, dict), "telemetry is required")
    normalized_telemetry: dict[str, int | None] = {}
    for name in ("request_count", "retries", "failures", "truncation_events", "context_events"):
        item = telemetry.get(name)
        if name == "request_count" and arm["id"] != "qq-mini-qa" and item is None:
            normalized_telemetry[name] = None
            continue
        require(isinstance(item, int) and not isinstance(item, bool) and item >= 0, f"invalid telemetry {name}")
        normalized_telemetry[name] = item

    tool_reported = None
    usage_verification: dict[str, Any]
    usage = value.get("usage")
    require(isinstance(usage, dict), "usage object is required")
    if usage.get("tool_reported") is not None:
        tool_reported = normalize_usage(usage["tool_reported"], complete=False)
    if proxy_usage is not None:
        captured = proxy_usage
        proxy_request_count = len(proxy_records or [])
        if normalized_telemetry["request_count"] is not None:
            require(normalized_telemetry["request_count"] == proxy_request_count,
                    "tool request count differs from capture proxy")
        normalized_telemetry["request_count"] = proxy_request_count
        successful_responses = sum(record.get("usage") is not None for record in (proxy_records or []))
        normalized_telemetry["retries"] = max(proxy_request_count - successful_responses, 0)
        normalized_telemetry["failures"] = sum(
            record.get("usage") is None or int(record.get("status", 0)) >= 400
            for record in (proxy_records or [])
        )
        normalized_telemetry["truncation_events"] = sum(
            "length" in record.get("finish_reasons", []) for record in (proxy_records or [])
        )
        normalized_telemetry["context_events"] = sum(
            record.get("context_event") is True for record in (proxy_records or [])
        )
        captured_evidence = {
            "request_models": [record["request_model"] for record in (proxy_records or [])
                               if record.get("request_model") is not None],
            "response_models": [record["response_model"] for record in (proxy_records or [])
                                if record.get("response_model") is not None],
        }
        if provider_evidence is not None:
            require(provider_evidence == captured_evidence,
                    "launcher provider model evidence differs from capture proxy")
        provider_evidence = captured_evidence
        require(provider_evidence["request_models"] and provider_evidence["response_models"],
                "capture proxy did not prove request/response Grok model identity")
        usage_verification = (
            compare_reported_usage(tool_reported, captured)
            if tool_reported is not None
            else {"compared_fields": [], "mismatches": {}, "verified": None, "reason": "tool output is incomplete"}
        )
        require(not usage_verification["mismatches"], "tool-reported usage differs from provider responses")
        if arm["id"] == "pr-agent":
            require(tool_reported is not None, "PR-Agent --json-output accumulated usage is required")
    else:
        host_captured = usage.get("host_captured")
        require(host_captured is not None, "qq runner must provide host-captured provider usage")
        captured = {key: int(value or 0) for key, value in normalize_usage(host_captured, complete=True).items()}
        require(normalized_telemetry["request_count"] >= 1, "qq host response log must report request count")
        usage_verification = (
            compare_reported_usage(tool_reported, captured)
            if tool_reported is not None
            else {"compared_fields": [], "mismatches": {}, "verified": None,
                  "reason": "host-captured response usage is authoritative"}
        )
        require(not usage_verification["mismatches"], "qq reported usage differs from host response usage")
    return {
        "native_verdict": native_verdict,
        "normalized_verdict": normalized_verdict,
        "verdict_source": verdict_source,
        "findings": findings,
        "effective_config": value["effective_config"],
        "provider_evidence": provider_evidence,
        "telemetry": normalized_telemetry,
        "usage": captured,
        "usage_verification": usage_verification,
    }


def run_one(
    config: dict[str, Any], corpus: dict[str, Any], corpus_path: Path,
    case: dict[str, Any], arm: dict[str, Any], repository: Path,
    command: list[str], source: Path, final_directory: Path,
    start_barrier: threading.Barrier | None = None,
) -> dict[str, Any]:
    # Required immediately before every arm, not merely once at run start.
    integrity_before = case_integrity(case, corpus_path, repository)
    stage_root = Path(tempfile.mkdtemp(prefix=f"grok-review-{case['id']}-{arm['id']}-"))
    os.chmod(stage_root, 0o700)
    sandbox = stage_root / "workspace"
    inputs = stage_root / "inputs"
    output = stage_root / "output"
    inputs.mkdir()
    output.mkdir()
    create_sandbox(repository, case["base"], case["head"], sandbox)
    diff = git(repository, "diff", "--binary", "--full-index", "--no-ext-diff",
               case["base"], case["head"], text=False)
    (inputs / "diff.patch").write_bytes(diff)
    task_path = resolve_relative(corpus_path, case["task"]["path"])
    standards_path = resolve_relative(corpus_path, corpus["standards"]["path"])
    shutil.copyfile(task_path, inputs / "task.md")
    shutil.copyfile(standards_path, inputs / "standards.md")
    input_manifest = {
        "case_id": case["id"], "repository_id": case["repository_id"],
        "base": case["base"], "head": case["head"],
        "diff_sha256": case["diff_sha256"], "task_sha256": case["task"]["sha256"],
        "standards_sha256": corpus["standards"]["sha256"],
    }
    write_json(inputs / "manifest.json", input_manifest)

    child_environment = sanitized_child_environment()
    private_home = stage_root / "home"
    private_tmp = stage_root / "tmp"
    private_home.mkdir(mode=0o700)
    private_tmp.mkdir(mode=0o700)
    child_environment.update({
        "HOME": str(private_home), "XDG_CONFIG_HOME": str(private_home / ".config"),
        "XDG_CACHE_HOME": str(private_home / ".cache"), "TMPDIR": str(private_tmp),
        "PWD": str(sandbox),
    })
    source_state = verify_arm_source(arm, source)
    result_path = output / "result.json"
    child_environment.update({
        "BENCH_ARM_ID": arm["id"], "BENCH_CASE_ID": case["id"],
        "BENCH_REPOSITORY": str(sandbox), "BENCH_BASE": case["base"], "BENCH_HEAD": case["head"],
        "BENCH_DIFF_PATH": str(inputs / "diff.patch"), "BENCH_TASK_PATH": str(inputs / "task.md"),
        "BENCH_STANDARDS_PATH": str(inputs / "standards.md"),
        "BENCH_INPUT_MANIFEST": str(inputs / "manifest.json"),
        "BENCH_RESULT_PATH": str(result_path), "BENCH_OUTPUT_DIR": str(output),
        "BENCH_TOOL_SOURCE": str(source), "BENCH_CLIENT_MODEL": arm["client_model"],
        "BENCH_PROVIDER_MODEL": arm["provider_model"],
    })
    if arm["id"] == "qq-mini-qa":
        for source_name, child_name in (
            ("GROK_BENCH_QQ_CORE_SOURCE", "BENCH_QQ_CORE_SOURCE"),
            ("GROK_BENCH_QQ_MODELS_SOURCE", "BENCH_QQ_MODELS_SOURCE"),
            ("GROK_BENCH_QQ_DSH_HOME", "BENCH_QQ_DSH_HOME"),
        ):
            raw = os.environ.get(source_name)
            require(bool(raw), f"missing trusted qq runtime path {source_name}")
            child_environment[child_name] = str(Path(raw).expanduser().resolve())
    proxy: subprocess.Popen[bytes] | None = None
    proxy_usage = None
    proxy_records = None
    if arm["id"] != "qq-mini-qa":
        endpoint = config["provider"]["external_arm_endpoints"][arm["id"]]
        proxy, local_base = start_proxy(
            stage_root,
            os.environ[endpoint["base_url_env"]],
            os.environ[endpoint["api_key_env"]],
        )
        child_environment.update({
            "BENCH_OPENAI_BASE_URL": local_base,
            "OPENAI_BASE_URL": local_base,
            "OPENAI_API_KEY": "benchmark-local-proxy",
            "XAI_API_KEY": "benchmark-local-proxy",
        })

    if start_barrier is not None:
        try:
            start_barrier.wait(timeout=60)
        except BaseException as error:
            if proxy is not None:
                stop_proxy(proxy)
            shutil.rmtree(stage_root, ignore_errors=True)
            if isinstance(error, threading.BrokenBarrierError):
                raise BenchmarkError(f"arm launch barrier failed for {case['id']}/{arm['id']}") from error
            raise
    started_at = datetime.now(timezone.utc).isoformat()
    started_ns = time.monotonic_ns()
    returncode: int | None = None
    timeout = False
    execution_error: str | None = None
    with (stage_root / "stdout.bin").open("wb") as stdout, (stage_root / "stderr.bin").open("wb") as stderr:
        try:
            process = subprocess.Popen(
                command, cwd=sandbox, env=child_environment,
                stdout=stdout, stderr=stderr, start_new_session=True,
            )
            try:
                returncode = process.wait(timeout=config["execution"]["timeout_seconds"])
            except subprocess.TimeoutExpired:
                timeout = True
                execution_error = "timeout"
                try:
                    os.killpg(process.pid, 15)
                except ProcessLookupError:
                    pass
                try:
                    returncode = process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, 9)
                    except ProcessLookupError:
                        pass
                    returncode = process.wait(timeout=5)
        except OSError as error:
            execution_error = f"{type(error).__name__}: {error}"
    wall_seconds = (time.monotonic_ns() - started_ns) / 1_000_000_000
    finished_at = datetime.now(timezone.utc).isoformat()
    if proxy is not None:
        stop_proxy(proxy)
        try:
            proxy_usage, proxy_records = aggregate_proxy_usage(stage_root / "provider", arm["provider_model"])
        except BenchmarkError as error:
            execution_error = f"{execution_error + '; ' if execution_error else ''}{error}"

    normalized_payload: dict[str, Any] | None = None
    result_error: str | None = None
    if returncode == 0 and result_path.is_file() and execution_error is None:
        try:
            normalized_payload = validate_arm_result(
                read_json(result_path), arm, case, proxy_usage, proxy_records,
            )
        except BenchmarkError as error:
            result_error = str(error)
    else:
        if returncode not in (None, 0):
            result_error = f"launcher exited {returncode}"
        elif not result_path.is_file() and execution_error is None:
            result_error = "launcher wrote no result.json"

    sandbox_status = git(sandbox, "status", "--porcelain").strip()
    sandbox_head = git(sandbox, "rev-parse", "HEAD^{commit}").strip()
    if sandbox_status or sandbox_head != case["head"]:
        result_error = "reviewer mutated the frozen repository"
    integrity_after = case_integrity(case, corpus_path, repository)
    require(integrity_after == integrity_before, "source case changed during arm run")

    normalized = {
        "schema": NORMALIZED_SCHEMA,
        "arm_id": arm["id"], "case_id": case["id"],
        "model": arm["client_model"], "provider_model": arm["provider_model"],
        "source": source_state, "command": command,
        "started_at": started_at, "finished_at": finished_at,
        "started_monotonic_ns": started_ns,
        "wall_clock_seconds": round(wall_seconds, 6),
        "returncode": returncode, "timeout": timeout,
        "failure": execution_error or result_error,
        "integrity_before": integrity_before, "integrity_after": integrity_after,
        "prior_findings_exposed": False,
        "result": normalized_payload,
    }
    write_json(stage_root / "normalized.json", normalized)
    shutil.rmtree(sandbox)
    final_directory.parent.mkdir(parents=True, exist_ok=True)
    require(not final_directory.exists(), f"artifact collision: {final_directory}")
    shutil.move(str(stage_root), str(final_directory))
    return normalized


def command_verify(args: argparse.Namespace) -> int:
    validate_config(args.config)
    corpus = validate_corpus(args.corpus)
    reports = []
    missing = []
    for case in corpus["cases"]:
        raw = os.environ.get(case["repository_env"])
        if not raw:
            missing.append(case["repository_env"])
            continue
        reports.append(case_integrity(case, args.corpus, Path(raw).expanduser().resolve()))
    if missing:
        raise RuntimeUnblock([f"missing frozen repository {name}" for name in missing])
    print(canonical_json({"status": "ok", "cases": reports}), end="")
    return 0


def command_doctor(args: argparse.Namespace) -> int:
    config = validate_config(args.config)
    corpus = validate_corpus(args.corpus)
    readiness = runtime_readiness(config, corpus, args.corpus)
    print(canonical_json({"status": "ready", **readiness}), end="")
    return 0


def command_run(args: argparse.Namespace) -> int:
    config = validate_config(args.config)
    corpus = validate_corpus(args.corpus)
    readiness = runtime_readiness(config, corpus, args.corpus)
    selected_cases = set(args.case or [])
    selected_arms = set(args.arm or [])
    known_cases = {case["id"] for case in corpus["cases"]}
    require(selected_cases <= known_cases, f"unknown selected cases: {sorted(selected_cases - known_cases)}")
    require(selected_arms <= set(EXPECTED_ARMS), f"unknown selected arms: {sorted(selected_arms - set(EXPECTED_ARMS))}")
    cases = [case for case in corpus["cases"] if not selected_cases or case["id"] in selected_cases]
    arm_wave = [arm_id for arm_id in config["execution"]["arm_wave"] if not selected_arms or arm_id in selected_arms]
    require(cases and arm_wave, "selected benchmark job set is empty")

    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+", run_id) is not None, "unsafe run id")
    root = args.output or (HERE / config["execution"]["artifacts_directory"] / run_id)
    root = root.resolve()
    require(not root.exists(), f"run directory already exists: {root}")
    root.mkdir(parents=True, mode=0o700)
    write_json(root / "config.snapshot.json", config)
    write_json(root / "corpus.snapshot.json", corpus)
    run_manifest = {
        "schema": "qq.grok-reviewer-benchmark-run/v1",
        "run_id": run_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "serial": False,
        "execution_mode": "sequential-case-waves-concurrent-arms",
        "provider_family": "Grok",
        "provider_model": "grok-4.6",
        "selection": {"cases": sorted(selected_cases), "arms": sorted(selected_arms)},
        "waves": [],
        "results": [],
    }
    write_json(root / "run.json", run_manifest)
    arms = {arm["id"]: arm for arm in config["arms"]}
    sources = {arm_id: arm_source(arms[arm_id]) for arm_id in EXPECTED_ARMS}
    repositories = {case["repository_id"]: case_repository(case) for case in corpus["cases"]}

    for wave_index, case in enumerate(cases):
        dispatched_ns = time.monotonic_ns()
        wave_record: dict[str, Any] = {
            "wave_index": wave_index,
            "case_id": case["id"],
            "arm_ids": list(arm_wave),
            "dispatched_at": datetime.now(timezone.utc).isoformat(),
            "status": "running",
            "auth_readiness": None,
            "common_wave_start_at": None,
            "common_wave_start_monotonic_ns": None,
            "arm_started_at": {},
            "arm_start_offset_seconds": {},
            "arm_start_offset_from_common_seconds": {},
        }
        run_manifest["waves"].append(wave_record)
        write_json(root / "run.json", run_manifest)

        def release_wave() -> None:
            wave_record["auth_readiness"] = provider_auth_readiness(config)
            write_json(root / "run.json", run_manifest)
            # Set these last: Barrier releases all waiters immediately after its
            # action returns, with no I/O between this timestamp and release.
            wave_record["common_wave_start_at"] = datetime.now(timezone.utc).isoformat()
            wave_record["common_wave_start_monotonic_ns"] = time.monotonic_ns()

        # The action runs exactly once, after all isolated arms/proxies are
        # staged and before the barrier releases any reviewer generation.
        barrier = threading.Barrier(len(arm_wave), action=release_wave)

        def execute_arm(arm_id: str) -> dict[str, Any]:
            try:
                return run_one(
                    config, corpus, args.corpus, case, arms[arm_id],
                    repositories[case["repository_id"]], readiness["commands"][arm_id],
                    sources[arm_id], root / "cases" / case["id"] / arm_id,
                    start_barrier=barrier,
                )
            except BaseException:
                barrier.abort()
                raise

        normalized_by_arm: dict[str, dict[str, Any]] = {}
        infrastructure_errors: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=len(arm_wave), thread_name_prefix=f"review-{case['id']}") as executor:
            future_arms = {executor.submit(execute_arm, arm_id): arm_id for arm_id in arm_wave}
            for future in as_completed(future_arms):
                arm_id = future_arms[future]
                try:
                    normalized_by_arm[arm_id] = future.result()
                except BaseException as error:
                    infrastructure_errors[arm_id] = f"{type(error).__name__}: {error}"

        start_values = []
        for arm_id in arm_wave:
            normalized = normalized_by_arm.get(arm_id)
            if normalized is None:
                continue
            started_ns = normalized["started_monotonic_ns"]
            start_values.append(started_ns)
            wave_record["arm_started_at"][arm_id] = normalized["started_at"]
            wave_record["arm_start_offset_seconds"][arm_id] = round(
                (started_ns - dispatched_ns) / 1_000_000_000, 6,
            )
            wave_record["arm_start_offset_from_common_seconds"][arm_id] = round(
                (started_ns - wave_record["common_wave_start_monotonic_ns"]) / 1_000_000_000, 6,
            )
            run_manifest["results"].append({
                "case_id": case["id"], "arm_id": arm_id,
                "artifact": f"cases/{case['id']}/{arm_id}",
                "wall_clock_seconds": normalized["wall_clock_seconds"],
                "failure": normalized["failure"],
            })
        start_skew = (max(start_values) - min(start_values)) / 1_000_000_000 if start_values else None
        wave_record.update({
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "status": "infrastructure-failure" if infrastructure_errors else "complete",
            "infrastructure_errors": infrastructure_errors,
            "arm_start_skew_seconds": round(start_skew, 6) if start_skew is not None else None,
            "start_skew_target_seconds": config["execution"]["max_arm_start_skew_seconds"],
            "within_start_skew_target": (
                start_skew <= config["execution"]["max_arm_start_skew_seconds"]
                if start_skew is not None and len(start_values) == len(arm_wave) else False
            ),
        })
        write_json(root / "run.json", run_manifest)
        if infrastructure_errors:
            raise BenchmarkError(
                f"case wave {case['id']} infrastructure failure: "
                + "; ".join(f"{arm_id}: {message}" for arm_id, message in infrastructure_errors.items())
            )
        if wave_index != len(cases) - 1 and config["execution"]["cooldown_seconds"]:
            time.sleep(config["execution"]["cooldown_seconds"])
    print(canonical_json(run_manifest), end="")
    return 1 if any(item["failure"] is not None for item in run_manifest["results"]) else 0


def command_freeze_case(args: argparse.Namespace) -> int:
    repository = args.repository.resolve()
    base = git(repository, "rev-parse", f"{args.base}^{{commit}}").strip()
    head = git(repository, "rev-parse", f"{args.head}^{{commit}}").strip()
    diff = git(repository, "diff", "--binary", "--full-index", "--no-ext-diff", base, head, text=False)
    numstat = git(repository, "diff", "--numstat", base, head)
    lines = sum(
        int(parts[0]) + int(parts[1])
        for line in numstat.splitlines()
        if len(parts := line.split("\t", 2)) >= 2 and parts[0].isdigit() and parts[1].isdigit()
    )
    files = len([item for item in git(repository, "diff", "--name-only", "-z", base, head).split("\0") if item])
    value = {
        "id": args.case_id, "repository_id": args.repository_id, "repository_env": args.repository_env,
        "base": base, "head": head,
        "base_tree": git(repository, "rev-parse", f"{base}^{{tree}}").strip(),
        "head_tree": git(repository, "rev-parse", f"{head}^{{tree}}").strip(),
        "diff_sha256": sha256_bytes(diff), "changed_lines": lines, "changed_files": files,
        "task": {"path": args.task_path, "sha256": sha256_file(args.task)},
    }
    print(canonical_json(value), end="")
    return 0


def load_run_results(run: Path) -> list[dict[str, Any]]:
    manifest = read_json(run / "run.json")
    results = []
    for item in manifest.get("results", []):
        normalized = read_json(run / item["artifact"] / "normalized.json")
        if normalized.get("failure") is None and normalized.get("result") is not None:
            results.append(normalized)
    return results


def command_blind(args: argparse.Namespace) -> int:
    results = load_run_results(args.run)
    require(results, "run has no successful results to adjudicate")
    entries: list[dict[str, Any]] = []
    secret_map: list[dict[str, Any]] = []
    for result in results:
        for index, finding in enumerate(result["result"]["findings"]):
            blind_id = f"F-{uuid.uuid4().hex[:12]}"
            entries.append({
                "blind_id": blind_id, "case_id": result["case_id"],
                "path": finding["path"], "line": finding["line"], "body": finding["body"],
                "reported_severity": finding["severity"], "reported_confidence": finding["confidence"],
                "rubric": {
                    "introduced_by_diff": None, "concrete_reproducible_trigger": None,
                    "behavior_claim_correct": None, "actionable_path_line": None,
                    "nonduplicate": None, "cluster_id": None, "known_defect_id": None,
                    "severity": None, "confidence": None, "notes": "",
                },
            })
            secret_map.append({
                "blind_id": blind_id, "case_id": result["case_id"], "arm_id": result["arm_id"],
                "finding_index": index, "reported_blocker": finding["blocks_merge"] is True,
            })
    random.Random(args.seed).shuffle(entries)
    destination = args.output.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    write_json(destination / "packet.json", {
        "schema": "qq.grok-reviewer-adjudication/v1", "seed": args.seed,
        "instructions": "Complete every rubric field without opening blind-map.json.",
        "entries": entries,
    })
    write_json(destination / "blind-map.json", {
        "schema": "qq.grok-reviewer-blind-map/v1", "entries": secret_map,
    })
    os.chmod(destination / "blind-map.json", 0o600)
    return 0


def adjudication_valid(rubric: dict[str, Any]) -> bool:
    return all(rubric[name] is True for name in (
        "introduced_by_diff", "concrete_reproducible_trigger", "behavior_claim_correct", "actionable_path_line",
    ))


def command_score(args: argparse.Namespace) -> int:
    truth = read_json(args.truth)
    packet = read_json(args.adjudication)
    blind_map = read_json(args.blind_map)
    mapping = {item["blind_id"]: item for item in blind_map["entries"]}
    truth_cases = truth.get("cases")
    require(isinstance(truth_cases, dict), "invalid truth cases")
    observations: list[dict[str, Any]] = []
    for entry in packet.get("entries", []):
        blind_id = entry.get("blind_id")
        require(blind_id in mapping, f"unmapped blind id {blind_id}")
        rubric = entry.get("rubric")
        require(isinstance(rubric, dict), f"missing rubric for {blind_id}")
        for field in (
            "introduced_by_diff", "concrete_reproducible_trigger", "behavior_claim_correct",
            "actionable_path_line", "nonduplicate",
        ):
            require(isinstance(rubric.get(field), bool), f"rubric {field} is incomplete for {blind_id}")
        require(isinstance(rubric.get("cluster_id"), str) and rubric["cluster_id"],
                f"cluster_id is incomplete for {blind_id}")
        require(rubric.get("severity") in {"blocker", "non-blocker"}, f"severity is incomplete for {blind_id}")
        confidence = rubric.get("confidence")
        require(isinstance(confidence, int) and 1 <= confidence <= 5,
                f"confidence must be 1..5 for {blind_id}")
        known = rubric.get("known_defect_id")
        require(known is None or isinstance(known, str), f"invalid known defect id for {blind_id}")
        case_id = mapping[blind_id]["case_id"]
        require(case_id in truth_cases, f"truth has no case {case_id}")
        allowed_known = {item["id"] for item in truth_cases[case_id].get("known_defects", [])}
        require(known is None or known in allowed_known,
                f"known defect {known} is not in truth for case {case_id}")
        joined = {**mapping[blind_id], "rubric": rubric, "valid": adjudication_valid(rubric)}
        observations.append(joined)

    run_results = load_run_results(args.run)
    run_by_pair = {(item["case_id"], item["arm_id"]): item for item in run_results}
    summary: dict[str, Any] = {"schema": "qq.grok-reviewer-score/v1", "arms": {}}
    for arm_id in EXPECTED_ARMS:
        arm_observations = [item for item in observations if item["arm_id"] == arm_id]
        clusters: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for item in arm_observations:
            clusters[(item["case_id"], item["rubric"]["cluster_id"])].append(item)
        valid_clusters = {
            key for key, items in clusters.items()
            if any(item["valid"] and item["rubric"]["nonduplicate"] for item in items)
        }
        known_total = sum(len(case["known_defects"]) for case in truth_cases.values())
        known_found = {
            item["rubric"]["known_defect_id"] for item in arm_observations
            if item["valid"] and item["rubric"]["known_defect_id"] is not None
        }
        clean_cases = {case_id for case_id, case in truth_cases.items() if not case["known_defects"]}
        clean_false_positive_clusters = {
            key for key, items in clusters.items()
            if key[0] in clean_cases and not any(item["valid"] for item in items)
        }
        clean_valid_discoveries = {
            key for key, items in clusters.items()
            if key[0] in clean_cases and any(item["valid"] for item in items)
        }
        reported_blockers = [item for item in arm_observations if item["reported_blocker"]]
        valid_blocker_keys = {
            (item["case_id"], item["rubric"]["cluster_id"])
            for item in reported_blockers
            if item["valid"] and item["rubric"]["severity"] == "blocker"
        }
        reported_blocker_keys = {
            (item["case_id"], item["rubric"]["cluster_id"]) for item in reported_blockers
        }
        pairs = [value for (case_id, candidate), value in run_by_pair.items() if candidate == arm_id]
        total_time = sum(item["wall_clock_seconds"] for item in pairs)
        total_usage = {field: sum(item["result"]["usage"][field] for item in pairs) for field in TOKEN_FIELDS}
        summary["arms"][arm_id] = {
            "defect_cluster_precision": (len(valid_clusters) / len(clusters)) if clusters else None,
            "valid_defect_clusters": len(valid_clusters), "reported_defect_clusters": len(clusters),
            "known_defect_recall": (len(known_found) / known_total) if known_total else None,
            "known_defects_found": sorted(known_found), "known_defects_total": known_total,
            "false_positive_clusters_on_clean_cases": len(clean_false_positive_clusters),
            "valid_new_clusters_on_nominally_clean_cases": len(clean_valid_discoveries),
            "blocker_precision": (
                len(valid_blocker_keys) / len(reported_blocker_keys) if reported_blocker_keys else None
            ),
            "valid_blockers": len(valid_blocker_keys), "reported_blockers": len(reported_blocker_keys),
            "wall_clock_seconds": round(total_time, 6), "tokens": total_usage,
            "seconds_per_valid_blocker": (
                round(total_time / len(valid_blocker_keys), 6) if valid_blocker_keys else None
            ),
            "processed_tokens_per_valid_blocker": (
                total_usage["processed_tokens"] / len(valid_blocker_keys) if valid_blocker_keys else None
            ),
        }
    write_json(args.output, summary)
    print(canonical_json(summary), end="")
    return 0


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.set_defaults(config=HERE / "config.json", corpus=HERE / "corpus" / "smoke.json")
    subparsers = value.add_subparsers(dest="command", required=True)
    for name, function in (("verify", command_verify), ("doctor", command_doctor)):
        child = subparsers.add_parser(name)
        child.add_argument("--config", type=Path, default=HERE / "config.json")
        child.add_argument("--corpus", type=Path, default=HERE / "corpus" / "smoke.json")
        child.set_defaults(function=function)
    child = subparsers.add_parser("run")
    child.add_argument("--config", type=Path, default=HERE / "config.json")
    child.add_argument("--corpus", type=Path, default=HERE / "corpus" / "smoke.json")
    child.add_argument("--run-id")
    child.add_argument("--output", type=Path)
    child.add_argument("--case", action="append", help="run only this case (repeatable)")
    child.add_argument("--arm", action="append", help="run only this settled arm (repeatable)")
    child.set_defaults(function=command_run)
    child = subparsers.add_parser("freeze-case")
    child.add_argument("--repository", type=Path, required=True)
    child.add_argument("--base", required=True); child.add_argument("--head", required=True)
    child.add_argument("--case-id", required=True); child.add_argument("--repository-id", required=True)
    child.add_argument("--repository-env", required=True); child.add_argument("--task", type=Path, required=True)
    child.add_argument("--task-path", required=True)
    child.set_defaults(function=command_freeze_case)
    child = subparsers.add_parser("blind")
    child.add_argument("--run", type=Path, required=True); child.add_argument("--output", type=Path, required=True)
    child.add_argument("--seed", type=int, required=True); child.set_defaults(function=command_blind)
    child = subparsers.add_parser("score")
    child.add_argument("--run", type=Path, required=True); child.add_argument("--truth", type=Path, required=True)
    child.add_argument("--adjudication", type=Path, required=True); child.add_argument("--blind-map", type=Path, required=True)
    child.add_argument("--output", type=Path, required=True); child.set_defaults(function=command_score)
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        return args.function(args)
    except RuntimeUnblock as error:
        print_unblock(error)
        return 2
    except BenchmarkError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
