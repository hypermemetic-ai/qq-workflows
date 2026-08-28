"""Tests for the inspect-only bash window-value census."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("bash_window_census", HERE / "census.py")
assert SPEC and SPEC.loader
census = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = census
SPEC.loader.exec_module(census)


class ImportedMethodTests(unittest.TestCase):
    def test_classifier_and_ladders_are_imported(self) -> None:
        self.assertIs(census.source_lines.__globals__["opportunity"], census.opportunity)
        self.assertEqual(census.BASH_CLASSES, tuple(census.opportunity.frozen.BASH_CLASSES))
        flags = census.opportunity.ladder_flags(
            ["\n", "error: bad\n", "@@ -1 +1 @@\n", "+new\n", "x.py:2: here\n"],
            "other",
        )
        self.assertTrue(flags["K_struct"][0])
        self.assertTrue(flags["K_fail"][1])
        self.assertTrue(flags["K_hunk"][3])
        self.assertTrue(flags["K_nav"][4])

    def test_frozen_delegation_snapshot(self) -> None:
        self.assertEqual(census.EVENT_CUTOFF_MS, 1787925121608)
        self.assertEqual(
            census.STUDY_SESSION,
            "session-676456e0-e1b6-4b74-a066-bd044f1bdacf",
        )
        self.assertEqual(
            census.AUTHORITATIVE_DELEGATION,
            "f9a65065-efd7-4d72-a7b2-ba3b02b4655e",
        )


class ProvenanceTests(unittest.TestCase):
    def test_exact_10000_boundary_can_split_a_physical_line(self) -> None:
        lines = census.source_lines("a" * 9998 + "éx\n" + "tail\n", "other")
        self.assertEqual(lines[0].size, 10002)
        self.assertEqual(lines[0].prefix_bytes, 10000)
        self.assertEqual(lines[0].tail_bytes, 2)
        self.assertEqual(lines[1].prefix_bytes, 0)
        self.assertEqual(lines[1].tail_bytes, 5)

    def test_disjoint_categories_partition_every_line(self) -> None:
        lines = census.source_lines(
            "\nerror: bad\n@@ -1 +1 @@\n+new\nsrc/x.py:2: nav\nunique\n",
            "other",
        )
        for line in lines:
            categories = (
                line.k_struct,
                line.fail_increment,
                line.hunk_increment,
                line.nav_increment,
                line.leftover_unique,
            )
            self.assertEqual(sum(categories), 1)

    def test_visible_tail_provenance_survives_reordering(self) -> None:
        value = "context\n" * 1300 + "FAILED tail_case\n"
        lines = census.source_lines(value, "test")
        selected = census.evidence_first(lines, "test")
        visible = census.visible_metrics(selected)
        self.assertGreater(visible["tail_failure_increment_bytes"], 0)
        self.assertLessEqual(selected.size, census.ENVELOPE_BYTES)


class PolicyConstructionTests(unittest.TestCase):
    def test_evidence_first_prioritizes_tail_and_has_exact_marker(self) -> None:
        value = "context line\n" * 1000 + "FAILED late\n"
        lines = census.source_lines(value, "test")
        selected = census.evidence_first(lines, "test")
        self.assertTrue(selected.value.startswith("FAILED late\n"))
        self.assertIn(
            f"[... {selected.omitted_lines} lines omitted by evidence-first pack ...]",
            selected.value,
        )
        self.assertLessEqual(selected.size, census.ENVELOPE_BYTES)

    def test_evidence_first_adds_hunks_only_after_observed_diff(self) -> None:
        before = census.source_lines("+ list item\n" + "x\n" * 6000, "other")
        self.assertFalse(before[0].hunk_increment)
        observed = census.source_lines(
            "x\n" * 5100 + "diff --git a/x b/x\n@@ -1 +1 @@\n+new\n",
            "other",
        )
        self.assertTrue(observed[-1].hunk_increment)
        packed = census.evidence_first(observed, "other")
        self.assertTrue(packed.value.startswith("diff --git"))
        self.assertIn("+new\n", packed.value)

    def test_head_tail_keeps_endpoints_and_middle_failure(self) -> None:
        values = [f"line {i}\n" for i in range(120)]
        values[60] = "fatal: middle evidence\n"
        lines = census.source_lines("".join(values), "source_dump")
        selected = census.head_tail(lines, "source_dump")
        self.assertIn(values[0], selected.value)
        self.assertIn(values[39], selected.value)
        self.assertIn(values[60], selected.value)
        self.assertIn(values[-1], selected.value)
        self.assertNotIn(values[50], selected.value)

    def test_listing_search_keeps_first_50_and_late_failure(self) -> None:
        values = [f"entry {i:03}\n" for i in range(100)]
        values[80] = "warning: late\n"
        selected = census.listing_search(
            census.source_lines("".join(values), "listing"), "listing"
        )
        self.assertIn(values[49], selected.value)
        self.assertNotIn(values[50], selected.value)
        self.assertIn(values[80], selected.value)
        self.assertEqual(selected.omitted_lines, 49)

    def test_test_fold_keeps_global_pass_endpoints_and_all_nonpass_output(self) -> None:
        values = [f"x.py::t{i} PASSED\n" for i in range(5)]
        values += ["FAILED x.py::bad\n"]
        values += [f"x.py::u{i} PASSED\n" for i in range(3)]
        values += ["9 tests, 1 failed\n"]
        selected = census.test_fold(
            census.source_lines("".join(values), "test"), "test"
        )
        self.assertIn(values[0], selected.value)
        self.assertNotIn(values[1], selected.value)
        self.assertNotIn(values[4], selected.value)
        self.assertIn("x.py::u2 PASSED\n", selected.value)
        self.assertIn("FAILED x.py::bad\n", selected.value)
        # Recognized pass lines are folded across the whole test body.
        self.assertNotIn("x.py::u1 PASSED\n", selected.value)
        self.assertIn("9 tests, 1 failed\n", selected.value)
        self.assertEqual(selected.omitted_lines, 6)


class AcceptanceTests(unittest.TestCase):
    class Item:
        def __init__(self, value: str, cls: str = "other", eligible: bool = True):
            self.text = value
            self.cls = cls
            self.eligible = eligible
            self.raw_bytes = census.utf8_bytes(value)

    def test_every_under_10k_body_is_identity(self) -> None:
        item = self.Item("FAILED still identity\n" + "x\n" * 100)
        lines = census.source_lines(item.text, item.cls)
        for builder in (
            census.evidence_first,
            census.head_tail,
            census.listing_search,
            census.test_fold,
            census.class_aware,
        ):
            selected = census.select_for_observation(item, lines, builder)
            self.assertEqual(selected.value, item.text)
            self.assertFalse(selected.accepted)

    def test_sensitive_overflow_is_identity(self) -> None:
        item = self.Item("x\n" * 6000 + "FAILED tail\n", "test", eligible=False)
        lines = census.source_lines(item.text, item.cls)
        selected = census.select_for_observation(item, lines, census.evidence_first)
        self.assertEqual(selected.value, item.text)
        self.assertFalse(selected.accepted)

    def test_complete_selected_result_is_strictly_useful(self) -> None:
        item = self.Item("x\n" * 6000)
        lines = census.source_lines(item.text, item.cls)
        selected = census.select_for_observation(item, lines, census.evidence_first)
        self.assertTrue(selected.accepted)
        self.assertLessEqual(selected.size, census.ENVELOPE_BYTES)

    def test_overflow_proposal_without_density_gain_fails_open(self) -> None:
        value = "z" * 11000 + "\n" + "tail\n"
        item = self.Item(value, "source_dump")
        lines = census.source_lines(value, item.cls)
        selected = census.select_for_observation(item, lines, census.head_tail)
        self.assertEqual(selected.value, value)
        self.assertTrue(selected.fail_open)

    def test_class_aware_never_uses_source_cap_for_mixed(self) -> None:
        value = "context\n" * 1300 + "FAILED late\n"
        mixed = self.Item(value, "mixed/compound")
        lines = census.source_lines(value, mixed.cls)
        direct = census.evidence_first(lines, mixed.cls)
        routed = census.class_aware(lines, mixed.cls)
        self.assertEqual(routed.value, direct.value)


class ArtifactTests(unittest.TestCase):
    def load_artifact(self) -> dict[str, object]:
        path = HERE / "results.json"
        if not path.exists():
            self.skipTest("run census.py to materialize aggregates")
        return json.loads(path.read_text(encoding="utf-8"))

    def test_accounting_identity_and_metadata(self) -> None:
        payload = self.load_artifact()
        method = payload["method"]
        overflow = payload["overflow_census"]["all_bash"]
        footnote = payload["under_10k_identity_footnote"]
        self.assertEqual(method["delegation_id"], census.AUTHORITATIVE_DELEGATION)
        self.assertEqual(method["event_cutoff_ms"], census.EVENT_CUTOFF_MS)
        self.assertEqual(method["study_session_excluded"], census.STUDY_SESSION)
        self.assertEqual(
            method["scanner_and_ladders_sha256"],
            census.sha256_file(census.OPPORTUNITY_PATH),
        )
        self.assertEqual(
            overflow["overflow_bodies"] + overflow["already_complete_bodies"],
            payload["coverage"]["bash_bodies"],
        )
        self.assertEqual(
            payload["overflow_census"]["bodies_10001_through_10240_bytes"]
            + payload["overflow_census"]["bodies_greater_than_10KiB"],
            overflow["overflow_bodies"],
        )
        self.assertEqual(
            payload["overflow_census"]["bodies_greater_than_100000_bytes"], 0
        )
        self.assertEqual(
            payload["overflow_census"]["bodies_greater_than_100KiB"], 0
        )
        self.assertEqual(footnote["byte_shrink"], 0)
        self.assertEqual(footnote["input_bytes"], footnote["selected_bytes"])
        for policy in payload["window_policies"].values():
            totals = policy["all_overflow"]
            self.assertEqual(
                totals["overflow_reduction_bodies"],
                totals["overflow_before"] - totals["overflow_after"],
            )
            self.assertEqual(
                totals["completed_selected_reads"],
                totals["overflow_reduction_bodies"],
            )

    def test_signal_partition_and_clipped_evidence(self) -> None:
        payload = self.load_artifact()
        signal = payload["signal_location"]
        partition = signal["disjoint_partition"]
        self.assertEqual(
            sum(row["bytes"] for row in partition.values()),
            payload["coverage"]["bash_bytes"],
        )
        self.assertEqual(
            sum(row["tail_bytes"] for row in partition.values()),
            payload["overflow_census"]["all_bash"]["clipped_tail_bytes"],
        )
        for row in partition.values():
            self.assertEqual(row["bytes"], row["prefix_bytes"] + row["tail_bytes"])

    def test_persisted_artifact_has_aggregate_data_only(self) -> None:
        payload = self.load_artifact()
        method = payload["method"]
        self.assertFalse(method["full_commands_persisted"])
        self.assertFalse(method["full_result_bodies_persisted"])
        self.assertFalse(method["selected_windows_persisted"])
        self.assertFalse(method["excerpts_persisted"])
        self.assertFalse(method["per_observation_data_persisted"])
        forbidden = {
            "command", "body", "text", "candidate", "excerpt", "records", "rows",
        }
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
