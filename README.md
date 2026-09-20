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
- Links the `opencode` alias into `~/.local/bin/` (target: `bin/muse-architect.sh`) so Orca detects its built-in opencode slot as installed, and renames that slot's display labels to `Muse Spark` in Orca's shipped bundles (a foreign `opencode` entry is always left alone).
- Links `architect`, `implementer`, and `reviewer` into `~/.gemini/config/agents/`.
- Configures the `architect-ticket` `PreInvocation` hook in `~/.gemini/config/hooks.json` to automatically create `.architect/tickets/<sessionId>.md` from template before turn 1.
- Registers the `qq-workflows` MCP server in `~/.gemini/config/mcp_config.json` providing `prepare_worktree` and `land`.
- Installs the `architect` CLI launcher into `~/.local/bin/architect`.

The installer also removes one stale artifact when present (with a stdout note): the hardcoded `architect/AGENTS.md` prompt (the launcher now renders from `agents/architect/agent.md`).

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

## Paseo-native Architect (pi)

The Architect can be selected directly inside Paseo instead of a terminal
launcher. The profile is a custom Paseo provider (`qq-architect`) that extends
`pi`, so the operator picks the model in the app and pi's own authentication is
reused. Worker roles (runner, implementer, reviewer) are untouched: they keep
the existing centrally configured harness and pins, and no part of this profile
can select a provider, model, endpoint, or effort level for them.

### Install

```bash
npm run install:architect          # add the provider + agent profile, install the Paseo plugin
npm run install:architect -- --dry-run    # report the plan without changing anything
npm run install:architect -- --rollback   # restore the pre-install Paseo config and remove the plugin
```

The installer:

- removes exactly the two confirmed obsolete dangling pi extension entries
  (`~/.pi/agent/extensions/qq` and `~/.pi/agent/extensions/subagent`) and only
  while they are dangling symlinks; targets, unrelated extensions, unrelated
  config, and credentials are never touched;
- adds/updates the `qq-architect` provider entry and `Architect` agent profile in
  the Paseo daemon config, preserving every other key, and keeps a pre-install
  backup for rollback;
- validates `paseo-plugin/paseo-plugin.json` against the daemon's strict manifest
  schema before anything is installed, so an unrecognized key is reported by the
  installer instead of surfacing as a rejected `paseo plugin install` (the schema
  accepts exactly `id`, `requirements`, and `build`);
- installs the `paseo-plugin/` plugin through `paseo plugin install`, runs
  `paseo plugin enable`, sets **`pluginsEnabled: true`** (a plugin cannot start
  while the daemon-wide switch is off), asks the daemon to `reload` config.json
  (no restart), and then verifies the plugin reports `running`. If it does not,
  the install is reported as `installed-not-running` with the operator action
  instead of claiming success. Rollback restores the previous `pluginsEnabled`
  value from the pre-install backup;
- never writes worker provider/model/harness/effort pins.

In the app, the Architect appears as the **Architect (qq-workflows)** provider
and as the **Architect** agent profile. Creating or resuming that agent binds the
stable Paseo agent ID as the workflow session key before the first turn (the
installed plugin injects the identity env during `agent.session_open`), so the
ticket (`.architect/tickets/<sessionId>.md`) survives reopen and resume. The
ticket is never inferred from directory recency, and the extension falls back to
the daemon-set `PASEO_AGENT_ID` when the plugin is not running, so the identity
binding degrades rather than breaks.

### Profile boundaries

- **Prompt.** The final system prompt is the owned Architect prompt
  (`agents/architect/agent.md`) plus repository instructions and skills included
  through one controlled mechanism. The stock pi coding prompt is replaced, and
  the prompt is re-asserted at the provider boundary so an append from another
  extension or the daemon cannot leak into the request. `QQ_ARCHITECT_PROMPT_CAPTURE=<file>`
  records the assembled prompt, the enforced payload, the active tools, and
  compaction events for verification.
- **Tools.** `read`, `grep`, `find`, `ls` plus the native workflow tools
  (`read_ticket`, `update_ticket`, `dispatch_runner`, `check_runner`,
  `await_runner`, `steer_runner`, `cancel_runner`, `read_report`, `list_jobs`,
  `recover_deliveries`) and the managed implementation delegation
  (`dispatch_execution`, `check_execution`, `await_execution`, which call the
  repository's existing pipeline as a library — no MCP transport, no separate
  implementation path). There is no shell, editor, or write tool, and a tool
  guard blocks any non-allowlisted tool. Scoped ticket updates and explicitly
  approved delegation remain intentional capabilities; low-level land/branch
  mutation is not exposed.
- **Isolation.** The provider entry launches `pi --no-extensions --extension
  <repo>/pi-extension/qq-architect.mjs`, so only the owned extension (plus the
  extension Paseo always passes explicitly) loads into this profile. Global pi
  extensions, moods/harness settings, and instructions of other providers are
  unaffected, and ordinary Codex/pi sessions in Paseo keep their normal
  behaviour.
- **Long sessions.** pi's shared setting disables automatic compaction; this
  profile compacts itself at its own threshold (75% of the context
  window or the reserved-token floor), at most once per minute, never while a
  turn is streaming, with ticket state, decisions, running job ids, and report
  references preserved by the compaction instructions.

### Completion delivery and the recovery boundary

Every job (runner or execution) has a durable record under
`.architect/state/`: identity and ownership, phase/status, process fingerprint,
launch-plan provenance, cancellation tombstone, terminal result, and the
delivery state of its notification. Complete terminal results and failure
diagnostics are persisted to `.architect/state/reports/` **before** anything is
notified; notifications carry a bounded summary (16,384 characters, the observed
transport cap) plus a report reference, and the full report is retrievable in
chunks with `read_report`. A worker result that exceeds the pinned
32,768-character `complete_task` cap is spilled verbatim to the report store
instead of being lost.

Delivery is explicit about what happened: idle sessions start a turn, busy
sessions queue/steer without interrupting the operator's active work, and the
record distinguishes transport acceptance, queued, delivered, and result
availability. Event IDs are stable, so repeated callbacks and reconnects never
duplicate a side effect.

Automatic on restart, for every pi start reason: pi emits `startup` for a fresh
CLI session and for `--session <file>` (the shape Paseo opens), `resume`/`new`/
`fork` from its SDK runtime, and `reload` for `/reload`, so recovery is not gated
on a reason the runtime never produces. It runs once the session is ready —
after the `session_start` handler returned and pi's initialization continuation
resumed — because a turn fabricated while the session is still opening would race
pi's own initialization and the operator's first prompt. A completion offered in
that window is neither sent nor claimed: its durable record stays pending and the
readiness step delivers it exactly once.

Records are then reconciled against live processes (fingerprint-checked, so a
reused PID is never adopted or signalled), undelivered completion notifications
are replayed for their owning session only, and cancellations stay tombstoned. A
recovered completion in an idle session starts a turn — including a reopened
session the operator has not spoken in yet; in a busy session it is steered
between tool calls and never interrupts the active work. Everything else is
deliberately manual: an interrupted or reconciliation-required job is surfaced
with `interrupted`, `pid-reused`, or `process-unreadable` and its artifacts, and
is never restarted, never marked complete, and never silently re-run.
Implementation, review, and landing are not replayed after an uncertain crash —
inspect the record and decide explicitly. `recover_deliveries` and `/qq_recover`
remain available as explicit operator-triggered recovery.

## Development & Testing

Run the test suite:

```bash
npm test
```
