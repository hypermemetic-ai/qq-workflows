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
durable record distinguishes what the transport achieved from what the session
actually retained:

* `accepted` / `queued` — the transport took the message (a queue command exited
  0, or pi accepted the steer behind the active turn). **Volatile**: no receipt
  proves the session kept it, so a crash before the queue drains cannot silently
  lose the wakeup. These states stay reconcilable.
* `delivered` — a **receipt** proves the owning session retained this exact
  event: the pi session entry whose `details` carry the event/job identity (the
  busy/steer path), the exact session user message pi appended (the idle path),
  or the turn pi started for it. Never merely transport acceptance, never model
  turn success. The evidence (`kind`, entry id, session file, observed time) is
  recorded on both the notification and the job record.
* `failed` — the transport refused it; nothing was accepted, so it stays
  retryable.
* `unknown` — the outcome cannot be proven: a record from an older release has
  no stable event identity at all, the owning session's evidence could not be
  read, or the only evidence is a completion entry whose text cannot be tied to
  exactly one event. It is never reported as delivered. The exact reason is
  recorded (`missing-event-identity`, `no-session-evidence`,
  `legacy-completion-identity-ambiguous`,
  `legacy-completion-identity-unconfirmed`). A record that only lacked readable
  evidence is re-evaluated on the next pass that has it (proven retention
  acknowledges it, proven absence replays it). An identity-less record stays
  identity-less on every pass that has no evidence — nothing invents an identity
  for it — so it is delivered only by an explicit operator retry (under the
  canonical identity this release would have assigned) or by the exact content
  correspondence described below, which is proof of retention and never a
  replay.
* `unreconciled` (recovery result) — the retention is proven but a durable record
  could not be written or read (a lost, corrupt, unwritable, or unreadable
  notification record). The pass reports it instead of claiming a delivery,
  sends nothing, and leaves the projection exactly where it was; recovery
  converges on the next pass that can write both records.

Acknowledging is a separate step from sending, by necessity. The Architect puts
the stable `eventId`/`jobId` in the completion's custom-message `details`, which
pi persists verbatim into the session entry — but pi writes that entry *after*
its extension handlers return, so the check runs on a later task and only a
proven entry becomes a receipt. Event IDs are stable and a receipt is the dedupe
boundary, so repeated callbacks, duplicate message hooks, coalesced concurrent
attempts, and reconnects never duplicate a side effect, and a late queued or
failed result for an already acknowledged event is recorded as history without
downgrading the delivery.

That deferred check is bound to the session that scheduled it, because pi's
context is *designed* to fail: after `newSession()`, `fork()`,
`switchSession()`, or `/reload`, every guarded getter of the old context raises
“This extension ctx is stale after session replacement or reload”. The check
therefore captures its context instead of resolving one later, and a session
change invalidates it: it never reads the replaced context (it used to end the
session with an uncaught exception), never falls back to the context that
replaced it (that would acknowledge one session's completion from another
session's entries), and never turns a failed read into proof of absence. The
outstanding expectation is dropped with the session it belonged to; the durable
records stay volatile, so the owning session's own recovery still resolves them.
The delivery path is guarded the same way: a context it cannot read is never
written to, and the completion stays pending instead of being claimed.

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
reused PID is never adopted or signalled), and every completion whose delivery is
not confirmed is resolved against the owning session, in this order:

1. the event is present in the session's entries → **acknowledge** it as
   `delivered` from that receipt; nothing is sent again. Before the receipt is
   recorded, a notification record that is missing or unreadable is rebuilt from
   the owner-bound job projection, and a corrupt one is preserved (quarantined
   next to the journal) rather than silently overwritten — if neither can be
   done, the event is reported as **unreconciled** and nothing is sent;
2. the session holds a completion entry from a release that steered it *without*
   the identity metadata (see below) → **acknowledge** it only when the entry's
   text is exactly the text this event's completion carried *and* exactly one
   pending event in this session can claim that text. Identical copies of one
   text are copies of one event; a text two events could claim, or a partial
   (truncated) copy of this event's text, is not proof of anything: it is
   reported as `unknown` and is neither acknowledged nor replayed;
3. the live session is still holding this exact event in its message queue →
   **defer** it; it is on its way, and resending would duplicate it. pi's
   `hasPendingMessages()` cannot report this by itself — it counts only queued
   user prompts, while a completion is steered as a custom message into a
   separate agent queue — so the owning extension supplies the exact in-flight
   events it is still expecting a receipt for. The claim is process-scoped and
   bounded: it survives an extension `/reload` (which keeps the same live agent)
   and is released when pi drains the message, when the receipt is observed, and
   when the run that accepted it settles — and it dies with the process, exactly
   like the queue it mirrors, so a queue pi abandoned can never block
   reconciliation forever;
4. the event is absent (no entry relates to it, and no completion evidence
   mentions it) and no queued messages remain → the crash happened before the
   drain, so the completion is **replayed** to the owner;
5. the outcome cannot be proven (no identity, no session evidence at all, or
   ambiguous legacy evidence) → the record is marked `unknown` and reported:
   never blindly duplicated, never labelled delivered. Such a record is never
   auto-replayed, on this pass or any later one; explicit recovery's retry is the
   only path that delivers it, under the canonical event identity.

#### Upgrading from a release that sent completions without an identity

Before this change the completion was steered as a custom message with only its
text; the durable job and notification records were left `queued` when the
session was busy, even though the operator's session had already consumed the
message. Those session entries are the only evidence that such a completion was
retained, so they are **preserved** as evidence (the extension reports them
separately from identity-bearing entries) and are read through an exact
correspondence with the canonical completion text of each pending event:

* entry text == the event's completion text, and exactly one pending event can
  claim that text → the event was retained: acknowledge it, record the
  correspondence hint (entry id, copy count, text length) as the receipt, and
  never send it again;
* several identical entries → still one event, acknowledged once, with the copy
  count recorded;
* a partial copy (truncated, or a text this release no longer reproduces
  exactly), a text two events could claim, or an unknown formatting difference →
  the record is reported as `unknown` and **never** replayed automatically;
  `/qq_recover` is the explicit decision that may retry it;
* no related entry at all → the absence stands, and the genuinely lost busy
  notification is replayed to its owner exactly once.

Missing identity metadata therefore never implies the completion was never
received. It also never means "delivered": a similar text is not a receipt, an
arbitrary completion entry is not a receipt, and nothing is acknowledged from a
different session's entries — the ownership check runs before any evidence is
read.

A recovered completion in an idle session starts a turn — including a reopened
session the operator has not spoken in yet; in a busy session it is steered
between tool calls and never interrupts the active work. An event reported as
unknown or deferred is a decision for the operator: `/qq_recover` is the explicit
path that retries an unprovable completion on request (and `recover_deliveries`
is the native tool equivalent, which reports the unverifiable set instead of
retrying it). Explicit recovery is still not a licence to duplicate: an event
positively known to be in the live session's queue is deferred there too, and
becomes retryable once that run settles. Everything else is deliberately manual
as well: an interrupted or reconciliation-required job is surfaced with
`interrupted`, `pid-reused`, or `process-unreadable` and its artifacts, and is
never restarted, never marked complete, and never silently re-run.
Implementation, review, and landing are not replayed after an uncertain crash —
inspect the record and decide explicitly.

#### Crash-boundary limits (not exactly-once)

pi offers no transaction across its queue, its session file, and this workflow's
records, so the honest guarantee is: **a completion is sent until a receipt
proves the session retained it, and never sent again after that**. What follows
from that boundary, precisely:

* a crash between pi accepting a steer and the queue drain leaves the record
  `queued`; the next recovery replays it, because the session provably never
  held it. If the model had already read the message in the crashed turn, the
  operator may see it once more: re-delivery is possible, silence is not;
* a crash between pi retaining the entry and this workflow writing the receipt
  is repaired by reconciliation from the session entry — no duplicate;
* pi's session file is flushed lazily (a fresh session writes its entries when
  the first assistant message completes). A crash before that flush loses the
  entry, so the receipt is absent and recovery replays the completion — the same
  re-delivery window as above, on evidence that no longer exists;
* the inverse window is possible for the same reason: a receipt may be written
  from an entry pi retained in memory that had not been flushed yet. If the
  process dies immediately after the model read the completion, the record says
  `delivered` while the session file never shows the entry. The receipt keeps the
  entry id and the observation time, so the discrepancy stays diagnosable, and
  the completion is not re-sent;
* the idle branch's receipt is "pi started a turn for this text", confirmed later
  by the exact session entry; a wake that lost a prompt race without producing an
  entry keeps an unconfirmed turn-start receipt rather than claiming consumption;
* an identity-less record is never silently repaired in either direction: it
  keeps that absence, keeps the acceptance evidence it already carries, and is
  reported as `unknown` on every pass that has no evidence, so only an explicit
  retry delivers it (under the canonical identity) — or the exact content
  correspondence above proves retention, which acknowledges it and leaves its
  identity-less form intact;
* an `unknown` record that had no readable evidence at the time is re-evaluated
  when evidence becomes readable — proven retention acknowledges it, proven
  absence replays it, and a positive in-flight fact still defers it;
* the notification record is part of the crash surface: it is written before the
  job projection, so it can be lost or corrupted while the projection still says
  `queued`. Both cases are recovered *from the projection* (or, when the session
  retained the event, repaired and then acknowledged), never by pretending the
  records agree. A record that cannot be read is not overwritten — its bytes are
  evidence — and a record whose write fails is reported as **unreconciled**:
  recovery re-reports and converges on the next pass that can write, instead of
  reporting a delivery it did not persist.

No generated test-state artifact is part of this change: every suite runs in its
own temporary state directory and only prunes records it owns.

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
transport achieved (acceptance, not a delivered turn). The adapter keeps its own
process-scoped dedupe and `notifiedTerminal` gate, so its `accepted` records are
never mistaken for the Architect's acknowledgement receipts.

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
jobs, reports, restart recovery, over-cap spill), `architect-notify-receipts.mjs`
(completion receipts and recovery counterexamples: consumed-before-send races,
crash before/after session insertion, upgrade from an identity-less release,
journal repair/quarantine for a lost or corrupt record, unprovable outcomes,
deferred checks against a replaced session, explicit recovery, and coalescing),
`architect-install.mjs` (installer idempotence and isolation),
and `mcp-durable-notify.mjs` (the merged MCP terminal path:
persist-before-notify, bounded delivery, retry/coalescing, and retention
pruning).

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
