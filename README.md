# qq-workflows

Ticket-driven planning, in-session teaching, and subagent delegation with two harnesses: **Muse Spark** (`muse`, default) and **Google Antigravity** (`agy`, opt-in).

You collaborate with a planning agent (**Architect**) to explore intent, make architectural decisions, and draft a specification ticket. When decisions require domain knowledge, Architect teaches interactively in-session until you can make an authentic choice. When the ticket is ready, Architect delegates to specialized subagents for implementation, research, and review.

The ticket is session-scoped at `.architect/tickets/<sessionId>.md`, automatically created and prefilled before execution.

## How it works

1. **Plan together.** Describe the change you want. Architect asks questions, investigates the codebase, and records scope and testing plans in `.architect/tickets/<sessionId>.md`.
2. **Teach in-session.** When an architectural fork requires unfamiliar domain knowledge, Architect teaches until you are informed enough to decide, recording the decision in the ticket.
3. **Research.** For documentation and codebase lookups, Architect delegates to a `researcher` — the `researcher` preset on the muse seat, or Antigravity's built-in `research` subagent on the gemini seat.
4. **Implement.** Architect prepares a dedicated worktree branch (`architect/<kind>/<sessionId.slice(0,8)>`) and delegates to `implementer` working in that checkout. Children leave changes uncommitted; only the architect session lands.
5. **Review.** Architect delegates to `reviewer` to verify changes against the testing plan in that checkout without altering project code.
6. **Land.** When review passes, Architect lands the work: commits changes, creates and merges the PR via `gh` with `--delete-branch` (or fast-forwards local main for local repos), retires the worktree (`git worktree remove`), and cleans up the local branch (`git branch -d`).

## Quick Start

### 1. Install Agents, Presets & Launchers

Clone the repository and install both harnesses:

```bash
git clone https://github.com/hypermemetic-ai/qq-workflows.git
cd qq-workflows
npm run install:agents
```

This:

- Ensures `presets.{architect,implementer,reviewer,researcher}` exist in the muse `settings.json` (`$XDG_CONFIG_HOME/muse` when set, else `~/.config/muse`), creating missing names as `{}` while preserving all pre-existing content, and registers the `qq-workflows` MCP server there.
- Links the `muse-architect` launcher into `~/.local/bin/` (target: `bin/muse-architect.sh` in this repo).
- Links `architect`, `implementer`, and `reviewer` into `~/.gemini/config/agents/`.
- Configures the `architect-ticket` `PreInvocation` hook in `~/.gemini/config/hooks.json` to automatically create `.architect/tickets/<sessionId>.md` from template before turn 1.
- Registers the `qq-workflows` MCP server in `~/.gemini/config/mcp_config.json` providing `prepare_worktree` and `land`.
- Installs the `architect` CLI launcher into `~/.local/bin/architect`.

The installer also removes two stale artifacts when present (with a stdout note): the old `opencode` → `muse-architect` alias in `~/.local/bin/` (anything else named `opencode` is left alone) and the hardcoded `architect/AGENTS.md` prompt (the launcher now renders from `agents/architect/agent.md`).

Old ticket mirrors under `~/.gemini/antigravity-cli/brain/` from previous versions are orphaned and harmless; the installer leaves user files alone and never recreates them.

### 2. Start an Architecture Session (Muse)

In any project repository, run:

```bash
muse-architect
```

This seeds `.architect/tickets/<sessionId>.md` (reusing `--session <id>` when given), renders the architect prompt from `agents/architect/agent.md`, and execs `muse --preset architect --yolo` with the ticket open. See `muse-architect --help` for options.

Alternatively, via the `architect` launcher (same session, provider-switchable):

```bash
architect
architect --provider gemini
```

### 3. Start an Architecture Session (Antigravity)

Via Antigravity CLI directly:

```bash
agy --agent architect
```

Or invoke `architect` from an active Antigravity session.

## Presets

`muse exec --preset <name>` requires the name to exist, so the installer guarantees the four seat names (`architect`, `implementer`, `reviewer`, `researcher`) in the muse `settings.json`. Preset content stays `{}`: role text rides in the delegation prompts built by `prepare_worktree`, not in preset configuration.

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

The architect launcher takes `--provider` / `ARCHITECT_PROVIDER` (default `muse`, served via `muse-architect`; override the binary with `MUSE_ARCHITECT_BIN`).

Unknown provider strings throw `unknown provider '<x>': expected 'muse' | 'gemini' | 'deepseek'`. A known provider resolving for a seat it does not serve throws `provider '<p>' does not support seat '<seat>'` with no silent fallback — so a global `deepseek` works for `bounded` tickets, while `open`/`research` tickets need explicit per-seat overrides for the reviewer/researcher seats.

The deepseek seat needs operator-side prerequisites the installer does not manage: a `~/.dsh` profile named `implementer` and a `DEEPSEEK_API_KEY` in the environment.

## Development & Testing

Run the test suite:

```bash
npm test
```
