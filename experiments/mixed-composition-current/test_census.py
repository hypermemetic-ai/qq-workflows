"""Tests for the inspect-only mixed composition census."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("mixed_census", HERE / "census.py")
assert SPEC and SPEC.loader
census = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = census
SPEC.loader.exec_module(census)


class FrozenClassifierTests(unittest.TestCase):
    def test_reconstructed_class_matches_representative_frozen_classes(self) -> None:
        cases = (
            ("git diff", "", "git_diff"),
            ("git diff && npm test", "", "mixed/compound"),
            ("find . -type f | grep widget", "", "mixed/compound"),
            ("rg needle | head", "", "search"),
            ("echo one && echo two; echo three", "", "mixed/compound"),
            ("custom", "@@ -1 +1 @@\n", "git_diff"),
        )
        for command, output, expected in cases:
            self.assertEqual(census.frozen.classify_bash(command, output), expected)
            self.assertEqual(census.reconstructed_class(command, output), expected)

    def test_no_tag_generic_fallback_is_not_a_new_tag(self) -> None:
        command = "echo one && echo two; echo three"
        self.assertEqual(census.constituent_tags(command, ""), set())
        self.assertEqual(census.reconstructed_class(command, ""), "mixed/compound")

    def test_shape_reports_overlapping_operators(self) -> None:
        operators, signature = census.body_shape("cat <<EOF | sed x && echo ok")
        self.assertEqual(operators, ["&&", "pipe", "heredoc"])
        self.assertEqual(signature, "&&+pipe+heredoc")


class StructuralFilterTests(unittest.TestCase):
    def test_nonadjacent_repeats_keep_endpoints_and_exact_count(self) -> None:
        body = "repeat me\nunique a\nrepeat me\nunique b\nrepeat me\nrepeat me\n"
        candidate = census.collapse_repeated_lines(body, frozenset())
        self.assertEqual(candidate.text.count("repeat me\n"), 2)
        self.assertIn("2 middle occurrences", candidate.text)
        self.assertIn("unique a\n", candidate.text)
        self.assertIn("unique b\n", candidate.text)
        self.assertEqual(candidate.removed_bytes, len("repeat me\n") * 2)

    def test_named_evidence_is_never_repeat_folded(self) -> None:
        for line in (
            "FAILED tests/test_widget.py::test_name\n",
            "src/widget.py:12: error: broken\n",
            "@@ -1,2 +1,2 @@\n",
            "pytest version 9.1.2\n",
            "10 tests passed\n",
        ):
            body = line * 4
            self.assertEqual(
                census.collapse_repeated_lines(body, frozenset()).text,
                body,
            )

    def test_progress_keeps_first_final_and_count_marker(self) -> None:
        body = "".join(f"Progress: resolved {number}\n" for number in range(6))
        candidate = census.collapse_progress(body, frozenset())
        self.assertTrue(candidate.text.startswith("Progress: resolved 0\n"))
        self.assertTrue(candidate.text.endswith("Progress: resolved 5\n"))
        self.assertIn("4 progress update lines omitted", candidate.text)

    def test_small_evidence_slice_is_identity(self) -> None:
        body = "payload\n" * 10
        self.assertEqual(
            census.evidence_indexed_slice(body, frozenset()).text,
            body,
        )


class ArtifactPrivacyTests(unittest.TestCase):
    def test_aggregate_has_no_commands_bodies_excerpts_or_records(self) -> None:
        source = (HERE / "results.json").read_text(encoding="utf-8")
        payload = json.loads(source)
        self.assertFalse(payload["method"]["full_commands_persisted"])
        self.assertFalse(payload["method"]["full_bodies_persisted"])
        self.assertFalse(payload["method"]["excerpts_persisted"])
        self.assertFalse(payload["method"]["per_observation_records_persisted"])
        forbidden_keys = {"command", "body", "excerpt", "records"}
        def walk(value: object) -> None:
            if isinstance(value, dict):
                self.assertTrue(forbidden_keys.isdisjoint(value))
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(payload)


if __name__ == "__main__":
    unittest.main()
