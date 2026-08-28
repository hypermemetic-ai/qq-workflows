#!/usr/bin/env python3
"""Inspect-only census of overflow reads and alternative 10k bash windows.

The prior all-bash scanner, frozen classifier, and keep ladders are imported,
not copied. Historical commands are classifier/shape metadata and are never
executed. Commands, result bodies, selected windows, excerpts, and individual
observations remain in memory only; the artifact is aggregate-only.
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
import sys
from typing import Any, Callable, Iterable

HERE = Path(__file__).resolve().parent
OPPORTUNITY_PATH = HERE.parent / "bash-filter-opportunity-current" / "census.py"
DEFAULT_CORPUS = Path.home() / ".local/state/qq/sessions"
STUDY_SESSION = "session-676456e0-e1b6-4b74-a066-bd044f1bdacf"
EVENT_CUTOFF_MS = 1787925121608
AUTHORITATIVE_PARENT = "session-af60703c-a964-41ee-bb2b-9edfc7b170f3"
AUTHORITATIVE_DELEGATION = "f9a65065-efd7-4d72-a7b2-ba3b02b4655e"

_spec = importlib.util.spec_from_file_location(
    "imported_bash_filter_opportunity", OPPORTUNITY_PATH
)
if _spec is None or _spec.loader is None:  # pragma: no cover - installation error
    raise RuntimeError(f"cannot import prior census: {OPPORTUNITY_PATH}")
opportunity = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = opportunity
_spec.loader.exec_module(opportunity)

BASH_CLASSES = tuple(opportunity.BASH_CLASSES)
ENVELOPE_BYTES = opportunity.ENVELOPE_BYTES
LADDER_NAMES = tuple(opportunity.LADDER_NAMES)
HEAD_TAIL_CLASSES = frozenset(
    {"source_dump", "lockfile/json", "npm/install/debug_log"}
)
LISTING_SEARCH_CLASSES = frozenset({"listing", "search"})

# Populated after the local, temporary review described in report.md. No sample
# identifier, command, body, selected window, or excerpt is retained here.
AUDIT_AGGREGATE: dict[str, Any] = {
    "status": "complete; temporary review material deleted",
    "selection": "up to two largest eligible overflow bodies per frozen class",
    "sampled_bodies": 21,
    "classes_with_overflow": 11,
    "prefix_hid_load_bearing_tail_bodies": 21,
    "evidence_first_hid_load_bearing_mid_unique_bodies": 21,
    "head_tail_hid_load_bearing_mid_unique_bodies": 4,
    "head_tail_sampled_bodies": 6,
    "interpretation": "sample disagreement counts, not accuracy estimates",
}


def utf8_bytes(value: str) -> int:
    return opportunity.utf8_bytes(value)


def sha256_file(path: Path) -> str:
    return opportunity.sha256_file(path)


def scan_corpus(corpus: Path) -> tuple[list[Any], dict[str, Any]]:
    """Use the prior first-result join with this study's frozen snapshot."""
    prior_cutoff = opportunity.EVENT_CUTOFF_MS
    prior_session = opportunity.STUDY_SESSION
    opportunity.EVENT_CUTOFF_MS = EVENT_CUTOFF_MS
    opportunity.STUDY_SESSION = STUDY_SESSION
    try:
        observations, coverage = opportunity.scan_corpus(corpus)
    finally:
        opportunity.EVENT_CUTOFF_MS = prior_cutoff
        opportunity.STUDY_SESSION = prior_session
    if coverage["classifier_reconstruction_mismatches"]:
        raise AssertionError("imported classifier reconstruction no longer matches")
    return observations, coverage


@dataclass(frozen=True)
class SourceLine:
    index: int
    value: str
    size: int
    start: int
    prefix_bytes: int
    tail_bytes: int
    k_struct: bool
    k_fail: bool
    k_hunk: bool
    k_nav: bool
    fail_evidence: bool
    hunk_evidence: bool
    nav_evidence: bool
    fail_increment: bool
    hunk_increment: bool
    nav_increment: bool
    leftover_unique: bool

    @property
    def evidence(self) -> bool:
        return self.fail_evidence or self.hunk_evidence


@dataclass(frozen=True)
class Segment:
    value: str
    source: SourceLine | None = None

    @property
    def size(self) -> int:
        return utf8_bytes(self.value)


@dataclass
class Selection:
    segments: list[Segment]
    omitted_lines: int = 0
    marker_bytes: int = 0
    accepted: bool = False
    fail_open: bool = False

    @property
    def size(self) -> int:
        return sum(segment.size for segment in self.segments)

    @property
    def value(self) -> str:
        return "".join(segment.value for segment in self.segments)


def source_lines(value: str, cls: str) -> list[SourceLine]:
    raw_lines = opportunity.split_lines(value)
    flags = opportunity.ladder_flags(raw_lines, cls)
    direct_hunks = opportunity.hunk_flags(raw_lines, cls)
    output: list[SourceLine] = []
    start = 0
    for index, line in enumerate(raw_lines):
        size = utf8_bytes(line)
        prefix = max(
            0,
            min(start + size, ENVELOPE_BYTES) - min(start, ENVELOPE_BYTES),
        )
        k_struct = flags["K_struct"][index]
        k_fail = flags["K_fail"][index]
        k_hunk = flags["K_hunk"][index]
        k_nav = flags["K_nav"][index]
        output.append(SourceLine(
            index=index,
            value=line,
            size=size,
            start=start,
            prefix_bytes=prefix,
            tail_bytes=size - prefix,
            k_struct=k_struct,
            k_fail=k_fail,
            k_hunk=k_hunk,
            k_nav=k_nav,
            fail_evidence=opportunity.is_fail_line(line),
            hunk_evidence=direct_hunks[index],
            nav_evidence=opportunity.is_nav_line(line),
            fail_increment=k_fail and not k_struct,
            hunk_increment=k_hunk and not k_fail,
            nav_increment=k_nav and not k_hunk,
            # K_struct includes every exact repeat after its first occurrence,
            # so a line outside K_nav is first-seen unique under the frozen ladder.
            leftover_unique=not k_nav,
        ))
        start += size
    if start != utf8_bytes(value):
        raise AssertionError("source-line byte accounting drift")
    return output


def identity_selection(lines: list[SourceLine]) -> Selection:
    return Selection([Segment(line.value, line) for line in lines])


def omission_marker(count: int, label: str) -> str:
    return f"[... {count} lines omitted by {label} ...]\n"


def render_original_order(
    lines: list[SourceLine], selected: set[int], label: str
) -> Selection:
    segments: list[Segment] = []
    omitted = marker_total = 0
    index = 0
    while index < len(lines):
        if index in selected:
            line = lines[index]
            segments.append(Segment(line.value, line))
            index += 1
            continue
        end = index + 1
        while end < len(lines) and end not in selected:
            end += 1
        count = end - index
        marker = omission_marker(count, label)
        segments.append(Segment(marker))
        omitted += count
        marker_total += utf8_bytes(marker)
        index = end
    return Selection(segments, omitted, marker_total)


def evidence_first(lines: list[SourceLine], cls: str) -> Selection:
    """Priority-pack named K_fail/K_hunk evidence, then unique context."""
    has_observed_hunk = any(line.hunk_evidence for line in lines)
    use_hunk = cls == "git_diff" or has_observed_hunk
    fixed = {
        line.index
        for line in lines
        if line.fail_evidence or (use_hunk and line.hunk_evidence)
    }
    # The frozen K_struct marks repeats/progress/layout. Context therefore uses
    # only first-seen, non-structural lines; it is never assumed disposable, but
    # follows named evidence in this selected window.
    context = [
        line for line in lines
        if line.index not in fixed and not line.k_struct
    ]
    selected_context: list[SourceLine] = []
    fixed_bytes = sum(lines[index].size for index in fixed)
    context_bytes = 0
    for line in context:
        prospective_count = len(lines) - len(fixed) - len(selected_context) - 1
        marker_size = (
            utf8_bytes(omission_marker(prospective_count, "evidence-first pack"))
            if prospective_count else 0
        )
        if fixed_bytes + context_bytes + line.size + marker_size <= ENVELOPE_BYTES:
            selected_context.append(line)
            context_bytes += line.size

    selected_count = len(fixed) + len(selected_context)
    omitted = len(lines) - selected_count
    # A final omitted count can gain a digit relative to a prospective marker.
    # Remove trailing context until the exact final marker fits the 10k budget,
    # unless priority evidence alone already overflows.
    while selected_context and omitted and (
        fixed_bytes + sum(line.size for line in selected_context)
        + utf8_bytes(omission_marker(omitted, "evidence-first pack"))
        > ENVELOPE_BYTES
    ):
        selected_context.pop()
        selected_count -= 1
        omitted += 1
    segments = [
        Segment(lines[index].value, lines[index]) for index in sorted(fixed)
    ]
    marker_total = 0
    if omitted:
        marker = omission_marker(omitted, "evidence-first pack")
        segments.append(Segment(marker))
        marker_total = utf8_bytes(marker)
    segments.extend(Segment(line.value, line) for line in selected_context)
    return Selection(segments, omitted, marker_total)


def head_tail(lines: list[SourceLine], _cls: str) -> Selection:
    selected = set(range(min(40, len(lines))))
    selected.update(range(max(0, len(lines) - 40), len(lines)))
    selected.update(line.index for line in lines if line.fail_evidence)
    return render_original_order(lines, selected, "first/last-40 plus K_fail")


def listing_search(lines: list[SourceLine], _cls: str) -> Selection:
    selected = set(range(min(50, len(lines))))
    selected.update(line.index for line in lines if line.fail_evidence)
    return render_original_order(lines, selected, "first-50 plus K_fail")


def test_fold(lines: list[SourceLine], _cls: str) -> Selection:
    """Fold recognized passing lines while retaining endpoints and all else."""
    selected = set(range(len(lines)))
    passing = [
        line.index for line in lines
        if opportunity.PASS_LINE_RE.fullmatch(opportunity.bare(line.value))
    ]
    if len(passing) >= 4:
        selected.difference_update(passing[1:-1])
    # Failures/diagnostics, summaries, and every unrecognized context line stay.
    selected.update(line.index for line in lines if line.fail_evidence)
    selected.update(
        line.index for line in lines
        if opportunity.SUMMARY_COUNT_RE.search(opportunity.bare(line.value))
    )
    return render_original_order(lines, selected, "passing-test fold")


def class_aware(lines: list[SourceLine], cls: str) -> Selection:
    if cls in HEAD_TAIL_CLASSES:
        return head_tail(lines, cls)
    if cls in LISTING_SEARCH_CLASSES:
        return listing_search(lines, cls)
    if cls == "test":
        return test_fold(lines, cls)
    # This is the only mixed policy: mixed text is never segmented by subcommand.
    return evidence_first(lines, cls)


def visible_metrics(selection: Selection) -> collections.Counter[str]:
    output: collections.Counter[str] = collections.Counter()
    remaining = ENVELOPE_BYTES
    for segment in selection.segments:
        if remaining <= 0:
            break
        shown = min(segment.size, remaining)
        output["window_bytes"] += shown
        remaining -= shown
        line = segment.source
        if line is None:
            output["marker_bytes"] += shown
            continue
        original_prefix = min(shown, line.prefix_bytes)
        original_tail = min(line.tail_bytes, max(0, shown - line.prefix_bytes))
        output["original_prefix_bytes"] += original_prefix
        output["original_tail_bytes"] += original_tail
        for name, matched in (
            ("K_struct", line.k_struct),
            ("K_fail", line.k_fail),
            ("K_hunk", line.k_hunk),
            ("K_nav", line.k_nav),
        ):
            if matched:
                output[f"frozen_{name}_bytes"] += shown
                output[f"tail_frozen_{name}_bytes"] += original_tail
        if line.fail_evidence:
            output["K_fail_bytes"] += shown
            output["tail_K_fail_bytes"] += original_tail
        if line.hunk_evidence:
            output["K_hunk_bytes"] += shown
            output["tail_K_hunk_bytes"] += original_tail
        if line.fail_increment:
            output["failure_increment_bytes"] += shown
            output["tail_failure_increment_bytes"] += original_tail
        if line.hunk_increment:
            output["hunk_increment_bytes"] += shown
            output["tail_hunk_increment_bytes"] += original_tail
        if line.evidence:
            output["evidence_bytes"] += shown
            output["tail_evidence_bytes"] += original_tail
    return output


def strictly_more_useful(
    original: Selection, proposed: Selection
) -> bool:
    """Accept only a complete selected read or a denser evidence window."""
    if proposed.size >= original.size or proposed.value == original.value:
        return False
    if proposed.size <= ENVELOPE_BYTES:
        return True
    before = visible_metrics(original)
    after = visible_metrics(proposed)
    return after["evidence_bytes"] > before["evidence_bytes"]


def select_for_observation(
    item: Any,
    lines: list[SourceLine],
    builder: Callable[[list[SourceLine], str], Selection],
) -> Selection:
    original = identity_selection(lines)
    if item.raw_bytes <= ENVELOPE_BYTES or not item.eligible:
        return original
    proposed = builder(lines, item.cls)
    if strictly_more_useful(original, proposed):
        proposed.accepted = True
        return proposed
    original.fail_open = True
    return original


def _location_add(
    stats: collections.Counter[str], line: SourceLine
) -> None:
    stats["lines"] += 1
    stats["bytes"] += line.size
    if line.prefix_bytes:
        stats["prefix_lines"] += 1
        stats["prefix_bytes"] += line.prefix_bytes
    if line.tail_bytes:
        stats["tail_lines"] += 1
        stats["tail_bytes"] += line.tail_bytes


def _location_json(
    totals: collections.Counter[str],
    by_class: dict[str, collections.Counter[str]],
) -> dict[str, Any]:
    return {
        **dict(totals),
        "by_class": {cls: dict(by_class[cls]) for cls in BASH_CLASSES},
    }


def signal_location(observations: Iterable[Any]) -> dict[str, Any]:
    cumulative_names = ("K_fail", "K_hunk", "K_nav")
    disjoint_names = (
        "structural", "failure_increment", "hunk_increment", "nav_increment",
        "leftover_unique_after_K_nav",
    )
    evidence_names = ("K_fail", "K_hunk", "K_nav", "K_fail_or_K_hunk")
    evidence = {name: collections.Counter() for name in evidence_names}
    evidence_class = {
        name: {cls: collections.Counter() for cls in BASH_CLASSES}
        for name in evidence_names
    }
    cumulative = {name: collections.Counter() for name in cumulative_names}
    cumulative_class = {
        name: {cls: collections.Counter() for cls in BASH_CLASSES}
        for name in cumulative_names
    }
    disjoint = {name: collections.Counter() for name in disjoint_names}
    disjoint_class = {
        name: {cls: collections.Counter() for cls in BASH_CLASSES}
        for name in disjoint_names
    }
    for item in observations:
        for line in source_lines(item.text, item.cls):
            for name, matched in (
                ("K_fail", line.fail_evidence),
                ("K_hunk", line.hunk_evidence),
                ("K_nav", line.nav_evidence),
                ("K_fail_or_K_hunk", line.evidence),
            ):
                if matched:
                    _location_add(evidence[name], line)
                    _location_add(evidence_class[name][item.cls], line)
            for name, matched in (
                ("K_fail", line.k_fail),
                ("K_hunk", line.k_hunk),
                ("K_nav", line.k_nav),
            ):
                if matched:
                    _location_add(cumulative[name], line)
                    _location_add(cumulative_class[name][item.cls], line)
            if line.k_struct:
                category = "structural"
            elif line.fail_increment:
                category = "failure_increment"
            elif line.hunk_increment:
                category = "hunk_increment"
            elif line.nav_increment:
                category = "nav_increment"
            else:
                category = "leftover_unique_after_K_nav"
            _location_add(disjoint[category], line)
            _location_add(disjoint_class[category][item.cls], line)
    return {
        "definition": (
            "Imported cumulative K_fail/K_hunk/K_nav plus an exact disjoint "
            "partition through K_nav. Prefix/tail bytes split at byte [0,10000); "
            "a physical line crossing the boundary touches both regions."
        ),
        "named_evidence": {
            name: _location_json(evidence[name], evidence_class[name])
            for name in evidence_names
        },
        "cumulative_frozen_ladders": {
            name: _location_json(cumulative[name], cumulative_class[name])
            for name in cumulative_names
        },
        "disjoint_partition": {
            name: _location_json(disjoint[name], disjoint_class[name])
            for name in disjoint_names
        },
    }


def _overflow_add(
    stats: collections.Counter[str], item: Any, is_overflow: bool
) -> None:
    stats["bodies"] += 1
    stats["bytes"] += item.raw_bytes
    if is_overflow:
        stats["overflow_bodies"] += 1
        stats["overflow_bytes"] += item.raw_bytes
        stats["clipped_tail_bytes"] += item.raw_bytes - ENVELOPE_BYTES
    else:
        stats["already_complete_bodies"] += 1
        stats["already_complete_bytes"] += item.raw_bytes


def _overflow_finalize(stats: collections.Counter[str], all_bodies: int, all_bytes: int) -> dict[str, Any]:
    result = dict(stats)
    result["overflow_body_share_of_all_bash_pct"] = (
        100.0 * stats["overflow_bodies"] / all_bodies if all_bodies else 0.0
    )
    result["overflow_byte_share_of_all_bash_pct"] = (
        100.0 * stats["overflow_bytes"] / all_bytes if all_bytes else 0.0
    )
    return result


def overflow_census(observations: Iterable[Any], coverage: dict[str, Any]) -> dict[str, Any]:
    items = list(observations)
    totals: collections.Counter[str] = collections.Counter()
    by_class = {cls: collections.Counter() for cls in BASH_CLASSES}
    mixed_signatures: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    mixed_operators: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    greater_100k = greater_100kib = 0
    between_10k_and_10kib = greater_10kib = 0
    for item in items:
        over = item.raw_bytes > ENVELOPE_BYTES
        _overflow_add(totals, item, over)
        _overflow_add(by_class[item.cls], item, over)
        between_10k_and_10kib += int(
            ENVELOPE_BYTES < item.raw_bytes <= 10 * 1024
        )
        greater_10kib += int(item.raw_bytes > 10 * 1024)
        greater_100k += int(item.raw_bytes > 100_000)
        greater_100kib += int(item.raw_bytes > 100 * 1024)
        if item.cls == "mixed/compound":
            operators, signature = opportunity.body_shape(item.command)
            _overflow_add(mixed_signatures[signature], item, over)
            for operator in operators:
                _overflow_add(mixed_operators[operator], item, over)
    all_bodies = coverage["bash_bodies"]
    all_bytes = coverage["bash_bytes"]
    return {
        "threshold_definition": "overflow iff pre-envelope UTF-8 bytes > 10000",
        "all_bash": _overflow_finalize(totals, all_bodies, all_bytes),
        "by_class": {
            cls: _overflow_finalize(by_class[cls], all_bodies, all_bytes)
            for cls in BASH_CLASSES
        },
        "mixed_shape": {
            "operator_exclusive_signatures": {
                key: _overflow_finalize(value, all_bodies, all_bytes)
                for key, value in sorted(mixed_signatures.items())
            },
            "operator_inclusive": {
                key: _overflow_finalize(value, all_bodies, all_bytes)
                for key, value in sorted(mixed_operators.items())
            },
        },
        "bodies_10001_through_10240_bytes": between_10k_and_10kib,
        "bodies_greater_than_10KiB": greater_10kib,
        "bodies_greater_than_100000_bytes": greater_100k,
        "bodies_greater_than_100KiB": greater_100kib,
        "threshold_note": (
            "The prior >10 KiB size stratum used 10240 bytes; this census uses "
            "the stock envelope's exact 10000-byte boundary."
        ),
    }


POLICY_COUNTER_KEYS = (
    "overflow_before", "overflow_after", "applicable_overflow_bodies",
    "eligible_overflow_bodies", "identity_excluded_overflow_bodies",
    "accepted_bodies", "fail_open_bodies", "completed_selected_reads",
    "omitted_lines", "marker_bytes", "clipped_tail_bytes_available",
    "clipped_K_fail_bytes_available", "clipped_K_hunk_bytes_available",
    "clipped_failure_increment_bytes_available", "clipped_hunk_increment_bytes_available",
    "clipped_evidence_bytes_available", "before_window_bytes", "after_window_bytes",
    "before_evidence_bytes", "after_evidence_bytes",
    "before_failure_increment_bytes", "after_failure_increment_bytes",
    "before_hunk_increment_bytes", "after_hunk_increment_bytes",
    "tail_K_fail_bytes_recovered", "tail_K_hunk_bytes_recovered",
    "tail_failure_increment_bytes_recovered", "tail_hunk_increment_bytes_recovered",
    "tail_evidence_bytes_recovered", "tail_original_bytes_in_selected_window",
)


def _policy_update(
    stats: collections.Counter[str],
    item: Any,
    lines: list[SourceLine],
    before: collections.Counter[str],
    after: collections.Counter[str],
    selection: Selection,
    applicable: bool,
) -> None:
    stats["overflow_before"] += 1
    stats["overflow_after"] += int(selection.size > ENVELOPE_BYTES)
    stats["applicable_overflow_bodies"] += int(applicable)
    stats["eligible_overflow_bodies"] += int(applicable and item.eligible)
    stats["identity_excluded_overflow_bodies"] += int(applicable and not item.eligible)
    stats["accepted_bodies"] += int(selection.accepted)
    stats["fail_open_bodies"] += int(applicable and item.eligible and selection.fail_open)
    stats["completed_selected_reads"] += int(selection.size <= ENVELOPE_BYTES)
    stats["omitted_lines"] += selection.omitted_lines if selection.accepted else 0
    stats["marker_bytes"] += selection.marker_bytes if selection.accepted else 0
    stats["clipped_tail_bytes_available"] += item.raw_bytes - ENVELOPE_BYTES
    stats["clipped_K_fail_bytes_available"] += sum(
        line.tail_bytes for line in lines if line.fail_evidence
    )
    stats["clipped_K_hunk_bytes_available"] += sum(
        line.tail_bytes for line in lines if line.hunk_evidence
    )
    stats["clipped_failure_increment_bytes_available"] += sum(
        line.tail_bytes for line in lines if line.fail_increment
    )
    stats["clipped_hunk_increment_bytes_available"] += sum(
        line.tail_bytes for line in lines if line.hunk_increment
    )
    stats["clipped_evidence_bytes_available"] += sum(
        line.tail_bytes for line in lines if line.evidence
    )
    for key in (
        "window_bytes", "evidence_bytes", "failure_increment_bytes",
        "hunk_increment_bytes",
    ):
        stats[f"before_{key}"] += before[key]
        stats[f"after_{key}"] += after[key]
    stats["tail_K_fail_bytes_recovered"] += after["tail_K_fail_bytes"]
    stats["tail_K_hunk_bytes_recovered"] += after["tail_K_hunk_bytes"]
    stats["tail_failure_increment_bytes_recovered"] += after[
        "tail_failure_increment_bytes"
    ]
    stats["tail_hunk_increment_bytes_recovered"] += after[
        "tail_hunk_increment_bytes"
    ]
    stats["tail_evidence_bytes_recovered"] += after["tail_evidence_bytes"]
    stats["tail_original_bytes_in_selected_window"] += after["original_tail_bytes"]


def _finalize_policy(stats: collections.Counter[str]) -> dict[str, Any]:
    for key in POLICY_COUNTER_KEYS:
        stats[key] += 0
    output = dict(stats)
    output["overflow_reduction_bodies"] = stats["overflow_before"] - stats["overflow_after"]
    output["before_evidence_density_pct"] = (
        100.0 * stats["before_evidence_bytes"] / stats["before_window_bytes"]
        if stats["before_window_bytes"] else 0.0
    )
    output["after_evidence_density_pct"] = (
        100.0 * stats["after_evidence_bytes"] / stats["after_window_bytes"]
        if stats["after_window_bytes"] else 0.0
    )
    output["evidence_density_change_percentage_points"] = (
        output["after_evidence_density_pct"] - output["before_evidence_density_pct"]
    )
    output["clipped_evidence_recovery_pct"] = (
        100.0 * stats["tail_evidence_bytes_recovered"]
        / stats["clipped_evidence_bytes_available"]
        if stats["clipped_evidence_bytes_available"] else 0.0
    )
    return output


def evaluate_policy(
    observations: Iterable[Any],
    applicable_fn: Callable[[str], bool],
    builder: Callable[[list[SourceLine], str], Selection],
) -> dict[str, Any]:
    totals: collections.Counter[str] = collections.Counter()
    applicable_totals: collections.Counter[str] = collections.Counter()
    by_class = {cls: collections.Counter() for cls in BASH_CLASSES}
    for item in observations:
        if item.raw_bytes <= ENVELOPE_BYTES:
            continue
        lines = source_lines(item.text, item.cls)
        original = identity_selection(lines)
        applies = applicable_fn(item.cls)
        selection = (
            select_for_observation(item, lines, builder) if applies else original
        )
        before = visible_metrics(original)
        after = visible_metrics(selection)
        _policy_update(totals, item, lines, before, after, selection, applies)
        _policy_update(by_class[item.cls], item, lines, before, after, selection, applies)
        if applies:
            _policy_update(
                applicable_totals, item, lines, before, after, selection, True
            )
    return {
        "all_overflow": _finalize_policy(totals),
        "applicable_overflow": _finalize_policy(applicable_totals),
        "by_class": {
            cls: _finalize_policy(by_class[cls]) for cls in BASH_CLASSES
        },
    }


def evaluate_policies(observations: list[Any]) -> dict[str, Any]:
    definitions = {
        "evidence_first": {
            "applicable": lambda _cls: True,
            "builder": evidence_first,
            "rule": (
                "All overflow classes: imported named K_fail, plus K_hunk for "
                "git_diff or an observed diff, then first-seen unique context in "
                "original order. Mixed is never segmented."
            ),
        },
        "head_tail": {
            "applicable": lambda cls: cls in HEAD_TAIL_CLASSES,
            "builder": head_tail,
            "rule": (
                "Overflow pure source_dump, lockfile/json, and npm/install/debug_log: "
                "first 40 plus last 40 physical lines plus imported K_fail."
            ),
        },
        "listing_search": {
            "applicable": lambda cls: cls in LISTING_SEARCH_CLASSES,
            "builder": listing_search,
            "rule": (
                "Overflow pure listing/search: first 50 physical lines plus imported "
                "K_fail."
            ),
        },
        "test_fold": {
            "applicable": lambda cls: cls == "test",
            "builder": test_fold,
            "rule": (
                "Overflow pure test: retain all non-pass output, K_fail, summaries, "
                "and the first/final recognized pass line; mark folded interiors."
            ),
        },
        "class_aware_route": {
            "applicable": lambda _cls: True,
            "builder": class_aware,
            "rule": (
                "Apply the three pure-class packs above and evidence-first to all "
                "remaining classes, including whole-body mixed/compound."
            ),
        },
    }
    output: dict[str, Any] = {}
    for name, definition in definitions.items():
        output[name] = {
            "rule": definition["rule"],
            "acceptance_rule": (
                "Overflow eligible proposals only; accept iff selected bytes are "
                "strictly smaller and either the entire selected result is <=10000 "
                "bytes or visible failure/hunk evidence bytes strictly increase."
            ),
            **evaluate_policy(
                observations, definition["applicable"], definition["builder"]
            ),
        }
    return output


def under_10k_identity_footnote(observations: Iterable[Any]) -> dict[str, int]:
    complete = [item for item in observations if item.raw_bytes <= ENVELOPE_BYTES]
    total = sum(item.raw_bytes for item in complete)
    # Every policy short-circuits before constructing a proposal for this set.
    return {
        "already_complete_bodies": len(complete),
        "input_bytes": total,
        "selected_bytes": total,
        "byte_shrink": 0,
    }


def aggregate(observations: list[Any], coverage: dict[str, Any]) -> dict[str, Any]:
    overflow = overflow_census(observations, coverage)
    locations = signal_location(observations)
    policies = evaluate_policies(observations)
    digest_lines: list[str] = []
    for item in observations:
        lines = source_lines(item.text, item.cls)
        digest_lines.append(json.dumps({
            "observation_id": item.observation_id,
            "bytes": item.raw_bytes,
            "class": item.cls,
            "joined": item.joined,
            "sensitive": item.sensitive,
            "overflow": item.raw_bytes > ENVELOPE_BYTES,
            "failure_increment_bytes": sum(
                line.size for line in lines if line.fail_increment
            ),
            "hunk_increment_bytes": sum(
                line.size for line in lines if line.hunk_increment
            ),
        }, sort_keys=True, separators=(",", ":")))
    return {
        "schema": "qq.bash-window-value-current/v1",
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
            "scanner_and_ladders": (
                "imported experiments/bash-filter-opportunity-current/census.py"
            ),
            "scanner_and_ladders_sha256": sha256_file(OPPORTUNITY_PATH),
            "classifier": "frozen 11-class classifier imported transitively",
            "classifier_module": "experiments/cca-mixed-current/replay.py",
            "classifier_module_sha256": sha256_file(opportunity.REPLAY_PATH),
            "envelope_bytes": ENVELOPE_BYTES,
            "byte_measure": "UTF-8 with replacement for invalid scalar values",
            "historical_commands_executed": False,
            "full_commands_persisted": False,
            "full_result_bodies_persisted": False,
            "selected_windows_persisted": False,
            "excerpts_persisted": False,
            "per_observation_data_persisted": False,
            "sensitive_and_unresolved_policy": "identity",
            "under_10k_policy": "identity for every policy",
            "mixed_subcommand_segmentation_attempted": False,
            "optional_pipe_last_stage_policy_evaluated": False,
            "cca_invoked": False,
            "rtk_invoked": False,
            "live_pair_used": False,
            "product_behavior_changed": False,
        },
        "coverage": coverage,
        "overflow_census": overflow,
        "signal_location": locations,
        "window_policies": policies,
        "under_10k_identity_footnote": under_10k_identity_footnote(observations),
        "audit": AUDIT_AGGREGATE,
        "bodyless_observation_count": len(observations),
        "bodyless_observation_digest": hashlib.sha256(
            ("\n".join(digest_lines) + "\n").encode("utf-8", "replace")
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
        "bash_bodies": coverage["bash_bodies"],
        "overflow": payload["overflow_census"]["all_bash"],
        "policy_headlines": {
            name: {
                key: row["all_overflow"][key]
                for key in (
                    "overflow_before", "overflow_after",
                    "tail_evidence_bytes_recovered",
                    "before_evidence_density_pct", "after_evidence_density_pct",
                )
            }
            for name, row in payload["window_policies"].items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
