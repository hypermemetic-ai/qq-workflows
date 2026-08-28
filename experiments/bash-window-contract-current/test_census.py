from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("bash_window_contract_census", HERE / "census.py")
assert _spec is not None and _spec.loader is not None
census = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = census
_spec.loader.exec_module(census)


class ContractTests(unittest.TestCase):
    def test_stock_identity_and_exact_threshold(self) -> None:
        under = "x" * 9_999
        self.assertEqual(census.stock_window(under).value, under)
        exact = "x" * 10_000
        stock = census.stock_window(exact)
        self.assertEqual(stock.source_projection, exact)
        self.assertEqual(stock.omitted_chars, 0)
        self.assertIn("0 chars omitted", stock.value)

    def test_stock_counts_code_points_and_keeps_head_tail(self) -> None:
        text = "H" * 5_000 + "😀" * 13 + "T" * 5_000
        stock = census.stock_window(text)
        self.assertEqual(stock.source_projection, "H" * 5_000 + "T" * 5_000)
        self.assertEqual(stock.omitted_chars, 13)
        self.assertIn("13 chars omitted", stock.value)

    def test_region_bounds_measure_the_middle_hole(self) -> None:
        self.assertEqual(census.region_bounds(10_000), {
            "head": (0, 5_000), "hole": (5_000, 5_000), "tail": (5_000, 10_000),
        })
        self.assertEqual(census.region_bounds(14_000), {
            "head": (0, 5_000), "hole": (5_000, 9_000), "tail": (9_000, 14_000),
        })

    def test_archive_normalization_does_not_recap_mini_json(self) -> None:
        mini_identity = json.dumps({"returncode": 0, "output": "x" * 9_999}, indent=2)
        identity = census.body_view(mini_identity)
        self.assertEqual(identity.stored_shape, "mini_identity_json")
        self.assertEqual(identity.original_chars, 9_999)
        self.assertEqual(identity.raw_text, "x" * 9_999)
        mini_stock = json.dumps({
            "returncode": 0, "output_head": "H" * 5_000,
            "output_tail": "T" * 5_000, "elided_chars": 123,
            "warning": "Output too long.",
        }, indent=2)
        stock = census.body_view(mini_stock)
        self.assertTrue(stock.already_windowed)
        self.assertEqual(stock.original_chars, 10_123)
        self.assertEqual(stock.omitted_chars, 123)
        malformed = json.dumps({
            "returncode": 0, "output_head": "short", "output_tail": "tail",
            "elided_chars": 123,
        })
        self.assertEqual(census.body_view(malformed).stored_shape, "raw_text")

    def test_archive_normalization_recognizes_dsh_stock(self) -> None:
        rendered = census.stock_window("H" * 5_000 + "middle" + "T" * 5_000).value
        view = census.body_view(rendered)
        self.assertEqual(view.stored_shape, "dsh_head_tail_text")
        self.assertTrue(view.already_windowed)
        self.assertEqual(view.omitted_chars, len("middle"))

    def test_c2_elides_only_structural_runs_in_place(self) -> None:
        # Blank lines and exact repeats after first occurrence are frozen K_struct.
        text = "alpha\n\nunique\nrepeat\nrepeat\nomega\n"
        lines = census.source_lines(text, "other")
        result = census.structural_elision(lines)
        projection = census.retained_projection(result, lines, text)
        self.assertEqual(projection, "alpha\nunique\nrepeat\nomega\n")
        self.assertEqual(result.omitted_runs, 2)
        self.assertEqual(result.omitted_lines, 2)
        self.assertEqual(result.omitted_chars, len("\n") + len("repeat\n"))
        self.assertLess(projection.find("unique\n"), projection.find("repeat\n"))
        self.assertTrue(census.is_subsequence(projection, text))
        self.assertIn("1 chars omitted from 1 lines", result.value)
        self.assertIn("7 chars omitted from 1 lines", result.value)

    def test_c2_accepts_only_complete_marked_document_strictly_under_cap(self) -> None:
        text = "unique\n" + "\n" * 10_100
        result = census.c2_contract(text, "other")
        self.assertTrue(result.accepted)
        self.assertFalse(result.fail_open)
        self.assertLess(result.chars, census.MAX_CHARS)
        self.assertIn("10100 chars omitted", result.value)

    def test_c2_fails_open_to_stock_on_original_without_combining(self) -> None:
        text = "".join(f"unique-{index:05d}\n" for index in range(1_000))
        self.assertGreaterEqual(len(text), census.MAX_CHARS)
        lines = census.source_lines(text, "other")
        proposed = census.structural_elision(lines)
        self.assertGreaterEqual(proposed.chars, census.MAX_CHARS)
        result = census.c2_contract(text, "other")
        self.assertTrue(result.fail_open)
        self.assertFalse(result.accepted)
        self.assertEqual(result.value, census.stock_window(text).value)
        self.assertNotIn("C2 in-place elision", result.value)

    def test_c2_exact_10000_can_complete_but_under_cap_is_identity(self) -> None:
        under = "unique\n" + "\n" * (9_999 - len("unique\n"))
        self.assertEqual(len(under), 9_999)
        identity = census.c2_contract(under, "other")
        self.assertEqual(identity.value, under)
        self.assertFalse(identity.accepted)
        exact = under + "\n"
        accepted = census.c2_contract(exact, "other")
        self.assertTrue(accepted.accepted)
        self.assertLess(accepted.chars, 10_000)

    def test_first_seen_crlf_and_ansi_payload_is_not_disposable(self) -> None:
        text = "unique CRLF payload\r\n\x1b[31munique ANSI payload\x1b[0m\n"
        lines = census.source_lines(text, "other")
        self.assertTrue(all(line.k_struct for line in lines))
        self.assertTrue(all(not line.c2_disposable for line in lines))
        proposal = census.structural_elision(lines)
        self.assertEqual(proposal.value, text)
        self.assertEqual(proposal.omitted_runs, 0)

    def test_unique_payload_is_never_disposable(self) -> None:
        text = "".join(f"payload-{index}\n" for index in range(1_100)) + "\n\n"
        lines = census.source_lines(text, "mixed/compound")
        proposal = census.structural_elision(lines)
        unique = [line for line in lines if not line.k_struct]
        self.assertTrue(all(line.index in proposal.kept for line in unique))
        self.assertEqual(
            census.retained_projection(proposal, lines, text),
            "".join(line.value for line in unique),
        )


class ArtifactTests(unittest.TestCase):
    def load(self) -> dict[str, object]:
        path = HERE / "results.json"
        if not path.exists():
            self.skipTest("run census.py to materialize aggregates")
        return json.loads(path.read_text(encoding="utf-8"))

    def test_metadata_and_accounting(self) -> None:
        payload = self.load()
        method = payload["method"]
        census_row = payload["real_window_census"]
        total = census_row["all_overflow"]
        self.assertEqual(method["delegation_id"], census.AUTHORITATIVE_DELEGATION)
        self.assertEqual(method["event_cutoff_ms"], census.value_study.EVENT_CUTOFF_MS)
        self.assertNotIn("first_10k_input_bytes", payload["coverage"])
        self.assertEqual(
            census_row["under_cap_identity_bodies"] + total["overflow_bodies"],
            payload["coverage"]["bash_bodies"],
        )
        self.assertEqual(
            total["original_chars"],
            total["head_chars"] + total["hole_chars"] + total["tail_chars"],
        )
        self.assertEqual(
            total["raw_overflow_bodies_with_signal_measurable"]
            + total["already_windowed_bodies_with_hole_signal_unavailable"],
            total["overflow_bodies"],
        )
        self.assertEqual(
            total["signal_measurable_hole_chars"]
            + total["hole_chars_with_signal_unavailable"],
            total["hole_chars"],
        )
        self.assertEqual(
            payload["contract_fidelity"]["all_overflow"]["logical_overflow_bodies"],
            total["overflow_bodies"],
        )
        partition = total["disjoint_partition"]
        self.assertEqual(
            sum(row["chars"] for row in partition.values()),
            total["signal_measurable_original_chars"],
        )
        for region in census.REGIONS:
            self.assertEqual(
                sum(row["by_region"][region]["chars"] for row in partition.values()),
                total[f"signal_measurable_{region}_chars"],
            )

    def test_contract_invariants(self) -> None:
        payload = self.load()
        fidelity = payload["contract_fidelity"]["all_overflow"]
        identity = payload["under_cap_identity_footnote"]
        self.assertEqual(fidelity["C1_source_projection_subsequence_violations"], 0)
        self.assertEqual(fidelity["C2_source_projection_subsequence_violations"], 0)
        self.assertEqual(
            fidelity["C2_accepted_bodies"] + fidelity["C2_fail_open_to_C1_bodies"],
            fidelity["raw_overflow_bodies_evaluable_for_C2"],
        )
        self.assertEqual(identity["chars_shrunk"], 0)
        self.assertEqual(identity["input_chars"], identity["C2_output_chars"])

    def test_artifact_is_aggregate_only(self) -> None:
        payload = self.load()
        method = payload["method"]
        for key in (
            "full_commands_persisted", "full_result_bodies_persisted",
            "selected_windows_persisted", "excerpts_persisted",
            "sample_identifiers_persisted", "per_observation_data_persisted",
        ):
            self.assertFalse(method[key])
        forbidden = {"command", "body", "text", "excerpt", "records", "rows", "observation_id"}
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
