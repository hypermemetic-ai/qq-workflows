# qq-workflows

Ticket-driven planning, in-session teaching, and subagent delegation natively built for **Google Antigravity** (`agy`).

You collaborate with a planning agent (**Architect**) to explore intent, make architectural decisions, and draft a specification ticket. When decisions require domain knowledge, Architect teaches interactively in-session until you can make an authentic choice. When the ticket is ready, Architect delegates to specialized subagents for implementation, research, and review.

The ticket is session-scoped at `.architect/tickets/<sessionId>.md`, automatically created and prefilled before execution.

## How it works

1. **Plan together.** Describe the change you want. Architect asks questions, investigates the codebase, and records scope and testing plans in `.architect/tickets/<sessionId>.md`.
2. **Teach in-session.** When an architectural fork requires unfamiliar domain knowledge, Architect teaches until you are informed enough to decide, recording the decision in the ticket.
3. **Research.** For documentation and codebase lookups, Architect invokes Antigravity's built-in `research` subagent.
4. **Implement.** Architect prepares a dedicated worktree branch (`architect/<kind>/<sessionId.slice(0,8)>`) and delegates to `implementer` working in that checkout.
5. **Review.** Architect delegates to `reviewer` to verify changes against the testing plan in that checkout without altering project code.
6. **Land.** When review passes, Architect lands the work: commits changes, creates and merges the PR via `gh` with `--delete-branch` (or fast-forwards local main for local repos), retires the worktree (`git worktree remove`), and cleans up the local branch (`git branch -d`).

## Quick Start

### 1. Install Agents & Hook

Clone the repository and install the agents and lifecycle hook:

```bash
git clone https://github.com/hypermemetic-ai/qq-workflows.git
cd qq-workflows
npm run install:agents
```

This:
- Links `architect`, `implementer`, and `reviewer` into `~/.gemini/config/agents/`.
- Configures the `architect-ticket` `PreInvocation` hook in `~/.gemini/config/hooks.json` to automatically create `.architect/tickets/<sessionId>.md` from template before turn 1.
- Registers the `qq-workflows` MCP server in `~/.gemini/config/mcp_config.json` providing `prepare_worktree` and `land`.
- Installs the `architect` CLI launcher into `~/.local/bin/architect`.

### 2. Start an Architecture Session

In any project repository, run:

```bash
architect
```

Or via Antigravity CLI directly:

```bash
agy --agent architect
```

Or invoke `architect` from an active Antigravity session.

## Providers

Each delegation seat (implementer, reviewer, researcher, architect) is served by a provider. Every seat defaults to `muse`; DeepSeek serves implementation only:

| Seat | `muse` | `gemini` | `deepseek` |
| --- | --- | --- | --- |
| implementer | ✓ | ✓ | ✓ |
| reviewer | ✓ | ✓ | — |
| researcher | ✓ | ✓ | — |
| architect | ✓ | ✓ | — |

`muse` delegates via `muse exec --preset <seat> --yolo`, `gemini` via `agy --agent <seat> --conversation <uuid> --print-timeout 60m --print` (Gemini's built-in research subagent serves the researcher seat), and `deepseek` via `dsh --profile implementer`.

Switch providers globally or per seat. Per-seat precedence: seat arg > seat env > global arg > global env > `muse`:

| Scope | `prepare_worktree` arg | Env |
| --- | --- | --- |
| global | `provider` | `QQ_WORKFLOW_PROVIDER` |
| implementer | `implementerProvider` | `QQ_IMPLEMENTER_PROVIDER` |
| reviewer | `reviewerProvider` | `QQ_REVIEWER_PROVIDER` |
| researcher | `researcherProvider` | `QQ_RESEARCHER_PROVIDER` |

The architect launcher takes `--provider` / `ARCHITECT_PROVIDER` (default `muse`, served via opencode).

Unknown provider strings throw `unknown provider '<x>': expected 'muse' | 'gemini' | 'deepseek'`. A known provider resolving for a seat it does not serve throws `provider '<p>' does not support seat '<seat>'` with no silent fallback — so a global `deepseek` works for `bounded` tickets, while `open`/`research` tickets need explicit per-seat overrides for the reviewer/researcher seats.

## Development & Testing

Run the test suite:

```bash
npm test
```
