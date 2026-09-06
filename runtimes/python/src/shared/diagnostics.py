"""Job-local diagnostic execution and scratch services for Researcher.

Lightweight accident-prevention, not a security sandbox. Diagnostic subprocesses
get a separate PASEO_HOME and do not inherit normal runtime endpoints. HOME and
credential environment variables stay available without being copied into scratch
or tool output. Owned process groups are tracked; descendants outside those
groups are not claimed.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

FOREGROUND_TIMEOUT_DEFAULT = 120
FOREGROUND_TIMEOUT_MAX = 600
SERVICE_LIFETIME_DEFAULT = 300
SERVICE_LIFETIME_MAX = 1800
SERVICE_READY_TIMEOUT_DEFAULT = 30
SERVICE_READY_TIMEOUT_MAX = 120
TERM_GRACE_SECONDS = 2.0
KILL_GRACE_SECONDS = 1.0
JSON_HEAD_CHARS = 2000
JSON_TAIL_CHARS = 2000
DISK_STREAM_LIMIT = 8 * 1024 * 1024
SERVICE_DISK_STREAM_LIMIT = 1 * 1024 * 1024
DRAIN_CHUNK = 65536
SHELL = "/bin/bash"
ISOLATE_ENV_KEYS = (
    "PASEO_HOME",
    "PASEO_HOST",
    "ARCHITECT_HOST",
    "ARCHITECT_JOB_ID",
    "ARCHITECT_ZG_LISTEN",
)

_SESSION = None
_SESSION_LOCK = threading.Lock()


class CancelledError(RuntimeError):
    failure_class = "cancelled"

    def __init__(self, message="diagnostic session cancelled"):
        super().__init__(message)


def get_session():
    global _SESSION
    with _SESSION_LOCK:
        if _SESSION is None:
            _SESSION = DiagnosticSession()
        return _SESSION


def set_session(session):
    global _SESSION
    with _SESSION_LOCK:
        previous = _SESSION
        _SESSION = session
    return previous


def shutdown_diagnostics():
    session = None
    with _SESSION_LOCK:
        session = _SESSION
    if session is not None:
        return session.shutdown()
    return {"cleanup_failures": []}


def run_diagnostic_command(command, cwd=None, timeout_seconds=None):
    return get_session().run_command(command, cwd=cwd, timeout_seconds=timeout_seconds)


def start_diagnostic_service(
    command,
    service_id=None,
    cwd=None,
    ready_url=None,
    endpoint=None,
    ready_timeout_seconds=None,
    lifetime_seconds=None,
):
    return get_session().start_service(
        command,
        service_id=service_id,
        cwd=cwd,
        ready_url=ready_url,
        endpoint=endpoint,
        ready_timeout_seconds=ready_timeout_seconds,
        lifetime_seconds=lifetime_seconds,
    )


def diagnostic_service_status(service_id=None):
    return get_session().service_status(service_id=service_id)


def stop_diagnostic_service(service_id=None):
    return get_session().stop_service(service_id=service_id)


def _clamp_int(value, default, maximum, minimum=1):
    if value is None or value == "":
        return default, False
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default, False
    if parsed < minimum:
        return default, True
    if parsed > maximum:
        return maximum, True
    return parsed, False


def _decode(data):
    if not data:
        return ""
    if isinstance(data, str):
        return data
    return data.decode("utf-8", errors="replace")


def _clip_text(text, head=JSON_HEAD_CHARS, tail=JSON_TAIL_CHARS):
    text = text or ""
    if len(text) <= head + tail:
        return text, False
    return text[:head] + "\n...[truncated]...\n" + text[-tail:], True


def _now():
    return time.monotonic()


def _json(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _reap(proc):
    if proc is None:
        return None
    try:
        return proc.poll()
    except Exception:
        return None


def terminate_group(pgid, proc=None, term_grace=TERM_GRACE_SECONDS, kill_grace=KILL_GRACE_SECONDS):
    failures = []
    if pgid is None:
        return failures
    if proc is not None:
        _reap(proc)
    if not _alive(pgid):
        if proc is not None:
            try:
                proc.wait(timeout=0.2)
            except Exception:
                pass
        return failures
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return failures
    except Exception as error:
        failures.append(f"SIGTERM process group {pgid} failed: {error}")
    deadline = _now() + term_grace
    while _now() < deadline:
        if proc is not None and proc.poll() is not None and not _alive(pgid):
            return failures
        if proc is None and not _alive(pgid):
            return failures
        time.sleep(0.05)
    if not _alive(pgid):
        if proc is not None:
            try:
                proc.wait(timeout=0.2)
            except Exception:
                pass
        return failures
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return failures
    except Exception as error:
        failures.append(f"SIGKILL process group {pgid} failed: {error}")
    deadline = _now() + kill_grace
    while _now() < deadline:
        if not _alive(pgid):
            if proc is not None:
                try:
                    proc.wait(timeout=0.2)
                except Exception:
                    pass
            return failures
        time.sleep(0.05)
    if _alive(pgid):
        failures.append(
            f"process group {pgid} still alive after SIGKILL; residual processes may remain"
        )
    if proc is not None:
        try:
            proc.wait(timeout=0.2)
        except Exception:
            pass
    return failures


class StreamDrain:
    def __init__(self, stream, evidence_path, disk_limit):
        self.stream = stream
        self.evidence_path = Path(evidence_path) if evidence_path else None
        self.disk_limit = disk_limit
        self.total = 0
        self.truncated = False
        self.cleanup_failures = []
        self._head = bytearray()
        self._tail = bytearray()
        self._file = None
        self._wrote = False
        if self.evidence_path is not None:
            try:
                self.evidence_path.parent.mkdir(parents=True, exist_ok=True)
                self._file = open(self.evidence_path, "wb")
            except Exception as error:
                self.cleanup_failures.append(f"open {self.evidence_path} failed: {error}")
                self._file = None
                self.evidence_path = None

    def start(self):
        thread = threading.Thread(target=self._run, daemon=True)
        thread.start()
        return thread

    def _run(self):
        try:
            while True:
                chunk = self.stream.read(DRAIN_CHUNK)
                if not chunk:
                    break
                self._accept(chunk)
        except Exception as error:
            self.cleanup_failures.append(f"stream drain failed: {error}")
        finally:
            try:
                self.stream.close()
            except Exception:
                pass
            if self._file is not None:
                try:
                    self._file.close()
                except Exception as error:
                    self.cleanup_failures.append(f"close evidence failed: {error}")
                self._file = None
                if self.evidence_path is not None and not self._wrote:
                    try:
                        self.evidence_path.unlink()
                    except FileNotFoundError:
                        pass
                    except Exception as error:
                        self.cleanup_failures.append(f"remove empty evidence failed: {error}")
                    self.evidence_path = None

    def _accept(self, chunk):
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8", errors="replace")
        self.total += len(chunk)
        head_room = JSON_HEAD_CHARS - len(self._head)
        if head_room > 0:
            self._head.extend(chunk[:head_room])
            chunk_for_tail = chunk[head_room:]
        else:
            chunk_for_tail = chunk
        if chunk_for_tail:
            self._tail.extend(chunk_for_tail)
            overflow = len(self._tail) - JSON_TAIL_CHARS
            if overflow > 0:
                del self._tail[:overflow]
        if self._file is not None:
            remaining = self.disk_limit - self._file.tell()
            if remaining <= 0:
                self.truncated = True
            else:
                try:
                    self._file.write(chunk[:remaining])
                    self._file.flush()
                    self._wrote = True
                    if len(chunk) > remaining:
                        self.truncated = True
                except Exception as error:
                    self.truncated = True
                    self.cleanup_failures.append(f"write evidence failed: {error}")
        elif self.total > JSON_HEAD_CHARS + JSON_TAIL_CHARS:
            self.truncated = True

    def text(self):
        if self.total <= JSON_HEAD_CHARS + JSON_TAIL_CHARS:
            return _decode(bytes(self._head) + bytes(self._tail))
        return _decode(bytes(self._head)) + "\n...[truncated]...\n" + _decode(bytes(self._tail))

    def artifact(self, finalize=False):
        if self._wrote and self.evidence_path is not None:
            path = str(self.evidence_path)
        else:
            path = None
        if not finalize:
            return path
        if path is None:
            return None
        small = (not self.truncated) and self.total <= JSON_HEAD_CHARS + JSON_TAIL_CHARS
        if small:
            try:
                self.evidence_path.unlink()
            except FileNotFoundError:
                path = None
            except Exception as error:
                self.cleanup_failures.append(f"remove small evidence failed: {error}")
                return path
            else:
                self.evidence_path = None
                return None
        return path


class ManagedService:
    def __init__(self, service_id, command, cwd, env, endpoint, lifetime_seconds, evidence_dir):
        self.service_id = service_id
        self.command = command
        self.cwd = cwd
        self.env = env
        self.endpoint = endpoint
        self.lifetime_seconds = lifetime_seconds
        self.evidence_dir = evidence_dir
        self.proc = None
        self.pgid = None
        self.pid = None
        self.launched = False
        self.ready = False
        self.state = "starting"
        self.exit_status = None
        self.timed_out = False
        self.expired = False
        self.cleanup_failures = []
        self.created_at = time.time()
        self.expires_at = self.created_at + lifetime_seconds
        self.stop_event = threading.Event()
        self.stdout = None
        self.stderr = None
        self.lifetime_thread = None

    def snapshot(self):
        if self.proc is not None:
            code = self.proc.poll()
            if code is not None and self.state not in {"stopped", "expired"}:
                self.exit_status = code
                if self.state not in {"failed"}:
                    self.state = "exited"
                self.launched = self.launched and True
                self.ready = False if code is not None else self.ready
        remaining = max(0, int(self.expires_at - time.time()))
        stdout_text, _ = _clip_text(self.stdout.text() if self.stdout else "")
        stderr_text, _ = _clip_text(self.stderr.text() if self.stderr else "")
        return {
            "service_id": self.service_id,
            "state": self.state,
            "launched": self.launched,
            "ready": self.ready,
            "pid": self.pid,
            "pgid": self.pgid,
            "endpoint": self.endpoint,
            "cwd": self.cwd,
            "command": self.command,
            "exit_status": self.exit_status,
            "lifetime_seconds": self.lifetime_seconds,
            "remaining_seconds": remaining if self.state in {"running", "ready", "starting"} else 0,
            "expired": self.expired,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "stdout_artifact": self.stdout.artifact() if self.stdout else None,
            "stderr_artifact": self.stderr.artifact() if self.stderr else None,
            "cleanup_failures": list(self.cleanup_failures),
        }


class DiagnosticSession:
    def __init__(
        self,
        env=None,
        evidence_dir=None,
        disk_stream_limit=DISK_STREAM_LIMIT,
        term_grace=TERM_GRACE_SECONDS,
        kill_grace=KILL_GRACE_SECONDS,
    ):
        self.parent_env = dict(os.environ if env is None else env)
        self.parent_home = self.parent_env.get("HOME")
        self.parent_paseo_home = self.parent_env.get("PASEO_HOME")
        self.parent_paseo_host = self.parent_env.get("PASEO_HOST")
        self.parent_architect_host = self.parent_env.get("ARCHITECT_HOST")
        self.job_id = str(self.parent_env.get("ARCHITECT_JOB_ID") or "local")
        self.disk_stream_limit = disk_stream_limit
        self.term_grace = term_grace
        self.kill_grace = kill_grace
        self.scratch_root = None
        self.scratch_work = None
        self.scratch_paseo_home = None
        self.services = {}
        self.foreground = []
        self.cancelled = False
        self.cancel_reason = None
        self._lock = threading.Lock()
        self._service_seq = 0
        self._command_seq = 0
        self._shutdown = False
        self.owned_path = None
        if self.parent_paseo_home:
            self.owned_path = (
                Path(self.parent_paseo_home) / "architect" / "jobs" / self.job_id / "owned-process-groups.json"
            )
        if evidence_dir is not None:
            self.evidence_dir = Path(evidence_dir)
        else:
            parent_home = self.parent_paseo_home or str(Path.home() / ".paseo")
            self.evidence_dir = (
                Path(parent_home) / "architect" / "artifacts" / "diagnostics" / self.job_id
            )
        self.evidence_dir.mkdir(parents=True, exist_ok=True)

    def request_cancel(self, reason="cancelled"):
        with self._lock:
            self.cancelled = True
            self.cancel_reason = reason
        self.stop_all_owned(include_services=True)

    def ensure_scratch(self):
        with self._lock:
            if self.scratch_root is not None:
                return self.scratch_work
            root = Path(tempfile.mkdtemp(prefix="architect-research-scratch-"))
            work = root / "work"
            paseo = root / "paseo"
            work.mkdir()
            paseo.mkdir()
            (paseo / "config.json").write_text('{"pluginsEnabled":false}\n', encoding="utf-8")
            self.scratch_root = root
            self.scratch_work = str(work)
            self.scratch_paseo_home = str(paseo)
            return self.scratch_work

    def child_env(self):
        self.ensure_scratch()
        env = dict(self.parent_env)
        for key in ISOLATE_ENV_KEYS:
            env.pop(key, None)
        env["PASEO_HOME"] = self.scratch_paseo_home
        if self.parent_home:
            env["HOME"] = self.parent_home
        return env

    def _resolve_cwd(self, cwd):
        if cwd is None or str(cwd).strip() == "":
            return self.ensure_scratch()
        path = str(cwd)
        if not os.path.isdir(path):
            raise ValueError(f"cwd does not exist: {path}")
        return path

    def _next_service_id(self, requested):
        if requested is not None and str(requested).strip():
            value = str(requested).strip()
            if len(value) > 64 or not all(ch.isalnum() or ch in "._-" for ch in value):
                raise ValueError("service_id must be 1-64 characters [A-Za-z0-9._-]")
            if value in self.services:
                raise ValueError(f"service_id already in use: {value}")
            return value
        while True:
            self._service_seq += 1
            value = f"svc-{self._service_seq}"
            if value not in self.services:
                return value

    def _evidence_path(self, label, stream):
        self._command_seq += 1
        return self.evidence_dir / f"{int(time.time() * 1000)}-{self._command_seq}-{label}-{stream}.log"

    def _owned_groups(self):
        groups = []
        for item in self.foreground:
            if item.get("pgid") is not None:
                groups.append({"kind": "command", "pgid": item["pgid"], "pid": getattr(item.get("proc"), "pid", None)})
        for service in self.services.values():
            if service.pgid is not None and service.state not in {"stopped", "expired", "failed", "exited"}:
                groups.append({"kind": "service", "service_id": service.service_id, "pgid": service.pgid, "pid": service.pid})
        return groups

    def _persist_owned(self):
        if self.owned_path is None:
            return
        try:
            self.owned_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "job_id": self.job_id,
                "pid": os.getpid(),
                "groups": self._owned_groups(),
            }
            self.owned_path.write_text(_json(payload) + "\n", encoding="utf-8")
        except Exception:
            pass

    def run_command(self, command, cwd=None, timeout_seconds=None):
        if self.cancelled:
            return _json(
                {
                    "ok": False,
                    "cancelled": True,
                    "reason": self.cancel_reason or "cancelled",
                    "cleanup_failures": [],
                }
            )
        command = str(command or "").strip()
        if not command:
            return _json({"ok": False, "error": "command is empty", "cleanup_failures": []})
        timeout, clamped = _clamp_int(
            timeout_seconds, FOREGROUND_TIMEOUT_DEFAULT, FOREGROUND_TIMEOUT_MAX
        )
        try:
            workdir = self._resolve_cwd(cwd)
        except ValueError as error:
            return _json({"ok": False, "error": str(error), "cleanup_failures": []})
        env = self.child_env()
        started = time.monotonic()
        stdout_path = self._evidence_path("cmd", "stdout")
        stderr_path = self._evidence_path("cmd", "stderr")
        try:
            proc = subprocess.Popen(
                [SHELL, "-c", command],
                cwd=workdir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as error:
            return _json(
                {
                    "ok": False,
                    "error": f"failed to launch command: {error}",
                    "cwd": workdir,
                    "shell": f"{SHELL} -c",
                    "cleanup_failures": [],
                }
            )
        try:
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            pgid = proc.pid
        owned = {"proc": proc, "pgid": pgid}
        with self._lock:
            self.foreground.append(owned)
            self._persist_owned()
        stdout = StreamDrain(proc.stdout, stdout_path, self.disk_stream_limit)
        stderr = StreamDrain(proc.stderr, stderr_path, self.disk_stream_limit)
        t_out = stdout.start()
        t_err = stderr.start()
        timed_out = False
        cleanup_failures = []
        try:
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                cleanup_failures.extend(
                    terminate_group(pgid, proc, self.term_grace, self.kill_grace)
                )
        finally:
            # A shell can exit while descendants still hold its pipes. Clean
            # the owned group on success and exceptions, not just timeouts.
            if not timed_out:
                cleanup_failures.extend(terminate_group(pgid, proc, self.term_grace, self.kill_grace))
            t_out.join(timeout=2)
            t_err.join(timeout=2)
            if t_out.is_alive() or t_err.is_alive():
                cleanup_failures.append("output drain still active after process-group cleanup")
            with self._lock:
                self.foreground = [item for item in self.foreground if item is not owned]
                self._persist_owned()
        duration = round(time.monotonic() - started, 3)
        code = proc.poll()
        stdout_text, stdout_clipped = _clip_text(stdout.text())
        stderr_text, stderr_clipped = _clip_text(stderr.text())
        truncated = bool(
            stdout.truncated or stderr.truncated or stdout_clipped or stderr_clipped
        )
        cleanup_failures.extend(stdout.cleanup_failures)
        cleanup_failures.extend(stderr.cleanup_failures)
        if timed_out and _alive(pgid):
            cleanup_failures.append(
                f"foreground process group {pgid} may still be running after timeout cleanup"
            )
        return _json(
            {
                "ok": (not timed_out) and code == 0,
                "exit_status": code,
                "timed_out": timed_out,
                "truncated": truncated,
                "timeout_seconds": timeout,
                "timeout_clamped": clamped,
                "duration_seconds": duration,
                "cwd": workdir,
                "shell": f"{SHELL} -c",
                "stdout": stdout_text,
                "stderr": stderr_text,
                "stdout_bytes": stdout.total,
                "stderr_bytes": stderr.total,
                "stdout_artifact": stdout.artifact(finalize=True),
                "stderr_artifact": stderr.artifact(finalize=True),
                "cleanup_failures": cleanup_failures,
                "parent_home": self.parent_home,
                "parent_paseo_home": self.parent_paseo_home,
            }
        )

    def start_service(
        self,
        command,
        service_id=None,
        cwd=None,
        ready_url=None,
        endpoint=None,
        ready_timeout_seconds=None,
        lifetime_seconds=None,
    ):
        if self.cancelled:
            return _json(
                {
                    "ok": False,
                    "cancelled": True,
                    "reason": self.cancel_reason or "cancelled",
                    "cleanup_failures": [],
                }
            )
        command = str(command or "").strip()
        if not command:
            return _json({"ok": False, "error": "command is empty", "cleanup_failures": []})
        lifetime, life_clamped = _clamp_int(
            lifetime_seconds, SERVICE_LIFETIME_DEFAULT, SERVICE_LIFETIME_MAX
        )
        ready_timeout, ready_clamped = _clamp_int(
            ready_timeout_seconds, SERVICE_READY_TIMEOUT_DEFAULT, SERVICE_READY_TIMEOUT_MAX
        )
        try:
            workdir = self._resolve_cwd(cwd)
            with self._lock:
                sid = self._next_service_id(service_id)
            env = self.child_env()
            service = ManagedService(
                sid, command, workdir, env, endpoint or ready_url, lifetime, self.evidence_dir
            )
            stdout_path = self._evidence_path(sid, "stdout")
            stderr_path = self._evidence_path(sid, "stderr")
            proc = subprocess.Popen(
                [SHELL, "-c", command],
                cwd=workdir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as error:
            return _json({"ok": False, "error": f"failed to launch service: {error}", "cleanup_failures": []})
        service.proc = proc
        service.pid = proc.pid
        try:
            service.pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            service.pgid = proc.pid
        service.stdout = StreamDrain(proc.stdout, stdout_path, SERVICE_DISK_STREAM_LIMIT)
        service.stderr = StreamDrain(proc.stderr, stderr_path, SERVICE_DISK_STREAM_LIMIT)
        service.stdout.start()
        service.stderr.start()
        with self._lock:
            self.services[sid] = service
            self._persist_owned()
        time.sleep(0.05)
        code = proc.poll()
        if code is not None:
            service.launched = False
            service.state = "failed"
            service.exit_status = code
            service.cleanup_failures.extend(service.stdout.cleanup_failures)
            service.cleanup_failures.extend(service.stderr.cleanup_failures)
            with self._lock:
                self.services[sid] = service
                self._persist_owned()
            snap = service.snapshot()
            snap["ok"] = False
            snap["error"] = f"process exited during launch with status {code}"
            snap["ready_timeout_seconds"] = ready_timeout
            snap["lifetime_clamped"] = life_clamped
            snap["ready_timeout_clamped"] = ready_clamped
            return _json(snap)
        service.launched = True
        service.state = "running"
        service.lifetime_thread = threading.Thread(
            target=self._expire_service, args=(sid,), daemon=True
        )
        service.lifetime_thread.start()
        ready_url = str(ready_url or "").strip() or None
        if ready_url:
            service.endpoint = service.endpoint or ready_url
            deadline = _now() + ready_timeout
            while _now() < deadline and not self.cancelled and not service.stop_event.is_set() and proc.poll() is None:
                if _http_ready(ready_url):
                    service.ready = True
                    service.state = "ready"
                    break
                time.sleep(0.1)
            if service.stop_event.is_set():
                service.ready = False
            elif proc.poll() is not None:
                service.exit_status = proc.poll()
                service.state = "failed"
                service.ready = False
            elif not service.ready:
                service.state = "running"
        else:
            service.ready = False
        with self._lock:
            self._persist_owned()
        snap = service.snapshot()
        snap["ok"] = service.launched and service.state in {"running", "ready"} and not service.stop_event.is_set()
        snap["ready_timeout_seconds"] = ready_timeout
        snap["lifetime_clamped"] = life_clamped
        snap["ready_timeout_clamped"] = ready_clamped
        snap["readiness"] = "ready" if service.ready else ("launched" if service.launched else "not_launched")
        return _json(snap)

    def _expire_service(self, service_id):
        service = self.services.get(service_id)
        if service is None:
            return
        remaining = max(0.0, service.expires_at - time.time())
        if service.stop_event.wait(remaining):
            return
        with self._lock:
            current = self.services.get(service_id)
            if current is None or current.stop_event.is_set():
                return
            current.expired = True
        self._stop_one(service_id, reason="lifetime")

    def service_status(self, service_id=None):
        with self._lock:
            if service_id:
                service = self.services.get(str(service_id).strip())
                if service is None:
                    return _json({"ok": False, "error": f"unknown service_id: {service_id}", "services": []})
                return _json({"ok": True, "services": [service.snapshot()]})
            return _json(
                {
                    "ok": True,
                    "services": [item.snapshot() for item in self.services.values()],
                    "scratch_work": self.scratch_work,
                    "scratch_paseo_home": self.scratch_paseo_home,
                    "evidence_dir": str(self.evidence_dir),
                    "cancelled": self.cancelled,
                }
            )

    def stop_service(self, service_id=None):
        if service_id:
            result = self._stop_one(str(service_id).strip(), reason="stop")
            return _json(result)
        results = []
        cleanup_failures = []
        with self._lock:
            ids = list(self.services.keys())
        for sid in ids:
            item = self._stop_one(sid, reason="stop")
            results.append(item)
            cleanup_failures.extend(item.get("cleanup_failures") or [])
        return _json({"ok": True, "services": results, "cleanup_failures": cleanup_failures})

    def _stop_one(self, service_id, reason="stop"):
        with self._lock:
            service = self.services.get(service_id)
        if service is None:
            return {"ok": False, "service_id": service_id, "error": f"unknown service_id: {service_id}", "cleanup_failures": []}
        service.stop_event.set()
        failures = []
        if service.pgid is not None:
            failures.extend(
                terminate_group(service.pgid, service.proc, self.term_grace, self.kill_grace)
            )
        if service.proc is not None:
            code = service.proc.poll()
            if code is not None:
                service.exit_status = code
        service.ready = False
        if reason == "lifetime":
            service.expired = True
            service.state = "expired"
        else:
            service.state = "stopped"
        service.cleanup_failures.extend(failures)
        with self._lock:
            self._persist_owned()
        snap = service.snapshot()
        snap["ok"] = not failures
        snap["stop_reason"] = reason
        return snap

    def stop_all_owned(self, include_services=True):
        failures = []
        with self._lock:
            foreground = list(self.foreground)
            service_ids = list(self.services.keys()) if include_services else []
        for item in foreground:
            failures.extend(
                terminate_group(item.get("pgid"), item.get("proc"), self.term_grace, self.kill_grace)
            )
        for sid in service_ids:
            result = self._stop_one(sid, reason="session")
            failures.extend(result.get("cleanup_failures") or [])
        return failures

    def shutdown(self):
        failures = []
        with self._lock:
            if self._shutdown:
                return {"cleanup_failures": list(getattr(self, "_shutdown_failures", [])), "scratch_removed": self.scratch_root is None}
            self._shutdown = True
        failures.extend(self.stop_all_owned(include_services=True))
        scratch = self.scratch_root
        if scratch is not None:
            try:
                shutil.rmtree(scratch, ignore_errors=False)
            except Exception as error:
                failures.append(f"scratch teardown failed: {error}")
                try:
                    shutil.rmtree(scratch, ignore_errors=True)
                    failures.append(f"scratch {scratch} may be partially removed")
                except Exception as nested:
                    failures.append(f"scratch {scratch} still present: {nested}")
            else:
                if Path(scratch).exists():
                    failures.append(f"scratch {scratch} still present after teardown")
                else:
                    self.scratch_root = None
                    self.scratch_work = None
                    self.scratch_paseo_home = None
        self._shutdown_failures = failures
        return {
            "cleanup_failures": failures,
            "scratch_removed": self.scratch_root is None,
            "evidence_dir": str(self.evidence_dir),
            "evidence_retained": self.evidence_dir.exists(),
        }


def _http_ready(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return 200 <= getattr(response, "status", 200) < 500
    except urllib.error.HTTPError as error:
        return 200 <= error.code < 500
    except Exception:
        return False


def unused_free_port():
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port
