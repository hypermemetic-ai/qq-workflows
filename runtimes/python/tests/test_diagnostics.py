import json
import os
import signal
import socket
import threading
import time
from pathlib import Path

import pytest
from smolagents.tool_validation import validate_tool_attributes

from researcher import (
    RunCommandTool,
    ServiceStatusTool,
    StartServiceTool,
    StopServiceTool,
    build_agent,
    build_tools,
)
from shared.diagnostics import (
    DISK_STREAM_LIMIT,
    FOREGROUND_TIMEOUT_DEFAULT,
    FOREGROUND_TIMEOUT_MAX,
    DiagnosticSession,
    set_session,
    shutdown_diagnostics,
    unused_free_port,
)


@pytest.fixture
def session(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PASEO_HOME", str(tmp_path / "paseo"))
    monkeypatch.setenv("PASEO_HOST", "127.0.0.1:3083")
    monkeypatch.setenv("ARCHITECT_HOST", "http://127.0.0.1:43903")
    monkeypatch.setenv("ARCHITECT_JOB_ID", "job-diag-1")
    monkeypatch.setenv("ARCHITECT_ZG_LISTEN", "127.0.0.1:9")
    (tmp_path / "home").mkdir()
    (tmp_path / "paseo").mkdir()
    parent_home = os.environ["PASEO_HOME"]
    sess = DiagnosticSession(
        evidence_dir=tmp_path / "evidence",
        disk_stream_limit=64 * 1024,
        term_grace=0.4,
        kill_grace=0.4,
    )
    previous = set_session(sess)
    yield sess
    set_session(previous)
    sess.shutdown()
    assert os.environ["PASEO_HOME"] == parent_home
    assert os.environ["PASEO_HOST"] == "127.0.0.1:3083"
    assert os.environ["ARCHITECT_HOST"] == "http://127.0.0.1:43903"


def _payload(raw):
    return json.loads(raw)


def test_diagnostic_tools_pass_smolagents_validation():
    import smolagents

    assert smolagents.__version__ == "1.26.0"
    for cls in (RunCommandTool, StartServiceTool, ServiceStatusTool, StopServiceTool):
        validate_tool_attributes(cls)
        payload = cls().to_dict()
        assert payload["name"] == cls.name
        assert "from shared.diagnostics import" in payload["code"]


def test_build_tools_includes_diagnostic_names():
    names = [tool.name for tool in build_tools(env={"BRAVE_API_KEY": "x"})]
    assert names == [
        "brave_search",
        "visit_webpage",
        "zvec_grep_search",
        "zvec_grep_rg",
        "run_command",
        "start_service",
        "service_status",
        "stop_service",
        "done",
    ]
    agent = build_agent(env={"BRAVE_API_KEY": "x"})
    for name in ("run_command", "start_service", "service_status", "stop_service"):
        assert name in agent.tools
        assert agent.tools[name].to_dict()["name"] == name


def test_run_command_shell_timeout_and_isolation(session):
    result = _payload(
        session.run_command("echo $PASEO_HOME; echo host=$PASEO_HOST; echo architect=$ARCHITECT_HOST; echo HOME=$HOME")
    )
    assert result["ok"] is True
    assert result["exit_status"] == 0
    assert result["shell"] == "/bin/bash -c"
    assert result["timed_out"] is False
    assert result["cwd"] == session.scratch_work
    assert session.scratch_paseo_home in result["stdout"]
    assert os.environ["PASEO_HOME"] not in result["stdout"]
    assert "host=\n" in result["stdout"] or "host=\r\n" in result["stdout"] or result["stdout"].split("host=")[1].startswith("\n")
    assert os.environ["HOME"] in result["stdout"]
    assert os.environ["PASEO_HOST"] == "127.0.0.1:3083"
    assert os.environ["ARCHITECT_HOST"] == "http://127.0.0.1:43903"

    timed = _payload(session.run_command("sleep 5", timeout_seconds=1))
    assert timed["timed_out"] is True
    assert timed["ok"] is False
    assert timed["timeout_seconds"] == 1
    assert timed["exit_status"] not in (0,)
    assert Path(session.scratch_work).exists()

    clamped = _payload(session.run_command("true", timeout_seconds=10_000))
    assert clamped["timeout_seconds"] == FOREGROUND_TIMEOUT_MAX
    assert clamped["timeout_clamped"] is True
    assert FOREGROUND_TIMEOUT_DEFAULT == 120


def test_run_command_output_saturation_retains_artifact(session):
    result = _payload(session.run_command("python3 -c 'print(\"x\"*200000)'"))
    assert result["truncated"] is True
    assert result["stdout_artifact"]
    artifact = Path(result["stdout_artifact"])
    assert artifact.exists()
    assert artifact.stat().st_size > 1000
    session.shutdown()
    assert artifact.exists()
    assert session.scratch_root is None or not Path(session.scratch_root).exists()


def test_service_across_commands_and_unrelated_failure(session):
    port = unused_free_port()
    ready = f"http://127.0.0.1:{port}/"
    started = _payload(
        session.start_service(
            f"python3 -m http.server {port} --bind 127.0.0.1",
            service_id="web",
            ready_url=ready,
            endpoint=f"127.0.0.1:{port}",
            ready_timeout_seconds=5,
            lifetime_seconds=30,
        )
    )
    assert started["ok"] is True
    assert started["service_id"] == "web"
    assert started["launched"] is True
    assert started["ready"] is True
    assert started["readiness"] == "ready"
    assert started["endpoint"] == f"127.0.0.1:{port}"

    failed = _payload(session.run_command("false"))
    assert failed["ok"] is False
    status = _payload(session.service_status("web"))
    assert status["services"][0]["state"] in {"ready", "running"}
    assert status["services"][0]["pid"]

    stopped = _payload(session.stop_service("web"))
    assert stopped["state"] == "stopped"
    assert stopped["ready"] is False


def test_service_launch_without_readiness(session):
    started = _payload(
        session.start_service("sleep 8", service_id="sleeper", lifetime_seconds=20)
    )
    assert started["launched"] is True
    assert started["ready"] is False
    assert started["readiness"] == "launched"
    session.stop_service("sleeper")


def test_cleanup_on_timeout_and_shutdown(session, tmp_path):
    marker = tmp_path / "still"
    timed = _payload(session.run_command(f"sleep 8; echo survived > '{marker}'", timeout_seconds=1))
    assert timed["timed_out"] is True
    time.sleep(0.2)
    assert not marker.exists()
    report = session.shutdown()
    assert report["scratch_removed"] is True
    assert Path(report["evidence_dir"]).exists()


def test_cancel_stops_managed_service(session):
    started = _payload(session.start_service("sleep 30", service_id="hold", lifetime_seconds=60))
    assert started["launched"] is True
    session.request_cancel("test-cancel")
    status = _payload(session.service_status("hold"))
    assert status["services"][0]["state"] in {"stopped", "expired"}


def test_service_lifetime_includes_readiness_wait(session):
    port = unused_free_port()
    started_at = time.monotonic()
    started = _payload(session.start_service('sleep 20', service_id='expires', lifetime_seconds=1,
        ready_url=f'http://127.0.0.1:{port}/', ready_timeout_seconds=10))
    assert time.monotonic() - started_at < 5
    assert started['ok'] is False
    assert started['expired'] is True


def test_completed_shell_does_not_leave_background_child(session):
    result = _payload(session.run_command('sleep 30 & echo $!'))
    pid = int(result['stdout'].strip())
    state = Path(f'/proc/{pid}/stat')
    # An orphan may briefly remain as a zombie until PID 1 reaps it.
    assert not state.exists() or state.read_text().split()[2] == 'Z'


def test_research_agent_loop_uses_run_command(session):
    import sys
    from smolagents import LogLevel
    from smolagents.models import ChatMessage, ChatMessageToolCall, ChatMessageToolCallFunction, Model
    from researcher import DoneTool, ResearchAgent, RunCommandTool, INSTRUCTIONS

    class FixtureModel(Model):
        def __init__(self):
            super().__init__()
            self.count = 0

        def generate(self, *args, **kwargs):
            self.count += 1
            if self.count == 1:
                name, arguments = "run_command", {"command": "echo diagnostic-ok"}
            else:
                name, arguments = "done", {"answer": "diagnostic-ok. researcher.py"}
            return ChatMessage(
                role="assistant",
                content="",
                tool_calls=[
                    ChatMessageToolCall(
                        id=str(self.count),
                        type="function",
                        function=ChatMessageToolCallFunction(name=name, arguments=arguments),
                    )
                ],
            )

    model = FixtureModel()
    agent = ResearchAgent(
        tools=[RunCommandTool(), DoneTool()],
        model=model,
        instructions=INSTRUCTIONS,
        max_steps=sys.maxsize,
        verbosity_level=LogLevel.OFF,
    )
    assert agent.run("Reproduce the command") == "diagnostic-ok. researcher.py"
    assert model.count == 2
