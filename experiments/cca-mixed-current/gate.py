"""Pure evidence-preserving accept gate for CCA observation output.

The gate has no I/O and does not inspect CCA's ``critical`` metadata.  Evidence
retention mirrors historical-observation-corpus/study.py: matching raw line
occurrences must remain byte-for-byte equal as decoded Python strings, and a
Counter preserves duplicate-line multiplicity.
"""
from __future__ import annotations

from collections import Counter
import re
from typing import Any

DIFF_HUNK_RE = re.compile(r"^@@ ")
FAILED_NAME_RE = re.compile(
    r"(?i)(?:^|\s)(?:FAIL(?:ED)?\b|not ok\b|[✗×❌])"
)
DIAGNOSTIC_RE = re.compile(
    r"(?i)\b(?:error|fail(?:ed|ure)?|assert|traceback|exception)\b"
)

_EVIDENCE_PATTERNS = (
    ("diff hunks", DIFF_HUNK_RE),
    ("test failing-name lines", FAILED_NAME_RE),
    ("diagnostic lines", DIAGNOSTIC_RE),
)


def _exact_line_retention(raw: str, candidate: str, pattern: re.Pattern[str]) -> dict[str, int]:
    """Return Counter-based exact retention for matching raw line occurrences."""
    raw_lines = [line for line in raw.splitlines() if pattern.search(line)]
    available = Counter(candidate.splitlines())
    retained = 0
    for line in raw_lines:
        if available[line] > 0:
            retained += 1
            available[line] -= 1
    candidate_count = sum(1 for line in candidate.splitlines() if pattern.search(line))
    return {
        "raw": len(raw_lines),
        "candidate": candidate_count,
        "retained_exact": retained,
        "lost_exact": len(raw_lines) - retained,
    }


def accept_cca(raw: str, cca_text: str, meta: dict[str, Any]) -> dict[str, Any]:
    """Decide whether a CCA candidate may replace ``raw``.

    Acceptance requires CCA to report ``changed is True``, a strictly smaller
    UTF-8 byte count, and zero exact-line loss for diff hunks, test failing-name
    lines, and diagnostics.  The return value is JSON-serializable and contains
    no body text.
    """
    if not isinstance(raw, str) or not isinstance(cca_text, str):
        raise TypeError("raw and cca_text must be strings")
    if not isinstance(meta, dict):
        raise TypeError("meta must be a dict")

    raw_bytes = len(raw.encode("utf-8", "replace"))
    candidate_bytes = len(cca_text.encode("utf-8", "replace"))
    evidence: dict[str, Any] = {
        "changed": meta.get("changed") is True,
        "raw_bytes": raw_bytes,
        "candidate_bytes": candidate_bytes,
        "saved_bytes": raw_bytes - candidate_bytes,
    }
    for name, pattern in _EVIDENCE_PATTERNS:
        evidence[name] = _exact_line_retention(raw, cca_text, pattern)

    if meta.get("changed") is not True:
        return {"accepted": False, "reason": "changed_false", "evidence": evidence}
    if candidate_bytes >= raw_bytes:
        return {"accepted": False, "reason": "not_shorter", "evidence": evidence}
    for name, reason in (
        ("diff hunks", "diff_hunk_loss"),
        ("test failing-name lines", "test_failing_name_loss"),
        ("diagnostic lines", "diagnostic_loss"),
    ):
        if evidence[name]["lost_exact"]:
            return {"accepted": False, "reason": reason, "evidence": evidence}
    return {"accepted": True, "reason": "accepted", "evidence": evidence}
