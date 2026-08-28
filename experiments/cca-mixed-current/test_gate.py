"""Unit tests for the pure CCA accept gate."""
from __future__ import annotations

import unittest

from gate import accept_cca


class AcceptCcaTests(unittest.TestCase):
    def test_hunk_drop_rejected(self) -> None:
        raw = "header\n@@ -1,2 +1,2 @@\n context\n" + ("filler\n" * 20)
        out = "header\n context\n"
        result = accept_cca(raw, out, {"changed": True})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "diff_hunk_loss")
        self.assertEqual(result["evidence"]["diff hunks"]["lost_exact"], 1)

    def test_fail_drop_rejected(self) -> None:
        raw = "suite\n  FAIL widget preserves state\n" + ("filler\n" * 20)
        out = "suite\n"
        result = accept_cca(raw, out, {"changed": True})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "test_failing_name_loss")
        self.assertEqual(
            result["evidence"]["test failing-name lines"]["lost_exact"], 1
        )

    def test_diagnostic_drop_rejected(self) -> None:
        raw = "start\nTraceback: exact detail\n" + ("filler\n" * 20)
        out = "start\n"
        result = accept_cca(raw, out, {"changed": True})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "diagnostic_loss")
        self.assertEqual(result["evidence"]["diagnostic lines"]["lost_exact"], 1)

    def test_shorter_with_zero_loss_accepted(self) -> None:
        must_keep = "@@ -1 +1 @@\nFAIL widget\nAssertionError: detail\n"
        raw = must_keep + ("noise\n" * 30)
        out = must_keep
        result = accept_cca(raw, out, {"changed": True, "critical": True})
        self.assertTrue(result["accepted"])
        self.assertEqual(result["reason"], "accepted")
        self.assertGreater(result["evidence"]["saved_bytes"], 0)
        for category in (
            "diff hunks",
            "test failing-name lines",
            "diagnostic lines",
        ):
            self.assertEqual(result["evidence"][category]["lost_exact"], 0)

    def test_identity_changed_false_rejected(self) -> None:
        raw = "same body\n"
        result = accept_cca(raw, raw, {"changed": False})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "changed_false")

    def test_longer_output_rejected(self) -> None:
        # UTF-8 byte lengths, rather than character counts, control acceptance.
        raw = "é\n"
        out = "éé\n"
        result = accept_cca(raw, out, {"changed": True})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "not_shorter")
        self.assertGreaterEqual(
            result["evidence"]["candidate_bytes"],
            result["evidence"]["raw_bytes"],
        )

    def test_duplicate_evidence_uses_counter_not_set(self) -> None:
        line = "ERROR duplicate\n"
        raw = line + line + ("noise\n" * 20)
        out = line
        result = accept_cca(raw, out, {"changed": True})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "diagnostic_loss")
        self.assertEqual(result["evidence"]["diagnostic lines"]["raw"], 2)
        self.assertEqual(result["evidence"]["diagnostic lines"]["retained_exact"], 1)


if __name__ == "__main__":
    unittest.main()
