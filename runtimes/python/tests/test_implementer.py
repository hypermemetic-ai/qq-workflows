import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import litellm
import minisweagent
import yaml
from minisweagent.agents.default import DefaultAgent
from implementer import HostAgent, HostEnvironment, HostModel


class Recorder:
    def __init__(self): self.requests = []; self.checkpoints = []
    def checkpoint(self, name, value): self.checkpoints.append((name, value))
    def request(self, name, request, fn, serialize):
        self.requests.append(request)
        result = fn()
        self.checkpoints.append(('response', serialize(result)))
        return result
    def call(self, *args, **kwargs): return {'action': 'allow'}


def test_actual_mini_loop_and_effective_requests(tmp_path):
    recorder = Recorder()
    config = yaml.safe_load((Path(minisweagent.__file__).parent / 'config' / 'mini.yaml').read_text())
    model = HostModel(recorder, model_name='xai/grok-4.6', cost_tracking='ignore_errors', observation_template=config['model']['observation_template'])
    class Environment(HostEnvironment):
        def execute(self, action): return {'output': 'observed', 'returncode': 0, 'exception_info': ''}
    env = Environment(recorder, cwd=str(tmp_path))
    settings = config['agent']; settings.pop('mode')
    settings.update(cost_limit=0, step_limit=0, max_consecutive_format_errors=2)
    agent = HostAgent(model, env, **settings); agent.supervisor = recorder
    count = 0
    def complete(**request):
        nonlocal count
        count += 1
        name = 'done' if count == 25 else 'bash'
        arguments = {'answer': 'Completed. example.txt'} if name == 'done' else {'command': f'echo {count}'}
        return litellm.ModelResponse(choices=[{'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'content': 'Working.', 'tool_calls': [{'id': f'c{count}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}}])
    with patch('litellm.completion', side_effect=complete), patch('sys.stdin', io.StringIO('{"accepted":true,"receiptId":"receipt"}\n')), patch('sys.stdout', io.StringIO()):
        result = agent.run('Implement the ticket')
    assert result['exit_status'] == 'Submitted'
    assert count == 25  # Healthy lengthy work exceeds the previous custom-loop cap.
    assert HostAgent.run is DefaultAgent.run
    first = recorder.requests[0]
    assert first['messages'][0]['content'] == 'You are a helpful assistant that can interact with a computer.'
    assert [tool['function']['name'] for tool in first['tools']] == ['bash', 'done']
    assert first['model'] == 'xai/grok-4.6'
    assert first['reasoning_effort'] == 'high' and first['num_retries'] == 0
    assert json.loads(recorder.requests[1]['messages'][-1]['content']) == {'returncode': 0, 'output': 'observed'}
    assert any(name == 'response' for name, _ in recorder.checkpoints)


def test_malformed_done_is_not_remapped():
    from researcher import rewrite_done_tool_call
    import pytest
    for args in ['{bad', {}, {'answer': ''}, {'answer': 42}]:
        call = SimpleNamespace(function=SimpleNamespace(name='done', arguments=args))
        with pytest.raises((ValueError, TypeError)):
            rewrite_done_tool_call(call)
        assert call.function.name == 'done'


def test_research_tools_pass_actual_framework_validation(monkeypatch):
    monkeypatch.setenv('BRAVE_API_KEY', 'fixture')
    monkeypatch.delenv('ARCHITECT_HOST', raising=False)
    from researcher import build_agent
    agent = build_agent({'BRAVE_API_KEY': 'fixture'})
    assert 'done' in agent.tools
    assert 'zvec_grep_rg' in agent.tools


def test_supervised_research_serializes_actual_framework_messages():
    from smolagents.models import ChatMessage, MessageRole
    from shared.recovery import RetryingModel
    message = ChatMessage(role=MessageRole.ASSISTANT, content='Answer', tool_calls=[])
    class Inner:
        model_id = 'xai/grok-4.6'
        def generate(self, **kwargs): return message
    class Supervisor:
        def call(self, *args, **kwargs): return {'action': 'allow'}
        def request(self, operation, request, run, serialize):
            json.dumps(request)
            result = run()
            assert json.loads(json.dumps(serialize(result)))['content'] == 'Answer'
            return result
    assert RetryingModel(Inner(), supervisor=Supervisor()).generate(messages=[message]) is message


def test_supervised_research_uses_loaded_schemas_without_exporting_source(monkeypatch):
    from researcher import build_tools
    from shared.recovery import RetryingModel
    from smolagents.models import ChatMessage
    tools = build_tools({'BRAVE_API_KEY': 'fixture'})
    def changed_source(*args, **kwargs):
        raise SyntaxError("unmatched ')'", ('<unknown>', 5, 1, ')'))
    for tool in tools:
        monkeypatch.setattr(tool, 'to_dict', changed_source)
    class Inner:
        model_id = 'fixture'
        def generate(self, **kwargs): return ChatMessage(role='assistant', content='Answer')
    recorder = Recorder()
    result = RetryingModel(Inner(), supervisor=recorder).generate(messages=[], tools_to_call_from=tools)
    assert result.content == 'Answer'
    schemas = recorder.requests[0]['options']['tools_to_call_from']
    assert [schema['name'] for schema in schemas] == [tool.name for tool in tools]
    assert all('code' not in schema and 'inputs' in schema for schema in schemas)
    json.dumps(recorder.requests)


def test_actual_research_loop_repairs_done_and_allows_lengthy_work():
    import sys
    from smolagents import Tool, LogLevel
    from smolagents.models import Model, ChatMessage, ChatMessageToolCall, ChatMessageToolCallFunction
    from researcher import ResearchAgent, DoneTool, INSTRUCTIONS
    class Observe(Tool):
        name = 'observe'
        description = 'Read the numbered observation.'
        inputs = {'number': {'type': 'integer', 'description': 'Observation number.'}}
        output_type = 'string'
        def forward(self, number: int) -> str:
            return f'Observation {number}'
    class FixtureModel(Model):
        def __init__(self): super().__init__(); self.count = 0
        def generate(self, *args, **kwargs):
            self.count += 1
            name = 'observe' if self.count <= 25 else 'done'
            arguments = {'number': self.count} if self.count <= 25 else {} if self.count == 26 else {'answer': 'The answer. source.py'}
            return ChatMessage(role='assistant', content='', tool_calls=[ChatMessageToolCall(id=str(self.count), type='function', function=ChatMessageToolCallFunction(name=name, arguments=arguments))])
    model = FixtureModel()
    agent = ResearchAgent(tools=[Observe(), DoneTool()], model=model, instructions=INSTRUCTIONS, max_steps=sys.maxsize, verbosity_level=LogLevel.OFF)
    assert agent.run('Obtain the answer') == 'The answer. source.py'
    assert model.count == 27
    assert agent.invalid_completions == 1


def test_research_tools_to_dict_uses_actual_smolagents_validator():
    from smolagents.tool_validation import validate_tool_attributes
    from researcher import ZvecGrepSearchTool, ZvecGrepRgTool, build_agent
    for cls in (ZvecGrepSearchTool, ZvecGrepRgTool):
        validate_tool_attributes(cls)
        assert cls().to_dict()["name"] == cls.name
    agent = build_agent({"BRAVE_API_KEY": "fixture"})
    for name in ("zvec_grep_search", "zvec_grep_rg"):
        assert agent.tools[name].to_dict()["name"] == name


def test_supervised_research_serializes_search_wrappers(monkeypatch):
    from smolagents.models import ChatMessage, MessageRole
    from shared.recovery import RetryingModel
    from researcher import build_tools
    tools = build_tools({"BRAVE_API_KEY": "fixture"})
    message = ChatMessage(role=MessageRole.ASSISTANT, content="Answer", tool_calls=[])
    class Inner:
        model_id = "xai/grok-4.6"
        def generate(self, *args, **kwargs):
            return message
    serialized = []
    class Supervisor:
        def call(self, *args, **kwargs):
            return {"action": "allow"}
        def request(self, operation, request, run, serialize):
            serialized.append(json.dumps(request))
            result = run()
            json.dumps(serialize(result))
            return result
    result = RetryingModel(Inner(), supervisor=Supervisor()).generate(
        messages=[message],
        tools_to_call_from=tools,
    )
    assert result is message
    blob = serialized[0]
    assert "zvec_grep_search" in blob
    assert "zvec_grep_rg" in blob


def test_research_agent_exercises_both_search_wrappers(monkeypatch):
    import sys
    from smolagents import LogLevel
    from smolagents.models import Model, ChatMessage, ChatMessageToolCall, ChatMessageToolCallFunction
    import researcher
    from researcher import ResearchAgent, ZvecGrepSearchTool, ZvecGrepRgTool, DoneTool, INSTRUCTIONS
    calls = []
    def fake_zg(name, arguments):
        calls.append((name, dict(arguments)))
        return f"evidence from {name}: researcher.py"
    monkeypatch.setattr(researcher, "official_zg", fake_zg)
    class FixtureModel(Model):
        def __init__(self):
            super().__init__()
            self.count = 0
        def generate(self, *args, **kwargs):
            self.count += 1
            if self.count == 1:
                name, arguments = "zvec_grep_search", {"root": "/ws", "query": "official_zg helper"}
            elif self.count == 2:
                name, arguments = "zvec_grep_rg", {"root": "/ws", "command": "rg official_zg"}
            else:
                name, arguments = "done", {"answer": "official_zg bridges zg-call.mjs. researcher.py"}
            return ChatMessage(
                role="assistant",
                content="",
                tool_calls=[ChatMessageToolCall(
                    id=str(self.count),
                    type="function",
                    function=ChatMessageToolCallFunction(name=name, arguments=arguments),
                )],
            )
    model = FixtureModel()
    agent = ResearchAgent(
        tools=[ZvecGrepSearchTool(), ZvecGrepRgTool(), DoneTool()],
        model=model,
        instructions=INSTRUCTIONS,
        max_steps=sys.maxsize,
        verbosity_level=LogLevel.OFF,
    )
    assert agent.run("Find official_zg") == "official_zg bridges zg-call.mjs. researcher.py"
    assert [name for name, _ in calls] == ["zvec_grep_search", "zvec_grep_rg"]
    assert calls[0][1] == {"root": "/ws", "query": "official_zg helper"}
    assert calls[1][1] == {"root": "/ws", "command": "rg official_zg"}
    assert model.count == 3
