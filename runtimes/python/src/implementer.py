"""Adapter for pinned Mini v2. DefaultAgent.run and its observation formatter are upstream."""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")
os.environ.setdefault("MSWEA_GLOBAL_CONFIG_DIR", str(Path(os.environ.get("PASEO_HOME", str(Path.home() / ".paseo"))) / "architect" / "mini-config"))

import litellm
import yaml
import minisweagent
from minisweagent.agents.default import DefaultAgent
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models.litellm_model import LitellmModel
from minisweagent.models.utils.actions_toolcall import BASH_TOOL
from minisweagent.exceptions import FormatError, Submitted
from shared.supervision import Supervisor
from shared.progress import worktree_state

DONE = {'type': 'function', 'function': {'name': 'done', 'description': 'Submit completed work to the host.', 'parameters': {'type': 'object', 'properties': {'answer': {'type': 'string'}}, 'required': ['answer'], 'additionalProperties': False}}}


def emit(kind, **fields):
    print(json.dumps({'version': 1, 'kind': kind, **fields}), flush=True)


class HostModel(LitellmModel):
    def __init__(self, supervisor, **kwargs):
        super().__init__(**kwargs)
        self.supervisor = supervisor
        self.sequence = 0

    def query(self, messages, **kwargs):
        # Deliberately bypass upstream's retry decorator; the host grants every retry.
        self.sequence += 1
        prepared = self._prepare_messages_for_api(messages)
        request = {'model': self.config.model_name, 'messages': prepared, 'tools': [BASH_TOOL, DONE], 'reasoning_effort': 'high', 'num_retries': 0}
        def complete():
            response = litellm.completion(**request, **kwargs)
            if response.choices[0].finish_reason not in ('stop', 'tool_calls'):
                error = RuntimeError('incomplete model response')
                error.failure_class = 'invalid_output'
                raise error
            return response
        response = self.supervisor.request(f'model:{self.sequence}', request, complete, lambda r: r.model_dump(mode='json'))
        message = response.choices[0].message.model_dump()
        if message.get('content'): self.supervisor.call('text', f'model:{self.sequence}', {'text': message['content']})
        calls = response.choices[0].message.tool_calls or []
        try:
            done = [call for call in calls if call.function.name == 'done']
            if done:
                if len(calls) != 1: raise ValueError('done must be the only tool call')
                args = json.loads(done[0].function.arguments)
                if not isinstance(args, dict) or set(args) != {'answer'} or not isinstance(args['answer'], str): raise ValueError('done requires an answer string')
                actions = [{'done': args, 'tool_call_id': done[0].id}]
            else:
                actions = self._parse_actions(response)
        except (ValueError, FormatError) as error:
            self.supervisor.call('repair')
            raise FormatError({'role': 'user', 'content': f'Tool call error: {error}. Use bash or call done alone with an answer string.', 'extra': {'cost': 0, 'response': response.model_dump(mode='json')}}) from error
        message['extra'] = {'actions': actions, 'response': response.model_dump(mode='json'), 'cost': self._calculate_cost(response)['cost']}
        if message.get('content'): emit('text', text=message['content'])
        return message


class HostEnvironment(LocalEnvironment):
    def __init__(self, supervisor, **kwargs):
        super().__init__(**kwargs)
        self.supervisor = supervisor
        self.sequence = 0

    def _check_finished(self, output):
        # Shell output is data. Only the dedicated done tool can finish the run.
        pass

    def execute(self, action, **kwargs):
        self.sequence += 1
        # Invocation IDs change on each response and are not task progress.
        arguments = {k: v for k, v in action.items() if k != 'tool_call_id'}
        state = worktree_state(self.config.cwd)
        decision = self.supervisor.call('loop_before', value={'name': 'bash', 'args': arguments, 'state': state})
        if decision['action'] == 'stop': raise RuntimeError('repeated-action loop: sixth occurrence prevented')
        emit('tool', name='bash', arguments=action, status='pending', id=str(self.sequence))
        with self.supervisor.execution(f'command:{self.sequence}', action) as outcome:
            output = super().execute(action, **kwargs)
            outcome.update(output)
        decision = self.supervisor.call('loop', value={'name': 'bash', 'args': arguments, 'result': output, 'state': worktree_state(self.config.cwd)})
        if decision['action'] == 'stop': raise RuntimeError('repeated-action loop persisted despite a warning')
        if decision['action'] == 'warn': output['output'] += '\n' + decision['warning']
        emit('tool', name='bash', output=output['output'][:10000], status='completed', id=str(self.sequence))
        return output


class HostAgent(DefaultAgent):
    def query(self):
        self.supervisor.checkpoint('trajectory', self.serialize())
        return super().query()

    def execute_actions(self, message):
        self.supervisor.checkpoint('trajectory', self.serialize())
        actions = message.get('extra', {}).get('actions', [])
        if len(actions) == 1 and 'done' in actions[0]:
            emit('done', arguments=actions[0]['done'])
            receipt = json.loads(sys.stdin.readline())
            if not receipt.get('accepted'): raise RuntimeError('host did not accept completion')
            raise Submitted({'role': 'exit', 'content': actions[0]['done']['answer'], 'extra': {'exit_status': 'Submitted', 'submission': actions[0]['done']['answer'], 'receipt': receipt}})
        result = super().execute_actions(message)
        self.supervisor.checkpoint('trajectory', self.serialize())
        return result


def main():
    payload = json.loads(sys.stdin.readline())
    supervisor = Supervisor().start()
    config_path = Path(minisweagent.__file__).parent / 'config' / 'mini.yaml'
    config = yaml.safe_load(config_path.read_text())
    settings = config['agent']
    settings.pop('mode', None)
    settings.update(step_limit=0, cost_limit=0, wall_time_limit_seconds=0, max_consecutive_format_errors=2)
    # Only completion changes; all other template text and Mini's bash semantics stay upstream.
    settings['instance_template'] = settings['instance_template'].replace('issuing the following command: `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`', 'calling the `done` tool').replace('Do not combine it with any other command.', 'Do not combine it with any other tool call.').replace('After this command,', 'After this tool call,').replace('AT LEAST ONE bash tool call', 'AT LEAST ONE bash tool call, unless finishing with done')
    settings['instance_template'] += '\n\n' + payload['zgGuidance']
    model_settings = config['model']
    model_settings.pop('model_kwargs', None)
    model_settings.update(model_name='xai/grok-4.6', cost_tracking='ignore_errors')
    if 'format_error_template' in model_settings:
        model_settings['format_error_template'] = 'Return a valid bash tool call, or call done alone with an answer string when the work is complete.'
    model = HostModel(supervisor, **model_settings)
    environment = HostEnvironment(supervisor, cwd=payload['cwd'], **config['environment'])
    agent = HostAgent(model, environment, **settings)
    agent.supervisor = supervisor
    try:
        result = agent.run(payload['task'])
        if result.get('exit_status') != 'Submitted': raise RuntimeError(str(result))
        emit('exit', result=result)
    finally:
        supervisor.stop.set()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        from shared.recovery import failure_details
        emit('failure', error=failure_details(error))
        raise
