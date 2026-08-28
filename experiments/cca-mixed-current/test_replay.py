"""Unit tests for the recovered classifier and current mixed replay helpers."""
from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from replay import CcaJsonlBridge, classify_bash, compound_shell, test_projection_stratum


class ClassifierTests(unittest.TestCase):
    def test_single_intent_precedence_is_unchanged(self) -> None:
        self.assertEqual(classify_bash("git diff", ""), "git_diff")
        self.assertEqual(classify_bash("git diff --stat", ""), "git_diff")
        self.assertEqual(classify_bash("npm test", ""), "test")
        self.assertEqual(classify_bash("cat src/main.py", ""), "source_dump")
        self.assertEqual(classify_bash("rg needle src", ""), "search")

    def test_mixed_requires_compound_multiple_intents(self) -> None:
        self.assertEqual(
            classify_bash("git diff && npm test", ""),
            "mixed/compound",
        )
        self.assertEqual(
            classify_bash("find . -type f | grep widget", ""),
            "mixed/compound",
        )
        self.assertEqual(classify_bash("rg needle | head", ""), "search")

    def test_generic_long_compound_fallback_is_unchanged(self) -> None:
        self.assertEqual(
            classify_bash("echo one && echo two; echo three", ""),
            "mixed/compound",
        )
        self.assertTrue(compound_shell("printf x | cat"))
        self.assertFalse(compound_shell("printf x || true"))

    def test_output_hunk_can_classify_diff(self) -> None:
        self.assertEqual(classify_bash("custom inspect", "@@ -1 +1 @@\n"), "git_diff")

    def test_projection_labels_are_only_prior_weighting_strata(self) -> None:
        self.assertEqual(test_projection_stratum("pytest -q"), "matched")
        self.assertEqual(test_projection_stratum("npm test"), "unmatched")

    def test_jsonl_transport_failure_fails_open_to_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            raw = "must remain exact\n"
            with CcaJsonlBridge(Path(directory)) as bridge:
                candidate, info, error, attempts = bridge.compress("echo metadata", raw)
            self.assertEqual(candidate, raw)
            self.assertEqual(info, {})
            self.assertTrue(error)
            self.assertEqual(attempts, 1)


if __name__ == "__main__":
    unittest.main()
