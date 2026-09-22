# qq-workflows

Ticket-driven planning, in-session teaching, and deliberate delegation. One
Architect, one worker runtime.

- **Architect**: a Pi profile on Paseo (`pi-extension/qq-architect.mjs` +
  `paseo-plugin/`), installed by `scripts/install-architect.mjs`. It plans with
  the operator, owns the session ticket at `.architect/tickets/<sessionId>.md`,
  and delegates through durable background jobs. Its own model choice is
  independent of the worker runtime.
- **Workers**: the `runner`, `implementer`, and `reviewer` seats run through one
  documented runtime interface - pi's RPC mode (`pi --mode rpc`) - driven by
  `workflow/pi-worker/adapter.mjs`. Provider, model, endpoint, capabilities and
  credentials come from pi's own registry; the operator's selection lives in one
  central configuration file.

There is no second Architect launcher and no blocking wait tool: the Architect
dispatches, yields the turn, and is woken by the durable completion
notification. `check_runner` / `check_execution` are point-in-time reads.

## Repository map

| Area | Where |
| --- | --- |
| Architect profile (Pi on Paseo) | `pi-extension/qq-architect.mjs`, `pi-extension/managed-execution.mjs`, `paseo-plugin/` |
| Architect installation | `scripts/install-architect.mjs` |
| Worker runtime (Pi RPC) | `workflow/pi-worker/adapter.mjs`, `workflow/pi-worker/rpc.mjs` |
| Effective seat instructions in a Pi session | `workflow/pi-worker/instructions.mjs` |
| Worker tools in a Pi session | `pi-extension/worker-tools.mjs` (root-bound `zvec_grep_search`) |
| Central worker configuration | `workflow/worker-config.mjs`, `workflow/worker-launch.mjs` |
| Workflow tools and durable jobs | `workflow/operations.mjs`, `workflow/jobs.mjs`, `workflow/notify.mjs`, `workflow/reports.mjs`, `workflow/results.mjs` |
| Shared MCP server | `bin/mcp-server.mjs` (`complete_task`, ticket tools, `prepare_worktree`/`land`, `dispatch_execution`, ...) |
| Out-of-process worker launcher | `bin/worker-exec.mjs` |
| Search gateway (shared ZG) | `prototype/deepseek-minimal/gateway/`, `bin/zg-rerank.py` |
| Worker role contracts | `agents/{runner,implementer,reviewer}/agent.md` |
| Migration/activation guide | `docs/pi-worker-migration.md`, templates in `config/` |

## Install

```bash
git clone https://github.com/hypermemetic-ai/qq-workflows.git
cd qq-workflows
npm test                 # offline suite, no provider calls
npm run install:architect
```

`install:architect` registers the Pi/Paseo Architect provider (`paseo-plugin`),
installs the extension the provider entry points at, and reports what it
observed. It never writes worker provider/model selection - that is
configuration, not installation (see below).

## Central worker configuration

One operator-owned file - `~/.config/qq-workflows/worker-config.json`,
overridable with `QQ_WORKER_CONFIG_FILE` - selects the worker runtime and the
worker model. Changing provider or model inside pi's supported catalog is a
config change: no workflow source edit, no per-role rewrite.

```json
{
  "harness": "pi",
  "provider": "meta",
  "model": "muse-spark-1.3-contributor",
  "reasoning_effort": "xhigh",
  "env_key": "MODEL_API_KEY",
  "api_key_file": "/home/<operator>/.config/qq-workflows/model-api-key",
  "context": {
    "enabled": true,
    "reserve_tokens": 917504,
    "keep_recent_tokens": 20000
  }
}
```

`reserve_tokens: 917504` is the `~128k` working window on the 1M-capacity
target model (`workerCompactionBudget({ contextWindow: 1048576, reserveTokens:
917504 })` -> `workingWindow: 131072`); it is a compaction trigger, not a hard
input cap. `config/worker-config.muse.template.json` carries the same value.

Rules that hold for every seat and every entry point:

- `harness: "pi"` is the one documented worker runtime. `base_url`/`wire_api`
  and `max_output_tokens` are refused there: the endpoint, protocol, output cap
  and model capabilities belong to pi's registry (`~/.pi/agent/models.json`),
  as do credentials (`auth.json`); `env_key`/`api_key_file` is the operator's
  credential *reference*, resolved per launch and never embedded in a prompt or
  ticket.
- Provider and model are validated structurally, then against the model's real
  capability at launch. The requested `reasoning_effort` is emitted verbatim
  (`--thinking <level>`) and checked with `get_available_thinking_levels`: an
  unavailable level refuses the launch instead of silently dropping to `high`.
- The swap is confirmed, not assumed: before the prompt is sent, the runtime's
  own report of the selected provider/model is compared with the configuration
  and a mismatch refuses the launch (`model_mismatch` / `provider_mismatch`).
  Success also requires a message that did not end in `error`, `aborted`, or
  `length` - a failed or truncated turn is a named failure
  (`message_error`, `run_aborted`, `final_answer_truncated`), never a delivered
  partial result.
- Context policy is materialized into an isolated worker pi agent directory
  (`~/.local/state/qq-workflows/pi-worker-agent/settings.json`) that references
  the operator's registry in place. The adapter verifies the runtime actually
  enabled compaction (`get_state.autoCompactionEnabled`) and reports measured
  `contextUsage` from `get_session_stats`. `reserve_tokens` is a compaction
  trigger knob, **not** a hard input cap; provider `contextWindow` is capacity
  metadata, not an enforced bound. See `docs/pi-worker-migration.md`.
- Per-call or legacy provider selection is refused (`provider`,
  `implementerProvider`, `reviewerProvider`, and the `QQ_*_PROVIDER`
  environment variables), as are retired executable overrides such as
  `QQ_WORKER_EXEC`. The target repository is a working directory only: the
  launcher, adapter, and runtime come from this installation, never from a
  project-local probe.
- A runner keeps its bound identity and explicit result transport
  (`QQ_RUNNER_ID` / `QQ_RUNNER_RESULT_FILE`) and completes only through the
  authoritative `complete_task` module (`workflow/results.mjs`,
  `workflow/reports.mjs`); implementer/reviewer never inherit runner identity.
  A Pi worker session has no MCP tool at all, so the adapter bridges the
  runner's closing assistant message into that same module, and the runner's
  effective instructions state exactly that (`workflow/pi-worker/instructions.mjs`).
- One narrative cap per result (`workflow/limits.mjs`: 16,384 characters),
  enforced fail-closed by the transport, the result reader, the adapter, and the
  seat contracts.
- Each seat's instructions are adapted to the runtime that will read them: the
  shared role contract keeps its wording, the Pi session is told the transport it
  actually has, and a seat instruction naming a tool outside that seat's
  allowlist refuses the launch instead of instructing an impossible action.
- Seat tool policy is explicit and asserted: every seat reads and searches
  (`read`/`grep`/`find`/`ls` + the root-bound `zvec_grep_search`), the runner and
  reviewer execute commands (`bash`), and only the implementer writes
  (`edit`/`write`). The runner keeps the command execution its seat had on every
  earlier runtime (tests, reproductions, diagnostics) and reads images through
  pi's own `read` tool.

## Background work and completion

`dispatch_runner` and `dispatch_execution` return a durable job id immediately.
The Architect then yields:

- a terminal completion is persisted (report + terminal record) and delivered to
  the owning session - an idle turn is started, a busy one is queued or steered,
  and `recover_deliveries` replays completions that were never consumed;
- `check_runner` / `check_execution` report status, active tool, trajectory, and
  stall evidence without touching the work;
- use `steer_runner` / `cancel_runner` for runners and `steer_execution` /
  `cancel_execution` for managed implementer/reviewer work. An update is first
  submitted, then received, then acknowledged by its exact worker attempt;
  only a successful result covering that acknowledged revision fulfills it.
  Cancellation intent is recorded before signalling the owned process;
- retrieve full durable findings with `read_report`. A model's final answer
  alone is not proof of managed completion. Missing telemetry means unavailable
  evidence, not idle work; unknown exits remain interrupted with unknown outcome;
- there is no `await_runner` / `await_execution`: the blocking wait tools were
  deleted from the executable surface, the prompts, and the launchers, because
  parking a turn on a long job is what made the Paseo Architect unresponsive.

After a coordinator reload, call `recover_deliveries` to reconstruct pending
progress and completion obligations and inspect the actual loaded module paths.
Recovery never relaunches a worker. An uncertain delivery stays uncertain until
owning-session evidence resolves it; queue acceptance is not a receipt.

To continue an existing phase, pass its `phaseId` to `dispatch_execution` while
retaining the current coordinating session. The phase selects the preserved
ticket/worktree; the coordinator owns notifications. A new phase selects its
base explicitly or from fresh remote main. Never substitute a stale root HEAD.

See [managed execution communication](docs/execution-communication.md) for
attempt isolation, pending updates, cancellation, reports, and unsupported
legacy/manual communication. Updates that arrive too late remain visible for
an explicit follow-up decision; they are never silently marked incorporated.

## Retained legacy harness (rollback only)

`workflow/worker-config.mjs` still understands the previously installed
`deepseek-minimal` (and `codex`) harnesses **when the same central config file
selects them**, so an installed release keeps working until the operator
activates the Pi worker selection. They are provider-specific runtimes with no
source-level provider/model allowance beyond their own documented pin, they are
never selected implicitly, and they are removed with the DeepSeek runtime after
activation (see the migration guide). The documented production worker runtime
is Pi.

## Test

```bash
npm test
```

The suite uses temporary repositories and state directories and does not change
operator configuration or call external model providers. Unit tests use worker
doubles; functional tests drive installed Pi, the real adapter/relay, production
MCP entrypoints, and installed Paseo close semantics against a deterministic
localhost provider. Missing required installations are reported as skips, not
proof of those scenarios. Simulated notification sinks prove transport
submission only; separate actual Architect tests prove idle wake and receipt. `tests/pi-worker.mjs` covers the worker runtime
contract (capability validation, context policy, selection confirmation, tool
binding, result transport, failure/cancellation) without a live model, and
`tests/pi-runtime-wire.mjs` drives the installed pi runtime through the real
adapter against a localhost mock provider (dummy key, no provider traffic; it
skips when no pi runtime is on `PATH`).
