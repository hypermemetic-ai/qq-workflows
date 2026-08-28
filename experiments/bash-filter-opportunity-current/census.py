#!/usr/bin/env python3
"""Inspect-only all-bash keep-ladder and class-cap opportunity census.

Historical shell commands are classifier metadata and are never executed. Full
commands, result text, candidates, excerpts, and per-observation rows remain in
memory only. The persisted artifact contains aggregate counts/UTF-8 bytes and a
digest over bodyless metrics.
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
STUDY_SESSION = "session-e2a0fe75-9bf3-42fe-8cff-51886cbab871"
EVENT_CUTOFF_MS = 1787919339065
AUTHORITATIVE_PARENT = "session-af60703c-a964-41ee-bb2b-9edfc7b170f3"
AUTHORITATIVE_DELEGATION = "92bb40b1-5440-414b-b654-172c958bdfe8"
ENVELOPE_BYTES = 10_000

# Import the frozen implementation itself. Inserting its directory permits the
# module's sibling `gate` import; no compression entry point is called by this study.
_spec = importlib.util.spec_from_file_location("frozen_bash_filter_replay", REPLAY_PATH)
if _spec is None or _spec.loader is None:  # pragma: no cover - install failure
    raise RuntimeError(f"cannot import frozen classifier: {REPLAY_PATH}")
import sys
sys.path.insert(0, str(REPLAY_PATH.parent))
frozen = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = frozen
_spec.loader.exec_module(frozen)

BASH_CLASSES = tuple(frozen.BASH_CLASSES)
CLASS_TAG_ORDER = (
    "git_diff", "git_status", "test", "npm/install/debug_log", "write/edit",
    "source_dump", "search", "listing", "lockfile/json",
)
SIZE_STRATA = (
    "zero", "1-255 B", "256 B-1 KiB", ">1-4 KiB", ">4-10 KiB",
    ">10-100 KiB", ">100 KiB",
)
LADDER_NAMES = ("K_struct", "K_fail", "K_hunk", "K_nav", "K_greedy")

ANSI_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))"
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
DIAGNOSTIC_RE = re.compile(
    r"(?i)(?:\berror\b|\bwarn(?:ing)?\b|\bfail(?:ed|ure|ing)?\b|"
    r"traceback|exception|panic|assert(?:ion)?|segmentation fault|\bfatal\b)"
)
FAIL_NAME_RE = re.compile(
    r"(?i)^(?:FAILED\s+|FAIL\s+|not ok\b)|(?:[>✗✘×]\s*.*\bfail)|"
    r"\b(?:failed|failure)\b"
)
TRACE_RE = re.compile(
    r"(?i)^\s*(?:File \".*\", line \d+|at\s+\S+|caused by:|"
    r"\d+:\s+\S+|stack backtrace:)"
)
DIFF_HEADER_RE = re.compile(
    r"^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|--- |\+\+\+ |@@ )"
)
DIFF_ADD_REMOVE_RE = re.compile(r"^[+-](?!\+\+ |-- )")

SOURCE_EXT = (
    r"(?:py|mjs|cjs|js|jsx|ts|tsx|rs|go|java|c|cc|cpp|h|hpp|rb|sh|bash|"
    r"zsh|md|toml|ya?ml|json)"
)
# K_nav is deliberately narrower than the old path rule: slash paths or a
# source/config filename carrying a line (and optional column) location.
NAV_PATH_RE = re.compile(
    rf"(?:^|\s|[\"'(])(?:\.?\.?/|/)?(?:[A-Za-z0-9_.@+-]+[/\\])+"
    rf"[A-Za-z0-9_.@+(){{}}\[\]-]+(?::\d+(?::\d+)?)?"
    rf"|(?:^|\s)[A-Za-z0-9_.@+-]+\.{SOURCE_EXT}:\d+(?::\d+)?(?:\s|:|$)"
)
# Exact previous mixed-composition greedy predicates. This intentionally keeps
# plain source filenames, loose decimal versions, summary counts, and any +/-
# line; it is reported only as the too-conservative baseline.
GREEDY_PATH_RE = re.compile(
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


def split_lines(text: str) -> list[str]:
    lines = text.splitlines(keepends=True)
    if sum(utf8_bytes(line) for line in lines) != utf8_bytes(text):
        raise AssertionError("splitlines byte accounting drift")
    return lines


def bare(line: str) -> str:
    return line.rstrip("\r\n")


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


def constituent_tags(command: str, output: str) -> set[str]:
    """Repeat only the predicates inside frozen classify_bash for reporting."""
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
    text: str
    joined: bool
    sensitive: bool
    cls: str
    tags: frozenset[str]

    @property
    def raw_bytes(self) -> int:
        return utf8_bytes(self.text)

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
    omitted_lines: int = 0
    marker_bytes: int = 0


def scan_corpus(corpus: Path) -> tuple[list[Observation], dict[str, Any]]:
    paths = sorted(corpus.glob("**/session.jsonl.zstd"))
    observations: list[Observation] = []
    by_class = {name: collections.Counter() for name in BASH_CLASSES}
    included_session_ids: list[str] = []
    bash_sessions: set[str] = set()
    serial = result_events = duplicate_results = divergent_results = 0
    unresolved = decode_failures = classifier_mismatches = 0
    archives_at_or_before_cutoff = 0
    post_cutoff_events: collections.Counter[str] = collections.Counter()
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
                post_cutoff_events[str(event.get("type", "unknown"))] += 1
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
            text = variants[0][0] if variants else ""
            command = str(call["args"].get("command", ""))
            actual = frozen.classify_bash(command, text)
            expected = reconstructed_class(command, text)
            classifier_mismatches += int(actual != expected)
            tags = frozenset(constituent_tags(command, text))
            sensitive = frozen.is_sensitive(command, text) if joined else False
            item = Observation(
                serial, sid, call["call_id"], command, text, joined,
                sensitive, actual, tags,
            )
            observations.append(item)
            slot = by_class[actual]
            slot["bodies"] += 1
            slot["bytes"] += item.raw_bytes
            slot["joined_bodies"] += int(joined)
            slot["sensitive_bodies"] += int(sensitive)
            slot["sensitive_bytes"] += item.raw_bytes if sensitive else 0
            slot["unresolved_bodies"] += int(not joined)

    included_session_ids.sort()
    total_bytes = sum(slot["bytes"] for slot in by_class.values())
    total_bodies = sum(slot["bodies"] for slot in by_class.values())
    for cls in BASH_CLASSES:
        by_class[cls]["byte_share_pct"] = (
            100.0 * by_class[cls]["bytes"] / total_bytes if total_bytes else 0.0
        )
    coverage = {
        "discovered_archives": len(paths),
        "archives_at_or_before_cutoff": archives_at_or_before_cutoff,
        "included_sessions": len(included_session_ids),
        "included_session_ids_sha256": hashlib.sha256(
            "\n".join(included_session_ids).encode()
        ).hexdigest(),
        "bash_issuing_sessions": len(bash_sessions),
        "bash_bodies": total_bodies,
        "bash_bytes": total_bytes,
        "joined_bodies": sum(item.joined for item in observations),
        "sensitive_identity_bodies": sum(item.sensitive for item in observations),
        "sensitive_identity_bytes": sum(
            item.raw_bytes for item in observations if item.sensitive
        ),
        "unresolved_identity_bodies": unresolved,
        "unresolved_identity_bytes": sum(
            item.raw_bytes for item in observations if not item.joined
        ),
        "first_10k_input_bytes": sum(
            min(item.raw_bytes, ENVELOPE_BYTES) for item in observations
        ),
        "result_events": result_events,
        "duplicate_result_events": duplicate_results,
        "divergent_result_groups": divergent_results,
        "decode_failures": decode_failures,
        "zstd_failures": zstd_failures,
        "post_cutoff_events": dict(sorted(post_cutoff_events.items())),
        "classifier_reconstruction_mismatches": classifier_mismatches,
        "by_class": {name: dict(by_class[name]) for name in BASH_CLASSES},
    }
    return observations, coverage


def body_shape(command: str) -> tuple[list[str], str]:
    operators: list[str] = []
    if "&&" in command:
        operators.append("&&")
    if re.search(r"(?<!\|)\|(?!\|)", command):
        operators.append("pipe")
    if "<<" in command:
        operators.append("heredoc")
    return operators, "+".join(operators) if operators else "none"


def add_slot(table: dict[str, collections.Counter[str]], key: str, size: int) -> None:
    table[key]["bodies"] += 1
    table[key]["bytes"] += size


def census_composition(observations: Iterable[Observation]) -> dict[str, Any]:
    class_totals: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    strata: dict[str, dict[str, collections.Counter[str]]] = {
        cls: collections.defaultdict(collections.Counter) for cls in BASH_CLASSES
    }
    mixed_shapes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    mixed_signatures: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    mixed_paths: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for item in observations:
        add_slot(class_totals, item.cls, item.raw_bytes)
        add_slot(strata[item.cls], size_stratum(item.raw_bytes), item.raw_bytes)
        if item.cls == "mixed/compound":
            operators, signature = body_shape(item.command)
            for operator in operators:
                add_slot(mixed_shapes, operator, item.raw_bytes)
            add_slot(mixed_signatures, signature, item.raw_bytes)
            path = "multi-tag compound" if len(item.tags) >= 2 else "generic fallback"
            add_slot(mixed_paths, path, item.raw_bytes)
    total = sum(slot["bytes"] for slot in class_totals.values())
    classes: dict[str, dict[str, Any]] = {}
    for cls in BASH_CLASSES:
        slot = class_totals[cls]
        classes[cls] = {
            "bodies": slot["bodies"],
            "bytes": slot["bytes"],
            "byte_share_pct": 100.0 * slot["bytes"] / total if total else 0.0,
            "size_strata": {
                label: dict(strata[cls][label]) for label in SIZE_STRATA
            },
        }
    return {
        "by_class": classes,
        "mixed": {
            "operator_inclusive": {
                key: dict(value) for key, value in sorted(mixed_shapes.items())
            },
            "operator_exclusive_signatures": {
                key: dict(value) for key, value in sorted(mixed_signatures.items())
            },
            "classifier_path": {
                key: dict(value) for key, value in sorted(mixed_paths.items())
            },
        },
    }


def is_fail_line(line: str) -> bool:
    value = bare(line)
    return bool(
        DIAGNOSTIC_RE.search(value)
        or FAIL_NAME_RE.search(value)
        or TRACE_RE.search(value)
        or DIFF_HEADER_RE.search(value)
    )


def is_nav_line(line: str) -> bool:
    return bool(NAV_PATH_RE.search(bare(line)))


def is_greedy_line(line: str) -> bool:
    value = bare(line)
    return bool(
        is_fail_line(line)
        or GREEDY_PATH_RE.search(value)
        or VERSION_RE.search(value)
        or SUMMARY_COUNT_RE.search(value)
        or value.startswith(("+", "-"))
    )


def hunk_flags(lines: list[str], cls: str) -> list[bool]:
    observed_diff = cls == "git_diff"
    flags: list[bool] = []
    for line in lines:
        value = bare(line)
        header = bool(DIFF_HEADER_RE.search(value))
        if header:
            observed_diff = True
        flags.append(bool(observed_diff and DIFF_ADD_REMOVE_RE.search(value)))
    return flags


def ladder_flags(lines: list[str], cls: str) -> dict[str, list[bool]]:
    seen: set[str] = set()
    structural: list[bool] = []
    for line in lines:
        value = bare(line)
        structural.append(bool(
            ANSI_RE.search(line)
            or line.endswith("\r\n")
            or not value.strip()
            or DECORATOR_RE.fullmatch(value)
            or PROGRESS_RE.fullmatch(value)
            or line in seen
        ))
        seen.add(line)
    fail = [is_fail_line(line) for line in lines]
    hunk = hunk_flags(lines, cls)
    nav = [is_nav_line(line) for line in lines]
    greedy = [is_greedy_line(line) for line in lines]
    output: dict[str, list[bool]] = {}
    prior = [False] * len(lines)
    for name, additions in (
        ("K_struct", structural),
        ("K_fail", fail),
        ("K_hunk", hunk),
        ("K_nav", nav),
        ("K_greedy", greedy),
    ):
        current = [old or new for old, new in zip(prior, additions)]
        output[name] = current
        prior = current
    return output


def _add_line(counter: collections.Counter[str], size: int, start: int) -> None:
    counter["lines"] += 1
    counter["bytes"] += size
    inside = max(0, min(start + size, ENVELOPE_BYTES) - min(start, ENVELOPE_BYTES))
    counter["original_first_10k_bytes"] += inside
    counter["clipped_tail_bytes"] += size - inside


def keep_ladder_census(observations: Iterable[Observation], total_bytes: int) -> dict[str, Any]:
    aggregate = {name: collections.Counter() for name in LADDER_NAMES}
    by_class = {
        name: {cls: collections.Counter() for cls in BASH_CLASSES}
        for name in LADDER_NAMES
    }
    disjoint = {
        name: collections.Counter() for name in (
            "structural", "fail_increment", "hunk_increment", "nav_increment",
            "greedy_increment", "leftover_after_greedy",
        )
    }
    disjoint_by_class = {
        name: {cls: collections.Counter() for cls in BASH_CLASSES}
        for name in disjoint
    }
    physical_lines = physical_bytes = 0

    for item in observations:
        lines = split_lines(item.text)
        flags = ladder_flags(lines, item.cls)
        positions: list[int] = []
        offset = 0
        for line in lines:
            positions.append(offset)
            offset += utf8_bytes(line)
        physical_lines += len(lines)
        physical_bytes += item.raw_bytes
        prior = [False] * len(lines)
        for rung_index, name in enumerate(LADDER_NAMES):
            stats = aggregate[name]
            cls_stats = by_class[name][item.cls]
            stats["bodies"] += 1
            stats["input_bytes"] += item.raw_bytes
            cls_stats["bodies"] += 1
            cls_stats["input_bytes"] += item.raw_bytes
            current = flags[name]
            for index, line in enumerate(lines):
                size = utf8_bytes(line)
                start = positions[index]
                if current[index]:
                    _add_line(stats, size, start)
                    _add_line(cls_stats, size, start)
                    if not prior[index]:
                        stats["incremental_lines"] += 1
                        stats["incremental_bytes"] += size
                        cls_stats["incremental_lines"] += 1
                        cls_stats["incremental_bytes"] += size
                else:
                    # K_struct includes every repeated occurrence, so every
                    # non-matching line here is first-seen/unique in this body.
                    _add_line_with_prefix(stats, "candidate_drop_ceiling", size, start)
                    _add_line_with_prefix(cls_stats, "candidate_drop_ceiling", size, start)
                    if item.eligible:
                        _add_line_with_prefix(
                            stats, "eligible_candidate_drop_ceiling", size, start
                        )
                        _add_line_with_prefix(
                            cls_stats, "eligible_candidate_drop_ceiling", size, start
                        )
                    else:
                        _add_line_with_prefix(
                            stats, "identity_excluded_candidate_ceiling", size, start
                        )
                        _add_line_with_prefix(
                            cls_stats, "identity_excluded_candidate_ceiling", size, start
                        )
            prior = current

        # Assign every physical line to the earliest additive rung, or the
        # disjoint leftover after K_greedy.
        labels = (
            "structural", "fail_increment", "hunk_increment", "nav_increment",
            "greedy_increment",
        )
        previous = [False] * len(lines)
        assigned = [False] * len(lines)
        for name, label in zip(LADDER_NAMES, labels):
            current = flags[name]
            for index, line in enumerate(lines):
                if current[index] and not previous[index]:
                    size = utf8_bytes(line)
                    _add_line(disjoint[label], size, positions[index])
                    _add_line(disjoint_by_class[label][item.cls], size, positions[index])
                    assigned[index] = True
            previous = current
        for index, line in enumerate(lines):
            if not assigned[index]:
                size = utf8_bytes(line)
                _add_line(disjoint["leftover_after_greedy"], size, positions[index])
                _add_line(
                    disjoint_by_class["leftover_after_greedy"][item.cls],
                    size,
                    positions[index],
                )

    rows: dict[str, Any] = {}
    for name in LADDER_NAMES:
        stats = aggregate[name]
        stats["keep_floor_pct_of_all_bash_bytes"] = (
            100.0 * stats["bytes"] / total_bytes if total_bytes else 0.0
        )
        stats["eligible_candidate_drop_ceiling_pct_of_all_bash_bytes"] = (
            100.0 * stats["eligible_candidate_drop_ceiling_bytes"] / total_bytes
            if total_bytes else 0.0
        )
        rows[name] = {
            **dict(stats),
            "by_class": {
                cls: dict(by_class[name][cls]) for cls in BASH_CLASSES
            },
        }
    return {
        "definition": (
            "Raw physical-line union. K_struct matches layout, ANSI/CRLF, progress, "
            "and exact-repeat-after-first occurrences. Later rungs add semantic "
            "evidence. Candidate ceilings are non-matching first-seen lines; no "
            "unique-line ceiling is an implemented filter."
        ),
        "physical_lines": physical_lines,
        "physical_line_bytes": physical_bytes,
        "ladders": rows,
        "disjoint_partition": {
            label: {
                **dict(stats),
                "by_class": {
                    cls: dict(disjoint_by_class[label][cls]) for cls in BASH_CLASSES
                },
            }
            for label, stats in disjoint.items()
        },
    }


def _add_line_with_prefix(
    counter: collections.Counter[str], prefix: str, size: int, start: int
) -> None:
    counter[f"{prefix}_lines"] += 1
    counter[f"{prefix}_bytes"] += size
    inside = max(0, min(start + size, ENVELOPE_BYTES) - min(start, ENVELOPE_BYTES))
    counter[f"{prefix}_original_first_10k_bytes"] += inside
    counter[f"{prefix}_clipped_tail_bytes"] += size - inside


def required_flags(lines: list[str], cls: str) -> list[bool]:
    fail = [is_fail_line(line) for line in lines]
    if cls in {"git_diff", "mixed/compound"}:
        return [left or right for left, right in zip(fail, hunk_flags(lines, cls))]
    return fail


def strip_terminal_control(text: str, _cls: str) -> Candidate:
    return Candidate(ANSI_RE.sub("", text).replace("\r\n", "\n"))


def normalize_layout(text: str, _cls: str) -> Candidate:
    output: list[str] = []
    blank_run = 0
    for line in split_lines(text):
        value = bare(line)
        if not value.strip():
            blank_run += 1
            if blank_run > 2:
                continue
        else:
            blank_run = 0
        if DECORATOR_RE.fullmatch(value) and len(value.strip()) > 3:
            ending = line[len(value):]
            output.append(
                value[: len(value) - len(value.lstrip())] + value.strip()[0] * 3 + ending
            )
        else:
            output.append(line)
    return Candidate("".join(output))


def collapse_adjacent_duplicates(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    protected = required_flags(lines, cls)
    output: list[str] = []
    omitted = marker_bytes = 0
    index = 0
    while index < len(lines):
        end = index + 1
        while end < len(lines) and lines[end] == lines[index]:
            end += 1
        count = end - index
        if count >= 3 and bare(lines[index]).strip() and not any(protected[index:end]):
            count_omitted = count - 2
            marker = f"[... {count_omitted} identical lines omitted ...]\n"
            output.extend((lines[index], marker, lines[end - 1]))
            omitted += count_omitted
            marker_bytes += utf8_bytes(marker)
        else:
            output.extend(lines[index:end])
        index = end
    return Candidate("".join(output), omitted, marker_bytes)


def collapse_nonadjacent_duplicates(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    protected = required_flags(lines, cls)
    positions: dict[str, list[int]] = collections.defaultdict(list)
    for index, line in enumerate(lines):
        if bare(line).strip() and not protected[index]:
            positions[line].append(index)
    targets = {line: indexes for line, indexes in positions.items() if len(indexes) >= 3}
    output: list[str] = []
    seen: collections.Counter[str] = collections.Counter()
    omitted = marker_bytes = 0
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
            count_omitted = len(indexes) - 2
            marker = (
                f"[... {count_omitted} middle occurrences of an exact line "
                "omitted; final retained ...]\n"
            )
            output.append(marker)
            omitted += 1
            marker_bytes += utf8_bytes(marker)
        else:
            omitted += 1
    return Candidate("".join(output), omitted, marker_bytes)


def _collapse_runs(
    text: str,
    cls: str,
    predicate: Callable[[str], bool],
    minimum: int,
    label: str,
) -> Candidate:
    lines = split_lines(text)
    protected = required_flags(lines, cls)
    output: list[str] = []
    omitted = marker_bytes = 0
    index = 0
    while index < len(lines):
        matches = predicate(lines[index]) and not protected[index]
        if not matches:
            output.append(lines[index])
            index += 1
            continue
        end = index + 1
        while end < len(lines) and predicate(lines[end]) and not protected[end]:
            end += 1
        count = end - index
        if count >= minimum:
            count_omitted = count - 2
            marker = f"[... {count_omitted} {label} lines omitted ...]\n"
            output.extend((lines[index], marker, lines[end - 1]))
            omitted += count_omitted
            marker_bytes += utf8_bytes(marker)
        else:
            output.extend(lines[index:end])
        index = end
    return Candidate("".join(output), omitted, marker_bytes)


def collapse_progress(text: str, cls: str) -> Candidate:
    return _collapse_runs(
        text, cls, lambda line: bool(PROGRESS_RE.fullmatch(bare(line))),
        4, "progress update",
    )


STRUCTURAL_FAMILIES: tuple[tuple[str, Callable[[str, str], Candidate], str], ...] = (
    ("terminal_control", strip_terminal_control, "low"),
    ("layout", normalize_layout, "low"),
    ("adjacent_exact_repeat", collapse_adjacent_duplicates, "low"),
    ("nonadjacent_exact_repeat", collapse_nonadjacent_duplicates, "low-medium"),
    ("progress", collapse_progress, "low-medium"),
)


def structural_stack(text: str, cls: str) -> Candidate:
    current = text
    marker_bytes = omitted_lines = 0
    for _name, function, _risk in STRUCTURAL_FAMILIES:
        candidate = strict_candidate(current, cls, function)
        if candidate.text != current:
            current = candidate.text
            marker_bytes += candidate.marker_bytes
            omitted_lines += candidate.omitted_lines
    return Candidate(current, omitted_lines, marker_bytes)


def render_kept_lines(lines: list[str], keep: set[int], label: str) -> Candidate:
    output: list[str] = []
    omitted = marker_bytes = 0
    index = 0
    while index < len(lines):
        if index in keep:
            output.append(lines[index])
            index += 1
            continue
        end = index + 1
        while end < len(lines) and end not in keep:
            end += 1
        count = end - index
        marker = f"[... {count} lines omitted by {label} ...]\n"
        output.append(marker)
        omitted += count
        marker_bytes += utf8_bytes(marker)
        index = end
    return Candidate("".join(output), omitted, marker_bytes)


def required_indices(lines: list[str], cls: str) -> set[int]:
    return {index for index, flag in enumerate(required_flags(lines, cls)) if flag}


def source_cap(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    keep = set(range(min(40, len(lines))))
    keep.update(range(max(0, len(lines) - 40), len(lines)))
    keep.update(required_indices(lines, cls))
    return render_kept_lines(lines, keep, "source first/last-40 cap")


def listing_cap(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    keep = set(range(min(50, len(lines))))
    keep.update(required_indices(lines, cls))
    return render_kept_lines(lines, keep, "listing first-50 cap")


def search_cap(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    # Search first-result lines are not segmentable further. A match line is a
    # nonblank physical output line; diagnostics beyond the first 50 remain.
    matches = [index for index, line in enumerate(lines) if bare(line).strip()]
    keep = set(matches[:50])
    keep.update(required_indices(lines, cls))
    return render_kept_lines(lines, keep, "search first-50-match cap")


def test_pass_cap(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    required = required_indices(lines, cls)
    required.update(
        index for index, line in enumerate(lines)
        if SUMMARY_COUNT_RE.search(bare(line))
    )
    passing = [
        index for index, line in enumerate(lines)
        if PASS_LINE_RE.fullmatch(bare(line)) and index not in required
    ]
    if len(passing) < 4:
        return Candidate(text)
    omit = set(passing[1:-1])
    output: list[str] = []
    marker = f"[... {len(omit)} passing-test lines omitted ...]\n"
    marker_added = False
    for index, line in enumerate(lines):
        if index not in omit:
            output.append(line)
        elif not marker_added:
            output.append(marker)
            marker_added = True
    return Candidate("".join(output), len(omit), utf8_bytes(marker))


def lockfile_cap(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    keep = set(range(min(40, len(lines))))
    keep.update(range(max(0, len(lines) - 40), len(lines)))
    keep.update(required_indices(lines, cls))
    return render_kept_lines(lines, keep, "lockfile/json first/last-40 cap")


def npm_log_cap(text: str, cls: str) -> Candidate:
    lines = split_lines(text)
    keep = set(range(max(0, len(lines) - 40), len(lines)))
    keep.update(required_indices(lines, cls))
    return render_kept_lines(lines, keep, "install/debug K_fail+last-40 cap")


CAP_FAMILIES: tuple[
    tuple[str, str, Callable[[str, str], Candidate], str], ...
] = (
    ("source_first_last_40", "source_dump", source_cap, "high"),
    ("listing_first_50", "listing", listing_cap, "medium-high"),
    ("search_first_50_matches", "search", search_cap, "high"),
    ("test_passing_fold", "test", test_pass_cap, "medium"),
    ("lockfile_json_first_last_40", "lockfile/json", lockfile_cap, "high"),
    ("install_debug_fail_last_40", "npm/install/debug_log", npm_log_cap, "high"),
)
CAP_BY_CLASS = {cls: (name, function, risk) for name, cls, function, risk in CAP_FAMILIES}


def strict_candidate(text: str, cls: str, function: Callable[[str, str], Candidate]) -> Candidate:
    candidate = function(text, cls)
    return candidate if utf8_bytes(candidate.text) < utf8_bytes(text) else Candidate(text)


def _measure_add(
    stats: collections.Counter[str], raw_bytes: int, output_bytes: int,
    changed: bool, marker_bytes: int = 0, omitted_lines: int = 0,
) -> None:
    stats["evaluated_bodies"] += 1
    stats["input_bytes"] += raw_bytes
    stats["output_bytes"] += output_bytes
    stats["saved_bytes"] += raw_bytes - output_bytes
    stats["changed_bodies"] += int(changed)
    stats["marker_bytes"] += marker_bytes if changed else 0
    stats["omitted_lines"] += omitted_lines if changed else 0
    input_10k = min(raw_bytes, ENVELOPE_BYTES)
    output_10k = min(output_bytes, ENVELOPE_BYTES)
    stats["input_first_10k_bytes"] += input_10k
    stats["output_first_10k_remaining_bytes"] += output_10k
    stats["first_10k_length_reduction_bytes"] += input_10k - output_10k


def _finalize_measurement(
    stats: collections.Counter[str], total_bash_bytes: int,
    by_class: dict[str, collections.Counter[str]], risk: str,
) -> dict[str, Any]:
    class_rows: dict[str, dict[str, Any]] = {}
    for cls in BASH_CLASSES:
        row = by_class[cls]
        class_rows[cls] = {
            **dict(row),
            "all_scope_output_bytes": row["scope_bytes"] - row["saved_bytes"],
            "all_scope_output_first_10k_remaining_bytes": (
                row["scope_first_10k_input_bytes"]
                - row["first_10k_length_reduction_bytes"]
            ),
        }
    return {
        **dict(stats),
        "all_scope_output_bytes": stats["scope_bytes"] - stats["saved_bytes"],
        "all_scope_output_first_10k_remaining_bytes": (
            stats["scope_first_10k_input_bytes"]
            - stats["first_10k_length_reduction_bytes"]
        ),
        "saved_pct_of_all_bash_bytes": (
            100.0 * stats["saved_bytes"] / total_bash_bytes if total_bash_bytes else 0.0
        ),
        "evidence_risk": risk,
        "by_class": class_rows,
    }


def evaluate_independent(
    observations: Iterable[Observation],
    function: Callable[[str, str], Candidate],
    applicable_class: str | None,
    total_bash_bytes: int,
    risk: str,
) -> dict[str, Any]:
    stats: collections.Counter[str] = collections.Counter()
    by_class = {cls: collections.Counter() for cls in BASH_CLASSES}
    for item in observations:
        if applicable_class is not None and item.cls != applicable_class:
            continue
        stats["scope_bodies"] += 1
        stats["scope_bytes"] += item.raw_bytes
        stats["scope_first_10k_input_bytes"] += min(item.raw_bytes, ENVELOPE_BYTES)
        by_class[item.cls]["scope_bodies"] += 1
        by_class[item.cls]["scope_bytes"] += item.raw_bytes
        by_class[item.cls]["scope_first_10k_input_bytes"] += min(
            item.raw_bytes, ENVELOPE_BYTES
        )
        if not item.eligible:
            stats["identity_exclusion_bodies"] += 1
            stats["identity_exclusion_bytes"] += item.raw_bytes
            by_class[item.cls]["identity_exclusion_bodies"] += 1
            by_class[item.cls]["identity_exclusion_bytes"] += item.raw_bytes
            continue
        candidate = strict_candidate(item.text, item.cls, function)
        output_bytes = utf8_bytes(candidate.text)
        changed = candidate.text != item.text
        _measure_add(
            stats, item.raw_bytes, output_bytes, changed,
            candidate.marker_bytes, candidate.omitted_lines,
        )
        _measure_add(
            by_class[item.cls], item.raw_bytes, output_bytes, changed,
            candidate.marker_bytes, candidate.omitted_lines,
        )
    return _finalize_measurement(stats, total_bash_bytes, by_class, risk)


def evaluate_caps(
    observations: list[Observation], total_bash_bytes: int,
    all_first_10k_input: int,
) -> dict[str, Any]:
    independent: dict[str, Any] = {}
    for name, function, risk in STRUCTURAL_FAMILIES:
        independent[name] = evaluate_independent(
            observations, function, None, total_bash_bytes, risk
        )
    independent["structural_stack"] = evaluate_independent(
        observations, structural_stack, None, total_bash_bytes, "low-medium"
    )
    for name, cls, function, risk in CAP_FAMILIES:
        independent[name] = evaluate_independent(
            observations, function, cls, total_bash_bytes, risk
        )

    stats: collections.Counter[str] = collections.Counter()
    by_class = {cls: collections.Counter() for cls in BASH_CLASSES}
    incremental = {
        name: collections.Counter()
        for name, _function, _risk in STRUCTURAL_FAMILIES
    }
    incremental.update({name: collections.Counter() for name, *_rest in CAP_FAMILIES})
    for item in observations:
        stats["scope_bodies"] += 1
        stats["scope_bytes"] += item.raw_bytes
        stats["scope_first_10k_input_bytes"] += min(item.raw_bytes, ENVELOPE_BYTES)
        by_class[item.cls]["scope_bodies"] += 1
        by_class[item.cls]["scope_bytes"] += item.raw_bytes
        by_class[item.cls]["scope_first_10k_input_bytes"] += min(
            item.raw_bytes, ENVELOPE_BYTES
        )
        if not item.eligible:
            stats["identity_exclusion_bodies"] += 1
            stats["identity_exclusion_bytes"] += item.raw_bytes
            by_class[item.cls]["identity_exclusion_bodies"] += 1
            by_class[item.cls]["identity_exclusion_bytes"] += item.raw_bytes
            continue
        text = item.text
        marker_bytes = omitted_lines = 0
        for name, function, _risk in STRUCTURAL_FAMILIES:
            before = utf8_bytes(text)
            candidate = strict_candidate(text, item.cls, function)
            after = utf8_bytes(candidate.text)
            if after < before:
                text = candidate.text
                marker_bytes += candidate.marker_bytes
                omitted_lines += candidate.omitted_lines
                incremental[name]["changed_bodies"] += 1
                incremental[name]["incremental_saved_bytes"] += before - after
                incremental[name][f"{item.cls}_incremental_saved_bytes"] += before - after
        cap = CAP_BY_CLASS.get(item.cls)
        if cap is not None:
            name, function, _risk = cap
            before = utf8_bytes(text)
            candidate = strict_candidate(text, item.cls, function)
            after = utf8_bytes(candidate.text)
            if after < before:
                text = candidate.text
                marker_bytes += candidate.marker_bytes
                omitted_lines += candidate.omitted_lines
                incremental[name]["changed_bodies"] += 1
                incremental[name]["incremental_saved_bytes"] += before - after
                incremental[name][f"{item.cls}_incremental_saved_bytes"] += before - after
        output_bytes = utf8_bytes(text)
        changed = text != item.text
        _measure_add(
            stats, item.raw_bytes, output_bytes, changed, marker_bytes, omitted_lines
        )
        _measure_add(
            by_class[item.cls], item.raw_bytes, output_bytes, changed,
            marker_bytes, omitted_lines,
        )

    result = _finalize_measurement(stats, total_bash_bytes, by_class, "class-dependent")
    # Include identity bodies in the corpus-level output/remainder, while the
    # evaluated fields above remain joined/non-sensitive as requested.
    result["all_corpus_output_bytes"] = total_bash_bytes - stats["saved_bytes"]
    result["all_corpus_output_first_10k_remaining_bytes"] = (
        all_first_10k_input - stats["first_10k_length_reduction_bytes"]
    )
    result["incremental_by_family"] = {
        name: dict(values) for name, values in incremental.items()
    }
    return {"independent": independent, "stacked": result}


def aggregate(observations: list[Observation], coverage: dict[str, Any]) -> dict[str, Any]:
    digest_rows: list[str] = []
    for item in observations:
        digest_rows.append(json.dumps({
            "observation_id": item.observation_id,
            "bytes": item.raw_bytes,
            "joined": item.joined,
            "sensitive": item.sensitive,
            "class": item.cls,
            "stratum": size_stratum(item.raw_bytes),
        }, sort_keys=True, separators=(",", ":")))
    return {
        "schema": "qq.bash-filter-opportunity-current/v1",
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
            "full_result_text_persisted": False,
            "candidate_text_persisted": False,
            "excerpts_persisted": False,
            "per_observation_rows_persisted": False,
            "stock_10k_envelope_applied": False,
            "envelope_reference_bytes": ENVELOPE_BYTES,
            "byte_measure": "pre-envelope UTF-8 with replacement for invalid scalar values",
            "sensitive_and_unresolved_filter_policy": "identity but included in denominators",
            "mixed_subcommand_segmentation_attempted": False,
            "optional_pipe_last_stage_cap_evaluated": False,
            "live_pair_used": False,
        },
        "coverage": coverage,
        "census": census_composition(observations),
        "keep_list_sensitivity": keep_ladder_census(
            observations, coverage["bash_bytes"]
        ),
        "class_aware_caps": evaluate_caps(
            observations,
            coverage["bash_bytes"],
            coverage["first_10k_input_bytes"],
        ),
        "bodyless_observation_count": len(observations),
        "bodyless_observation_digest": hashlib.sha256(
            ("\n".join(digest_rows) + "\n").encode("utf-8", "replace")
        ).hexdigest(),
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
        "coverage": coverage,
        "class_bytes": {
            cls: payload["census"]["by_class"][cls]["bytes"] for cls in BASH_CLASSES
        },
        "keep_ladders": {
            name: {
                key: payload["keep_list_sensitivity"]["ladders"][name].get(key, 0)
                for key in (
                    "bytes", "eligible_candidate_drop_ceiling_bytes",
                    "eligible_candidate_drop_ceiling_original_first_10k_bytes",
                    "eligible_candidate_drop_ceiling_clipped_tail_bytes",
                )
            }
            for name in LADDER_NAMES
        },
        "stacked_caps": payload["class_aware_caps"]["stacked"],
    }, indent=2))


if __name__ == "__main__":
    main()
