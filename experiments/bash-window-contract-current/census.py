#!/usr/bin/env python3
"""Inspect-only study of the shipped head+tail bash observation contract.

This imports the frozen classifier, keep ladders, first-result join, and cutoff
from bash-window-value-current. Historical commands are classifier metadata
only and are never executed. Commands, bodies, windows, excerpts, and
per-observation records are never written to the aggregate artifact.
"""
from __future__ import annotations

import argparse
import collections
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
VALUE_PATH = HERE.parent / "bash-window-value-current" / "census.py"
DEFAULT_CORPUS = Path.home() / ".local/state/qq/sessions"
AUTHORITATIVE_PARENT = "session-af60703c-a964-41ee-bb2b-9edfc7b170f3"
AUTHORITATIVE_DELEGATION = "0995be92-d775-4936-a34f-a7af0608a2f6"
STUDY_SESSION = "session-858aea3d-5598-42bf-ab1b-0bb0fdfd2dbb"
MAX_CHARS = 10_000
HEAD_CHARS = 5_000
TAIL_CHARS = 5_000
REGIONS = ("head", "hole", "tail")
CUMULATIVE_LADDERS = ("K_fail", "K_hunk", "K_nav")
PARTITION_CATEGORIES = (
    "structural",
    "K_fail_increment",
    "K_hunk_increment",
    "K_nav_increment",
    "leftover_unique_after_K_nav",
)
DIRECT_SIGNALS = ("fail", "hunk", "locator")

_spec = importlib.util.spec_from_file_location("imported_bash_window_value", VALUE_PATH)
if _spec is None or _spec.loader is None:  # pragma: no cover - installation failure
    raise RuntimeError(f"cannot import prior window study: {VALUE_PATH}")
value_study = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = value_study
_spec.loader.exec_module(value_study)
opportunity = value_study.opportunity
BASH_CLASSES = tuple(value_study.BASH_CLASSES)
EVENT_CUTOFF_MS = value_study.EVENT_CUTOFF_MS
FROZEN_STUDY_SESSION = value_study.STUDY_SESSION

# Filled only after temporary, local side-by-side review. No identifiers,
# commands, bodies, windows, or excerpts are retained.
AUDIT_AGGREGATE: dict[str, Any] = {
    "status": "complete; temporary review material deleted",
    "selection": (
        "up to two raw, pre-envelope overflow bodies per frozen class: one C2 "
        "completion with most C1-hole direct signal where available plus largest "
        "fail-open; otherwise two largest fail-open bodies"
    ),
    "sampled_bodies": 19,
    "sampled_C2_completion_bodies": 4,
    "sampled_C2_fail_open_bodies": 15,
    "classes_sampled": 10,
    "classes_without_raw_pre_envelope_overflow": ["source_dump"],
    "by_class": {
        "git_diff": {"sampled_bodies": 2, "C1": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}},
        "git_status": {"sampled_bodies": 1, "C1": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}},
        "listing": {"sampled_bodies": 2, "C1": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}},
        "lockfile/json": {"sampled_bodies": 2, "C1": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}},
        "mixed/compound": {"sampled_bodies": 2, "C1": {"rerun": 2, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 2, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}},
        "npm/install/debug_log": {"sampled_bodies": 2, "C1": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}},
        "other": {"sampled_bodies": 2, "C1": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}},
        "search": {"sampled_bodies": 2, "C1": {"rerun": 1, "wrong_edit_or_location": 0, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 1, "wrong_edit_or_location": 0, "false_completeness": 0, "glued_events": 0}},
        "source_dump": {"sampled_bodies": 0, "C1": {"rerun": 0, "wrong_edit_or_location": 0, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 0, "wrong_edit_or_location": 0, "false_completeness": 0, "glued_events": 0}},
        "test": {"sampled_bodies": 2, "C1": {"rerun": 2, "wrong_edit_or_location": 2, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}},
        "write/edit": {"sampled_bodies": 2, "C1": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}, "C2": {"rerun": 1, "wrong_edit_or_location": 1, "false_completeness": 0, "glued_events": 0}},
    },
    "all_sampled": {
        "C1": {"rerun": 15, "wrong_edit_or_location": 13, "false_completeness": 0, "glued_events": 0},
        "C2": {"rerun": 14, "wrong_edit_or_location": 12, "false_completeness": 0, "glued_events": 0},
    },
    "interpretation": (
        "bounded audit disagreement counts, not accuracy estimates; already-windowed "
        "archive bodies were excluded because their original middle cannot be audited"
    ),
}


def code_points(value: str) -> int:
    """Python len matches production's iteration over Unicode code points."""
    return len(value)


def utf8_bytes(value: str) -> int:
    return len(value.encode("utf-8", "replace"))


def sha256_file(path: Path) -> str:
    return opportunity.sha256_file(path)


def scan_corpus(corpus: Path) -> tuple[list[Any], dict[str, Any]]:
    """Import the previous study's frozen first-result join and exact cutoff."""
    return value_study.scan_corpus(corpus)


DSH_STOCK_MARKER_RE = re.compile(
    r"\n\[\.\.\. environment output truncated: (\d+) chars omitted \.\.\.\]\n"
)


@dataclass(frozen=True)
class BodyView:
    stored_shape: str
    raw_text: str | None
    head: str
    tail: str
    omitted_chars: int
    original_chars: int
    stored_chars: int

    @property
    def already_windowed(self) -> bool:
        return self.raw_text is None


def body_view(stored_text: str) -> BodyView:
    """Recover the logical output shape without re-capping Mini JSON serialization."""
    stored_chars = code_points(stored_text)
    try:
        parsed = json.loads(stored_text)
    except Exception:
        parsed = None
    if isinstance(parsed, dict) and "returncode" in parsed:
        output = parsed.get("output")
        if isinstance(output, str):
            return BodyView(
                "mini_identity_json", output, "", "", 0,
                code_points(output), stored_chars,
            )
        head = parsed.get("output_head")
        tail = parsed.get("output_tail")
        omitted = parsed.get("elided_chars")
        if (
            isinstance(head, str)
            and isinstance(tail, str)
            and isinstance(omitted, int)
            and omitted >= 0
            and code_points(head) == HEAD_CHARS
            and code_points(tail) == TAIL_CHARS
        ):
            return BodyView(
                "mini_head_tail_json", None, head, tail, omitted,
                code_points(head) + omitted + code_points(tail), stored_chars,
            )
    matches = list(DSH_STOCK_MARKER_RE.finditer(stored_text))
    if len(matches) == 1:
        match = matches[0]
        head = stored_text[:match.start()]
        tail = stored_text[match.end():]
        if code_points(head) == HEAD_CHARS and code_points(tail) == TAIL_CHARS:
            omitted = int(match.group(1))
            return BodyView(
                "dsh_head_tail_text", None, head, tail, omitted,
                code_points(head) + omitted + code_points(tail), stored_chars,
            )
    return BodyView(
        "raw_text", stored_text, "", "", 0, stored_chars, stored_chars
    )


@dataclass(frozen=True)
class SourceLine:
    index: int
    value: str
    start: int
    chars: int
    k_struct: bool
    k_fail: bool
    k_hunk: bool
    k_nav: bool
    fail: bool
    hunk: bool
    locator: bool
    exact_repeat: bool
    blank_layout: bool
    decorator: bool
    progress: bool

    @property
    def end(self) -> int:
        return self.start + self.chars

    @property
    def c2_disposable(self) -> bool:
        # K_struct also broadly marks any ANSI- or CRLF-bearing line. C2 cannot
        # drop a whole first-seen payload line merely to remove that encoding.
        return self.k_struct and (
            self.exact_repeat or self.blank_layout or self.decorator or self.progress
        )

    @property
    def unique_payload(self) -> bool:
        return not self.c2_disposable

    @property
    def partition(self) -> str:
        if self.k_struct:
            return "structural"
        if self.k_fail:
            return "K_fail_increment"
        if self.k_hunk:
            return "K_hunk_increment"
        if self.k_nav:
            return "K_nav_increment"
        return "leftover_unique_after_K_nav"

    @property
    def fail_or_hunk(self) -> bool:
        return self.fail or self.hunk

    @property
    def any_direct_signal(self) -> bool:
        return self.fail or self.hunk or self.locator


@dataclass(frozen=True)
class Segment:
    value: str
    source_index: int | None

    @property
    def chars(self) -> int:
        return code_points(self.value)


@dataclass(frozen=True)
class C2Result:
    value: str
    segments: tuple[Segment, ...]
    kept: frozenset[int]
    omitted_runs: int
    omitted_lines: int
    omitted_chars: int
    marker_chars: int
    accepted: bool
    fail_open: bool

    @property
    def chars(self) -> int:
        return code_points(self.value)


@dataclass(frozen=True)
class StockWindow:
    value: str
    source_projection: str
    omitted_chars: int

    @property
    def chars(self) -> int:
        return code_points(self.value)


def source_lines(text: str, cls: str) -> list[SourceLine]:
    raw_lines = opportunity.split_lines(text)
    flags = opportunity.ladder_flags(raw_lines, cls)
    hunks = opportunity.hunk_flags(raw_lines, cls)
    lines: list[SourceLine] = []
    offset = 0
    seen: set[str] = set()
    for index, line in enumerate(raw_lines):
        chars = code_points(line)
        bare = opportunity.bare(line)
        exact_repeat = line in seen
        lines.append(SourceLine(
            index=index,
            value=line,
            start=offset,
            chars=chars,
            k_struct=flags["K_struct"][index],
            k_fail=flags["K_fail"][index],
            k_hunk=flags["K_hunk"][index],
            k_nav=flags["K_nav"][index],
            fail=opportunity.is_fail_line(line),
            hunk=hunks[index],
            locator=opportunity.is_nav_line(line),
            exact_repeat=exact_repeat,
            blank_layout=not bare.strip(),
            decorator=bool(opportunity.DECORATOR_RE.fullmatch(bare)),
            progress=bool(opportunity.PROGRESS_RE.fullmatch(bare)),
        ))
        if lines[-1].c2_disposable and not lines[-1].k_struct:
            raise AssertionError("C2 disposable line escaped frozen K_struct")
        seen.add(line)
        offset += chars
    if offset != code_points(text):
        raise AssertionError("source-line code-point accounting drift")
    return lines


def stock_marker(omitted_chars: int) -> str:
    return f"\n[... environment output truncated: {omitted_chars} chars omitted ...]\n"


def stock_window(text: str) -> StockWindow:
    total = code_points(text)
    if total < MAX_CHARS:
        return StockWindow(text, text, 0)
    head = text[:HEAD_CHARS]
    tail = text[-TAIL_CHARS:]
    omitted = total - MAX_CHARS
    return StockWindow(head + stock_marker(omitted) + tail, head + tail, omitted)


def c2_marker(chars: int, lines: int) -> str:
    return f"[... C2 in-place elision: {chars} chars omitted from {lines} lines ...]\n"


def structural_elision(lines: list[SourceLine]) -> C2Result:
    """Elide safe K_struct runs while retaining every first-seen payload line."""
    segments: list[Segment] = []
    kept: set[int] = set()
    omitted_runs = omitted_lines = omitted_chars = marker_chars = 0
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.c2_disposable:
            segments.append(Segment(line.value, line.index))
            kept.add(line.index)
            index += 1
            continue
        end = index + 1
        while end < len(lines) and lines[end].c2_disposable:
            end += 1
        run_lines = end - index
        run_chars = sum(item.chars for item in lines[index:end])
        marker = c2_marker(run_chars, run_lines)
        segments.append(Segment(marker, None))
        omitted_runs += 1
        omitted_lines += run_lines
        omitted_chars += run_chars
        marker_chars += code_points(marker)
        index = end
    rendered = "".join(segment.value for segment in segments)
    return C2Result(
        rendered,
        tuple(segments),
        frozenset(kept),
        omitted_runs,
        omitted_lines,
        omitted_chars,
        marker_chars,
        False,
        False,
    )


def c2_contract(text: str, cls: str) -> C2Result:
    """Identity under cap; otherwise complete structural elision or stock C1."""
    lines = source_lines(text, cls)
    all_indexes = frozenset(line.index for line in lines)
    if code_points(text) < MAX_CHARS:
        return C2Result(
            text,
            tuple(Segment(line.value, line.index) for line in lines),
            all_indexes,
            0, 0, 0, 0, False, False,
        )
    proposed = structural_elision(lines)
    if proposed.chars < MAX_CHARS:
        return C2Result(
            proposed.value,
            proposed.segments,
            proposed.kept,
            proposed.omitted_runs,
            proposed.omitted_lines,
            proposed.omitted_chars,
            proposed.marker_chars,
            True,
            False,
        )
    stock = stock_window(text)
    # Fail-open is C1 on the original, never elision followed by head+tail.
    return C2Result(
        stock.value,
        (Segment(stock.source_projection, -1), Segment(stock_marker(stock.omitted_chars), None)),
        frozenset(),
        1,
        0,
        stock.omitted_chars,
        code_points(stock_marker(stock.omitted_chars)),
        False,
        True,
    )


def retained_projection(result: C2Result, lines: list[SourceLine], text: str) -> str:
    if result.fail_open:
        return stock_window(text).source_projection
    return "".join(line.value for line in lines if line.index in result.kept)


def is_subsequence(needle: str, haystack: str) -> bool:
    iterator = iter(haystack)
    return all(any(candidate == point for candidate in iterator) for point in needle)


def region_bounds(total: int) -> dict[str, tuple[int, int]]:
    if total < MAX_CHARS:
        return {"head": (0, total), "hole": (total, total), "tail": (total, total)}
    tail_start = total - TAIL_CHARS
    return {
        "head": (0, HEAD_CHARS),
        "hole": (HEAD_CHARS, tail_start),
        "tail": (tail_start, total),
    }


def overlap(start: int, end: int, region_start: int, region_end: int) -> int:
    return max(0, min(end, region_end) - max(start, region_start))


def blank_location() -> dict[str, Any]:
    return {
        "chars": 0,
        "lines_touching": 0,
        "by_region": {region: {"chars": 0, "lines_touching": 0} for region in REGIONS},
    }


def blank_window_stats() -> dict[str, Any]:
    return {
        "overflow_bodies": 0,
        "original_chars": 0,
        "head_chars": 0,
        "hole_chars": 0,
        "tail_chars": 0,
        "raw_overflow_bodies_with_signal_measurable": 0,
        "already_windowed_bodies_with_hole_signal_unavailable": 0,
        "signal_measurable_original_chars": 0,
        "signal_measurable_head_chars": 0,
        "signal_measurable_hole_chars": 0,
        "signal_measurable_tail_chars": 0,
        "hole_chars_with_signal_unavailable": 0,
        "cumulative_frozen_ladders": {
            name: blank_location() for name in CUMULATIVE_LADDERS
        },
        "disjoint_partition": {
            name: blank_location() for name in PARTITION_CATEGORIES
        },
        "direct_signal": {name: blank_location() for name in DIRECT_SIGNALS},
    }


def _add_location(location: dict[str, Any], line: SourceLine, bounds: dict[str, tuple[int, int]]) -> None:
    location["chars"] += line.chars
    location["lines_touching"] += 1
    for region, (start, end) in bounds.items():
        chars = overlap(line.start, line.end, start, end)
        location["by_region"][region]["chars"] += chars
        location["by_region"][region]["lines_touching"] += int(chars > 0)


def _add_window_body(stats: dict[str, Any], text: str, lines: list[SourceLine]) -> None:
    total = code_points(text)
    bounds = region_bounds(total)
    stats["overflow_bodies"] += 1
    stats["raw_overflow_bodies_with_signal_measurable"] += 1
    stats["original_chars"] += total
    stats["signal_measurable_original_chars"] += total
    for region, (start, end) in bounds.items():
        region_chars = end - start
        stats[f"{region}_chars"] += region_chars
        stats[f"signal_measurable_{region}_chars"] += region_chars
    for line in lines:
        for name, matched in (
            ("K_fail", line.k_fail),
            ("K_hunk", line.k_hunk),
            ("K_nav", line.k_nav),
        ):
            if matched:
                _add_location(stats["cumulative_frozen_ladders"][name], line, bounds)
        _add_location(stats["disjoint_partition"][line.partition], line, bounds)
        for name, matched in (
            ("fail", line.fail), ("hunk", line.hunk), ("locator", line.locator)
        ):
            if matched:
                _add_location(stats["direct_signal"][name], line, bounds)


def _add_already_windowed_body(stats: dict[str, Any], view: BodyView) -> None:
    stats["overflow_bodies"] += 1
    stats["already_windowed_bodies_with_hole_signal_unavailable"] += 1
    stats["original_chars"] += view.original_chars
    stats["head_chars"] += code_points(view.head)
    stats["hole_chars"] += view.omitted_chars
    stats["tail_chars"] += code_points(view.tail)
    stats["hole_chars_with_signal_unavailable"] += view.omitted_chars


def window_census(observations: Iterable[Any]) -> dict[str, Any]:
    total = blank_window_stats()
    by_class = {cls: blank_window_stats() for cls in BASH_CLASSES}
    bodies = under = exact = logical_chars = under_chars = stored_utf8 = 0
    logical_overflow_utf8_available = 0
    shapes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    shapes_class = {
        cls: collections.defaultdict(collections.Counter) for cls in BASH_CLASSES
    }
    for item in observations:
        view = body_view(item.text)
        body_chars = view.original_chars
        body_bytes = utf8_bytes(item.text)
        bodies += 1
        logical_chars += body_chars
        stored_utf8 += body_bytes
        for slot in (shapes[view.stored_shape], shapes_class[item.cls][view.stored_shape]):
            slot["bodies"] += 1
            slot["stored_chars"] += view.stored_chars
            slot["logical_original_chars"] += body_chars
            slot["reported_hole_chars"] += view.omitted_chars
        if body_chars < MAX_CHARS:
            under += 1
            under_chars += body_chars
            continue
        exact += int(body_chars == MAX_CHARS)
        if view.raw_text is None:
            _add_already_windowed_body(total, view)
            _add_already_windowed_body(by_class[item.cls], view)
            continue
        logical_overflow_utf8_available += utf8_bytes(view.raw_text)
        lines = source_lines(view.raw_text, item.cls)
        _add_window_body(total, view.raw_text, lines)
        _add_window_body(by_class[item.cls], view.raw_text, lines)
    return {
        "threshold_definition": (
            "overflow iff logical original Unicode code points >= 10000; identity iff < 10000"
        ),
        "stock_shape": (
            "C1 preserves logical source offsets [0,5000) and [chars-5000,chars), "
            "with one exact omitted-char marker between them"
        ),
        "archive_normalization": {
            "rule": (
                "Mini identity JSON is measured from its output field. Mini output_head/"
                "output_tail JSON and valid DSH truncation-marker text are recognized as "
                "already-windowed C1; their original hole text is unavailable and is not "
                "classified or passed through C2 a second time."
            ),
            "by_stored_shape": {
                name: dict(counter) for name, counter in sorted(shapes.items())
            },
            "by_class": {
                cls: {
                    name: dict(counter)
                    for name, counter in sorted(shapes_class[cls].items())
                }
                for cls in BASH_CLASSES
            },
        },
        "all_bash_bodies": bodies,
        "all_bash_logical_original_chars": logical_chars,
        "under_cap_identity_bodies": under,
        "under_cap_identity_chars": under_chars,
        "exactly_10000_char_bodies": exact,
        "all_overflow": total,
        "by_class": by_class,
        "utf8_footnote": {
            "all_stored_body_utf8_bytes": stored_utf8,
            "raw_available_overflow_utf8_bytes": logical_overflow_utf8_available,
            "measure_note": (
                "footnote only; thresholds/headlines use logical code points, and no byte "
                "count reconstructs an unavailable stock hole"
            ),
        },
    }


def blank_recovery() -> collections.Counter[str]:
    return collections.Counter()


def _line_hidden_by_c1(line: SourceLine, tail_start: int) -> bool:
    return line.chars > 0 and line.start >= HEAD_CHARS and line.end <= tail_start


def _line_hole_chars(line: SourceLine, tail_start: int) -> int:
    return overlap(line.start, line.end, HEAD_CHARS, tail_start)


def _recovery_add(
    stats: collections.Counter[str],
    lines: list[SourceLine],
    result: C2Result,
    signal: str,
    tail_start: int,
) -> None:
    matching = [line for line in lines if getattr(line, signal)]
    hidden = [line for line in matching if _line_hidden_by_c1(line, tail_start)]
    touching = [line for line in matching if _line_hole_chars(line, tail_start) > 0]
    stats["C1_hole_lines_touching"] += len(touching)
    stats["C1_hole_chars"] += sum(_line_hole_chars(line, tail_start) for line in matching)
    stats["C1_fully_hidden_lines"] += len(hidden)
    stats["bodies_with_C1_fully_hidden_lines"] += int(bool(hidden))
    if result.accepted:
        recovered = [line for line in hidden if line.index in result.kept]
        stats["C2_recovered_full_lines"] += len(recovered)
        stats["C2_recovered_hole_chars"] += sum(
            _line_hole_chars(line, tail_start)
            for line in matching if line.index in result.kept
        )
        stats["C2_structural_overlap_lines_still_elided"] += sum(
            line.k_struct for line in hidden
        )
        stats["accepted_bodies_with_recovered_full_lines"] += int(bool(recovered))
    else:
        stats["fail_open_fully_hidden_lines_still_missing"] += len(hidden)
        stats["fail_open_bodies_with_hidden_lines"] += int(bool(hidden))


def _source_visible_chars_c1(lines: list[SourceLine], total: int, predicate: Any) -> int:
    bounds = region_bounds(total)
    return sum(
        overlap(line.start, line.end, *bounds["head"])
        + overlap(line.start, line.end, *bounds["tail"])
        for line in lines if predicate(line)
    )


def _source_visible_chars_c2(lines: list[SourceLine], result: C2Result, total: int, predicate: Any) -> int:
    if result.fail_open:
        return _source_visible_chars_c1(lines, total, predicate)
    return sum(line.chars for line in lines if line.index in result.kept and predicate(line))


def _finalize_counter(counter: collections.Counter[str], keys: Iterable[str]) -> dict[str, int]:
    return {key: counter[key] for key in keys}


RECOVERY_KEYS = (
    "C1_hole_lines_touching",
    "C1_hole_chars",
    "C1_fully_hidden_lines",
    "bodies_with_C1_fully_hidden_lines",
    "C2_recovered_full_lines",
    "C2_recovered_hole_chars",
    "C2_structural_overlap_lines_still_elided",
    "accepted_bodies_with_recovered_full_lines",
    "fail_open_fully_hidden_lines_still_missing",
    "fail_open_bodies_with_hidden_lines",
)


def contract_fidelity(observations: Iterable[Any]) -> dict[str, Any]:
    totals: collections.Counter[str] = collections.Counter()
    classes = {cls: collections.Counter() for cls in BASH_CLASSES}
    recovery = {name: blank_recovery() for name in DIRECT_SIGNALS}
    recovery_class = {
        cls: {name: blank_recovery() for name in DIRECT_SIGNALS}
        for cls in BASH_CLASSES
    }
    neighborhood: collections.Counter[str] = collections.Counter()
    density: collections.Counter[str] = collections.Counter()

    for item in observations:
        view = body_view(item.text)
        total = view.original_chars
        if total < MAX_CHARS:
            continue
        for slot in (totals, classes[item.cls]):
            slot["logical_overflow_bodies"] += 1
        if view.raw_text is None:
            for slot in (totals, classes[item.cls]):
                slot["archive_already_windowed_not_evaluable_for_C2"] += 1
                slot["archive_unavailable_hole_chars"] += view.omitted_chars
            continue
        text = view.raw_text
        for slot in (totals, classes[item.cls]):
            slot["raw_overflow_bodies_evaluable_for_C2"] += 1
        lines = source_lines(text, item.cls)
        result = c2_contract(text, item.cls)
        stock = stock_window(text)
        stats = totals
        cls_stats = classes[item.cls]
        for slot in (stats, cls_stats):
            slot["evaluated_overflow_bodies"] += 1
            slot["C1_source_projection_subsequence_violations"] += int(
                not is_subsequence(stock.source_projection, text)
            )
            projection = retained_projection(result, lines, text)
            slot["C2_source_projection_subsequence_violations"] += int(
                not is_subsequence(projection, text)
            )
            slot["C2_accepted_bodies"] += int(result.accepted)
            slot["C2_fail_open_to_C1_bodies"] += int(result.fail_open)
            slot["C1_marker_holes"] += 1
            slot["C1_nonempty_middle_holes"] += int(stock.omitted_chars > 0)
            slot["C2_marker_holes"] += result.omitted_runs
            slot["C2_interior_marker_holes"] += (
                1 if result.fail_open else sum(
                    segment.source_index is None
                    and index > 0
                    and index + 1 < len(result.segments)
                    for index, segment in enumerate(result.segments)
                )
            )
            slot["C2_extra_marker_holes_vs_C1"] += result.omitted_runs - 1
            slot["C2_omitted_frozen_disposable_lines"] += (
                result.omitted_lines if result.accepted else 0
            )
            slot["C2_omitted_frozen_disposable_chars"] += (
                result.omitted_chars if result.accepted else 0
            )
            slot["C2_retained_broad_K_struct_lines_due_unique_payload_guard"] += (
                sum(line.k_struct and not line.c2_disposable for line in lines)
                if result.accepted else 0
            )
            slot["C2_retained_broad_K_struct_chars_due_unique_payload_guard"] += (
                sum(line.chars for line in lines if line.k_struct and not line.c2_disposable)
                if result.accepted else 0
            )
            slot["C2_marker_chars"] += result.marker_chars
            slot["unmarked_continuation_bodies"] += 0
            slot["explicit_omission_marker_bodies"] += 1

        tail_start = total - TAIL_CHARS
        for signal in DIRECT_SIGNALS:
            _recovery_add(recovery[signal], lines, result, signal, tail_start)
            _recovery_add(recovery_class[item.cls][signal], lines, result, signal, tail_start)

        if result.accepted:
            newly_visible = [
                line for line in lines
                if line.fail_or_hunk
                and _line_hidden_by_c1(line, tail_start)
                and line.index in result.kept
            ]
            for line in newly_visible:
                neighbors = [
                    neighbor for neighbor in (line.index - 1, line.index + 1)
                    if 0 <= neighbor < len(lines)
                ]
                kept_neighbors = sum(neighbor in result.kept for neighbor in neighbors)
                neighborhood["newly_visible_fail_or_hunk_lines"] += 1
                if not neighbors:
                    neighborhood["source_edge_lines"] += 1
                elif kept_neighbors == len(neighbors):
                    neighborhood["both_original_immediate_neighbors_retained"] += 1
                elif kept_neighbors == 0:
                    neighborhood["orphaned_from_both_original_immediate_neighbors"] += 1
                else:
                    neighborhood["one_original_immediate_neighbor_retained"] += 1

        direct_union = lambda line: line.any_direct_signal
        c1_evidence = _source_visible_chars_c1(lines, total, direct_union)
        c2_evidence = _source_visible_chars_c2(lines, result, total, direct_union)
        density["C1_marked_document_chars"] += stock.chars
        density["C2_marked_document_chars"] += result.chars
        density["C1_visible_direct_signal_source_chars"] += c1_evidence
        density["C2_visible_direct_signal_source_chars"] += c2_evidence

    FIDELITY_KEYS = (
        "logical_overflow_bodies",
        "raw_overflow_bodies_evaluable_for_C2",
        "archive_already_windowed_not_evaluable_for_C2",
        "archive_unavailable_hole_chars",
        "evaluated_overflow_bodies",
        "C1_source_projection_subsequence_violations",
        "C2_source_projection_subsequence_violations",
        "C2_accepted_bodies",
        "C2_fail_open_to_C1_bodies",
        "C1_marker_holes",
        "C1_nonempty_middle_holes",
        "C2_marker_holes",
        "C2_interior_marker_holes",
        "C2_extra_marker_holes_vs_C1",
        "C2_omitted_frozen_disposable_lines",
        "C2_omitted_frozen_disposable_chars",
        "C2_retained_broad_K_struct_lines_due_unique_payload_guard",
        "C2_retained_broad_K_struct_chars_due_unique_payload_guard",
        "C2_marker_chars",
        "unmarked_continuation_bodies",
        "explicit_omission_marker_bodies",
    )
    neighborhood_keys = (
        "newly_visible_fail_or_hunk_lines",
        "both_original_immediate_neighbors_retained",
        "one_original_immediate_neighbor_retained",
        "orphaned_from_both_original_immediate_neighbors",
        "source_edge_lines",
    )
    c1_denominator = density["C1_marked_document_chars"]
    c2_denominator = density["C2_marked_document_chars"]
    density_output = dict(density)
    density_output["C1_visible_direct_signal_density_pct"] = (
        100.0 * density["C1_visible_direct_signal_source_chars"] / c1_denominator
        if c1_denominator else 0.0
    )
    density_output["C2_visible_direct_signal_density_pct"] = (
        100.0 * density["C2_visible_direct_signal_source_chars"] / c2_denominator
        if c2_denominator else 0.0
    )
    return {
        "definitions": {
            "evaluation_scope": (
                "C1/C2 fidelity is evaluated only on logical pre-envelope bodies present "
                "in the archive; already-windowed Mini/DSH holes are unknown, not zero"
            ),
            "subsequence": (
                "source projection after removing explicit markers is a Unicode "
                "code-point subsequence of the original"
            ),
            "C1_holes": "one stock middle marker per overflow body",
            "C2_holes": (
                "one marker per contiguous K_struct run on accepted bodies; fail-open "
                "bodies are untouched stock C1"
            ),
            "newly_visible_line": (
                "a direct fail/hunk line wholly inside C1's hole and retained by an "
                "accepted C2 document"
            ),
            "neighborhood": "retention of the original immediate physical-line neighbors",
            "false_completeness": (
                "structural check for unmarked source continuation; both contracts expose "
                "every omission with a marker and traverse through the original end"
            ),
        },
        "all_overflow": _finalize_counter(totals, FIDELITY_KEYS),
        "by_class": {
            cls: _finalize_counter(classes[cls], FIDELITY_KEYS) for cls in BASH_CLASSES
        },
        "C1_hole_direct_signal_recovery": {
            name: {
                **_finalize_counter(recovery[name], RECOVERY_KEYS),
                "by_class": {
                    cls: _finalize_counter(recovery_class[cls][name], RECOVERY_KEYS)
                    for cls in BASH_CLASSES
                },
            }
            for name in DIRECT_SIGNALS
        },
        "newly_visible_fail_hunk_neighborhood": _finalize_counter(
            neighborhood, neighborhood_keys
        ),
        "false_completeness": {
            "unmarked_continuation_bodies_C1": 0,
            "unmarked_continuation_bodies_C2": totals["unmarked_continuation_bodies"],
            "note": "marker presence is necessary, not a semantic readability judgment",
        },
        "completion_and_density_footnote": {
            **density_output,
            "C2_whole_document_elision_completions": totals["C2_accepted_bodies"],
            "C2_fail_open_bodies": totals["C2_fail_open_to_C1_bodies"],
            "note": "footnote only; completion count and density do not choose a contract",
        },
    }


def identity_footnote(observations: Iterable[Any]) -> dict[str, int]:
    views = [body_view(item.text) for item in observations]
    items = [view for view in views if view.original_chars < MAX_CHARS]
    chars = sum(view.original_chars for view in items)
    return {
        "bodies": len(items),
        "input_chars": chars,
        "C1_output_chars": chars,
        "C2_output_chars": chars,
        "chars_shrunk": 0,
    }


def aggregate(observations: list[Any], coverage: dict[str, Any]) -> dict[str, Any]:
    # The imported scanner discovers archives created after the frozen cutoff and
    # counts their post-cutoff events before excluding those sessions. Those two
    # telemetry fields change as the live archive grows and describe no included
    # observation, so they are intentionally omitted from the frozen artifact.
    frozen_coverage = {
        key: value for key, value in coverage.items()
        if key not in {
            "discovered_archives", "post_cutoff_events", "first_10k_input_bytes"
        }
    }
    census = window_census(observations)
    fidelity = contract_fidelity(observations)
    bodyless_metrics = collections.Counter()
    for item in observations:
        view = body_view(item.text)
        chars = view.original_chars
        bodyless_metrics[f"class:{item.cls}:bodies"] += 1
        bodyless_metrics[f"class:{item.cls}:chars"] += chars
        bodyless_metrics[f"class:{item.cls}:overflow"] += int(chars >= MAX_CHARS)
    digest_payload = json.dumps(
        dict(sorted(bodyless_metrics.items())), sort_keys=True, separators=(",", ":")
    )
    return {
        "schema": "qq.bash-window-contract-current/v1",
        "method": {
            "delegation_id": AUTHORITATIVE_DELEGATION,
            "authoritative_parent_session": AUTHORITATIVE_PARENT,
            "study_session": STUDY_SESSION,
            "frozen_study_session_excluded": FROZEN_STUDY_SESSION,
            "event_cutoff_ms": EVENT_CUTOFF_MS,
            "event_cutoff_utc": datetime.fromtimestamp(
                EVENT_CUTOFF_MS / 1000, timezone.utc
            ).isoformat(),
            "dynamic_discovery_and_post_cutoff_telemetry_persisted": False,
            "corpus": "$HOME/.local/state/qq/sessions/**/session.jsonl.zstd",
            "first_result_per_bash_call": True,
            "frozen_window_study_import": (
                "experiments/bash-window-value-current/census.py"
            ),
            "frozen_window_study_sha256": sha256_file(VALUE_PATH),
            "scanner_and_ladders_imported_transitively": (
                "experiments/bash-filter-opportunity-current/census.py"
            ),
            "scanner_and_ladders_sha256": sha256_file(value_study.OPPORTUNITY_PATH),
            "classifier_module": "experiments/cca-mixed-current/replay.py",
            "classifier_module_sha256": sha256_file(opportunity.REPLAY_PATH),
            "code_point_measure": (
                "Python len(str), matching production iteration/Array.from over Unicode code points"
            ),
            "stock_DSH_path": "src/observation.mjs truncateObservation",
            "stock_Mini_paths": (
                "src/official-mini.mjs formatSummaries and "
                "src/mini-swe-v2.mjs renderMiniSweObservation"
            ),
            "stock_contract": (
                "identity below 10000 logical output code points; at or above, source head "
                "5000 + exact omitted-count marker/JSON field + source tail 5000"
            ),
            "archive_stock_holes_reconstructed": False,
            "archive_serialized_Mini_JSON_recapped": False,
            "C1_status": "already shipped baseline; not a build",
            "C2_contract": (
                "all classes; identity below cap; elide only complete runs in the safe "
                "K_struct subset (blank/layout, progress, exact repeats), preserving "
                "first-seen ANSI/CRLF payload; accept only if marked document <10000 code "
                "points; otherwise return C1 on the original"
            ),
            "historical_commands_executed": False,
            "full_commands_persisted": False,
            "full_result_bodies_persisted": False,
            "selected_windows_persisted": False,
            "excerpts_persisted": False,
            "sample_identifiers_persisted": False,
            "per_observation_data_persisted": False,
            "mixed_subcommand_segmentation_attempted": False,
            "reorder_or_collage_evaluated": False,
            "other_policy_families_evaluated": False,
            "cca_invoked": False,
            "rtk_invoked": False,
            "live_pair_used": False,
            "llm_judge_used": False,
            "product_behavior_changed": False,
        },
        "coverage": frozen_coverage,
        "real_window_census": census,
        "contract_fidelity": fidelity,
        "under_cap_identity_footnote": identity_footnote(observations),
        "audit": AUDIT_AGGREGATE,
        "bodyless_aggregate_digest": hashlib.sha256(digest_payload.encode()).hexdigest(),
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
        "bash_bodies": coverage["bash_bodies"],
        "window": payload["real_window_census"]["all_overflow"],
        "fidelity": payload["contract_fidelity"]["all_overflow"],
        "recovery": {
            name: {
                key: row[key] for key in (
                    "C1_hole_chars", "C1_fully_hidden_lines",
                    "C2_recovered_full_lines", "fail_open_fully_hidden_lines_still_missing",
                )
            }
            for name, row in payload["contract_fidelity"]["C1_hole_direct_signal_recovery"].items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
