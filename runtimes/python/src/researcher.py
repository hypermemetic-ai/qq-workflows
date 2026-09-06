import argparse
import signal
import threading
import traceback
from contextlib import redirect_stdout
import json
import os
import subprocess
import sys
from pathlib import Path
from shared.supervision import Supervisor

from smolagents import (
    ApiWebSearchTool,
    LiteLLMModel,
    LogLevel,
    Tool,
    ToolCallingAgent,
    VisitWebpageTool,
    WebSearchTool,
)

from shared.loop_guard import LOOP_WARNING, LoopGuard
from shared.recovery import DegenerationError, RetryingModel, HEARTBEAT_LINE, failure_details

INSTRUCTIONS = """You obtain knowledge for an architect.

The question is the user message.
Call done when you have the answer.
First sentence is the answer. Then the sources: file paths and URLs.

Diagnostic tools are for investigation only: focused tests, reproductions, temporary scripts, and isolated scratch services. Do not repair project code or mutate the normal runtime, shared configuration, or workflow job state. Do not create workflow-agent children. Preserve HOME and credentials; do not print secrets. Command execution is role-governed, not a sandbox. Scratch directories and a separate PASEO_HOME reduce accidents; they do not isolate shared files or services. run_command is a foreground shell (`/bin/bash -c`) with a 120-second default timeout and a 600-second maximum. start_service, service_status, and stop_service manage job-local services with stable IDs; do not background processes in the shell. Services last at most their lifetime and are torn down when research ends. Launch success is not readiness: report both. Bounded evidence is retained separately from disposable scratch state.
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


class RunCommandTool(Tool):
    name = "run_command"
    description = (
        "Run a foreground diagnostic shell command with `/bin/bash -c`. Default cwd is this research job's scratch work directory. Default timeout is 120 seconds, maximum 600. Returns exit status, timeout/truncation flags, bounded stdout/stderr, artifact paths for retained evidence, and cleanup failures. Isolated PASEO_HOME is applied to the subprocess; HOME and credentials remain available. Do not repair project code or mutate the normal runtime."
    )
    inputs = {
        "command": {
            "type": "string",
            "description": "Shell command executed as `/bin/bash -c command`.",
        },
        "cwd": {
            "type": "string",
            "description": "Working directory. Defaults to the job scratch work directory.",
            "nullable": True,
        },
        "timeout_seconds": {
            "type": "integer",
            "description": "Foreground timeout in seconds. Default 120, maximum 600.",
            "nullable": True,
        },
    }
    output_type = "string"

    def forward(self, command: str, cwd: str | None = None, timeout_seconds: int | None = None) -> str:
        from shared.diagnostics import run_diagnostic_command
        return run_diagnostic_command(command, cwd=cwd, timeout_seconds=timeout_seconds)


class StartServiceTool(Tool):
    name = "start_service"
    description = (
        "Start a managed diagnostic service in this research job. Explicit start/status/stop; do not background in the shell. Launch and readiness are distinct. Default lifetime 300 seconds, maximum 1800. Isolated PASEO_HOME applies to the subprocess; HOME and credentials remain available. Tracked process groups are best-effort, not comprehensive descendant containment."
    )
    inputs = {
        "command": {
            "type": "string",
            "description": "Shell command executed as `/bin/bash -c command` for the service process.",
        },
        "service_id": {
            "type": "string",
            "description": "Optional stable job-local ID. Generated when omitted.",
            "nullable": True,
        },
        "cwd": {
            "type": "string",
            "description": "Working directory. Defaults to the job scratch work directory.",
            "nullable": True,
        },
        "ready_url": {
            "type": "string",
            "description": "Optional HTTP URL polled until ready or ready_timeout_seconds elapses. Launch can succeed without readiness.",
            "nullable": True,
        },
        "endpoint": {
            "type": "string",
            "description": "Optional observed endpoint to record (for example host:port).",
            "nullable": True,
        },
        "ready_timeout_seconds": {
            "type": "integer",
            "description": "Seconds to wait for ready_url. Default 30, maximum 120.",
            "nullable": True,
        },
        "lifetime_seconds": {
            "type": "integer",
            "description": "Finite service lifetime in seconds. Default 300, maximum 1800.",
            "nullable": True,
        },
    }
    output_type = "string"

    def forward(
        self,
        command: str,
        service_id: str | None = None,
        cwd: str | None = None,
        ready_url: str | None = None,
        endpoint: str | None = None,
        ready_timeout_seconds: int | None = None,
        lifetime_seconds: int | None = None,
    ) -> str:
        from shared.diagnostics import start_diagnostic_service
        return start_diagnostic_service(
            command,
            service_id=service_id,
            cwd=cwd,
            ready_url=ready_url,
            endpoint=endpoint,
            ready_timeout_seconds=ready_timeout_seconds,
            lifetime_seconds=lifetime_seconds,
        )


class ServiceStatusTool(Tool):
    name = "service_status"
    description = (
        "Report job-local managed diagnostic services. Omit service_id for all services. Distinguishes launched vs ready, remaining lifetime, endpoints, and cleanup failures."
    )
    inputs = {
        "service_id": {
            "type": "string",
            "description": "Optional service ID. When omitted, list all job-local services.",
            "nullable": True,
        },
    }
    output_type = "string"

    def forward(self, service_id: str | None = None) -> str:
        from shared.diagnostics import diagnostic_service_status
        return diagnostic_service_status(service_id=service_id)


class StopServiceTool(Tool):
    name = "stop_service"
    description = (
        "Stop a managed diagnostic service with SIGTERM then SIGKILL on its tracked process group. Omit service_id to stop all job-local services. Reports cleanup failures honestly. Does not target the normal runtime."
    )
    inputs = {
        "service_id": {
            "type": "string",
            "description": "Optional service ID. When omitted, stop all job-local services.",
            "nullable": True,
        },
    }
    output_type = "string"

    def forward(self, service_id: str | None = None) -> str:
        from shared.diagnostics import stop_diagnostic_service
        return stop_diagnostic_service(service_id=service_id)


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
        from researcher import official_zg
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
        from researcher import official_zg
        return official_zg(self.name, {'root': root, 'command': command})


def official_zg(name, arguments):
    bridge = Path(__file__).resolve().parents[3] / 'paseo-plugin' / 'host' / 'zg-call.mjs'
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
    tools.append(RunCommandTool())
    tools.append(StartServiceTool())
    tools.append(ServiceStatusTool())
    tools.append(StopServiceTool())
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



def _heartbeat(stop):
    while not stop.wait(10):
        print(HEARTBEAT_LINE, file=sys.stderr, flush=True)


def _install_signal_handlers(stop):
    def handle(signum, _frame):
        stop.set()
        from shared.diagnostics import get_session, shutdown_diagnostics
        get_session().request_cancel(f"signal {signum}")
        shutdown_diagnostics()
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Short bounded fact-finder. Prints the answer and exits.",
    )
    parser.add_argument("question", nargs="?", help="The exact question to answer")
    args = parser.parse_args(argv)
    question = args.question or sys.stdin.read()
    stop = threading.Event()
    _install_signal_handlers(stop)
    beat = threading.Thread(target=_heartbeat, args=(stop,), daemon=True)
    beat.start()
    try:
        with redirect_stdout(sys.stderr):
            answer = run_research(question)
        if not isinstance(answer, str) or not answer.strip(): raise ValueError("invalid completion: empty answer")
        envelope = {"version": 1, "kind": "research_completion", "ok": True, "answer": answer}
        code = 0
    except Exception as error:
        details = failure_details(error)
        details['traceback'] = ''.join(traceback.format_tb(error.__traceback__))[-16000:]
        envelope = {'version': 1, 'kind': 'research_completion', 'ok': False, 'error': details}
        traceback.print_exc(file=sys.stderr)
        code = 1
    finally:
        stop.set()
        from shared.diagnostics import shutdown_diagnostics
        try:
            cleanup = shutdown_diagnostics()
        except Exception as error:
            cleanup = {'cleanup_failures': [str(error)]}
    if cleanup.get('cleanup_failures'):
        warning = 'Diagnostic cleanup incomplete: ' + '; '.join(cleanup['cleanup_failures'])
        envelope['cleanup'] = cleanup
        if envelope['ok']:
            envelope['answer'] += '\n\n' + warning
        else:
            envelope['error']['message'] += '\n' + warning
    print(json.dumps(envelope, ensure_ascii=False), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
