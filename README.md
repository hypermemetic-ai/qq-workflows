# qq-workflows

Ticket-driven planning, in-session teaching, and subagent delegation with two harnesses: **Muse Spark** (`muse`, default) and **Google Antigravity** (`agy`, opt-in).

You collaborate with a planning agent (**Architect**) to explore intent, make architectural decisions, and draft a specification ticket. When decisions require domain knowledge, Architect teaches interactively in-session until you can make an authentic choice. When the ticket is ready, Architect delegates to specialized subagents for implementation, research, and review.

The ticket is session-scoped at `.architect/tickets/<sessionId>.md`, automatically created and prefilled before execution.

## How it works

1. **Plan together.** Describe the change you want. Architect asks questions, investigates the codebase, and records scope and testing plans in `.architect/tickets/<sessionId>.md`.
2. **Teach in-session.** When an architectural fork requires unfamiliar domain knowledge, Architect teaches until you are informed enough to decide, recording the decision in the ticket.
3. **Research.** For documentation and codebase lookups, Architect delegates investigation to the `runner` seat (`dispatch_runner`); research is ordinary runner work, not a separate seat.
4. **Implement.** Architect prepares a dedicated worktree branch (`architect/<kind>/<sessionId.slice(0,8)>`) and delegates to `implementer` working in that checkout — through the centrally configured worker harness (see *Worker harness*). Children leave changes uncommitted; only the architect session lands.
5. **Review.** Architect delegates to `reviewer` (same central harness) to verify changes against the testing plan in that checkout without altering project code.
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

## Worker harness (central, operator-owned)

The three worker seats — `runner`, `implementer`, `reviewer` — do not select a
provider, model, endpoint, effort level, or harness. Every one of them launches
the same centrally configured worker harness, resolved from the operator's
configuration file `~/.config/qq-workflows/worker-config.json`
(`QQ_WORKER_CONFIG_FILE` overrides the path):

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "base_url": "https://api.deepseek.com",
  "wire_api": "responses",
  "env_key": "DEEPSEEK_API_KEY",
  "api_key_file": "~/.config/qq-workflows/deepseek-api-key",
  "harness": "deepseek-minimal",
  "reasoning_effort": "max"
}
```

`harness` selects the runtime that executes a seat turn: `deepseek-minimal`
(the pinned DeepSeek Harness runtime under
`~/.local/state/qq-workflows/deepseek-minimal-runtime`) or `codex` (the Codex
CLI with the same DeepSeek provider/model pins). The DeepSeek pin
(`provider`/`model`/`base_url`/`reasoning_effort`) is validated exactly and
fails closed: any other value refuses the launch instead of substituting a
provider, model, or effort level.

One resolution point (`workflow/worker-launch.mjs` →
`workflow/worker-config.mjs`) serves every entry point:

| Entry point | Seat(s) |
| --- | --- |
| native workflow runner (`dispatch_runner`, `workflow/operations.mjs`) | runner |
| managed execution pipeline (`dispatch_execution` → implementer/reviewer) | implementer, reviewer |
| manual delegation (`bin/worker-exec.mjs`, `prepare_worktree` handoff) | all three |

Fail-closed rules that hold for all three seats:

- A missing central configuration, a missing/incompatible configured runtime, a
  pin violation, or a conflicting legacy provider environment refuses the
  launch with an actionable diagnostic. There is no fallback to `agy`, native
  Codex, `pi`, or a harness discovered inside the target project.
- Per-call provider selection is refused (`provider`, `implementerProvider`,
  `reviewerProvider`, `researcherProvider`, and the `QQ_*_PROVIDER`
  environment variables). Worker provider selection belongs to operator
  configuration, not to architect arguments.
- The target repository is a working directory only. The harness executable,
  adapter source, and runtime root come from the installed integration source
  and the operator's state directory — never from a project-local launcher.
- A runner keeps its bound identity and explicit result transport
  (`QQ_RUNNER_ID` / `QQ_RUNNER_RESULT_FILE`); implementer/reviewer never inherit
  them. Research work is ordinary runner work (`dispatch_runner`), not a
  separate seat.
- The final worker narrative has ONE authoritative cap
  (`workflow/limits.mjs`: 16,384 characters), enforced fail-closed by the
  `complete_task` transport, the result reader, the DeepSeek Minimal adapter,
  and the seat contracts.

The architect seat is unchanged: the launcher takes `--provider` /
`ARCHITECT_PROVIDER` (default `muse`, served via `muse-architect`; override the
binary with `MUSE_ARCHITECT_BIN`), and unknown or unsupported values throw with
no silent fallback.

### Reused production worker source

The central worker contract and its DeepSeek Minimal harness were promoted from
the audited prototype into this repository. Reused verbatim (reviewed production
source): `workflow/worker-config.mjs` (central configuration, pins, seat
contracts, the `deepseek-minimal` launch branch), `workflow/limits.mjs`
(single-source narrative cap), `prototype/deepseek-minimal/**` (the harness
adapter `adapter/*`, the pinned runtime setup `scripts/setup-runtime.mjs`, the
seat-scoped search gateway `gateway/*` + `profile/*`, the `read_image`
plugin/overlay, the loopback provider double `mock/*`, `PIN.json`, and the
runtime acceptance suite `tests/t1..t11`), the seat role contracts
`agents/{runner,implementer,reviewer}/agent.md`.

Adapted for this integration:

- `workflow/worker-launch.mjs` was replaced by the central resolution contract
  above: it no longer probes the target project for an executable and has no
  `agy`/legacy-fallback branch. The retired executable overrides (for example
  `QQ_WORKER_EXEC`) are refused explicitly.
- `bin/worker-exec.mjs` now passes the runner's bound identity/result transport
  into the central launch (`--runner-id` / `--runner-result-file`, or exactly
  those two environment variables) instead of relying on an ambient identity.
- `workflow/results.mjs` derives `COMPLETE_TASK_RESPONSE_MAX` from
  `workflow/limits.mjs`, so the completion transport and the seat contracts can
  not disagree about the cap.
- `bin/mcp-server.mjs` launches the runner (native MCP `dispatch_runner`) and the
  managed implementer/reviewer seats through the same central constructor,
  refuses provider overrides at `prepare_worktree`/`dispatch_execution`, emits
  the `bin/worker-exec.mjs` delegation handoff instead of per-provider command
  templates, and reports research delegation as a `dispatch_runner` handoff.
- `pi-extension/managed-execution.mjs` refuses to drive a pipeline revision that
  does not carry the central launch contract.

The central worker tests carried with it are
`tests/{worker-central-contract,worker-launch,deepseek-minimal,worker-effort-wire}.mjs`.

### Release packaging

The integration has no npm dependency of its own and resolves the pinned worker
runtime from the operator's state directory, not from the checkout it is started
in, so a versioned deployment is a plain source archive of the landed revision:

```bash
LANDED_SHA=$(git rev-parse HEAD)
DEST=$HOME/.local/share/qq-workflows/releases/$LANDED_SHA
mkdir -p "$DEST"
git archive --format=tar "$LANDED_SHA" | tar -C "$DEST" -xf -
node "$DEST/scripts/install-architect.mjs"     # installs the profile + plugin, verifies it runs
```

- The archive must include `prototype/deepseek-minimal/**` (adapter, gateway,
  profiles, plugin, setup script, pins, provider double) and
  `workflow/{worker-config,worker-launch,limits}.mjs` + `bin/worker-exec.mjs`;
  without the adapter source a `deepseek-minimal` launch fails closed with
  "no adapter source at ..." instead of substituting another harness.
- `.git` is not needed: the acceptance suites and a real dispatch run from an
  extracted archive (`git archive` of the landed revision) with no `.git` and no
  `node_modules`; the target projects are ordinary repositories, and the harness
  is still the one the operator configured.
- Deployment is versioned on purpose: agent/plugin installs symlink the release
  directory, so a mutable development checkout must never be the installed
  source. The pinned runtime under `~/.local/state/qq-workflows/` is reused
  as-is; do not re-materialize it unless the adapter reports an incompatible
  artifact.

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
  through one controlled mechanism (`before_agent_start`). The stock pi coding
  prompt is replaced, and the assembled prompt is then re-asserted at the
  provider boundary (`before_provider_request`), so an append from another
  extension or the daemon cannot leak into the request. Every wire shape pi
  0.84.1 serializes for selectable models is covered: `instructions`
  (codex/responses), `input[]` system/developer messages (OpenAI Responses),
  `messages[]` system/developer messages (chat completions, Mistral), `system`
  as a string or as a block array (Anthropic typed blocks and Bedrock bare
  `{text}` blocks — a second text block in the same slot is dropped as an
  append), and `systemInstruction` / `config.systemInstruction` as a string or
  `{parts:[{text}]}` (Google Generative AI and Vertex).
  `QQ_ARCHITECT_PROMPT_CAPTURE=<file>` records the assembled prompt, the enforced
  payload with the path it replaced, the active tools, the runtime compaction
  settings, and compaction events for verification.
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
- **Long sessions.** pi's shared setting disables automatic compaction, which
  must not become a silent context overflow. The extension therefore enforces
  the profile's own trigger: it compacts at 75% of the context window or at the
  reserved-token floor (whichever fires first), at most once per minute, never
  while a turn is streaming, with ticket state, decisions, running job ids, and
  report references preserved by the compaction instructions. The runtime's own
  `reserveTokens` widens that trigger. pi 0.84.1's `ctx.compact()` accepts no
  retention budget (`CompactOptions` carries only `customInstructions`,
  `onComplete`, and `onError`) and `keepRecentTokens` lives in pi's settings
  files, which this profile must not rewrite: it reads the effective values
  through that documented channel (`PI_CODING_AGENT_DIR` or
  `<cwd>/.pi/settings.json`), records them in the capture, and warns once per
  session when the runtime retention falls below the profile's floor or cannot
  free room inside the selected model's window. The shared
  `compaction.enabled=false` stays where it belongs: ordinary pi sessions keep
  their own behaviour, and the Architect still compacts.

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

### Compatibility with the MCP architecture

The MCP server keeps working through a thin adapter. The transport-independent
modules (`workflow/results.mjs`, `workflow/notify.mjs`, `workflow/reports.mjs`,
`workflow/jobs.mjs`) are the shared implementation: the pinned
32,768-character `complete_task` contract, the durable runner-findings
retention/replay path (`cleanupRunnerFiles`, `retainRunnerFindings`,
`retry_runner_notification`), the findings-free `check_runner` trajectory, and
the in-flight/retry delivery semantics are unchanged. Terminal results are
persisted to the report store **before** the notification, which is bounded and
carries the report reference, and the durable record states exactly what the
transport achieved (acceptance, not a delivered turn).

This branch also carries one prerequisite inherited from local `main`: the
operator-action tools (`workflow/operator-action.mjs`, `tests/operator-action.mjs`)
and their `bin/mcp-server.mjs` wiring. The adapter imports that module, so it
ships unchanged apart from the integration; it is not part of the Architect
migration and does not affect the Architect profile (the tools stay disabled
unless `QQ_ENABLE_OPERATOR_ACTION=1`).

## Development & Testing

Run the test suite:

```bash
npm test
```

`tests/run.mjs` runs every `tests/*.mjs` file in an isolated environment (its own
durable state directory, findings directory, and notification backstop), so no
test reads or writes the operator's live state. The Architect-specific suites are
`architect-pi-extension.mjs` (prompt enforcement at the provider boundary, tool
surface, compaction policy, delivery), `architect-operations.mjs` (native
workflow tools and the mocked runner roundtrip), `architect-state.mjs` (durable
jobs, reports, restart recovery, over-cap spill), `architect-install.mjs`
(installer idempotence and isolation), and `mcp-durable-notify.mjs` (the merged
MCP terminal path: persist-before-notify, bounded delivery, retry/coalescing,
and retention pruning).

The central worker launch contract has its own suites:
`worker-central-contract.mjs` (both target repositories, all three seats, the
runner/managed-execution/manual entry points, provider-override refusal,
fail-closed runtime and configuration checks, and read-only worker
configuration), `worker-launch.mjs` (per-seat launch semantics and role
contracts), `deepseek-minimal.mjs` (harness selector, Messages endpoint mapping,
output-token setting, adapter fail-closed boundaries), and
`worker-effort-wire.mjs` (on-wire reasoning effort, run against a local capture
server with the installed Codex client; skipped when no client is installed).

The runtime-backed acceptance suite for the pinned DeepSeek Minimal harness boots
the real runtime against a loopback provider double and is kept separate because
it requires the pinned runtime to be materialized:

```bash
node prototype/deepseek-minimal/tests/run.mjs            # t7 production adapter, t8 relocation, t9 quiet window, ...
node prototype/deepseek-minimal/tests/run.mjs t7         # one file
```
