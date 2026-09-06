import json
import os
import subprocess
import sys
from pathlib import Path
from .supervision import Supervisor

from smolagents import (
    ApiWebSearchTool,
    LiteLLMModel,
    LogLevel,
    Tool,
    ToolCallingAgent,
    VisitWebpageTool,
    WebSearchTool,
)

from .loop_guard import LOOP_WARNING, LoopGuard
from .recovery import DegenerationError, RetryingModel

INSTRUCTIONS = """You obtain knowledge for an architect.

The question is the user message.
Call done when you have the answer.
First sentence is the answer. Then the sources: file paths and URLs.
"""


class BraveSearchTool(ApiWebSearchTool):
    name = "brave_search"
    description = (
        "Lexical web search via Brave. Use for names, docs, APIs, exact phrases."
    )


class ExaSearchTool(WebSearchTool):
    name = "exa_search"
    description = (
        "Semantic web search via Exa. Use when you know the meaning but not the wording."
    )

    def __init__(self, max_results: int = 8):
        super().__init__(max_results=max_results, engine="exa")


class DoneTool(Tool):
    name = "done"
    description = (
        "Finished. First sentence is the answer. Then the sources: file paths and URLs."
    )
    inputs = {
        "answer": {
            "type": "string",
            "description": "The answer, then file paths and URLs.",
        }
    }
    output_type = "string"

    def forward(self, answer: str) -> str:
        return answer


class ZvecGrepSearchTool(Tool):
    name = "zvec_grep_search"
    description = (
        "Search an existing workspace index for semantic, relational, cross-file, or multi-hop evidence such as architecture, call chains, dependencies, lifecycle, data or control flow, design rationale, and comparisons. Use it when exact lookup alone cannot answer a workspace-grounded question. Results include bounded source snippets and query-group metadata; treat sufficient snippets as already-read evidence. Use zvec_grep_rg instead when exact lookup alone is sufficient. Read freshness and background_refresh from the response; when results are served_from_current_index, use them if sufficient."
    )
    inputs = {
        "root": {
            "type": "string",
            "description": "Absolute workspace root visible to the daemon.",
        },
        "query": {
            "type": "string",
            "description": "One primary hybrid-search group using natural-language or exact terms.",
            "nullable": True,
        },
    }
    output_type = "string"

    def forward(self, root: str, query: str | None = None) -> str:
        from mini_researcher.agent import official_zg
        return official_zg(self.name, {'root': root, 'query': query})



class ZvecGrepRgTool(Tool):
    name = "zvec_grep_rg"
    description = (
        "Run exhaustive, AST-enriched ripgrep across code or non-code workspace material without an index. Use it when a known word, symbol, filename, source fragment, or regex can answer the workspace-grounded question. Pass a command starting with `rg`; results are exhaustive unless a trailing `| head -N` explicitly bounds them."
    )
    inputs = {
        "root": {
            "type": "string",
            "description": "Absolute workspace root visible to the daemon. Keep this at the workspace root; scope the search with command paths or globs.",
        },
        "command": {
            "type": "string",
            "description": "The command MUST start with `rg`; it is parsed as arguments and never executed by a shell. Search is exhaustive by default; append `| head -N` only to request a bounded result set.",
        },
    }
    output_type = "string"

    def forward(self, root: str, command: str) -> str:
        from mini_researcher.agent import official_zg
        return official_zg(self.name, {'root': root, 'command': command})


def official_zg(name, arguments):
    bridge = Path(__file__).resolve().parents[4] / 'paseo-plugin' / 'host' / 'zg-call.mjs'
    completed = subprocess.run([os.environ.get('NODE', 'node'), str(bridge)], input=json.dumps({'name': name, 'arguments': arguments}), text=True, capture_output=True)
    if completed.returncode: raise RuntimeError(completed.stderr)
    return completed.stdout



def rewrite_done_tool_call(tool_call):
    """smolagents only stops on tool name final_answer with input {answer}."""
    fn = getattr(tool_call, "function", None)
    if fn is None or getattr(fn, "name", None) != "done":
        return tool_call
    args = fn.arguments
    if isinstance(args, str):
        args = json.loads(args)
    if not isinstance(args, dict) or set(args) != {'answer'} or not isinstance(args['answer'], str) or not args['answer'].strip():
        raise ValueError('done requires exactly one nonempty answer string')
    answer = args['answer']
    fn.name = "final_answer"
    fn.arguments = {"answer": answer}
    return tool_call


class ResearchAgent(ToolCallingAgent):
    def __init__(self, *args, loop_guard=None, supervisor=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.loop_guard = loop_guard or LoopGuard()
        self.supervisor = supervisor
        self.invalid_completions = 0

    def process_tool_calls(self, chat_message, memory_step):
        for call in chat_message.tool_calls or []:
            if call.function.name == "final_answer": raise ValueError("call done to complete research")
            try:
                rewrite_done_tool_call(call)
            except (ValueError, TypeError) as error:
                self.invalid_completions += 1
                if self.supervisor: self.supervisor.call('repair')
                if self.invalid_completions > 1: raise RuntimeError('output repair exhausted') from error
                # Keep malformed done unmodified so normal smol tool feedback requests repair.
                call.function.name = 'invalid_done'
                call.function.arguments = {'error': str(error)}
        return super().process_tool_calls(chat_message, memory_step)

    def execute_tool_call(self, tool_name, arguments):
        args = arguments or {}
        self.loop_guard.check_before(tool_name, args)
        if self.supervisor and self.supervisor.call('loop_before', value={'name': tool_name, 'args': args})['action'] == 'stop':
            raise DegenerationError(action=tool_name, occurrences=6)
        try:
            result = super().execute_tool_call(tool_name, arguments)
        except DegenerationError:
            raise
        except Exception as error:
            decision = self.loop_guard.observe(tool_name, args, result=str(error))
            if decision["action"] == "stop":
                raise DegenerationError(action=str(tool_name), occurrences=decision["occurrences"]) from error
            raise
        raw = result
        if isinstance(raw, str) and len(raw) > 16000:
            import hashlib
            artifact = Path(os.environ.get('PASEO_HOME', str(Path.home() / '.paseo'))) / 'architect' / 'artifacts' / (hashlib.sha256(raw.encode()).hexdigest() + '.txt')
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text(raw)
            raw = raw[:8000] + f'\n[Output bounded; full diagnostic: {artifact}; narrow the query or use an explicit result bound.]\n' + raw[-8000:]
        decision = self.loop_guard.observe(tool_name, args, result=raw)
        if self.supervisor: decision = self.supervisor.call("loop", value={"name": tool_name, "args": args, "result": raw})
        if decision["action"] == "stop":
            raise DegenerationError(action=str(tool_name), occurrences=decision["occurrences"])
        if decision["action"] == "warn":
            return f"{raw}\n\n{LOOP_WARNING}"
        return raw


def build_tools(env=None):
    env = os.environ if env is None else env
    tools = []
    if env.get("BRAVE_API_KEY"):
        tools.append(BraveSearchTool(params={"count": 8}))
    if env.get("EXA_API_KEY"):
        tools.append(ExaSearchTool(max_results=8))
    if not tools:
        raise RuntimeError("set BRAVE_API_KEY and/or EXA_API_KEY")
    tools.append(VisitWebpageTool(max_output_length=12_000))
    tools.append(ZvecGrepSearchTool())
    tools.append(ZvecGrepRgTool())
    tools.append(DoneTool())
    return tools


def build_agent(env=None):
    env = os.environ if env is None else env
    model_id = "xai/grok-4.6"
    kwargs = {"reasoning_effort": "high"}
    inner = LiteLLMModel(model_id=model_id, retry=False, num_retries=0, **kwargs)
    supervisor = Supervisor().start() if env.get("ARCHITECT_HOST") else None
    return ResearchAgent(
        tools=build_tools(env),
        model=RetryingModel(inner, supervisor=supervisor),
        supervisor=supervisor,
        instructions=INSTRUCTIONS,
        max_steps=sys.maxsize,
        verbosity_level=LogLevel.OFF,
    )


def run_research(question: str, env=None):
    question = str(question or "").strip()
    if not question:
        raise ValueError("question is empty")
    agent = build_agent(env)
    return agent.run(question)
