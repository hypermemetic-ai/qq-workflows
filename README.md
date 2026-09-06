# Paseo Architect

A ticket-driven workflow for planning, teaching, research, implementation, review and landing in Paseo.

Architect uses Astra high and keeps the current and previous exchanges in context. Decisions live in `.architect/ticket.md`. Teacher, Researcher and Implementer use Grok 4.6 high.

- **Teacher** uses Grok's native conversational harness with a restricted agent profile.
- **Researcher** uses smolagents, repository search and web search, returning an answer and sources.
- **Implementer** runs the pinned upstream Mini v2 loop in an indexed worktree.
- **Bounded work** lands directly. **Open work** receives an immutable-revision OCR review, at most one correction in the same worktree, and a second review before landing.

## Setup

Requires Node with `node:sqlite`, Python 3.10+, Paseo 0.7.2, the Grok CLI, `zg`, Git, GitHub CLI and OCR 1.11.5. Authenticate the model providers and GitHub CLI before use.

Run from the repository root:

```bash
npm ci --prefix paseo-plugin
python3 -m venv runtimes/python/.venv
runtimes/python/.venv/bin/pip install -e './runtimes/python[dev]'
npm run typecheck
paseo plugin install "$PWD/paseo-plugin"
paseo plugin reload architect
```

Plugins must be enabled in the selected Paseo daemon. Set `PASEO_HOME` and `PASEO_HOST` before installation to target a specific home and endpoint. The [scratch recipe](.architect/scratch.md) includes concrete setup and cleanup commands for an isolated daemon and disposable repositories.

For web research, supply `BRAVE_API_KEY` and/or `EXA_API_KEY` to the daemon, or store them in a private `$PASEO_HOME/architect/credentials.yaml`:

```yaml
BRAVE_API_KEY: your-brave-key
EXA_API_KEY: your-exa-key
```

Restrict that file to its owner (`chmod 600`). `ARCHITECT_CREDENTIALS` selects another credential file; `GROK_TOKEN_HELPER` can select an existing Grok token helper.

## Use

Open a repository workspace in Paseo and choose **Start architect** from the command center. Work with Architect in the conversation and follow the ticket in the **Ticket** panel. Open a Teacher session when Architect asks you to learn about a parked question. Child sessions and their status appear with the workspace ticket.

Repositories can optionally provide `.architect/scratch.md` to describe their preferred test environment. Architect records any different setup the work needs in the ticket.

## Recovery and landing

An independent host stores jobs, attempt journals, completion receipts and acknowledged wake messages in SQLite beneath `$PASEO_HOME/architect`. Duplicate completion returns the same receipt. Plugin reload preserves work; a changed host drains existing jobs before upgrading.

Recovery permits three provider attempts, one output repair, one known-safe process restart and six recovery actions across a delegation and its correction cycle. Circuit and repetition histories persist. Missing heartbeats trigger diagnosis; commands and publication with unknown outcomes require inspection before proceeding.

Remote landing pushes the intended branch, identifies its PR and verifies the merged revision. Local landing requires a fast-forward onto `main` or `master`; divergent work remains intact.

## Development

```bash
npm test
npm run test:python
npm run typecheck
# Optional: makes real Astra requests using configured credentials.
npm run test:live
```

The [code guide](docs/architecture.md) maps the entry points and supporting modules. The Node suite includes compilation with the installed Paseo compiler. Python tests exercise the actual Mini and smolagents loops. See the [verification record](docs/verification.md) for live role, recovery, publication and UI evidence.

| Directory | Contents |
| --- | --- |
| `paseo-plugin/` | Paseo UI, role adapters and durable host |
| `runtimes/python/` | Python Researcher and Mini Implementer runtimes, with Python tests |
| `tests/` | Workflow and plugin integration tests |
| `.architect/` | Repository ticket, template and optional scratch recipe |
| `docs/` | Architecture and verification notes |

Installed dependencies, search indexes and raw verification artifacts are ignored. Runtime state and credentials belong in the selected Paseo home.
