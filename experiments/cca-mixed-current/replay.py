#!/usr/bin/env python3
"""Replay pinned CCA plus the existing accept gate on current mixed bash bodies.

Historical shell commands are metadata and are never executed. Captured first
result bodies are sent only to the local pinned CCA bridge over stdin. No full
command, input body, candidate body, or excerpt is persisted.
"""
from __future__ import annotations

import argparse
import collections
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any

from gate import accept_cca

HERE = Path(__file__).resolve().parent
DEFAULT_CORPUS = Path("/home/qqp/.local/state/qq/sessions")
DEFAULT_CCA = Path(
    "/home/qqp/projects/.archive/qq-monolith/.worktrees/"
    "cap-aware-mini-v2/.experiment-tools/cca-v0.2.0"
)
BRIDGE = HERE / "cca_bridge.cjs"
STUDY_SESSION = "session-ebff3456-8e68-4add-9d19-0680b99f7494"
EVENT_CUTOFF_MS = 1787895040748
AUTHORITATIVE_PARENT = "session-af60703c-a964-41ee-bb2b-9edfc7b170f3"
AUTHORITATIVE_DELEGATION = "aa2d98c8-e415-4fbc-831c-9a1c6aa1aea8"

CCA_COMMIT = "fd9c022d364643fd80413201fb51a537c9020a86"
CCA_PACKAGE_SHA256 = "827e47579dca02b3bbf9b6a5cc8a9bd0f4e57d8bebbb48a294761450bf4b0ef1"
CCA_COMPRESSOR_SHA256 = "ddbbc84567d19de46a6e82c09eacd4571f5b226a4f54a0c827eba6f0146358ae"
CCA_RULES_SHA256 = "f085d8271aa97fd50773948b826320d13201e76a8f8b11fdb5dba7114e370331"
BRIDGE_SHA256 = "39552f6b449b4ef648160cf17664090b6ac56eb2517ae0551ef39dfc1e15638b"
JSONL_BRIDGE = HERE / "cca_bridge_jsonl.cjs"
JSONL_BRIDGE_SHA256 = "6e59a814a702769b3f9632769aec0693a89d28d16740fb4aa002f81b6ffcf45b"
GATE_SHA256 = "284bc2af2a6e255f521576a3d2c94a6e4bad36c1a9559853463fafb1bace3ff8"
PRIOR_STUDY_SHA256 = "dd090d49786adfffa00701a36bbf48812e4f9a60ce80f1ff746f825784df8784"
PRIOR_ROUTE_REPLAY_SHA256 = "d09e939716837f9c6c0b5dbb7f399d7862ce81f66ddeac00dec661ce85cde8df"
CCA_RETRIES = 3
COMPARABLE_SAMPLE_N = 20
COMPARABLE_MIN_CHARS = 500

BASH_CLASSES = [
    "source_dump", "listing", "search", "git_diff", "git_status", "test",
    "npm/install/debug_log", "lockfile/json", "write/edit", "mixed/compound", "other",
]
GATE_CATEGORIES = (
    "diff hunks",
    "test failing-name lines",
    "diagnostic lines",
)

# Frozen prior-study facts. The ungated test rates are carried forward only to
# answer the requested current-corpus projection; tests are not replayed here.
PRIOR = {
    "sessions": 459,
    "bash_issuing_sessions": 337,
    "bash_calls": 13637,
    "bash_bytes": 29341881,
    "mixed_calls": 4269,
    "mixed_bytes": 15927490,
    "mixed_byte_share_pct": 54.28244358294548,
    "mixed_sample_n": 20,
    "mixed_sample_input_bytes": 775926,
    "mixed_sample_ungated_saved_bytes": 123616,
    "mixed_sample_ungated_saved_pct": 15.931416140198937,
    "mixed_sample_gated_saved_bytes": 112908,
    "mixed_sample_gated_saved_pct": 14.551387632325763,
    "mixed_sample_accepted": 8,
    "mixed_sample_dirty_bodies": 1,
    "selected_policy_projected_pct": 10.815483910618658,
    "test_ungated_rates": {
        "matched": 0.5631198245671456,
        "unmatched": 0.38345223126074574,
    },
}

SECRET_CONTEXT_RE = re.compile(
    r"(?i)(?:\.qq-codex-auth\.json|(?:^|[/\\\s'\"])(?:[^/\\\s'\"]*auth[^/\\\s'\"]*\.json|credentials?(?:\.json)?)(?:$|[/\\\s'\"])|"
    r"(?:^|[/\\\s'\"])\.(?:aws|ssh|gnupg)(?:$|[/\\\s'\"])|"
    r"(?:^|[/\\\s'\"])(?:\.npmrc|\.pypirc|\.netrc|\.env(?:\.[A-Za-z0-9_-]+)?)(?:$|[/\\\s'\"])|"
    r"id_(?:rsa|ed25519)|private[_-]?key)"
)
SECRET_MATERIAL_RES = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"(?i)\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password)\b\s*[=:]\s*['\"]?[A-Za-z0-9_./+=-]{12,}"),
    re.compile(r"(?i)\bAuthorization\s*:\s*Bearer\s+\S+"),
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utf8_bytes(value: str) -> int:
    return len(value.encode("utf-8", "replace"))


def parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def extract_result(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    try:
        text = data["message"]["content"][0]["content"][0]["text"]
        return (text if isinstance(text, str) else str(text), meta)
    except (KeyError, IndexError, TypeError):
        return "", meta


def compound_shell(command: str) -> bool:
    return bool("&&" in command or "<<" in command or re.search(r"(?<!\|)\|(?!\|)", command))


# Exact logic and precedence from historical-observation-corpus/study.py,
# source SHA-256 PRIOR_STUDY_SHA256. Do not revise this taxonomy for the replay.
def classify_bash(command: str, output: str) -> str:
    c = command.lower()
    tags: set[str] = set()
    source_ext = r"(?:mjs|cjs|js|jsx|ts|tsx|py|rs|go|java|c|cc|cpp|h|hpp|rb|sh|bash|zsh|md|toml|ya?ml)"
    if re.search(r"\bgit\s+(?:diff|show|log\s+-p|format-patch)\b", c) or re.search(r"(?m)^@@\s", output):
        tags.add("git_diff")
    if re.search(r"\bgit\s+status\b|\bgit\s+diff\s+--(?:name|stat)", c):
        tags.add("git_status")
    if re.search(r"(?:^|[;&|\n]\s*)(?:rg|grep|ag|ack)(?:\s|$)|\bgit\s+grep\b", c):
        tags.add("search")
    if re.search(r"(?:^|[;&|\n]\s*)(?:ls|find|tree|fd|du)(?:\s|$)|\bprintf\b.*(?:files|tree|listing)", c):
        tags.add("listing")
    if re.search(r"\b(?:pytest|unittest|cargo\s+test|go\s+test|npm\s+(?:test|run\s+test)|pnpm\s+(?:test|run\s+test)|yarn\s+test|node\s+--test|vitest|jest|mocha|test-qq|run-tests|verifier)\b", c):
        tags.add("test")
    if re.search(r"\b(?:npm|pnpm|yarn|pipx?|uv|apt(?:-get)?|brew|cargo)\s+(?:install|add|update)|\bnpx\b", c):
        tags.add("npm/install/debug_log")
    if re.search(r"\b(?:journalctl|dmesg|strace|ltrace)\b|(?:tail|cat|sed\s+-n).{0,80}(?:\.log\b|/log/|stderr|stdout|debug)", c):
        tags.add("npm/install/debug_log")
    if re.search(r"\b(?:jq|python\s+-m\s+json\.tool)\b|(?:package-lock|npm-shrinkwrap|yarn\.lock|pnpm-lock|cargo\.lock|\.json\b)", c):
        tags.add("lockfile/json")
    if re.search(rf"\b(?:cat|bat|less|head|tail|nl|sed\s+-n|awk)\b[^\n;&|]*\.{source_ext}\b", c):
        tags.add("source_dump")
    if re.search(r"\b(?:apply_patch|sed\s+-i|perl\s+-pi|tee)\b|(?:^|\s)(?:>|>>)(?!\s*/dev/null)|\b(?:write_text|writeFileSync|cat\s+<<)", c):
        tags.add("write/edit")
    # A single narrow compound pipeline retains its semantic class. Mixed means
    # multiple observed intents, not merely any shell operator.
    if len(tags) >= 2 and compound_shell(command):
        return "mixed/compound"
    for cls in ("git_diff", "git_status", "test", "npm/install/debug_log", "write/edit", "source_dump", "search", "listing", "lockfile/json"):
        if cls in tags:
            return cls
    if compound_shell(command) and re.search(r"(?:\n|&&|;).*(?:\n|&&|;)", command, re.S):
        return "mixed/compound"
    return "other"


def test_projection_stratum(command: str) -> str:
    """Recover prior test labels for weighting only; no RTK is run."""
    c = command.lower()
    for pattern in (
        r"\bvitest\b",
        r"\bpytest\b",
        r"\btsc\b",
        r"\bcargo\s+test\b",
    ):
        if re.search(pattern, c):
            return "matched"
    return "unmatched"


def is_sensitive(command: str, body: str = "") -> bool:
    if SECRET_CONTEXT_RE.search(command):
        return True
    probe = command + "\n" + body
    return any(pattern.search(probe) for pattern in SECRET_MATERIAL_RES)


@dataclass
class MixedBody:
    serial: int
    session: str
    call_id: str
    command: str
    body: str
    joined: bool
    sensitive: bool

    @property
    def raw_chars(self) -> int:
        return len(self.body)

    @property
    def raw_bytes(self) -> int:
        return utf8_bytes(self.body)

    @property
    def observation_id(self) -> str:
        return hashlib.sha256(f"{self.session}\0{self.call_id}".encode()).hexdigest()

    @property
    def eligible(self) -> bool:
        return self.joined and not self.sensitive


def scan_corpus(corpus: Path) -> tuple[list[MixedBody], dict[str, Any]]:
    paths = sorted(corpus.glob("**/session.jsonl.zstd"))
    class_coverage = {name: collections.Counter() for name in BASH_CLASSES}
    mixed: list[MixedBody] = []
    included_session_ids: list[str] = []
    bash_sessions: set[str] = set()
    decode_failures = 0
    zstd_failures: list[dict[str, Any]] = []
    post_cutoff_events: collections.Counter[str] = collections.Counter()
    result_events = 0
    duplicate_result_events = 0
    divergent_result_groups = 0
    unresolved_calls = 0
    serial = 0

    for path in paths:
        process = subprocess.Popen(
            ["zstd", "-dc", "--", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdout is not None
        header: dict[str, Any] = {}
        calls: list[dict[str, Any]] = []
        results: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        for raw_line in process.stdout:
            try:
                event = json.loads(raw_line)
            except Exception:
                decode_failures += 1
                continue
            if event.get("type") == "session":
                header = event
            event_time = event.get("time")
            if isinstance(event_time, (int, float)) and event_time > EVENT_CUTOFF_MS:
                post_cutoff_events[str(event.get("type", "unknown"))] += 1
                continue
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            typ = event.get("type")
            if typ == "tool/call":
                calls.append({
                    "call_id": str(data.get("callId", "")),
                    "tool": str(data.get("name", "unknown")),
                    "args": parse_args(data.get("arguments")),
                })
            elif typ == "tool/result":
                result_events += 1
                message = data.get("message") if isinstance(data.get("message"), dict) else {}
                source = message.get("source") if isinstance(message.get("source"), dict) else {}
                call_id = str(source.get("callId", ""))
                text, meta = extract_result(data)
                results[call_id].append({
                    "text": text,
                    "meta": meta,
                    "sha256": hashlib.sha256(text.encode("utf-8", "replace")).hexdigest(),
                })
        stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
        returncode = process.wait()
        sid = str(header.get("id") or path.parent.name)
        if returncode:
            zstd_failures.append({
                "session_sha256": hashlib.sha256(sid.encode()).hexdigest(),
                "returncode": returncode,
                "error_kind": stderr.split(":", 1)[0][:80],
            })
        include = (
            sid != STUDY_SESSION
            and int(header.get("createdAt") or 0) <= EVENT_CUTOFF_MS
        )
        if not include:
            continue

        included_session_ids.append(sid)
        bash_calls = [call for call in calls if call["tool"] == "bash"]
        if bash_calls:
            bash_sessions.add(sid)
        for call_id, variants in results.items():
            if len(variants) > 1:
                duplicate_result_events += len(variants) - 1
                if len({item["sha256"] for item in variants}) > 1:
                    divergent_result_groups += 1

        for call in bash_calls:
            serial += 1
            variants = results.get(call["call_id"], [])
            joined = bool(variants)
            if not joined:
                unresolved_calls += 1
            body = variants[0]["text"] if variants else ""
            command = str(call["args"].get("command", ""))
            cls = classify_bash(command, body)
            raw_bytes = utf8_bytes(body)
            slot = class_coverage[cls]
            slot["calls"] += 1
            slot["bytes"] += raw_bytes
            slot["chars"] += len(body)
            slot["joined_calls"] += int(joined)
            if cls == "test":
                stratum = test_projection_stratum(command)
                slot[f"{stratum}_calls"] += 1
                slot[f"{stratum}_bytes"] += raw_bytes
            if cls == "mixed/compound":
                sensitive = is_sensitive(command, body) if joined else False
                slot["sensitive_calls"] += int(sensitive)
                slot["sensitive_bytes"] += raw_bytes if sensitive else 0
                mixed.append(MixedBody(
                    serial=serial,
                    session=sid,
                    call_id=call["call_id"],
                    command=command,
                    body=body,
                    joined=joined,
                    sensitive=sensitive,
                ))

    included_session_ids.sort()
    session_snapshot_sha256 = hashlib.sha256(
        "\n".join(included_session_ids).encode()
    ).hexdigest()
    total_calls = sum(slot["calls"] for slot in class_coverage.values())
    total_bytes = sum(slot["bytes"] for slot in class_coverage.values())
    total_chars = sum(slot["chars"] for slot in class_coverage.values())
    coverage = {
        "discovered_archives": len(paths),
        "included_sessions": len(included_session_ids),
        "included_session_ids_sha256": session_snapshot_sha256,
        "bash_issuing_sessions": len(bash_sessions),
        "bash_calls": total_calls,
        "bash_bytes": total_bytes,
        "bash_chars": total_chars,
        "mixed_body_count": len(mixed),
        "mixed_joined_body_count": sum(item.joined for item in mixed),
        "mixed_bytes": class_coverage["mixed/compound"]["bytes"],
        "mixed_byte_share_pct": (
            100.0 * class_coverage["mixed/compound"]["bytes"] / total_bytes
            if total_bytes else 0.0
        ),
        "result_events": result_events,
        "duplicate_result_events": duplicate_result_events,
        "divergent_result_groups": divergent_result_groups,
        "unresolved_bash_calls": unresolved_calls,
        "decode_failures": decode_failures,
        "zstd_failures": zstd_failures,
        "post_cutoff_events": dict(post_cutoff_events),
        "by_class": {name: dict(class_coverage[name]) for name in BASH_CLASSES},
    }
    return mixed, coverage


def validate_pins(cca_root: Path) -> dict[str, str]:
    expected_files = {
        "package.json": CCA_PACKAGE_SHA256,
        "src/compression/compressor.js": CCA_COMPRESSOR_SHA256,
        "rules/default-rules.json": CCA_RULES_SHA256,
    }
    for relative, expected in expected_files.items():
        actual = sha256_file(cca_root / relative)
        if actual != expected:
            raise SystemExit(f"CCA {relative} checksum mismatch: {actual}")
    if sha256_file(BRIDGE) != BRIDGE_SHA256:
        raise SystemExit("CCA bridge checksum mismatch")
    if sha256_file(JSONL_BRIDGE) != JSONL_BRIDGE_SHA256:
        raise SystemExit("CCA JSONL bridge checksum mismatch")
    if sha256_file(HERE / "gate.py") != GATE_SHA256:
        raise SystemExit("accept gate checksum mismatch")
    head = subprocess.run(
        ["git", "-C", str(cca_root), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if head != CCA_COMMIT:
        raise SystemExit(f"CCA commit mismatch: {head}")
    package = json.loads((cca_root / "package.json").read_text())
    if (package.get("name"), package.get("version")) != ("@linger-alpha/cca", "0.2.0"):
        raise SystemExit("CCA package identity mismatch")
    return {
        "cca_package": "@linger-alpha/cca@0.2.0",
        "cca_commit": CCA_COMMIT,
        "cca_package_sha256": CCA_PACKAGE_SHA256,
        "cca_compressor_sha256": CCA_COMPRESSOR_SHA256,
        "cca_rules_sha256": CCA_RULES_SHA256,
        "cca_bridge_sha256": BRIDGE_SHA256,
        "cca_jsonl_bridge_sha256": JSONL_BRIDGE_SHA256,
        "accept_gate_sha256": GATE_SHA256,
        "prior_classifier_source_sha256": PRIOR_STUDY_SHA256,
        "prior_route_replay_sha256": PRIOR_ROUTE_REPLAY_SHA256,
    }


def safe_error(cause: object) -> str:
    value = f"{type(cause).__name__}: {cause}"
    value = value.replace("/home/qqp", "$HOME")
    return value[:300]


def provider_failure(stdout: str, stderr: str) -> bool:
    return "PROVIDER" in (stdout + "\n" + stderr).upper()


def run_cca(
    cca_root: Path,
    command: str,
    raw: str,
) -> tuple[str, dict[str, Any], str, int]:
    """Pass one captured body to CCA over stdin; never execute its command."""
    last_error = ""
    for attempt in range(1, CCA_RETRIES + 1):
        try:
            with tempfile.TemporaryDirectory(prefix="cca-mixed-current-") as tmp:
                raw_dir = Path(tmp) / "raw"
                raw_dir.mkdir(mode=0o700)
                payload = {
                    "ccaRoot": str(cca_root),
                    "rawDir": str(raw_dir),
                    "command": command,
                    "stdout": raw,
                    # Preserve the prior replay's explicit historical-status
                    # assumption. This is not an observed exit status.
                    "exitCode": 0,
                }
                process = subprocess.run(
                    ["node", str(BRIDGE)],
                    input=json.dumps(payload),
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    capture_output=True,
                    timeout=30,
                )
        except Exception as exc:
            last_error = safe_error(exc)
            if attempt < CCA_RETRIES:
                continue
            return raw, {}, last_error, attempt
        if process.returncode:
            last_error = f"exit {process.returncode}: {safe_error(process.stderr)}"
            if provider_failure(process.stdout, process.stderr) and attempt < CCA_RETRIES:
                continue
            return raw, {}, last_error, attempt
        try:
            info = json.loads(process.stdout)
            candidate = info["text"] if info.get("changed") else raw
            if not isinstance(candidate, str):
                raise TypeError("CCA text is not a string")
            lines = candidate.splitlines(keepends=True)
            if lines and lines[0].startswith("[compressed output"):
                candidate = "".join(lines[1:])
            return candidate, info, "", attempt
        except Exception as exc:
            last_error = safe_error(exc)
            if provider_failure(process.stdout, process.stderr) and attempt < CCA_RETRIES:
                continue
            return raw, {}, last_error, attempt
    return raw, {}, last_error or "CCA retry exhaustion", CCA_RETRIES



class CcaJsonlBridge:
    """Persistent transport for the exact pinned synchronous CCA call."""

    def __init__(self, cca_root: Path):
        self.cca_root = cca_root
        self.temporary: tempfile.TemporaryDirectory[str] | None = None
        self.raw_dir: Path | None = None
        self.process: subprocess.Popen[str] | None = None

    def __enter__(self) -> "CcaJsonlBridge":
        self.temporary = tempfile.TemporaryDirectory(prefix="cca-mixed-current-jsonl-")
        self.raw_dir = Path(self.temporary.name) / "raw"
        self.raw_dir.mkdir(mode=0o700)
        self._start()
        return self

    def _start(self) -> None:
        self.process = subprocess.Popen(
            ["node", str(JSONL_BRIDGE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

    def _stop(self) -> None:
        process = self.process
        self.process = None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
            process.wait(timeout=5)
        except Exception:
            process.kill()
            process.wait()
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()

    def __exit__(self, *_args: object) -> None:
        self._stop()
        if self.temporary is not None:
            self.temporary.cleanup()
            self.temporary = None

    def compress(self, command: str, raw: str) -> tuple[str, dict[str, Any], str, int]:
        last_error = ""
        for attempt in range(1, CCA_RETRIES + 1):
            try:
                if self.process is None or self.process.poll() is not None:
                    self._stop()
                    self._start()
                assert self.process is not None
                assert self.process.stdin is not None
                assert self.process.stdout is not None
                assert self.raw_dir is not None
                payload = {
                    "ccaRoot": str(self.cca_root),
                    "rawDir": str(self.raw_dir),
                    "command": command,
                    "stdout": raw,
                    "exitCode": 0,
                }
                self.process.stdin.write(json.dumps(payload) + "\n")
                self.process.stdin.flush()
                line = self.process.stdout.readline()
                if not line:
                    stderr = self.process.stderr.read() if self.process.stderr else ""
                    raise RuntimeError(f"CCA JSONL bridge closed: {stderr[:200]}")
                info = json.loads(line)
                if info.get("ok") is not True:
                    last_error = (
                        f"{info.get('errorName', 'Error')}: "
                        f"{info.get('errorMessage', 'unknown CCA error')}"
                    )
                    if "PROVIDER" in last_error.upper() and attempt < CCA_RETRIES:
                        continue
                    return raw, {}, safe_error(last_error), attempt
                info.pop("ok", None)
                candidate = info["text"] if info.get("changed") else raw
                if not isinstance(candidate, str):
                    raise TypeError("CCA text is not a string")
                lines = candidate.splitlines(keepends=True)
                if lines and lines[0].startswith("[compressed output"):
                    candidate = "".join(lines[1:])
                return candidate, info, "", attempt
            except Exception as exc:
                last_error = safe_error(exc)
                self._stop()
                if attempt < CCA_RETRIES:
                    self._start()
                    continue
                return raw, {}, last_error, attempt
        return raw, {}, last_error or "CCA retry exhaustion", CCA_RETRIES


def is_dirty(decision: dict[str, Any]) -> bool:
    evidence = decision.get("evidence", {})
    return any(evidence.get(name, {}).get("lost_exact", 0) > 0 for name in GATE_CATEGORIES)


def replay_mixed(
    mixed: list[MixedBody],
    cca_root: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    comparable_ids = {
        item.observation_id
        for item in sorted(
            (
                item for item in mixed
                if item.eligible and item.raw_chars >= COMPARABLE_MIN_CHARS
            ),
            key=lambda item: (item.raw_chars, item.serial),
            reverse=True,
        )[:COMPARABLE_SAMPLE_N]
    }
    records: list[dict[str, Any]] = []
    eligible = [item for item in mixed if item.eligible]
    with CcaJsonlBridge(cca_root) as bridge:
        for index, item in enumerate(eligible, 1):
            print(
                f"[{index:04d}/{len(eligible):04d}] mixed bytes={item.raw_bytes}",
                flush=True,
            )
            candidate, info, error, attempts = bridge.compress(
                item.command, item.body
            )
            decision = accept_cca(item.body, candidate, info)
            if error:
                decision = {
                    **decision,
                    "accepted": False,
                    "reason": "cca_error",
                }
            records.append({
                "observation_id": item.observation_id,
                "command_sha256": hashlib.sha256(
                    item.command.encode("utf-8", "replace")
                ).hexdigest(),
                "raw_chars": item.raw_chars,
                "raw_bytes": item.raw_bytes,
                "comparable_sample": item.observation_id in comparable_ids,
                "cca": {
                    "changed": info.get("changed") is True,
                    "critical": info.get("critical") is True,
                    "rule_ids": info.get("ruleIds", []),
                    "candidate_chars": len(candidate),
                    "candidate_bytes": utf8_bytes(candidate),
                    "saved_bytes": item.raw_bytes - utf8_bytes(candidate),
                    "attempts": attempts,
                    "error": error,
                },
                "gate": decision,
                "dirty": is_dirty(decision),
            })
    exclusions = {
        "unresolved_identity_bodies": sum(not item.joined for item in mixed),
        "unresolved_identity_bytes": sum(item.raw_bytes for item in mixed if not item.joined),
        "sensitive_identity_bodies": sum(item.joined and item.sensitive for item in mixed),
        "sensitive_identity_bytes": sum(
            item.raw_bytes for item in mixed if item.joined and item.sensitive
        ),
    }
    return records, exclusions


def aggregate_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    input_bytes = sum(record["raw_bytes"] for record in records)
    candidate_bytes = sum(record["cca"]["candidate_bytes"] for record in records)
    gated_bytes = sum(
        record["cca"]["candidate_bytes"]
        if record["gate"]["accepted"]
        else record["raw_bytes"]
        for record in records
    )
    reasons = collections.Counter(record["gate"]["reason"] for record in records)
    reason_bytes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    dirty_categories = collections.Counter()
    dirty_reasons = collections.Counter()
    accepted_loss_categories = collections.Counter()
    for record in records:
        reason = record["gate"]["reason"]
        reason_bytes[reason]["input_bytes"] += record["raw_bytes"]
        reason_bytes[reason]["candidate_saved_bytes"] += record["raw_bytes"] - record["cca"]["candidate_bytes"]
        evidence = record["gate"]["evidence"]
        if record["dirty"]:
            dirty_reasons[reason] += 1
        for category in GATE_CATEGORIES:
            lost = evidence[category]["lost_exact"]
            if lost:
                dirty_categories[category] += 1
                if record["gate"]["accepted"]:
                    accepted_loss_categories[category] += 1
    accepted = sum(record["gate"]["accepted"] for record in records)
    accepted_input_bytes = sum(
        record["raw_bytes"] for record in records if record["gate"]["accepted"]
    )
    return {
        "evaluated_bodies": len(records),
        "input_bytes": input_bytes,
        "cca_changed_true_bodies": sum(record["cca"]["changed"] for record in records),
        "cca_critical_true_bodies": sum(record["cca"]["critical"] for record in records),
        "cca_errors": sum(bool(record["cca"]["error"]) for record in records),
        "ungated": {
            "output_bytes": candidate_bytes,
            "saved_bytes": input_bytes - candidate_bytes,
            "saved_pct": 100.0 * (input_bytes - candidate_bytes) / input_bytes if input_bytes else 0.0,
            "shorter_bodies": sum(record["cca"]["saved_bytes"] > 0 for record in records),
            "larger_bodies": sum(record["cca"]["saved_bytes"] < 0 for record in records),
        },
        "gated": {
            "output_bytes": gated_bytes,
            "saved_bytes": input_bytes - gated_bytes,
            "saved_pct": 100.0 * (input_bytes - gated_bytes) / input_bytes if input_bytes else 0.0,
            "accepted_bodies": accepted,
            "rejected_bodies": len(records) - accepted,
            "accepted_body_pct": 100.0 * accepted / len(records) if records else 0.0,
            "accepted_input_bytes": accepted_input_bytes,
            "accepted_input_byte_pct": 100.0 * accepted_input_bytes / input_bytes if input_bytes else 0.0,
        },
        "gate_reasons": dict(sorted(reasons.items())),
        "gate_reason_bytes": {
            reason: dict(reason_bytes[reason]) for reason in sorted(reason_bytes)
        },
        "accepted_critical_true_bodies": sum(
            record["gate"]["accepted"] and record["cca"]["critical"]
            for record in records
        ),
        "dirty_bodies": sum(record["dirty"] for record in records),
        "dirty_body_categories": dict(sorted(dirty_categories.items())),
        "dirty_gate_reasons": dict(sorted(dirty_reasons.items())),
        "accepted_evidence_loss_bodies": sum(
            record["gate"]["accepted"] and record["dirty"] for record in records
        ),
        "accepted_evidence_loss_categories": dict(sorted(accepted_loss_categories.items())),
    }


def make_projection(
    coverage: dict[str, Any],
    all_mixed: dict[str, Any],
) -> dict[str, Any]:
    total = coverage["bash_bytes"]
    test = coverage["by_class"]["test"]
    test_strata: dict[str, Any] = {}
    test_saved = 0.0
    for stratum, rate in PRIOR["test_ungated_rates"].items():
        corpus_bytes = test.get(f"{stratum}_bytes", 0)
        saved = corpus_bytes * rate
        test_saved += saved
        test_strata[stratum] = {
            "current_corpus_bytes": corpus_bytes,
            "prior_sample_save_rate": rate,
            "projected_saved_bytes": saved,
        }
    mixed_saved = all_mixed["gated"]["saved_bytes"]
    ungated_mixed_saved = all_mixed["ungated"]["saved_bytes"]
    return {
        "description": (
            "current all-safe-mixed CCA+gate actual; prior ungated test rates "
            "carried forward by label stratum; git_diff and all other classes identity"
        ),
        "input_bytes": total,
        "test": {
            "selected": "CCA; not rerun",
            "current_corpus_bytes": test.get("bytes", 0),
            "projected_saved_bytes": test_saved,
            "strata": test_strata,
        },
        "mixed": {
            "selected": "CCA then accept gate; sensitive/unresolved identity",
            "current_corpus_bytes": coverage["mixed_bytes"],
            "actual_saved_bytes": mixed_saved,
            "actual_ungated_saved_bytes": ungated_mixed_saved,
        },
        "git_diff": {
            "selected": "identity",
            "current_corpus_bytes": coverage["by_class"]["git_diff"].get("bytes", 0),
            "projected_saved_bytes": 0,
        },
        "other_classes": "identity",
        "tests_only_projected_saved_pct": 100.0 * test_saved / total if total else 0.0,
        "tests_plus_gated_mixed_projected_saved_bytes": test_saved + mixed_saved,
        "tests_plus_gated_mixed_projected_saved_pct": 100.0 * (test_saved + mixed_saved) / total if total else 0.0,
        "tests_plus_ungated_mixed_projected_saved_pct": 100.0 * (test_saved + ungated_mixed_saved) / total if total else 0.0,
        "bytes_are_not_tokens_or_spend": True,
    }


def build_payload(
    coverage: dict[str, Any],
    records: list[dict[str, Any]],
    exclusions: dict[str, Any],
    pins: dict[str, str],
) -> dict[str, Any]:
    evaluated = aggregate_records(records)
    sample = aggregate_records([
        record for record in records if record["comparable_sample"]
    ])
    identity_bytes = (
        exclusions["unresolved_identity_bytes"]
        + exclusions["sensitive_identity_bytes"]
    )
    full_input = coverage["mixed_bytes"]
    full_ungated_saved = evaluated["ungated"]["saved_bytes"]
    full_gated_saved = evaluated["gated"]["saved_bytes"]
    all_mixed = {
        **evaluated,
        "mixed_census_bodies": coverage["mixed_body_count"],
        "mixed_census_bytes": full_input,
        "identity_exclusions": exclusions,
        "identity_exclusion_bytes": identity_bytes,
        "ungated": {
            **evaluated["ungated"],
            "output_bytes_including_identity_exclusions": full_input - full_ungated_saved,
            "saved_pct_of_all_mixed_bytes": 100.0 * full_ungated_saved / full_input if full_input else 0.0,
        },
        "gated": {
            **evaluated["gated"],
            "output_bytes_including_identity_exclusions": full_input - full_gated_saved,
            "saved_pct_of_all_mixed_bytes": 100.0 * full_gated_saved / full_input if full_input else 0.0,
        },
    }
    return {
        "schema": "qq.cca-mixed-current/v1",
        "method": {
            "delegation_id": AUTHORITATIVE_DELEGATION,
            "authoritative_parent_session": AUTHORITATIVE_PARENT,
            "study_session_excluded": STUDY_SESSION,
            "event_cutoff_ms": EVENT_CUTOFF_MS,
            "event_cutoff_utc": datetime.fromtimestamp(EVENT_CUTOFF_MS / 1000, timezone.utc).isoformat(),
            "classifier": "unchanged historical 11-class command/output classifier",
            "replay_scope": "every joined non-sensitive mixed/compound body",
            "comparable_sample": f"largest {COMPARABLE_SAMPLE_N} joined non-sensitive mixed bodies with >= {COMPARABLE_MIN_CHARS} chars",
            "first_result_per_call": True,
            "cca_exit_code_assumption": 0,
            "cca_head_tail_disabled": False,
            "stock_10k_envelope_applied": False,
            "byte_measure": "pre-envelope UTF-8 with replacement for invalid scalar values",
            "critical_used_by_gate": False,
            "fail_open": True,
            "historical_commands_executed": False,
            "post_hoc_stdin_only": True,
            "cca_transport": "persistent JSONL; exact synchronous compressObservation call",
            "one_shot_transport_equivalence": "30/30 marker-stripped candidates byte-identical",
            "full_commands_persisted": False,
            "full_bodies_persisted": False,
            "excerpts_persisted": False,
            "secret_context_skipped_as_identity": True,
            "other_compressors_used": [],
            "paid_model_used": False,
        },
        "pins": pins,
        "prior": PRIOR,
        "coverage": coverage,
        "mixed": {
            "all_current": all_mixed,
            "comparable_largest_20": sample,
        },
        "gate": {
            "reject_reasons": [
                "changed_false", "not_shorter", "diff_hunk_loss",
                "test_failing_name_loss", "diagnostic_loss",
            ],
            "cca_error": "fail-open identity",
            "strictly_shorter_utf8_bytes_required": True,
            "exact_line_retention": "Counter (duplicate-sensitive)",
            "categories": list(GATE_CATEGORIES),
            "critical_ignored": True,
        },
        "projection": make_projection(coverage, all_mixed),
        "record_count": len(records),
        "records_sha256": hashlib.sha256(
            "".join(
                json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                for record in records
            ).encode("utf-8", "replace")
        ).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--cca-root", type=Path, default=DEFAULT_CCA)
    parser.add_argument("--output", type=Path, default=HERE / "results.json")
    parser.add_argument("--scan-only", action="store_true")
    args = parser.parse_args()

    pins = validate_pins(args.cca_root)
    mixed, coverage = scan_corpus(args.corpus)
    print(json.dumps({
        "coverage": {
            key: coverage[key] for key in (
                "discovered_archives", "included_sessions",
                "bash_issuing_sessions", "bash_calls", "bash_bytes",
                "mixed_body_count", "mixed_joined_body_count",
                "mixed_bytes", "mixed_byte_share_pct",
            )
        },
        "eligible_mixed": sum(item.eligible for item in mixed),
        "sensitive_mixed": sum(item.joined and item.sensitive for item in mixed),
    }, indent=2), flush=True)
    if args.scan_only:
        return

    records, exclusions = replay_mixed(mixed, args.cca_root)
    payload = build_payload(coverage, records, exclusions, pins)
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "all_current": payload["mixed"]["all_current"],
        "comparable_largest_20": payload["mixed"]["comparable_largest_20"],
        "projection": payload["projection"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
