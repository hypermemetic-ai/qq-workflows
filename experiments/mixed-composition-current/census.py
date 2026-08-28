#!/usr/bin/env python3
"""Census current frozen-classifier mixed bash bodies and structural opportunity.

Historical commands are metadata and are never executed. Full commands, result
bodies, excerpts, and per-observation records exist only in memory. The JSON
artifact contains aggregate counts/bytes and a digest over bodyless metrics.
"""
from __future__ import annotations

import argparse
import collections
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Callable, Iterable

HERE = Path(__file__).resolve().parent
REPLAY_PATH = HERE.parent / "cca-mixed-current" / "replay.py"
DEFAULT_CORPUS = Path.home() / ".local/state/qq/sessions"
STUDY_SESSION = "session-401143a9-2d26-4793-a2e9-8c8409f236fe"
EVENT_CUTOFF_MS = 1787915481900
AUTHORITATIVE_PARENT = "session-af60703c-a964-41ee-bb2b-9edfc7b170f3"
AUTHORITATIVE_DELEGATION = "835fde7c-7d7f-4cc9-af23-78019657d6e9"

# Import the recovered implementation itself. Adding its directory supports
# replay.py's sibling `gate` import without copying any final-class behavior.
_spec = importlib.util.spec_from_file_location("frozen_cca_mixed_replay", REPLAY_PATH)
if _spec is None or _spec.loader is None:  # pragma: no cover - installation error
    raise RuntimeError(f"cannot import frozen classifier: {REPLAY_PATH}")
import sys
sys.path.insert(0, str(REPLAY_PATH.parent))
frozen = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = frozen
_spec.loader.exec_module(frozen)

CLASS_TAG_ORDER = (
    "git_diff", "git_status", "test", "npm/install/debug_log", "write/edit",
    "source_dump", "search", "listing", "lockfile/json",
)

ANSI_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))"
)
DIAGNOSTIC_RE = re.compile(
    r"(?i)(?:\berror\b|\bwarn(?:ing)?\b|\bfail(?:ed|ure|ing)?\b|"
    r"traceback|exception|panic|assert(?:ion)?|segmentation fault|fatal:)"
)
DIFF_EVIDENCE_RE = re.compile(
    r"^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|--- |\+\+\+ |@@ |[+-])"
)
FAIL_NAME_RE = re.compile(
    r"(?i)^(?:FAILED\s+|FAIL\s+|not ok\b)|(?:[>✗✘×]\s*.*\bfail)|"
    r"\b(?:failed|failure)\b"
)
TRACE_RE = re.compile(
    r"(?i)^\s*(?:File \".*\", line \d+|at\s+\S+|caused by:|"
    r"\d+:\s+\S+|stack backtrace:)"
)
PATH_RE = re.compile(
    r"(?:^|\s|[\"'(])(?:\.?\.?/|/)?(?:[A-Za-z0-9_.@+-]+[/\\])+"
    r"[A-Za-z0-9_.@+(){}\[\]-]+(?::\d+(?::\d+)?)?"
    r"|(?:^|\s)[A-Za-z0-9_.@+-]+\."
    r"(?:py|mjs|cjs|js|jsx|ts|tsx|rs|go|java|c|cc|cpp|h|hpp|rb|sh|bash|"
    r"zsh|md|toml|ya?ml|json)(?::\d+(?::\d+)?)?(?:\s|:|$)"
)
VERSION_RE = re.compile(
    r"(?i)(?:\bversion\s*[:=]?\s*|(?:^|\s)v?)\d+\.\d+(?:\.\d+)?"
    r"(?:[-+][0-9A-Za-z.-]+)?\b"
)
SUMMARY_WORD = (
    r"(?:tests?|suites?|files?|cases?|checks?|assertions?|passed|failed|skipped|"
    r"todo|errors?|warnings?|total|found|matches|results?|added|removed|changed|"
    r"insertions?|deletions?)"
)
SUMMARY_COUNT_RE = re.compile(
    rf"(?i)(?:\b{SUMMARY_WORD}\b[^\n]{{0,80}}\b\d[\d,]*(?:\.\d+)?\b"
    rf"|\b\d[\d,]*(?:\.\d+)?\b[^\n]{{0,80}}\b{SUMMARY_WORD}\b)"
)
WRAPPER_LINE_RE = re.compile(
    r"(?i)^\s*(?:chunk id:\s*\S+|wall time:\s*\S+|process exited with code\s+"
    r"-?\d+|final output:|command output:)\s*$"
)
DECORATOR_RE = re.compile(r"^\s*[-=_.#*━─]{3,}\s*$")
PROGRESS_RE = re.compile(
    r"(?ix)^\s*(?:"
    r"(?:[|/\\\-]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+.*(?:\d{1,3}%|\d+\s*/\s*\d+)"
    r"|\[?[#=*>.\-]{3,}\]?\s*\d{1,3}%"
    r"|\d{1,3}%\s*(?:complete|done)?"
    r"|(?:progress:\s*)?(?:resolved|reused|downloaded|fetched|fetching|"
    r"extracting|linking|building)\s+\d+.*"
    r"|\[\s*\d+\s*/\s*\d+\s*\].*"
    r")\s*$"
)
PASS_LINE_RE = re.compile(
    r"(?ix)^\s*(?:"
    r"(?:ok\s+\d+\s+-\s+.+)"
    r"|(?:.+?::\S+\s+PASSED(?:\s+\[\s*\d+%\])?)"
    r"|(?:[✓✔√]\s+.+)"
    r"|(?:PASS\s+\S+\.(?:js|jsx|ts|tsx))"
    r")\s*$"
)


def utf8_bytes(value: str) -> int:
    return len(value.encode("utf-8", "replace"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def constituent_tags(command: str, output: str) -> set[str]:
    """Expose the exact predicates inside frozen classify_bash, without new tags."""
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
    return tags


def reconstructed_class(command: str, output: str) -> str:
    """Used only to assert reporting predicates remain equivalent to frozen logic."""
    tags = constituent_tags(command, output)
    if len(tags) >= 2 and frozen.compound_shell(command):
        return "mixed/compound"
    for cls in CLASS_TAG_ORDER:
        if cls in tags:
            return cls
    if frozen.compound_shell(command) and re.search(
        r"(?:\n|&&|;).*(?:\n|&&|;)", command, re.S
    ):
        return "mixed/compound"
    return "other"


@dataclass
class Observation:
    serial: int
    session: str
    call_id: str
    command: str
    body: str
    joined: bool
    sensitive: bool
    tags: frozenset[str]

    @property
    def raw_bytes(self) -> int:
        return utf8_bytes(self.body)

    @property
    def eligible(self) -> bool:
        return self.joined and not self.sensitive

    @property
    def observation_id(self) -> str:
        return hashlib.sha256(
            f"{self.session}\0{self.call_id}".encode("utf-8", "replace")
        ).hexdigest()


@dataclass
class Candidate:
    text: str
    removed_bytes: int = 0
    marker_bytes: int = 0


def slot_add(table: dict[str, collections.Counter[str]], key: str, size: int) -> None:
    table[key]["bodies"] += 1
    table[key]["bytes"] += size


def slot_json(table: dict[str, collections.Counter[str]]) -> dict[str, dict[str, int]]:
    return {key: dict(value) for key, value in sorted(
        table.items(), key=lambda item: (-item[1]["bytes"], item[0])
    )}


def split_lines(body: str) -> list[str]:
    lines = body.splitlines(keepends=True)
    if sum(utf8_bytes(line) for line in lines) != utf8_bytes(body):
        raise AssertionError("splitlines byte accounting drift")
    return lines


def bare(line: str) -> str:
    return line.rstrip("\r\n")


def is_diagnostic_evidence(line: str) -> bool:
    value = bare(line)
    return bool(
        DIAGNOSTIC_RE.search(value)
        or DIFF_EVIDENCE_RE.search(value)
        or FAIL_NAME_RE.search(value)
        or TRACE_RE.search(value)
    )


def is_named_keep_evidence(line: str) -> bool:
    value = bare(line)
    return bool(
        is_diagnostic_evidence(line)
        or PATH_RE.search(value)
        or VERSION_RE.search(value)
        or SUMMARY_COUNT_RE.search(value)
    )


def strip_terminal_control(body: str, _tags: frozenset[str]) -> Candidate:
    text = ANSI_RE.sub("", body).replace("\r\n", "\n")
    removed = utf8_bytes(body) - utf8_bytes(text)
    return Candidate(text, max(0, removed), 0)


def normalize_layout(body: str, _tags: frozenset[str]) -> Candidate:
    lines = split_lines(body)
    output: list[str] = []
    removed = 0
    blank_run = 0
    for line in lines:
        value = bare(line)
        if not value.strip():
            blank_run += 1
            if blank_run > 2:
                removed += utf8_bytes(line)
                continue
        else:
            blank_run = 0
        if DECORATOR_RE.fullmatch(value) and len(value.strip()) > 3:
            ending = line[len(value):]
            replacement = value[: len(value) - len(value.lstrip())] + value.strip()[0] * 3 + ending
            removed += utf8_bytes(line) - utf8_bytes(replacement)
            output.append(replacement)
        else:
            output.append(line)
    return Candidate("".join(output), removed, 0)


def collapse_adjacent_duplicates(body: str, _tags: frozenset[str]) -> Candidate:
    lines = split_lines(body)
    output: list[str] = []
    removed = marker_bytes = 0
    index = 0
    while index < len(lines):
        end = index + 1
        while end < len(lines) and lines[end] == lines[index]:
            end += 1
        count = end - index
        line = lines[index]
        if count >= 3 and bare(line).strip() and not is_named_keep_evidence(line):
            omitted = count - 2
            marker = f"[... {omitted} identical lines omitted ...]\n"
            output.extend((line, marker, line))
            removed += omitted * utf8_bytes(line)
            marker_bytes += utf8_bytes(marker)
        else:
            output.extend(lines[index:end])
        index = end
    return Candidate("".join(output), removed, marker_bytes)


def collapse_repeated_lines(body: str, _tags: frozenset[str]) -> Candidate:
    """Fold non-adjacent exact repeats while retaining endpoints and a count."""
    lines = split_lines(body)
    positions: dict[str, list[int]] = collections.defaultdict(list)
    for index, line in enumerate(lines):
        if bare(line).strip() and not is_named_keep_evidence(line):
            positions[line].append(index)
    targets = {line: indexes for line, indexes in positions.items() if len(indexes) >= 3}
    if not targets:
        return Candidate(body)
    output: list[str] = []
    removed = marker_bytes = 0
    seen: collections.Counter[str] = collections.Counter()
    for index, line in enumerate(lines):
        indexes = targets.get(line)
        if not indexes:
            output.append(line)
            continue
        seen[line] += 1
        occurrence = seen[line]
        if occurrence == 1 or index == indexes[-1]:
            output.append(line)
        elif occurrence == 2:
            omitted = len(indexes) - 2
            marker = f"[... {omitted} middle occurrences of an exact line omitted; final retained ...]\n"
            output.append(marker)
            marker_bytes += utf8_bytes(marker)
            removed += utf8_bytes(line)
        else:
            removed += utf8_bytes(line)
    return Candidate("".join(output), removed, marker_bytes)


def _collapse_runs(
    body: str,
    predicate: Callable[[str], bool],
    minimum: int,
    label: str,
) -> Candidate:
    lines = split_lines(body)
    output: list[str] = []
    removed = marker_bytes = 0
    index = 0
    while index < len(lines):
        if not predicate(lines[index]):
            output.append(lines[index])
            index += 1
            continue
        end = index + 1
        while end < len(lines) and predicate(lines[end]):
            end += 1
        count = end - index
        if count >= minimum:
            omitted = count - 2
            marker = f"[... {omitted} {label} lines omitted ...]\n"
            output.extend((lines[index], marker, lines[end - 1]))
            removed += sum(utf8_bytes(line) for line in lines[index + 1:end - 1])
            marker_bytes += utf8_bytes(marker)
        else:
            output.extend(lines[index:end])
        index = end
    return Candidate("".join(output), removed, marker_bytes)


def collapse_progress(body: str, _tags: frozenset[str]) -> Candidate:
    def progress(line: str) -> bool:
        return bool(PROGRESS_RE.fullmatch(bare(line))) and not is_diagnostic_evidence(line)
    return _collapse_runs(body, progress, 4, "progress update")


def collapse_passing_tests(body: str, tags: frozenset[str]) -> Candidate:
    if "test" not in tags:
        return Candidate(body)
    def passed(line: str) -> bool:
        return bool(PASS_LINE_RE.fullmatch(bare(line))) and not is_diagnostic_evidence(line)
    return _collapse_runs(body, passed, 4, "passing test")


def evidence_indexed_slice(body: str, _tags: frozenset[str]) -> Candidate:
    """High-risk ceiling: first/last 40 lines plus evidence and +/-2 lines."""
    if utf8_bytes(body) <= 10 * 1024:
        return Candidate(body)
    lines = split_lines(body)
    keep = set(range(min(40, len(lines))))
    keep.update(range(max(0, len(lines) - 40), len(lines)))
    for index, line in enumerate(lines):
        if is_named_keep_evidence(line):
            keep.update(range(max(0, index - 2), min(len(lines), index + 3)))
    output: list[str] = []
    removed = marker_bytes = 0
    index = 0
    while index < len(lines):
        if index in keep:
            output.append(lines[index])
            index += 1
            continue
        end = index + 1
        while end < len(lines) and end not in keep:
            end += 1
        marker = f"[... {end - index} unique/payload lines omitted by evidence slice ...]\n"
        output.append(marker)
        removed += sum(utf8_bytes(line) for line in lines[index:end])
        marker_bytes += utf8_bytes(marker)
        index = end
    return Candidate("".join(output), removed, marker_bytes)


FILTERS: tuple[tuple[str, Callable[[str, frozenset[str]], Candidate], str], ...] = (
    ("terminal_control", strip_terminal_control, "low"),
    ("layout_boilerplate", normalize_layout, "low"),
    ("adjacent_exact_repetition", collapse_adjacent_duplicates, "low"),
    ("nonadjacent_exact_repetition", collapse_repeated_lines, "low-medium"),
    ("progress_runs", collapse_progress, "low-medium"),
    ("passing_test_runs", collapse_passing_tests, "medium"),
)
CEILING_FILTER = ("evidence_indexed_large_body_slice", evidence_indexed_slice, "high")


def scan_corpus(corpus: Path) -> tuple[list[Observation], dict[str, Any]]:
    paths = sorted(corpus.glob("**/session.jsonl.zstd"))
    observations: list[Observation] = []
    by_class = {name: collections.Counter() for name in frozen.BASH_CLASSES}
    included_session_ids: list[str] = []
    bash_sessions: set[str] = set()
    serial = result_events = duplicate_results = divergent_results = 0
    unresolved = decode_failures = classifier_mismatches = 0
    archives_at_or_before_cutoff = 0
    zstd_failures: list[dict[str, Any]] = []

    for path in paths:
        process = subprocess.Popen(
            ["zstd", "-q", "-d", "-c", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        header: dict[str, Any] = {}
        session_decode_failures = 0
        session_result_events = 0
        calls: list[dict[str, Any]] = []
        results: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
        for raw_line in process.stdout:
            try:
                event = json.loads(raw_line)
            except Exception:
                session_decode_failures += 1
                continue
            if event.get("type") == "session":
                header = event
            event_time = event.get("time")
            if isinstance(event_time, (int, float)) and event_time > EVENT_CUTOFF_MS:
                continue
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            if event.get("type") == "tool/call":
                calls.append({
                    "call_id": str(data.get("callId", "")),
                    "tool": str(data.get("name", "unknown")),
                    "args": frozen.parse_args(data.get("arguments")),
                })
            elif event.get("type") == "tool/result":
                session_result_events += 1
                message = data.get("message") if isinstance(data.get("message"), dict) else {}
                source = message.get("source") if isinstance(message.get("source"), dict) else {}
                call_id = str(source.get("callId", ""))
                text, _meta = frozen.extract_result(data)
                results[call_id].append((text, hashlib.sha256(
                    text.encode("utf-8", "replace")
                ).hexdigest()))
        stderr = process.stderr.read() if process.stderr else ""
        returncode = process.wait()
        sid = str(header.get("id") or path.parent.name)
        created_at = int(header.get("createdAt") or 0)
        if created_at <= EVENT_CUTOFF_MS:
            archives_at_or_before_cutoff += 1
        if sid == STUDY_SESSION or created_at > EVENT_CUTOFF_MS:
            continue
        decode_failures += session_decode_failures
        result_events += session_result_events
        if returncode:
            zstd_failures.append({
                "session_sha256": hashlib.sha256(sid.encode()).hexdigest(),
                "returncode": returncode,
                "error_kind": stderr.split(":", 1)[0][:80],
            })

        included_session_ids.append(sid)
        bash_calls = [call for call in calls if call["tool"] == "bash"]
        if bash_calls:
            bash_sessions.add(sid)
        for variants in results.values():
            if len(variants) > 1:
                duplicate_results += len(variants) - 1
                divergent_results += int(len({digest for _text, digest in variants}) > 1)

        for call in bash_calls:
            serial += 1
            variants = results.get(call["call_id"], [])
            joined = bool(variants)
            unresolved += int(not joined)
            body = variants[0][0] if variants else ""
            command = str(call["args"].get("command", ""))
            actual = frozen.classify_bash(command, body)
            expected = reconstructed_class(command, body)
            classifier_mismatches += int(actual != expected)
            size = utf8_bytes(body)
            by_class[actual]["calls"] += 1
            by_class[actual]["bytes"] += size
            if actual != "mixed/compound":
                continue
            tags = frozenset(constituent_tags(command, body))
            sensitive = frozen.is_sensitive(command, body) if joined else False
            observations.append(Observation(
                serial, sid, call["call_id"], command, body, joined, sensitive, tags
            ))

    included_session_ids.sort()
    total_calls = sum(slot["calls"] for slot in by_class.values())
    total_bytes = sum(slot["bytes"] for slot in by_class.values())
    mixed_bytes = by_class["mixed/compound"]["bytes"]
    coverage = {
        "archives_at_or_before_cutoff": archives_at_or_before_cutoff,
        "included_sessions": len(included_session_ids),
        "included_session_ids_sha256": hashlib.sha256(
            "\n".join(included_session_ids).encode()
        ).hexdigest(),
        "bash_issuing_sessions": len(bash_sessions),
        "bash_calls": total_calls,
        "bash_bytes": total_bytes,
        "mixed_body_count": len(observations),
        "mixed_joined_body_count": sum(item.joined for item in observations),
        "mixed_bytes": mixed_bytes,
        "mixed_byte_share_pct": 100.0 * mixed_bytes / total_bytes if total_bytes else 0.0,
        "sensitive_mixed_bodies": sum(item.joined and item.sensitive for item in observations),
        "sensitive_mixed_bytes": sum(
            item.raw_bytes for item in observations if item.joined and item.sensitive
        ),
        "unresolved_bash_calls": unresolved,
        "result_events": result_events,
        "duplicate_result_events": duplicate_results,
        "divergent_result_groups": divergent_results,
        "decode_failures": decode_failures,
        "zstd_failures": zstd_failures,
        "post_cutoff_events_ignored": True,
        "constituent_reconstruction_mismatches": classifier_mismatches,
        "by_class": {name: dict(by_class[name]) for name in frozen.BASH_CLASSES},
    }
    if classifier_mismatches:
        raise AssertionError(
            f"constituent predicates differ from frozen classifier: {classifier_mismatches}"
        )
    return observations, coverage


def body_shape(command: str) -> tuple[list[str], str]:
    operators: list[str] = []
    if "&&" in command:
        operators.append("&&")
    if re.search(r"(?<!\|)\|(?!\|)", command):
        operators.append("pipe")
    if "<<" in command:
        operators.append("heredoc")
    return operators, "+".join(operators)


def size_stratum(size: int) -> str:
    if size == 0:
        return "zero"
    if size <= 255:
        return "1-255 B"
    if size <= 1024:
        return "256 B-1 KiB"
    if size <= 4 * 1024:
        return ">1-4 KiB"
    if size <= 10 * 1024:
        return ">4-10 KiB"
    if size <= 100 * 1024:
        return ">10-100 KiB"
    return ">100 KiB"


def profile_lines(observations: Iterable[Observation]) -> dict[str, Any]:
    categories: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    evidence: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    terminal_control_bytes = 0
    total_lines = total_bytes = 0
    for item in observations:
        seen: set[str] = set()
        for line in split_lines(item.body):
            size = utf8_bytes(line)
            total_lines += 1
            total_bytes += size
            terminal_control_bytes += sum(
                utf8_bytes(match.group(0)) for match in ANSI_RE.finditer(line)
            ) + (1 if line.endswith("\r\n") else 0)
            value = bare(line)
            if line in seen:
                category = "exact_repetition_after_first"
            elif WRAPPER_LINE_RE.fullmatch(value):
                category = "recognized_tool_wrapper"
            elif PROGRESS_RE.fullmatch(value):
                category = "progress_update"
            elif not value.strip() or DECORATOR_RE.fullmatch(value):
                category = "layout_boilerplate"
            elif "test" in item.tags and PASS_LINE_RE.fullmatch(value):
                category = "routine_passing_test"
            else:
                category = "first_seen_other_payload_like"
            seen.add(line)
            categories[category]["lines"] += 1
            categories[category]["bytes"] += size
            for name, predicate in (
                ("diagnostic_or_diff_or_failing", is_diagnostic_evidence),
                ("path", lambda text: bool(PATH_RE.search(bare(text)))),
                ("version", lambda text: bool(VERSION_RE.search(bare(text)))),
                ("summary_or_count", lambda text: bool(SUMMARY_COUNT_RE.search(bare(text)))),
            ):
                if predicate(line):
                    evidence[name]["lines"] += 1
                    evidence[name]["bytes"] += size
    for key in (
        "first_seen_other_payload_like", "exact_repetition_after_first",
        "recognized_tool_wrapper", "progress_update", "layout_boilerplate",
        "routine_passing_test",
    ):
        categories[key]["lines"] += 0
        categories[key]["bytes"] += 0
    return {
        "physical_lines": total_lines,
        "physical_line_bytes": total_bytes,
        "disjoint_line_profile": {
            key: dict(value) for key, value in sorted(
                categories.items(), key=lambda item: (-item[1]["bytes"], item[0])
            )
        },
        "inclusive_named_evidence": {
            key: dict(value) for key, value in sorted(evidence.items())
        },
        "terminal_control_bytes_inclusive": terminal_control_bytes,
    }


def evaluate_one_filter(
    observations: Iterable[Observation],
    function: Callable[[str, frozenset[str]], Candidate],
) -> dict[str, int]:
    totals: collections.Counter[str] = collections.Counter()
    for item in observations:
        if not item.eligible:
            totals["identity_exclusion_bodies"] += 1
            totals["identity_exclusion_bytes"] += item.raw_bytes
            continue
        totals["evaluated_bodies"] += 1
        totals["input_bytes"] += item.raw_bytes
        candidate = function(item.body, item.tags)
        output_bytes = utf8_bytes(candidate.text)
        # Each proposed family is fail-open per body if marker overhead or a
        # pathological match would make the result no shorter.
        if output_bytes < item.raw_bytes:
            totals["changed_bodies"] += 1
            totals["output_bytes"] += output_bytes
            totals["saved_bytes"] += item.raw_bytes - output_bytes
            totals["raw_removed_bytes"] += candidate.removed_bytes
            totals["marker_bytes"] += candidate.marker_bytes
        else:
            totals["output_bytes"] += item.raw_bytes
            totals["fail_open_not_shorter_bodies"] += int(candidate.text != item.body)
    return dict(totals)


def evaluate_filters(observations: list[Observation]) -> dict[str, Any]:
    independent: dict[str, Any] = {}
    for name, function, risk in FILTERS + (CEILING_FILTER,):
        stats = evaluate_one_filter(observations, function)
        stats["evidence_risk"] = risk
        independent[name] = stats

    stacked_totals: collections.Counter[str] = collections.Counter()
    by_family: dict[str, collections.Counter[str]] = {
        name: collections.Counter() for name, _function, _risk in FILTERS
    }
    for item in observations:
        if not item.eligible:
            stacked_totals["identity_exclusion_bodies"] += 1
            stacked_totals["identity_exclusion_bytes"] += item.raw_bytes
            continue
        stacked_totals["evaluated_bodies"] += 1
        stacked_totals["input_bytes"] += item.raw_bytes
        text = item.body
        touched = False
        for name, function, _risk in FILTERS:
            candidate = function(text, item.tags)
            before = utf8_bytes(text)
            after = utf8_bytes(candidate.text)
            if after < before:
                touched = True
                text = candidate.text
                by_family[name]["changed_bodies"] += 1
                by_family[name]["incremental_saved_bytes"] += before - after
                by_family[name]["raw_removed_bytes"] += candidate.removed_bytes
                by_family[name]["marker_bytes"] += candidate.marker_bytes
        output_bytes = utf8_bytes(text)
        stacked_totals["changed_bodies"] += int(touched)
        stacked_totals["output_bytes"] += output_bytes
        stacked_totals["saved_bytes"] += item.raw_bytes - output_bytes
    return {
        "independent": independent,
        "conservative_stack": {
            **dict(stacked_totals),
            "by_family_incremental": {
                key: dict(value) for key, value in by_family.items()
            },
        },
    }


def aggregate(observations: list[Observation], coverage: dict[str, Any]) -> dict[str, Any]:
    shape_inclusive: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    shape_signatures: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    classifier_paths: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    combinations: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    tag_inclusive: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    strata: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    digest_rows: list[str] = []

    for item in observations:
        size = item.raw_bytes
        operators, signature = body_shape(item.command)
        for operator in operators:
            slot_add(shape_inclusive, operator, size)
        slot_add(shape_signatures, signature, size)
        path = "multi-tag compound" if len(item.tags) >= 2 else "generic-compound fallback"
        slot_add(classifier_paths, path, size)
        combination = "+".join(tag for tag in CLASS_TAG_ORDER if tag in item.tags)
        if not combination:
            combination = "no-tag generic-compound"
        slot_add(combinations, combination, size)
        for tag in item.tags:
            slot_add(tag_inclusive, tag, size)
        slot_add(strata, size_stratum(size), size)
        digest_rows.append(json.dumps({
            "observation_id": item.observation_id,
            "bytes": size,
            "joined": item.joined,
            "sensitive": item.sensitive,
            "tags": sorted(item.tags),
            "shape": signature,
        }, sort_keys=True, separators=(",", ":")))

    for label in (
        "zero", "1-255 B", "256 B-1 KiB", ">1-4 KiB", ">4-10 KiB",
        ">10-100 KiB", ">100 KiB",
    ):
        strata[label]["bodies"] += 0
        strata[label]["bytes"] += 0

    filters = evaluate_filters(observations)
    all_mixed = coverage["mixed_bytes"]
    filters["conservative_stack"]["saved_pct_of_all_mixed_bytes"] = (
        100.0 * filters["conservative_stack"].get("saved_bytes", 0) / all_mixed
        if all_mixed else 0.0
    )
    for stats in filters["independent"].values():
        stats["saved_pct_of_all_mixed_bytes"] = (
            100.0 * stats.get("saved_bytes", 0) / all_mixed if all_mixed else 0.0
        )

    return {
        "schema": "qq.mixed-composition-current/v1",
        "method": {
            "delegation_id": AUTHORITATIVE_DELEGATION,
            "authoritative_parent_session": AUTHORITATIVE_PARENT,
            "study_session_excluded": STUDY_SESSION,
            "event_cutoff_ms": EVENT_CUTOFF_MS,
            "event_cutoff_utc": datetime.fromtimestamp(
                EVENT_CUTOFF_MS / 1000, timezone.utc
            ).isoformat(),
            "corpus": "$HOME/.local/state/qq/sessions/**/session.jsonl.zstd",
            "first_result_per_bash_call": True,
            "classifier": "imported frozen 11-class classify_bash and compound_shell",
            "classifier_module": "experiments/cca-mixed-current/replay.py",
            "classifier_module_sha256": sha256_file(REPLAY_PATH),
            "historical_commands_executed": False,
            "full_commands_persisted": False,
            "full_bodies_persisted": False,
            "excerpts_persisted": False,
            "per_observation_records_persisted": False,
            "stock_10k_envelope_applied": False,
            "byte_measure": "pre-envelope UTF-8 with replacement for invalid scalar values",
            "sensitive_and_unresolved_filter_policy": "identity",
            "cca_invoked": False,
            "rtk_invoked": False,
            "live_pair_used": False,
        },
        "coverage": coverage,
        "composition": {
            "command_shape_inclusive": slot_json(shape_inclusive),
            "command_shape_exclusive_signatures": slot_json(shape_signatures),
            "classifier_path": slot_json(classifier_paths),
            "constituent_tag_combinations": slot_json(combinations),
            "constituent_tags_inclusive": slot_json(tag_inclusive),
            "size_strata": slot_json(strata),
        },
        "structure": profile_lines(observations),
        "candidate_filters": filters,
        "bodyless_observation_digest": hashlib.sha256(
            ("\n".join(digest_rows) + "\n").encode("utf-8", "replace")
        ).hexdigest(),
        "bodyless_observation_count": len(digest_rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--output", type=Path, default=HERE / "results.json")
    args = parser.parse_args()
    observations, coverage = scan_corpus(args.corpus)
    payload = aggregate(observations, coverage)
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "coverage": {
            key: coverage[key] for key in (
                "included_sessions", "bash_calls", "bash_bytes", "mixed_body_count",
                "mixed_joined_body_count", "mixed_bytes", "mixed_byte_share_pct",
            )
        },
        "classifier_paths": payload["composition"]["classifier_path"],
        "size_strata": payload["composition"]["size_strata"],
        "structure": payload["structure"],
        "candidate_filters": payload["candidate_filters"],
    }, indent=2))


if __name__ == "__main__":
    main()
