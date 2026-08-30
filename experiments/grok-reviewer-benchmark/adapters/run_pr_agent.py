#!/usr/bin/env python3
"""Stock PR-Agent plain-diff adapter for the controlled Grok benchmark."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

RESULT_SCHEMA = "qq.grok-reviewer-arm-result/v1"
MODE = {"plain_diff": True, "head_file_enrichment": True, "json_output": True, "publishing": False}
PIN = "1b6925ba8cc3ef6be09dec704a374da53091926c"


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def git(repository: Path, *args: str) -> str:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(
        ["git", "-C", str(repository), *args], env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def verify_inputs() -> tuple[Path, Path, Path, Path, Path]:
    source = Path(required("BENCH_TOOL_SOURCE")).resolve()
    repository = Path(required("BENCH_REPOSITORY")).resolve()
    diff = Path(required("BENCH_DIFF_PATH")).resolve()
    task = Path(required("BENCH_TASK_PATH")).resolve()
    standards = Path(required("BENCH_STANDARDS_PATH")).resolve()
    output = Path(required("BENCH_OUTPUT_DIR")).resolve()
    manifest = read_json(Path(required("BENCH_INPUT_MANIFEST")))
    if git(source, "rev-parse", "HEAD^{commit}") != PIN:
        raise RuntimeError("PR-Agent source pin mismatch")
    if git(repository, "rev-parse", "HEAD^{commit}") != required("BENCH_HEAD"):
        raise RuntimeError("review repository head mismatch")
    if manifest.get("base") != required("BENCH_BASE") or manifest.get("head") != required("BENCH_HEAD"):
        raise RuntimeError("benchmark manifest geometry mismatch")
    for path, key in ((diff, "diff_sha256"), (task, "task_sha256"), (standards, "standards_sha256")):
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest[key]:
            raise RuntimeError(f"benchmark input hash mismatch: {path.name}")
    return source, repository, diff, task, output


def positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def normalize_findings(native: Any) -> list[dict[str, Any]]:
    review = native.get("review") if isinstance(native, dict) else None
    issues = review.get("key_issues_to_review") if isinstance(review, dict) else None
    if not isinstance(issues, list):
        return []
    findings = []
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        header = issue.get("issue_header")
        content = issue.get("issue_content")
        parts = [str(item).strip() for item in (header, content) if isinstance(item, str) and item.strip()]
        if not parts:
            continue
        path = issue.get("relevant_file")
        path = path.strip() if isinstance(path, str) and path.strip() else None
        line = issue.get("start_line")
        if isinstance(line, str) and line.strip().isdigit():
            line = int(line.strip())
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            line = None
        findings.append({
            "path": path,
            "line": line,
            "body": ": ".join(parts),
            "severity": None,
            "confidence": None,
            "blocks_merge": None,
        })
    return findings


def normalize_usage(native: Any) -> dict[str, int | None]:
    value = native.get("usage") if isinstance(native, dict) else None
    value = value if isinstance(value, dict) else {}
    completion = positive_int(value.get("completion_tokens"))
    total = positive_int(value.get("total_tokens"))
    # PR-Agent's prompt_tokens is inclusive of cached input and cannot be mapped
    # to the benchmark's disjoint uncached-input category without provider detail.
    return {
        "input_tokens": None,
        "output_tokens": completion,
        "cache_read_tokens": None,
        "cache_write_tokens": None,
        "reasoning_tokens": None,
        "processed_tokens": total,
    }


def build_result(native: Any) -> dict[str, Any]:
    findings = normalize_findings(native)
    return {
        "schema": RESULT_SCHEMA,
        "arm_id": required("BENCH_ARM_ID"),
        "case_id": required("BENCH_CASE_ID"),
        "model": required("BENCH_CLIENT_MODEL"),
        "provider_model": required("BENCH_PROVIDER_MODEL"),
        "mode": MODE,
        "effective_config": {
            "entrypoint": "python -m pr_agent.cli --diff-file --output --json-output review",
            "provider": "xai",
            "model": "xai/grok-4.6",
            "api_base_setting": "OPENAI__API_BASE",
            "api_key_setting": "XAI__KEY (inert local proxy credential)",
            "fallback_models": [],
            "reasoning_effort": "high",
            "temperature": 0.2,
            "temperature_forwarded_by_bridge": False,
            "max_findings": 3,
            "task_placement": "pr_reviewer.extra_instructions",
            "repo_settings": False,
            "global_settings": False,
            "request_stream": False,
            "response_format": None,
        },
        "native_verdict": None,
        "normalized_verdict": "fail" if findings else "pass",
        "verdict_source": "adapter_findings",
        "findings": findings,
        "usage": {"tool_reported": normalize_usage(native)},
        "telemetry": {
            "request_count": None,
            "retries": 0,
            "failures": 0,
            "truncation_events": 0,
            "context_events": 0,
        },
        "isolation": {"prior_findings_visible": False, "publishing": False},
    }


def main() -> int:
    source, repository, diff, task, output = verify_inputs()
    native_markdown = output / "native-review.md"
    native_json = output / "native-review.json"
    python = source / ".venv" / "bin" / "python"
    if not python.is_file():
        raise RuntimeError("pinned PR-Agent environment is missing .venv/bin/python; provision with uv 0.9.7 sync --frozen --no-install-project --no-dev")
    environment = os.environ.copy()
    environment.update({
        "PYTHONPATH": str(source),
        "CONFIG__MODEL": "xai/grok-4.6",
        "CONFIG__FALLBACK_MODELS": "[]",
        "CONFIG__REASONING_EFFORT": "high",
        "OPENAI__API_BASE": required("BENCH_OPENAI_BASE_URL"),
        "XAI__KEY": required("OPENAI_API_KEY"),
        "PR_REVIEWER__EXTRA_INSTRUCTIONS": task.read_text(encoding="utf-8"),
        "CONFIG__REPO_CONTEXT_FILES": "[]",
        "CONFIG__USE_REPO_SETTINGS_FILE": "false",
        "CONFIG__USE_GLOBAL_SETTINGS_FILE": "false",
        "NO_COLOR": "1",
    })
    command = [
        str(python), "-m", "pr_agent.cli",
        "--diff-file", str(diff),
        "--output", str(native_markdown),
        "--json-output", str(native_json),
        "review",
    ]
    completed = subprocess.run(
        command, cwd=repository, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
    )
    (output / "native.stdout").write_text(completed.stdout, encoding="utf-8")
    (output / "native.stderr").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode or not native_json.is_file():
        raise RuntimeError(f"stock PR-Agent failed ({completed.returncode}): {completed.stderr[-1000:].strip()}")
    native = read_json(native_json)
    result = build_result(native)
    Path(required("BENCH_RESULT_PATH")).write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"PR-Agent launcher: {error}", file=sys.stderr)
        raise SystemExit(2)
