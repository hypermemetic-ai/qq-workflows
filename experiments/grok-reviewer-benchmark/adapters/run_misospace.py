#!/usr/bin/env python3
"""Stock misospace/pr-reviewer-action adapter for the Grok benchmark."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from typing import Any

RESULT_SCHEMA = "qq.grok-reviewer-arm-result/v1"
MODE = {"tool_mode": "off", "publishing": False}
PIN = "54dfb1aac20e1e410ad8f71dc3681b888500a1ec"


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


def git_environment() -> dict[str, str]:
    value = {key: item for key, item in os.environ.items() if not key.startswith("GIT_")}
    value.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    return value


def run_git(repository: Path, *args: str, text: bool = True) -> Any:
    result = subprocess.run(
        ["git", "-C", str(repository), *args], env=git_environment(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=text, check=False,
    )
    if result.returncode:
        error = result.stderr if text else result.stderr.decode("utf-8", "replace")
        raise RuntimeError(f"git {' '.join(args)} failed: {error.strip()}")
    return result.stdout


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def verify_inputs() -> tuple[Path, Path, Path, Path, Path, dict[str, Any]]:
    source = Path(required("BENCH_TOOL_SOURCE")).resolve()
    repository = Path(required("BENCH_REPOSITORY")).resolve()
    diff = Path(required("BENCH_DIFF_PATH")).resolve()
    task = Path(required("BENCH_TASK_PATH")).resolve()
    standards = Path(required("BENCH_STANDARDS_PATH")).resolve()
    output = Path(required("BENCH_OUTPUT_DIR")).resolve()
    manifest = read_json(Path(required("BENCH_INPUT_MANIFEST")))
    if run_git(source, "rev-parse", "HEAD^{commit}").strip() != PIN:
        raise RuntimeError("misospace source pin mismatch")
    if run_git(repository, "rev-parse", "HEAD^{commit}").strip() != required("BENCH_HEAD"):
        raise RuntimeError("review repository head mismatch")
    if manifest.get("base") != required("BENCH_BASE") or manifest.get("head") != required("BENCH_HEAD"):
        raise RuntimeError("benchmark manifest geometry mismatch")
    for path, key in ((diff, "diff_sha256"), (task, "task_sha256"), (standards, "standards_sha256")):
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest[key]:
            raise RuntimeError(f"benchmark input hash mismatch: {path.name}")
    return source, repository, diff, task, output, manifest


def changed_files(repository: Path, base: str, head: str) -> tuple[list[dict[str, Any]], int, int]:
    counts: dict[str, tuple[int, int]] = {}
    for row in run_git(repository, "diff", "--numstat", base, head).splitlines():
        added, deleted, path = row.split("\t", 2)
        counts[path] = (0 if added == "-" else int(added), 0 if deleted == "-" else int(deleted))
    files = []
    for row in run_git(repository, "diff", "--name-status", base, head).splitlines():
        fields = row.split("\t")
        code = fields[0][0]
        path = fields[-1]
        previous = fields[1] if code in {"R", "C"} and len(fields) >= 3 else None
        added, deleted = counts.get(path, (0, 0))
        status = {"A": "added", "D": "removed", "R": "renamed"}.get(code, "modified")
        files.append({
            "filename": path, "status": status, "additions": added,
            "deletions": deleted, "changes": added + deleted,
            "previous_filename": previous,
        })
    return files, sum(item["additions"] for item in files), sum(item["deletions"] for item in files)


def materialize_fixture(repository: Path, diff: Path, task: Path, output: Path,
                        manifest: dict[str, Any]) -> tuple[Path, Path]:
    worktree = output / "worktree"
    subprocess.run(
        ["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(repository), str(worktree)],
        env=git_environment(), check=True,
    )
    run_git(worktree, "checkout", "--quiet", "--detach", required("BENCH_HEAD"))
    files, additions, deletions = changed_files(repository, required("BENCH_BASE"), required("BENCH_HEAD"))
    fixture = {
        "number": 1,
        "title": f"Benchmark case {required('BENCH_CASE_ID')}",
        "body": task.read_text(encoding="utf-8"),
        "head": {"sha": required("BENCH_HEAD"), "ref": "benchmark-head", "repo": {"full_name": "benchmark/local"}},
        "base": {"sha": required("BENCH_BASE"), "ref": "benchmark-base", "repo": {"full_name": "benchmark/local"}},
        "user": {"login": "benchmark-fixture"},
        "changed_files": len(files), "additions": additions, "deletions": deletions,
        "html_url": f"https://invalid.local/benchmark/{required('BENCH_CASE_ID')}",
    }
    (worktree / "pr-object.json").write_text(json.dumps(fixture, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    shutil.copyfile(diff, worktree / "pr.diff")
    files_path = output / "pr-files.fixture.json"
    files_path.write_text(json.dumps(files, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    # Preserve a secret-free fixture manifest separately from stock-generated files.
    (output / "fixture-manifest.json").write_text(json.dumps({
        "input": manifest, "pr_object_sha256": hashlib.sha256((worktree / "pr-object.json").read_bytes()).hexdigest(),
        "pr_files_sha256": hashlib.sha256(files_path.read_bytes()).hexdigest(),
    }, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return worktree, files_path


def make_gh_shim(output: Path) -> Path:
    bindir = output / "fixture-bin"
    bindir.mkdir()
    shim = bindir / "gh"
    shim.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
log = pathlib.Path(os.environ["MISOSPACE_GH_LOG"])
with log.open("a", encoding="utf-8") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
expected = ["api", "repos/benchmark/local/pulls/1/files?per_page=100"]
if sys.argv[1:] != expected:
    print("unexpected benchmark fixture gh call", file=sys.stderr)
    raise SystemExit(97)
sys.stdout.buffer.write(pathlib.Path(os.environ["MISOSPACE_FILES_FIXTURE"]).read_bytes())
""", encoding="utf-8")
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
    return bindir


def normalize_findings(native: Any) -> list[dict[str, Any]]:
    values = native.get("findings") if isinstance(native, dict) else None
    if not isinstance(values, list):
        return []
    findings = []
    for item in values:
        if not isinstance(item, dict):
            continue
        body = item.get("message")
        if not isinstance(body, str) or not body.strip():
            continue
        path = item.get("file")
        path = path.strip() if isinstance(path, str) and path.strip() else None
        line = item.get("line")
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            line = None
        severity = item.get("severity")
        severity = severity if isinstance(severity, str) else None
        confidence = item.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            confidence = None
        findings.append({
            "path": path, "line": line, "body": body.strip(),
            "severity": severity, "confidence": confidence,
            "blocks_merge": severity == "blocker",
        })
    return findings


def build_result(native: Any) -> dict[str, Any]:
    verdict = native.get("verdict") if isinstance(native, dict) else None
    if verdict not in {"approve", "request_changes"}:
        raise RuntimeError(f"stock action emitted invalid native verdict: {verdict!r}")
    findings = normalize_findings(native)
    return {
        "schema": RESULT_SCHEMA,
        "arm_id": required("BENCH_ARM_ID"), "case_id": required("BENCH_CASE_ID"),
        "model": required("BENCH_CLIENT_MODEL"), "provider_model": required("BENCH_PROVIDER_MODEL"),
        "mode": MODE,
        "effective_config": {
            "entrypoint": "scripts/run_review.sh",
            "fixture": "preseeded local pr-object.json/pr.diff plus fail-closed PR-files shim",
            "api_format": "openai", "model": "grok-4.6", "request_stream": True,
            "reasoning_effort": "bridge-forced-high",
            "temperature": 0.1, "temperature_forwarded_by_bridge": False,
            "max_tokens": 8192, "max_tokens_forwarded_by_bridge": False,
            "response_format": "off", "tokens_param": "max_tokens",
            "primary_retries": 8, "primary_retry_delay_seconds": 15,
            "fallback_base_url": None, "fallback_model": None,
            "compatibility_correction": "both fallback URL and model explicitly blank because v2.2.1 action.yml default contradicts driver validation",
            "review_routing_mode": "off", "tool_mode": "off", "scope": "full",
            "publishing": False,
        },
        "native_verdict": verdict,
        "normalized_verdict": "pass" if verdict == "approve" else "fail",
        "verdict_source": "native",
        "findings": findings,
        "usage": {},
        "telemetry": {"request_count": None, "retries": 0, "failures": 0,
                      "truncation_events": 0, "context_events": 0},
        "isolation": {"prior_findings_visible": False, "publishing": False},
    }


def main() -> int:
    source, repository, diff, task, output, manifest = verify_inputs()
    for executable in ("bash", "curl", "git", "jq", "python3"):
        if shutil.which(executable) is None:
            raise RuntimeError(f"stock action dependency unavailable: {executable}")
    worktree, files_path = materialize_fixture(repository, diff, task, output, manifest)
    bindir = make_gh_shim(output)
    gh_log = output / "gh-calls.jsonl"
    environment = os.environ.copy()
    environment.update({
        "PATH": f"{bindir}{os.pathsep}{environment.get('PATH', '')}",
        "GITHUB_ACTION_PATH": str(source),
        "REPO": "benchmark/local", "PR_NUMBER": "1", "GH_TOKEN": "benchmark-local-fixture",
        "AI_BASE_URL": required("BENCH_OPENAI_BASE_URL"), "AI_API_FORMAT": "openai",
        "AI_MODEL": "grok-4.6", "AI_API_KEY": required("OPENAI_API_KEY"),
        "AI_STREAM": "true", "AI_MAX_TOKENS": "8192", "AI_TEMPERATURE": "0.1",
        "AI_RESPONSE_FORMAT": "off", "AI_TOKENS_PARAM": "max_tokens",
        "AI_PRIMARY_RETRIES": "8", "AI_PRIMARY_RETRY_DELAY_SEC": "15",
        "AI_FALLBACK_BASE_URL": "", "AI_FALLBACK_API_FORMAT": "",
        "AI_FALLBACK_MODEL": "", "AI_FALLBACK_API_KEY": "",
        "REVIEW_ROUTING_MODE": "off", "TOOL_MODE": "off",
        "STANDARDS_FILE": required("BENCH_STANDARDS_PATH"),
        "EFFECTIVE_SCOPE": "full", "IS_FORK_PR": "false", "PREVIOUS_HEAD_SHA": "",
        "GITHUB_OUTPUT": str(output / "action-output.txt"),
        "GITHUB_STEP_SUMMARY": str(output / "step-summary.md"),
        "MISOSPACE_FILES_FIXTURE": str(files_path), "MISOSPACE_GH_LOG": str(gh_log),
        "NO_COLOR": "1",
    })
    completed = subprocess.run(
        ["bash", str(source / "scripts" / "run_review.sh")],
        cwd=worktree, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
    )
    (output / "native.stdout").write_text(completed.stdout, encoding="utf-8")
    (output / "native.stderr").write_text(completed.stderr, encoding="utf-8")
    native_path = worktree / "ai-output.json"
    if completed.returncode or not native_path.is_file():
        raise RuntimeError(f"stock misospace reviewer failed ({completed.returncode}): {completed.stderr[-1000:].strip()}")
    native = read_json(native_path)
    result = build_result(native)
    Path(required("BENCH_RESULT_PATH")).write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"misospace launcher: {error}", file=sys.stderr)
        raise SystemExit(2)
