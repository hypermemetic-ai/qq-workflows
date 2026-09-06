from contextlib import redirect_stdout
import json
import argparse
import sys
import threading
import traceback

from .agent import run_research
from .recovery import (
    HEARTBEAT_LINE,
    DegenerationError,
    PermanentError,
    RecoveryExhausted,
    classify_failure,
    failure_details,
    emit_result,
    summarize_failure,
)


def _heartbeat(stop):
    while not stop.wait(10):
        print(HEARTBEAT_LINE, file=sys.stderr, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Short bounded fact-finder. Prints the answer and exits.",
    )
    parser.add_argument("question", nargs="?", help="The exact question to answer")
    args = parser.parse_args(argv)
    question = args.question or sys.stdin.read()
    stop = threading.Event()
    beat = threading.Thread(target=_heartbeat, args=(stop,), daemon=True)
    beat.start()
    try:
        with redirect_stdout(sys.stderr):
            answer = run_research(question)
        if not isinstance(answer, str) or not answer.strip(): raise ValueError("invalid completion: empty answer")
        print(json.dumps({"version": 1, "kind": "research_completion", "ok": True, "answer": answer}, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        details = failure_details(error)
        print(json.dumps({'version': 1, 'kind': 'research_completion', 'ok': False, 'error': details}), flush=True)
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        stop.set()


if __name__ == "__main__":
    raise SystemExit(main())
