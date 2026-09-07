import json
import random
import re
import sys
import time
import dataclasses
from enum import Enum

PROVIDER_ATTEMPTS = 3
MALFORMED_REGENS = 1
BACKOFF_CAPS = (5.0, 10.0)

RESULT_PREFIX = "RESEARCHER_RESULT "
HEARTBEAT_LINE = "RESEARCHER_HEARTBEAT"


class DegenerationError(RuntimeError):
    def __init__(self, action="repeated tool calls", occurrences=6):
        super().__init__(
            f"repeated-action loop persisted despite a warning: {action}, {occurrences} occurrences"
        )
        self.action = action
        self.occurrences = occurrences
        self.failure_class = "degeneration"


class RecoveryExhausted(RuntimeError):
    def __init__(self, attempts):
        chain = " → ".join(attempts) if attempts else "provider failure"
        super().__init__(f"provider recovery exhausted: {chain}")
        self.attempts = list(attempts)
        self.failure_class = "transient"


class PermanentError(RuntimeError):
    failure_class = "permanent"


def cause_chain(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        yield error
        error = error.__cause__ or error.__context__


def failure_text(error):
    return " | ".join(str(item) for item in cause_chain(error)) if isinstance(error, BaseException) else str(error or "")


def failure_details(error):
    chain = list(cause_chain(error))
    typed = next((item for item in chain if getattr(item, 'failure_class', None)), error)
    response = next((getattr(item, 'response', None) for item in chain if getattr(item, 'response', None) is not None), None)
    return {
        'message': failure_text(error), 'failureClass': classify_failure(error),
        'attempts': getattr(typed, 'attempts', []), 'exhausted': getattr(typed, 'exhausted', isinstance(typed, RecoveryExhausted)),
        'retryAfter': response.headers.get('Retry-After') if response is not None else None,
    }



def classify_failure(error):
    for item in cause_chain(error) if isinstance(error, BaseException) else []:
        if getattr(item, 'failure_class', None): return item.failure_class
        status = getattr(item, 'status_code', None)
        if status in (400, 401, 403, 404, 422): return 'permanent'
        if status in (408, 429, 500, 502, 503, 504): return 'transient'
    s = failure_text(error).lower()
    if "degeneration" in s or "repeated-action loop" in s:
        return "degeneration"
    if re.search(
        r"set brave_api_key|exa_api_key|401\b|403\b|\b400\b|invalid api key|authentication|"
        r"insufficient_quota|quota exceeded|unsupported model|invalid_request|"
        r"invalid-argument|invalid_argument|badrequesterror|bad request|"
        r"maximum prompt|context length|context window|too many tokens|token limit",
        s,
    ) and not re.search(r"timeout|502|503|429", s):
        return "permanent"
    if re.search(
        r"\b429\b|rate.?limit|\b50[0234]\b|econnreset|etimedout|readtimeout|"
        r"timeout after|internal error during token|"
        r"service unavailable|temporarily unavailable",
        s,
    ):
        return "transient"
    if re.search(r"empty model response|produced no output|question is empty", s):
        return "invalid_output"
    return "process"


def summarize_failure(error):
    text = re.sub(r"\s+", " ", failure_text(error)).strip()
    timeout = re.search(r"timeout after ([\d.]+)\s*seconds", text, re.I)
    if timeout:
        return f"ReadTimeout at the provider's {timeout.group(1)}-second timeout"
    xai = re.search(r'"error"\s*:\s*"((?:\\.|[^"\\])*)"', text)
    if xai:
        return xai.group(1).replace('\\"', '"')
    if re.search(r"internal error during token|\b500\b", text, re.I) and not re.search(r"\b400\b", text):
        return "HTTP 500"
    if re.search(r"readtimeout", text, re.I):
        return "ReadTimeout"
    http = re.search(r"\bHTTP\s*([45]\d\d)\b", text, re.I)
    if http:
        return f"HTTP {http.group(1)}"
    return text if len(text) <= 240 else text[-240:]


def backoff_seconds(failed_attempt, rng=random.random):
    cap = BACKOFF_CAPS[min(max(failed_attempt, 1), len(BACKOFF_CAPS)) - 1]
    return rng() * cap


def emit_result(payload, stream=None):
    target = sys.stderr if stream is None else stream
    print(f"{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", file=target, flush=True)


def empty_model_response(message):
    content = getattr(message, "content", None)
    tool_calls = getattr(message, "tool_calls", None)
    if tool_calls:
        return False
    if content is None:
        return True
    if isinstance(content, str):
        return not content.strip()
    return False


class RetryingModel:
    def __init__(self, inner, sleep=time.sleep, rng=random.random, supervisor=None):
        self._inner = inner
        self._sleep = sleep
        self._rng = rng
        self.attempts = []
        self.regenerations = 0
        self.recovery_actions = 0
        self.supervisor = supervisor
        self.sequence = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def generate(self, *args, **kwargs):
        self.sequence += 1
        if "tools_to_call_from" in kwargs:
            kwargs["tools_to_call_from"] = [tool for tool in kwargs["tools_to_call_from"] if tool.name != "final_answer"]
        if self.supervisor:
            def run():
                result = self._inner.generate(*args, **kwargs)
                if empty_model_response(result): raise RuntimeError('empty model response')
                if isinstance(result.content, str): self.supervisor.call('text', f'model:{self.sequence}', {'text': result.content})
                return result
            # Save actual messages and tool schemas without credential-bearing model configuration.
            def serial(value):
                # Journal the schema already loaded in memory. Tool.to_dict()
                # exports executable code and reparses mutable source files.
                if hasattr(value, 'inputs') and hasattr(value, 'name'):
                    return {'name': value.name, 'description': value.description, 'inputs': serial(value.inputs), 'output_type': value.output_type}
                if hasattr(value, 'model_dump'): return serial(value.model_dump(mode='json'))
                if dataclasses.is_dataclass(value): return serial(dataclasses.asdict(value))
                if isinstance(value, Enum): return value.value
                if hasattr(value, 'to_dict'): return serial(value.to_dict())
                if isinstance(value, dict): return {k: serial(v) for k, v in value.items()}
                if isinstance(value, (list, tuple)): return [serial(v) for v in value]
                return value
            request = {'model': self._inner.model_id, 'messages': serial(args), 'options': serial(kwargs)}
            def repair(feedback):
                from smolagents.models import ChatMessage
                messages = kwargs.get('messages', args[0] if args else None)
                if isinstance(messages, list): messages.append(ChatMessage(role='user', content=feedback))
                request.update(messages=serial(args), options=serial(kwargs))
            run.repair = repair
            return self.supervisor.request(f'model:{self.sequence}', request, run, serial)
        self.attempts = []
        last = None
        for n in range(1, PROVIDER_ATTEMPTS + 1):
            try:
                result = self._inner.generate(*args, **kwargs)
                if empty_model_response(result):
                    raise RuntimeError("empty model response")
                return result
            except DegenerationError:
                raise
            except Exception as error:
                cls = classify_failure(error)
                summary = summarize_failure(error)
                self.attempts.append(summary)
                last = error
                if cls == "permanent":
                    raise PermanentError(summary) from error
                if cls == "process":
                    raise
                if cls == "degeneration":
                    raise
                if cls == "invalid_output":
                    if self.regenerations >= MALFORMED_REGENS:
                        raise RecoveryExhausted(self.attempts) from error
                    self.regenerations += 1
                if n >= PROVIDER_ATTEMPTS or self.recovery_actions >= 6:
                    raise RecoveryExhausted(self.attempts) from error
                self.recovery_actions += 1
                self._sleep(backoff_seconds(n, self._rng))
        raise RecoveryExhausted(self.attempts) from last
