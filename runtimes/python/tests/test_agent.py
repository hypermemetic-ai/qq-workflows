import json
import unittest

from researcher import (
    INSTRUCTIONS,
    BraveSearchTool,
    DoneTool,
    ExaSearchTool,
    ZvecGrepRgTool,
    ZvecGrepSearchTool,
    build_agent,
    build_tools,
    rewrite_done_tool_call,
    run_research,
)
from shared.loop_guard import LOOP_WARNING, LoopGuard
from shared.recovery import (
    PermanentError,
    RecoveryExhausted,
    RetryingModel,
    classify_failure,
    summarize_failure,
)


class BuildToolsTests(unittest.TestCase):
    def test_requires_a_search_key(self):
        with self.assertRaises(RuntimeError) as raised:
            build_tools(env={})
        self.assertIn("BRAVE_API_KEY", str(raised.exception))

    def test_brave_only(self):
        names = [tool.name for tool in build_tools(env={"BRAVE_API_KEY": "x"})]
        self.assertEqual(
            names,
            ["brave_search", "visit_webpage", "zvec_grep_search", "zvec_grep_rg", "done"],
        )

    def test_exa_only(self):
        names = [tool.name for tool in build_tools(env={"EXA_API_KEY": "x"})]
        self.assertEqual(
            names,
            ["exa_search", "visit_webpage", "zvec_grep_search", "zvec_grep_rg", "done"],
        )

    def test_both_search_tools_keep_distinct_names(self):
        names = [
            tool.name
            for tool in build_tools(env={"BRAVE_API_KEY": "x", "EXA_API_KEY": "y"})
        ]
        self.assertEqual(
            names,
            [
                "brave_search",
                "exa_search",
                "visit_webpage",
                "zvec_grep_search",
                "zvec_grep_rg",
                "done",
            ],
        )
        self.assertEqual(len(set(names)), 6)

    def test_tool_classes(self):
        self.assertEqual(BraveSearchTool.name, "brave_search")
        self.assertEqual(ExaSearchTool.name, "exa_search")
        self.assertEqual(DoneTool.name, "done")
        self.assertEqual(ZvecGrepSearchTool.name, "zvec_grep_search")
        self.assertEqual(ZvecGrepRgTool.name, "zvec_grep_rg")


class AgentConfigTests(unittest.TestCase):
    def test_empty_question(self):
        with self.assertRaises(ValueError):
            run_research("  ")

    def test_instructions_match_the_locked_prompt(self):
        self.assertIn("The question is the user message.", INSTRUCTIONS)
        self.assertIn("Call done when you have the answer.", INSTRUCTIONS)
        self.assertNotIn("final_answer", INSTRUCTIONS)
        self.assertNotIn("Do not recommend", INSTRUCTIONS)
        self.assertIn("file paths and URLs", INSTRUCTIONS)

    def test_no_step_budget(self):
        import sys
        from smolagents import LogLevel
        agent = build_agent(env={"BRAVE_API_KEY": "x"})
        self.assertEqual(agent.max_steps, sys.maxsize)
        self.assertEqual(agent.logger.level, LogLevel.OFF)
        self.assertIsInstance(agent.model, RetryingModel)


class RecoveryTests(unittest.TestCase):
    def test_classifies_provider_timeout(self):
        self.assertEqual(classify_failure("httpx.ReadTimeout timeout after 600.0 seconds"), "transient")
        self.assertEqual(
            summarize_failure("XaiException: timeout after 600.0 seconds"),
            "ReadTimeout at the provider's 600.0-second timeout",
        )
        self.assertEqual(classify_failure("set BRAVE_API_KEY"), "permanent")

    def test_classifies_max_prompt_as_permanent(self):
        err = (
            "Error while generating output: litellm.BadRequestError: XaiException - "
            '{"code":"invalid-argument","error":"This model\'s maximum prompt length is 2 million tokens"}'
        )
        self.assertEqual(classify_failure(err), "permanent")
        self.assertEqual(
            summarize_failure(err),
            "This model's maximum prompt length is 2 million tokens",
        )

    def test_retrying_model_does_not_retry_bad_request(self):
        class Inner:
            def __init__(self):
                self.calls = 0

            def generate(self, *_args, **_kwargs):
                self.calls += 1
                raise RuntimeError(
                    'litellm.BadRequestError: XaiException - {"code":"invalid-argument",'
                    '"error":"This model\'s maximum prompt length is 2 million tokens"}'
                )

        inner = Inner()
        model = RetryingModel(inner, sleep=lambda _s: None, rng=lambda: 0)
        with self.assertRaises(PermanentError):
            model.generate([])
        self.assertEqual(inner.calls, 1)

    def test_retrying_model_retries_transient(self):
        class Inner:
            def __init__(self):
                self.calls = 0

            def generate(self, *_args, **_kwargs):
                self.calls += 1
                if self.calls < 3:
                    raise RuntimeError("HTTP 500 Internal error during token generation")
                return type("Msg", (), {"content": "ok", "tool_calls": None})()

        inner = Inner()
        model = RetryingModel(inner, sleep=lambda _s: None, rng=lambda: 0)
        result = model.generate([])
        self.assertEqual(result.content, "ok")
        self.assertEqual(inner.calls, 3)

    def test_retrying_model_exhausts(self):
        class Inner:
            def generate(self, *_args, **_kwargs):
                raise RuntimeError("HTTP 500 Internal error during token generation")

        model = RetryingModel(Inner(), sleep=lambda _s: None, rng=lambda: 0)
        with self.assertRaises(RecoveryExhausted) as raised:
            model.generate([])
        self.assertEqual(raised.exception.attempts, ["HTTP 500", "HTTP 500", "HTTP 500"])


class LoopGuardTests(unittest.TestCase):
    def test_warns_then_stops_identical_actions(self):
        from shared.recovery import DegenerationError

        guard = LoopGuard()
        for _ in range(3):
            decision = guard.observe("search", {"q": "x"}, result="none")
        self.assertEqual(decision["action"], "warn")
        self.assertIn("three times", LOOP_WARNING)
        with self.assertRaises(DegenerationError):
            for _ in range(3):
                guard.check_before("search", {"q": "x"})
                guard.observe("search", {"q": "x"}, result="none")


class DoneRewriteTests(unittest.TestCase):
    def test_done_becomes_final_answer_with_only_answer(self):
        class Fn:
            def __init__(self):
                self.name = "done"
                self.arguments = {"answer": "ACP is a protocol."}

        class Call:
            def __init__(self):
                self.function = Fn()

        call = Call()
        rewrite_done_tool_call(call)
        self.assertEqual(call.function.name, "final_answer")
        self.assertEqual(call.function.arguments, {"answer": "ACP is a protocol."})


class CliTests(unittest.TestCase):
    def test_stdin_when_no_argv_question(self):
        from io import StringIO
        from unittest.mock import patch

        import researcher as cli

        with patch("researcher.run_research", return_value="ok") as run, \
             patch("sys.stdin", StringIO("from stdin\n")), \
             patch("sys.stdout", new_callable=StringIO) as out:
            rc = cli.main([])
        self.assertEqual(rc, 0)
        run.assert_called_once_with("from stdin\n")
        self.assertEqual(json.loads(out.getvalue()), {"version": 1, "kind": "research_completion", "ok": True, "answer": "ok"})

    def test_argv_question_wins(self):
        from io import StringIO
        from unittest.mock import patch

        import researcher as cli

        with patch("researcher.run_research", return_value="ok") as run, \
             patch("sys.stdin", StringIO("from stdin\n")), \
             patch("sys.stdout", new_callable=StringIO):
            rc = cli.main(["from argv"])
        self.assertEqual(rc, 0)
        run.assert_called_once_with("from argv")


if __name__ == "__main__":
    unittest.main()
