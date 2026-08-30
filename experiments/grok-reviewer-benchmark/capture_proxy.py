#!/usr/bin/env python3
"""Credential-shielding OpenAI-compatible proxy with raw response/usage capture.

The real upstream credential is read only by this process. Reviewer processes get
an inert local credential, so raw artifacts cannot accidentally contain the
upstream secret. Request and response bodies are intentionally retained in the
private run directory for reproducibility; authorization headers are never
written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

SCHEMA = "qq.grok-provider-response/v1"
HOP_HEADERS = {
    "authorization", "connection", "content-length", "host", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade",
}


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and value >= 0 and value.is_integer():
        return int(value)
    return None


def _first_integer(value: dict[str, Any], names: Iterable[str]) -> int | None:
    for name in names:
        found = _integer(value.get(name))
        if found is not None:
            return found
    return None


def normalize_usage(value: Any) -> dict[str, int] | None:
    """Normalize one provider usage object without double-counting reasoning."""
    if not isinstance(value, dict):
        return None
    input_tokens = _first_integer(value, ("input_tokens", "prompt_tokens"))
    output_tokens = _first_integer(value, ("output_tokens", "completion_tokens"))
    total_tokens = _first_integer(value, ("total_tokens", "processed_tokens"))

    prompt_details = value.get("prompt_tokens_details")
    input_details = value.get("input_tokens_details")
    completion_details = value.get("completion_tokens_details")
    output_details = value.get("output_tokens_details")
    prompt_details = prompt_details if isinstance(prompt_details, dict) else {}
    input_details = input_details if isinstance(input_details, dict) else {}
    completion_details = completion_details if isinstance(completion_details, dict) else {}
    output_details = output_details if isinstance(output_details, dict) else {}

    cache_read = _first_integer(value, ("cache_read_input_tokens", "cache_read_tokens"))
    if cache_read is None:
        cache_read = _first_integer(input_details, ("cached_tokens", "cache_read_tokens"))
    if cache_read is None:
        cache_read = _first_integer(prompt_details, ("cached_tokens", "cache_read_tokens"))

    cache_write = _first_integer(
        value,
        ("cache_creation_input_tokens", "cache_write_input_tokens", "cache_write_tokens"),
    )
    if cache_write is None:
        cache_write = _first_integer(input_details, ("cache_creation_tokens", "cache_write_tokens"))
    if cache_write is None:
        cache_write = _first_integer(prompt_details, ("cache_creation_tokens", "cache_write_tokens"))

    reasoning = _first_integer(value, ("reasoning_tokens",))
    if reasoning is None:
        reasoning = _first_integer(output_details, ("reasoning_tokens",))
    if reasoning is None:
        reasoning = _first_integer(completion_details, ("reasoning_tokens",))

    if input_tokens is None and output_tokens is None and total_tokens is None:
        return None
    input_tokens = input_tokens or 0
    output_tokens = output_tokens or 0
    # Reasoning is normally a subset of output/completion tokens. It is recorded
    # separately but is deliberately not added to processed tokens.
    processed = total_tokens if total_tokens is not None else input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read or 0,
        "cache_write_tokens": cache_write or 0,
        "reasoning_tokens": reasoning or 0,
        "processed_tokens": processed,
    }


def _walk(value: Any) -> Iterable[tuple[str | None, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield key, child
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield None, child
            yield from _walk(child)


def parse_response_body(body: bytes, content_type: str) -> tuple[str | None, dict[str, int] | None]:
    values: list[Any] = []
    text = body.decode("utf-8", errors="replace")
    if "text/event-stream" in content_type.lower() or text.lstrip().startswith("data:"):
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                values.append(json.loads(payload))
            except json.JSONDecodeError:
                continue
    else:
        try:
            values.append(json.loads(text))
        except json.JSONDecodeError:
            pass

    models: list[str] = []
    usages: list[dict[str, int]] = []
    for value in values:
        if isinstance(value, dict) and isinstance(value.get("model"), str):
            models.append(value["model"])
        for key, child in _walk(value):
            if key == "model" and isinstance(child, str):
                models.append(child)
            if key == "usage":
                normalized = normalize_usage(child)
                if normalized is not None:
                    usages.append(normalized)
    # Streaming APIs can repeat cumulative usage. The largest processed count is
    # the complete response, not a value to sum with earlier chunks.
    usage = max(usages, key=lambda item: item["processed_tokens"], default=None)
    return (models[-1] if models else None), usage


def ensure_stream_usage(body: bytes) -> tuple[bytes, bool]:
    """Request the provider's final usage chunk without changing generation controls."""
    try:
        value = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body, False
    if not isinstance(value, dict) or value.get("stream") is not True:
        return body, False
    options = value.get("stream_options")
    if options is None:
        options = {}
        value["stream_options"] = options
    if not isinstance(options, dict) or options.get("include_usage") is True:
        return body, False
    options["include_usage"] = True
    # Compact UTF-8 JSON changes only transport metadata, not prompts or model
    # generation controls. Both original and forwarded bytes are retained.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), True


def request_model(body: bytes) -> str | None:
    try:
        value = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    model = value.get("model") if isinstance(value, dict) else None
    return model if isinstance(model, str) else None


class CaptureState:
    def __init__(self, upstream: str, api_key: str, output: Path) -> None:
        parsed = urlsplit(upstream)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("upstream base URL must be http(s)")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("upstream base URL must not contain credentials, query, or fragment")
        self.upstream = parsed
        self.api_key = api_key
        self.output = output
        self.output.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = threading.Lock()
        self._sequence = 0

    def next_sequence(self) -> int:
        with self._lock:
            self._sequence += 1
            return self._sequence

    def target(self, incoming: str) -> str:
        request = urlsplit(incoming)
        base_path = self.upstream.path.rstrip("/")
        incoming_path = request.path
        if base_path.endswith("/v1") and (incoming_path == "/v1" or incoming_path.startswith("/v1/")):
            incoming_path = incoming_path[3:]
        path = f"{base_path}/{incoming_path.lstrip('/')}" if base_path else incoming_path
        return urlunsplit((self.upstream.scheme, self.upstream.netloc, path, request.query, ""))

    def append_metadata(self, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
        with self._lock:
            with (self.output / "responses.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(encoded)


class CaptureHandler(BaseHTTPRequestHandler):
    server_version = "GrokBenchmarkCapture/1"

    @property
    def state(self) -> CaptureState:
        return self.server.capture_state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # Avoid URL/query leakage to process logs; structured metadata is enough.
        return

    def do_GET(self) -> None:  # noqa: N802
        self._forward()

    def do_POST(self) -> None:  # noqa: N802
        self._forward()

    def _forward(self) -> None:
        sequence = self.state.next_sequence()
        prefix = f"request-{sequence:04d}"
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        forwarded_body, usage_requested = ensure_stream_usage(body)
        (self.state.output / f"{prefix}.request.bin").write_bytes(body)
        (self.state.output / f"{prefix}.forwarded-request.bin").write_bytes(forwarded_body)
        headers = {
            key: value for key, value in self.headers.items()
            if key.lower() not in HOP_HEADERS
        }
        headers["Authorization"] = f"Bearer {self.state.api_key}"
        started = time.monotonic_ns()
        status = 502
        response_headers: dict[str, str] = {}
        response_body = b""
        error_text: str | None = None
        try:
            upstream_request = Request(
                self.state.target(self.path),
                data=forwarded_body if self.command != "GET" or forwarded_body else None,
                headers=headers,
                method=self.command,
            )
            with urlopen(upstream_request, timeout=3600) as response:  # nosec: configured endpoint
                status = response.status
                response_headers = dict(response.headers.items())
                response_body = response.read()
        except HTTPError as error:
            status = error.code
            response_headers = dict(error.headers.items()) if error.headers else {}
            response_body = error.read()
            error_text = f"HTTP {error.code}"
        except Exception as error:  # pragma: no cover - depends on external transport
            error_text = f"{type(error).__name__}: {error}"
            response_body = json.dumps({"error": {"message": "capture proxy upstream failure"}}).encode()
            response_headers = {"Content-Type": "application/json"}

        elapsed_ms = (time.monotonic_ns() - started) / 1_000_000
        (self.state.output / f"{prefix}.response.bin").write_bytes(response_body)
        content_type = next(
            (value for key, value in response_headers.items() if key.lower() == "content-type"),
            "application/octet-stream",
        )
        response_model, usage = parse_response_body(response_body, content_type)
        metadata = {
            "schema": SCHEMA,
            "sequence": sequence,
            "method": self.command,
            "path": urlsplit(self.path).path,
            "status": status,
            "elapsed_ms": round(elapsed_ms, 3),
            "request_sha256": hashlib.sha256(body).hexdigest(),
            "forwarded_request_sha256": hashlib.sha256(forwarded_body).hexdigest(),
            "stream_usage_requested": usage_requested,
            "response_sha256": hashlib.sha256(response_body).hexdigest(),
            "request_model": request_model(forwarded_body),
            "response_model": response_model,
            "usage": usage,
            "error": error_text,
        }
        self.state.append_metadata(metadata)

        self.send_response(status)
        for key, value in response_headers.items():
            if key.lower() not in HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    args = parser.parse_args()
    upstream = os.environ.get("GROK_BENCH_PROXY_UPSTREAM")
    api_key = os.environ.get("GROK_BENCH_PROXY_API_KEY")
    if not upstream or not api_key:
        parser.error("GROK_BENCH_PROXY_UPSTREAM and GROK_BENCH_PROXY_API_KEY are required")
    state = CaptureState(upstream, api_key, args.output)
    server = ThreadingHTTPServer((args.host, args.port), CaptureHandler)
    server.capture_state = state  # type: ignore[attr-defined]
    args.ready_file.parent.mkdir(parents=True, exist_ok=True)
    ready = {"base_url": f"http://{args.host}:{server.server_port}/v1", "pid": os.getpid()}
    args.ready_file.write_text(json.dumps(ready, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(args.ready_file, 0o600)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
