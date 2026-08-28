"""Tests for the inspect-only all-bash filter opportunity census."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("bash_filter_census", HERE / "census.py")
assert SPEC and SPEC.loader
census = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = census
SPEC.loader.exec_module(census)


class FrozenClassifierTests(unittest.TestCase):
    def test_reconstructed_class_matches_all_frozen_precedence_paths(self) -> None:
        cases = (
            ("git diff", "", "git_diff"),
            ("git status", "", "git_status"),
            ("npm test", "", "test"),
            ("npm install x", "", "npm/install/debug_log"),
            ("sed -i s/x/y/ a.py", "", "write/edit"),
            ("cat a.py", "", "source_dump"),
            ("rg x", "", "search"),
            ("find .", "", "listing"),
            ("jq . a.json", "", "lockfile/json"),
            ("git diff && npm test", "", "mixed/compound"),
            ("printf ok", "", "other"),
            ("echo one && echo two; echo three", "", "mixed/compound"),
        )
        for command, output, expected in cases:
            self.assertEqual(census.frozen.classify_bash(command, output), expected)
            self.assertEqual(census.reconstructed_class(command, output), expected)


class KeepLadderTests(unittest.TestCase):
    def test_ladders_are_additive_and_diff_lines_require_observed_diff(self) -> None:
        lines = [
            "\n",                              # structural
            "error: broken\n",                 # fail
            "+ markdown list\n",               # greedy only before diff
            "diff --git a/x.py b/x.py\n",      # fail header
            "@@ -1 +1 @@\n",                   # fail header
            "-old\n",                          # hunk
            "+new\n",                          # hunk
            "src/x.py:12: location\n",         # nav
            "release 1.0 and 3 files\n",        # greedy, not fail/nav
            "unique payload\n",                # leftover
            "unique payload\n",                # structural exact repeat
        ]
        flags = census.ladder_flags(lines, "other")
        for left, right in zip(census.LADDER_NAMES, census.LADDER_NAMES[1:]):
            self.assertTrue(all(
                not old or new for old, new in zip(flags[left], flags[right])
            ))
        self.assertTrue(flags["K_struct"][0])
        self.assertTrue(flags["K_struct"][10])
        self.assertTrue(flags["K_fail"][1])
        self.assertFalse(flags["K_hunk"][2])
        self.assertTrue(flags["K_hunk"][5])
        self.assertTrue(flags["K_nav"][7])
        self.assertFalse(flags["K_nav"][8])
        self.assertTrue(flags["K_greedy"][2])
        self.assertTrue(flags["K_greedy"][8])
        self.assertFalse(flags["K_greedy"][9])

    def test_fail_does_not_keep_loose_version_count_path_or_any_minus(self) -> None:
        for line in (
            "1.0\n",
            "3 files\n",
            "src/widget.py\n",
            "- markdown item\n",
        ):
            self.assertFalse(census.is_fail_line(line), line)
            self.assertTrue(census.is_greedy_line(line), line)

    def test_nav_is_slash_path_or_file_location_not_plain_filename(self) -> None:
        self.assertTrue(census.is_nav_line("src/widget.py\n"))
        self.assertTrue(census.is_nav_line("widget.py:42: message\n"))
        self.assertFalse(census.is_nav_line("widget.py\n"))

    def test_candidate_ceiling_splits_line_at_exact_10k_byte_boundary(self) -> None:
        item = census.Observation(
            1, "s", "c", "printf x", "a" * 10_010, True, False,
            "other", frozenset(),
        )
        result = census.keep_ladder_census([item], item.raw_bytes)
        row = result["ladders"]["K_fail"]
        self.assertEqual(row["eligible_candidate_drop_ceiling_bytes"], 10_010)
        self.assertEqual(
            row["eligible_candidate_drop_ceiling_original_first_10k_bytes"], 10_000
        )
        self.assertEqual(row["eligible_candidate_drop_ceiling_clipped_tail_bytes"], 10)

    def test_sensitive_candidate_is_descriptive_but_not_filter_eligible(self) -> None:
        item = census.Observation(
            1, "s", "c", "printf x", "payload\n", True, True,
            "other", frozenset(),
        )
        row = census.keep_ladder_census([item], item.raw_bytes)["ladders"]["K_fail"]
        self.assertEqual(row["candidate_drop_ceiling_bytes"], len("payload\n"))
        self.assertEqual(row.get("eligible_candidate_drop_ceiling_bytes", 0), 0)
        self.assertEqual(
            row["identity_excluded_candidate_ceiling_bytes"], len("payload\n")
        )


class StructuralTests(unittest.TestCase):
    def test_duplicate_failures_and_diff_hunks_are_retained(self) -> None:
        failure = "FAILED tests/x.py::test_x\n"
        self.assertEqual(
            census.collapse_nonadjacent_duplicates(failure * 4, "test").text,
            failure * 4,
        )
        hunk = "+same\n"
        self.assertEqual(
            census.collapse_nonadjacent_duplicates(hunk * 4, "git_diff").text,
            hunk * 4,
        )
        mixed = "diff --git a/x b/x\n@@ -1 +1 @@\n" + hunk * 4
        self.assertEqual(
            census.collapse_nonadjacent_duplicates(mixed, "mixed/compound").text,
            mixed,
        )

    def test_exact_repeat_keeps_endpoints_count_and_unique_context(self) -> None:
        text = "repeat\na\nrepeat\nb\nrepeat\nrepeat\n"
        candidate = census.collapse_nonadjacent_duplicates(text, "other")
        self.assertEqual(candidate.text.count("repeat\n"), 2)
        self.assertIn("2 middle occurrences", candidate.text)
        self.assertIn("a\n", candidate.text)
        self.assertIn("b\n", candidate.text)

    def test_progress_requires_four_line_run(self) -> None:
        text = "".join(f"Progress: resolved {i}\n" for i in range(5))
        candidate = census.collapse_progress(text, "other")
        self.assertEqual(candidate.omitted_lines, 3)
        self.assertIn("3 progress update lines omitted", candidate.text)

    def test_structural_stack_composes_and_still_fails_open_per_stage(self) -> None:
        repeated = ("x" * 100) + "\n"
        text = "\x1b[31mred\x1b[0m\n" + repeated * 5
        candidate = census.structural_stack(text, "other")
        self.assertLess(census.utf8_bytes(candidate.text), census.utf8_bytes(text))
        self.assertNotIn("\x1b[", candidate.text)
        self.assertIn("identical lines omitted", candidate.text)
        short = "x\n" * 3
        self.assertEqual(census.structural_stack(short, "other").text, short)


class ClassCapTests(unittest.TestCase):
    def test_source_cap_keeps_boundaries_and_failure(self) -> None:
        lines = [f"line {i}\n" for i in range(120)]
        lines[60] = "fatal: middle evidence\n"
        candidate = census.strict_candidate(
            "".join(lines), "source_dump", census.source_cap
        )
        self.assertIn(lines[0], candidate.text)
        self.assertIn(lines[39], candidate.text)
        self.assertIn(lines[60], candidate.text)
        self.assertIn(lines[-1], candidate.text)
        self.assertNotIn(lines[50], candidate.text)
        self.assertGreater(candidate.omitted_lines, 0)

    def test_listing_cap_keeps_first_50_and_late_diagnostic(self) -> None:
        lines = [f"entry {i:03}\n" for i in range(100)]
        lines[80] = "warning: late evidence\n"
        candidate = census.listing_cap("".join(lines), "listing")
        self.assertIn(lines[49], candidate.text)
        self.assertNotIn(lines[50], candidate.text)
        self.assertIn(lines[80], candidate.text)

    def test_search_counts_nonblank_match_lines(self) -> None:
        lines = [f"src/x:{i}: hit\n" for i in range(60)]
        lines.insert(2, "\n")
        candidate = census.search_cap("".join(lines), "search")
        self.assertIn("src/x:49: hit\n", candidate.text)
        self.assertNotIn("src/x:50: hit\n", candidate.text)

    def test_test_fold_keeps_pass_endpoints_failures_and_summary(self) -> None:
        text = "".join([
            "x.py::a PASSED\n",
            "x.py::b PASSED\n",
            "FAILED x.py::bad\n",
            "x.py::c PASSED\n",
            "x.py::d PASSED\n",
            "4 tests, 1 failed\n",
        ])
        candidate = census.test_pass_cap(text, "test")
        self.assertIn("x.py::a PASSED\n", candidate.text)
        self.assertIn("x.py::d PASSED\n", candidate.text)
        self.assertNotIn("x.py::b PASSED\n", candidate.text)
        self.assertIn("FAILED x.py::bad\n", candidate.text)
        self.assertIn("4 tests, 1 failed\n", candidate.text)
        self.assertEqual(candidate.omitted_lines, 2)

    def test_lock_and_install_caps_keep_required_lines(self) -> None:
        lock_lines = [f'"key{i}": {i}\n' for i in range(100)]
        lock_lines[50] = "error: malformed middle\n"
        lock = census.lockfile_cap("".join(lock_lines), "lockfile/json")
        self.assertIn(lock_lines[0], lock.text)
        self.assertIn(lock_lines[50], lock.text)
        self.assertIn(lock_lines[-1], lock.text)
        log_lines = [f"log {i}\n" for i in range(100)]
        log_lines[10] = "error: early failure\n"
        log = census.npm_log_cap("".join(log_lines), "npm/install/debug_log")
        self.assertIn(log_lines[10], log.text)
        self.assertNotIn(log_lines[20], log.text)
        self.assertIn(log_lines[-1], log.text)

    def test_marker_overhead_fails_open(self) -> None:
        text = "x\n" * 51
        self.assertEqual(
            census.strict_candidate(text, "listing", census.listing_cap).text,
            text,
        )

    def test_mixed_has_no_unique_payload_cap(self) -> None:
        self.assertNotIn("mixed/compound", census.CAP_BY_CLASS)


class ArtifactPrivacyTests(unittest.TestCase):
    def load_artifact(self) -> dict[str, object]:
        path = HERE / "results.json"
        if not path.exists():
            self.skipTest("run census.py to materialize aggregate")
        return json.loads(path.read_text(encoding="utf-8"))

    def test_artifact_accounting_and_frozen_metadata(self) -> None:
        payload = self.load_artifact()
        method = payload["method"]
        coverage = payload["coverage"]
        self.assertEqual(method["delegation_id"], census.AUTHORITATIVE_DELEGATION)
        self.assertEqual(method["study_session_excluded"], census.STUDY_SESSION)
        self.assertEqual(method["event_cutoff_ms"], census.EVENT_CUTOFF_MS)
        self.assertEqual(
            method["classifier_module_sha256"], census.sha256_file(census.REPLAY_PATH)
        )
        self.assertEqual(
            coverage["bash_bytes"],
            sum(row["bytes"] for row in payload["census"]["by_class"].values()),
        )
        ladders = payload["keep_list_sensitivity"]
        self.assertEqual(ladders["physical_line_bytes"], coverage["bash_bytes"])
        self.assertEqual(
            sum(row["bytes"] for row in ladders["disjoint_partition"].values()),
            coverage["bash_bytes"],
        )
        prior = -1
        for name in census.LADDER_NAMES:
            row = ladders["ladders"][name]
            self.assertGreaterEqual(row["bytes"], prior)
            prior = row["bytes"]
            self.assertEqual(
                row["eligible_candidate_drop_ceiling_bytes"],
                row["eligible_candidate_drop_ceiling_original_first_10k_bytes"]
                + row["eligible_candidate_drop_ceiling_clipped_tail_bytes"],
            )
        stack = payload["class_aware_caps"]["stacked"]
        self.assertEqual(
            stack["all_corpus_output_bytes"] + stack["saved_bytes"],
            coverage["bash_bytes"],
        )
        self.assertEqual(
            stack["all_corpus_output_first_10k_remaining_bytes"]
            + stack["first_10k_length_reduction_bytes"],
            coverage["first_10k_input_bytes"],
        )

    def test_persisted_aggregate_has_no_payload_keys(self) -> None:
        payload = self.load_artifact()
        method = payload["method"]
        self.assertFalse(method["full_commands_persisted"])
        self.assertFalse(method["full_result_text_persisted"])
        self.assertFalse(method["candidate_text_persisted"])
        self.assertFalse(method["excerpts_persisted"])
        forbidden = {"command", "text", "candidate", "excerpt", "records", "rows"}
        def walk(value: object) -> None:
            if isinstance(value, dict):
                self.assertTrue(forbidden.isdisjoint(value))
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(payload)


if __name__ == "__main__":
    unittest.main()
