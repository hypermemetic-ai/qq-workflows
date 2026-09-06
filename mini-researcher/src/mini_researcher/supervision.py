"""Lifecycle protocol shared by the Python harness adapters. Policy lives in the host."""
import hashlib
import json
import os
import threading
import time
import urllib.request
import urllib.error
from contextlib import contextmanager


class Supervisor:
    def __init__(self, host=None, job_id=None):
        self.host = host or os.environ.get('ARCHITECT_HOST')
        self.job_id = job_id or os.environ.get('ARCHITECT_JOB_ID')
        self.activity = 'starting'
        self.stop = threading.Event()

    def call(self, event, operation='', value=None, attempt_id=None):
        if not self.host or not self.job_id:
            raise RuntimeError('runner requires an Architect host and job identity')
        data = json.dumps(dict(event=event, operation=operation, value=value or {}, attemptId=attempt_id, jobId=self.job_id)).encode()
        request = urllib.request.Request(self.host + '/runner', data, {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as response:
            payload = json.load(response)
            error = RuntimeError(payload.get('error', str(response)))
            error.failure_class = payload.get('failureClass', 'process')
            error.attempts = payload.get('attempts') or []
            error.exhausted = payload.get('exhausted', False)
            raise error from response

    def checkpoint(self, operation, value):
        return self.call('checkpoint', operation, value)

    def heartbeat(self):
        while not self.stop.is_set():
            try:
                self.call('heartbeat', value={'pid': os.getpid(), 'activity': self.activity})
            except Exception:
                pass  # Missing acknowledgements do not authorize another worker.
            self.stop.wait(10)

    def start(self):
        threading.Thread(target=self.heartbeat, daemon=True).start()
        return self

    def request(self, operation, request, fn, serialize=lambda x: x):
        from .recovery import classify_failure, failure_details
        endpoint = str(request.get('endpoint', 'https://api.x.ai/v1')).rstrip('/').removesuffix('/v1')
        model = str(request.get('model', 'grok-4.6')).removeprefix('xai/').removesuffix('-build')
        scope = hashlib.sha256((endpoint + '\n' + model + '\n' + os.environ.get('XAI_API_KEY', '')).encode()).hexdigest()
        while True:
            self.activity = 'provider request'
            attempt = self.call('begin', operation, {'kind': 'model', 'scope': scope, 'request': request})['attemptId']
            try:
                result = fn()
                value = serialize(result)
            except Exception as error:
                details = failure_details(error)
                reply = self.call('failure', operation, details, attempt)
                if not reply.get('retry'):
                    error.failure_class = reply.get('failureClass', classify_failure(error))
                    error.attempts = reply.get('attempts', [])
                    error.exhausted = reply.get('exhausted', False)
                    raise
                if reply.get('feedback'):
                    if hasattr(fn, 'repair'): fn.repair(reply['feedback'])
                    elif isinstance(request.get('messages'), list): request['messages'].append({'role': 'user', 'content': reply['feedback']})
                time.sleep(reply['delayMs'] / 1000)
                continue
            self.call('success', operation, value, attempt)
            return result

    @contextmanager
    def execution(self, operation, action):
        self.activity = 'command execution'
        attempt = self.call('begin', operation, {'kind': 'command', 'action': action})['attemptId']
        outcome = {}
        try:
            yield outcome
        except BaseException:
            # Unknown side effects remain active in the journal; no automatic replay.
            raise
        else:
            self.call('success', operation, outcome, attempt)
