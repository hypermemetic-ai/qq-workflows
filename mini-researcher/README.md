# mini-researcher

Python runtimes for Paseo Architect: a smolagents Researcher and an Implementer wrapping the pinned upstream Mini v2 loop. Both use Grok 4.6 high and the host's durable recovery journal. See the [workflow README](../README.md) for installation and use in Paseo.

## Run

```sh
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
export BRAVE_API_KEY=...          # and/or EXA_API_KEY
.venv/bin/mini-researcher "What does RFC 9110 say Transfer-Encoding means?"
```

Brave is lexical search. Exa is semantic search. `visit_webpage` fetches a URL as text. Indexed workspace search uses zg. It finishes by calling `done`. The model is pinned to Grok 4.6 with high reasoning. The host journals provider requests and grants recovery actions; stdout carries only a versioned completion envelope, and progress goes to stderr. Healthy research has no overall step or wall-time limit.

## Tests

```sh
.venv/bin/python -m pytest tests
```
