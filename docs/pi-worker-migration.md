# Worker migration: one Pi runtime, config-only model selection

Status: **code landed, runtime activation pending operator-owned credentials and a
bounded live smoke test.** Nothing in this document has been applied to the live
operator configuration by the implementation.

## What changed

| Before | After |
| --- | --- |
| Worker seats pinned in source to DeepSeek (`provider`/`model`/`base_url`/`wire_api` validated with no other legal value) | One documented runtime interface: `pi --mode rpc` per seat (`workflow/pi-worker/adapter.mjs`), with provider/model/effort/context selected in the central config and resolved against pi's own registry |
| `await_runner` / `await_execution` blocking wait tools, prompts and launchers | Removed from the executable surface, the instructions and the launchers; dispatch-and-yield plus durable completion notification, with `check_runner` / `check_execution` as point-in-time reads |
| Codex / Orca / Muse / Antigravity Architect launchers and their installer | Deleted (`bin/architect.mjs`, `bin/codex-architect.sh`, `bin/muse-architect.sh`, `scripts/install-agents.mjs`). The one Architect is the Pi profile on Paseo (`scripts/install-architect.mjs`) |
| Shared role contracts appended verbatim, including a runner `## Completion` section that mandates `mcp__qq_workflows__complete_task` | Adapted per runtime (`workflow/pi-worker/instructions.mjs`): the Pi session is instructed in the transport it has (closing assistant message, bridged through `completeTask`), the search section names the tool the runtime registers, and a tool outside the seat's allowlist refuses the launch |
| Runner seat without command execution | The runner keeps `bash` (tests, reproductions, diagnostics) - the capability its seat had on every previous runtime - and reads images through pi's own `read` tool |

Retained deliberately: the shared MCP server (`complete_task`, ticket tools,
`prepare_worktree`/`land`), the shared ZG search policy
(`prototype/deepseek-minimal/gateway/zvec-grep-tool.mjs`), durability/report
modules, and the legacy `deepseek-minimal`/`codex` harnesses reachable only
through the same central `harness` field for rollback.

## Activation (operator-owned, in order)

1. **Provide the credential reference** (not the secret) for the target
   provider. The Pi runtime reads credentials through pi's registry or the env
   key the config names; a separate Model API key is expected, and the Muse Code
   subscription credential must not be reused.
2. **Register the provider in pi's registry** (one-time, no workflow code):

   ```json
   {
     "providers": {
       "meta": {
         "name": "Meta Model API",
         "api": "openai-completions",
         "baseUrl": "https://api.meta.ai/v1",
         "apiKey": "$MODEL_API_KEY",
         "models": [{
           "id": "muse-spark-1.3-contributor",
           "name": "Muse Spark 1.3 Contributor",
           "reasoning": true,
           "input": ["text"],
           "contextWindow": 1048576,
           "maxTokens": 131072,
           "thinkingLevelMap": { "off": null, "minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null },
           "compat": { "supportsReasoningEffort": true, "maxTokensField": "max_tokens", "supportsStrictMode": false }
         }]
       }
     }
   }
   ```

   `thinkingLevelMap` is what makes `xhigh` reachable; `max` stays `null`
   because the documented Model API publishes `max` for Standard-tier
   `muse-spark-1.3` only. Nothing silently substitutes either level.
   Templates: `config/pi-models.template.json`, `config/worker-config.muse.template.json`.
3. **Select the worker runtime centrally** — `~/.config/qq-workflows/worker-config.json`:

   ```json
   {
     "harness": "pi",
     "provider": "meta",
     "model": "muse-spark-1.3-contributor",
     "reasoning_effort": "xhigh",
     "env_key": "MODEL_API_KEY",
     "api_key_file": "/home/qqp/.config/qq-workflows/meta-api-key",
     "context": { "enabled": true, "reserve_tokens": 917504, "keep_recent_tokens": 20000 }
   }
   ```

   `meta-api-key` is the operator-owned standalone Model API key file on this
   host (mode 0600, verified by an authenticated `GET /v1/models`); the key value
   is never read into this repository. The generic template keeps the neutral
   `model-api-key` name that the default resolution expects. Keep a copy of the
   previous file as the rollback point; the legacy harness keeps working while its
   selection is in place.
4. **Bounded smoke test** (one paid worker turn, operator-authorized): run one
   `runner` seat on a throwaway task and confirm streaming output, a tool call
   (the shared `zvec_grep_search`), the authoritative result landing in the
   bound transport (the adapter bridges the closing assistant message through
   `completeTask`; the Pi session exposes no completion tool of its own), and the
   policy lines the adapter reports (`availableThinkingLevels`,
   `autoCompactionEnabled`, `contextUsage`, `selectedModel`, `instructions`).
   Everything in this step except the operator's real provider and credential is
   already covered offline by `tests/pi-runtime-wire.mjs`, which runs the same
   launch with the installed runtime against a localhost mock provider; a smoke
   failure should therefore be read as provider/credential/registry evidence
   (`message_error` carrying the provider's own error text), not as an untested
   adapter path.
5. **Then retire the legacy runtime**: once every seat has run on Pi, delete the
   `deepseek-minimal`/`codex` branches from `workflow/worker-config.mjs`, the
   `prototype/deepseek-minimal/adapter` runtime and its tests, and the
   `harness` field itself. That deletion is intentionally NOT part of this
   change because the live configuration still selects the legacy harness.

## Context policy: what is and is not claimed

- pi compacts when `contextTokens > contextWindow - reserveTokens`
  (`docs/compaction.md`). `reserve_tokens` is therefore the knob that decides
  the working window, and the trigger is a compaction **target**, not a hard
  input bound: one oversized tool result or prompt can still exceed it. Only a
  pre-request bound (not implemented here) could claim a hard ceiling.
- The adapter materializes the policy into an isolated worker agent directory
  (`~/.local/state/qq-workflows/pi-worker-agent/settings.json`) and references
  the operator's `models.json` / `models-store.json` / `auth.json` in place (no
  copy, no secret in argv).
- At startup the adapter verifies what the runtime actually accepted
  (`get_state.autoCompactionEnabled`) and reports measured usage
  (`get_session_stats.contextUsage`). Provider `contextWindow` is recorded as
  capacity metadata only.
- A `~128k` working target on a 1M-capacity model is expressed truthfully:
  `workerCompactionBudget({ contextWindow: 1048576, reserveTokens: 917504 })`
  reports `workingWindow: 131072` and labels it a compaction trigger.

## Effort policy

Configured `reasoning_effort` is passed verbatim (`--thinking <level>`) and
validated with `get_available_thinking_levels` before the prompt is sent. An
unavailable level refuses the launch with the model's actual level list; it is
never downgraded to `high` and never silently upgraded.

## Selection confirmation and terminal discipline

A configuration-only swap is *confirmed*, not assumed. Before the prompt is sent
(and therefore before anything is billable), the adapter compares the runtime's
own `get_state.model` report against the configured provider and model and
refuses on a concrete mismatch (`provider_mismatch` / `model_mismatch`). A
registry id and a display name are both accepted, so selecting by name is not a
false failure - but running on a provider or model other than the one the
operator selected is impossible without a named refusal.

Success also requires a settled run whose final assistant message did not end in
`error`, `aborted`, or `length`. This matters because the runtime keeps the text
streamed before a mid-message provider failure inside that message: without the
gate, partial prose would become the runner's authoritative findings (or a
seat's final report) with exit 0. The named failures are `message_error`,
`run_aborted`, and `final_answer_truncated`; the legacy runtime fails closed on
the same conditions through its turn-end reason.

## Seat instructions and tool policy (Pi runtime)

`pi --mode rpc` is launched with an explicit `--tools` allowlist plus exactly one
extension tool (`zvec_grep_search`), and with **no MCP server**. The shared role
contracts (`agents/<role>/agent.md`) are written for the MCP/Codex era, so
`workflow/pi-worker/instructions.mjs` adapts exactly two sections for this
runtime and leaves everything else byte-identical:

- `## Completion` (runner) becomes the transport the adapter implements: write
  the final answer as the closing assistant message; no completion tool is
  named, because none exists in this session. The adapter bridges that message
  into the same authoritative modules the parent pipeline already reads.
- `## Workspace search` names `zvec_grep_search` (the tool every worker seat gets,
  root-bound to its worktree) instead of the MCP-qualified spelling.

After adaptation, every tool name the instruction body still contains is checked
against that seat's allowlist. A reference that cannot resolve refuses the launch
(`exit 2`, code `instruction_tool_unavailable`) rather than sending the model an
impossible instruction; the adapter records the effective surface
(`instructions.source`, `instructions.adaptedSections`,
`instructions.namedTools`) in the launch summary for the smoke receipt.

| Seat | Pi allowlist | Why |
| --- | --- | --- |
| runner | `read`, `grep`, `find`, `ls`, `bash`, `zvec_grep_search` | its contract mandates tests, reproductions, code inspection and diagnostic commands; images come through pi's `read` tool |
| implementer | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `zvec_grep_search` | changes files and runs the suite in its worktree |
| reviewer | `read`, `grep`, `find`, `ls`, `bash`, `zvec_grep_search` | executes the testing plan to completion; no write/edit |

This is the capability each seat had on the previous runtimes (`run_command` in
the Antigravity contracts; `bash` + `read_image` for the DeepSeek runner), so the
migration preserves tool permissions instead of reducing them. The policy, the
adapted instructions, and the refusal path are asserted offline by
`tests/pi-worker.mjs`.

One consequence is tracked on the parent side: the stall evidence a
`check_runner` read reports knows both shell spellings (`LONG_RUNNING_TOOLS` =
`run_command` for the legacy seat, `bash` for the Pi runtime), so a long test
run is not reported as suspicious silence (`tests/mcp.mjs`).

### Omitted context policy

A configuration without a `context` block leaves the built-in defaults in force
(`enabled`, `reserveTokens: 16384`, `keepRecentTokens: 20000`) - that is pi's own
stock threshold, which on a 1M-capacity model means a ~1M working window. Set the
block explicitly so the working window is a deliberate choice: the templates and
the examples above use `reserve_tokens: 917504` for the `~128k` target.

## Native per-attempt session recording (default-on, source-integrated)

Production workers record each attempt's native pi session by default: `--session <file>`
replaces `--no-session` at the same argv position (+1 token), and every other selection
argument stays byte-identical. A recording-disabled launch passes `--no-session` exactly
as before. The allocation lives inside the adapter (`workflow/pi-worker/adapter.mjs`), so
`launchPlan`/`planToSpawn` intentionally do NOT contain the path:

- Directory: `$XDG_STATE_HOME/qq-workflows/worker-sessions` (default
  `~/.local/state/qq-workflows/worker-sessions`); an explicit absolute
  `QQ_WORKER_SESSION_DIR` overrides it. The directory is created 0700 and verified with
  `lstat`: a real directory, owned by this user, exactly 0700 - never chmodded, never a
  symlink.
- Files: an exclusively created 0600 `pi-<seat>-<UTCstamp>-<pid>-<rand>.jsonl` (fresh
  random suffix per collision retry, 5 attempts) plus a 0600 sidecar
  `<session>.meta.json` with schema `qq-worker-session-meta/1` and exactly the fields
  `sessionFile`, `seat`, `pid`, `cwd`, `runnerId` (null when unbound), `startedAt` - no
  prompt, environment, or credentials. A sidecar failure removes the just-created session
  file.
- Diagnostics: one bounded payload-free stderr line per launch
  (`pi-worker-adapter: native session file: <path>`); `summary.sessionFile` is set only
  when `--summary-file` is passed (production passes none). Initialization problems
  refuse the launch (exit 2) with the named codes `native_session_dir_invalid`,
  `native_session_dir_unsafe`, `native_session_meta_failed`, `native_session_collision`
  - before any runtime is spawned.
- Tests: `tests/pi-worker.mjs` (offline: disabled argv equivalence, resolution rules,
  exclusive 0600/0700 allocation, collision retries and exhaustion, every named refusal,
  sidecar content and cleanup) and `tests/pi-worker-session-recording.mjs` (real
  installed pi against a deterministic localhost provider with a dummy key: success with
  the read tool call/result and final answer stored in the session file, a controlled
  abort with the persisted evidence, and an unsafe-directory refusal before any
  provider traffic). A missing installed runtime is reported as SKIPPED, never as a
  pass.

## Release materialization, activation, and pre-switch verification

There is no release-materialization script in this repository. The mechanism recorded for
the currently deployed release (PR111 dispatch record) is a read-only materialization of
a **landed commit**:

```bash
REL="$HOME/.local/share/qq-workflows/releases/<new-full-commit-sha>"
git archive <landed-sha> | tar -x -C "$REL" && chmod 700 "$REL"
```

Activation is the Paseo daemon config (`~/.paseo/config.json`) pointing its absolute
release paths — the plugin directory (`plugins.qq-architect.path`) and the architect
extension (`agents.providers.qq-architect.command` →
`pi-extension/qq-architect.mjs`) — at the new release, plus the parent restart that
re-resolves those paths. The MCP server is NOT named by a separately verified
daemon-config path: the live config carries no `configuredServer` entry, and the
worker's MCP server is resolved transitively from the release modules
(`WORKER_MCP_SERVER` in `workflow/worker-config.mjs` resolving `bin/mcp-server.mjs`
next to the release's own modules). The worker adapter path is likewise computed
from the parent's own source (`WORKER_PI_ADAPTER` in `workflow/worker-config.mjs`) and
a fresh adapter process is spawned per launch, so a running parent keeps serving its
current release until the switch.

Before switching to a newly materialized release, verify the recording repair is in the
built tree (never assume it from the commit id):

```bash
sha256sum "$REL/workflow/pi-worker/adapter.mjs"
# must equal the landed source adapter hash (for this integration:
# 5c5d10e5b8a9354258585f625a1abda0316735f63f2e4c31101c360ce3c182c7)
node --check "$REL/workflow/pi-worker/adapter.mjs"
grep -n "resolveNativeSessionPath\|native_session_dir_invalid" "$REL/workflow/pi-worker/adapter.mjs"
```

and run one bounded recording smoke against the built tree (the
`tests/pi-worker-session-recording.mjs` fixture shape: temporary `XDG_STATE_HOME`, dummy
key, localhost mock provider) before the switch. After the switch, one production worker
turn must produce a session file plus sidecar under
`$XDG_STATE_HOME/qq-workflows/worker-sessions` and the bounded stderr trace line.

The currently deployed ce0b35a release carries this exact repair as a local hotfix (same
bytes as the integrated source); landing the source does not itself activate a new
release, and the historical patch artifact must never be re-applied over the integrated
source.

## Verification available today (offline)

```bash
npm test          # offline test files, including tests/pi-worker.mjs
```

`tests/pi-worker.mjs` drives a fake `pi --mode rpc` runtime and proves: config
only model/provider swaps, capability refusal for an unsupported level,
compaction verification, the authoritative runner transport, failure and
cancellation semantics, RPC framing, the root-bound shared search tool, the
per-seat tool policy (runner command execution included), the adapted seat
instructions (no MCP tool named, correct search tool, cap stated), the selection
confirmation refusal, the failed/aborted/truncated terminal gate, and the
refusal of any instruction that names a tool outside its seat's allowlist.

`tests/pi-runtime-wire.mjs` goes one step further and drives the *installed* pi
runtime through the real adapter against a localhost mock provider (dummy key,
no provider traffic, skipped when no pi runtime is on `PATH`). It proves the
integration the rest of the design rests on: the real runtime's RPC events
arrive and translate, the native tool and the shared `zvec_grep_search` tool are
both registered under `--no-extensions --extension <worker-tools.mjs>`, the
request body carries the configured `model`, the registry `max_tokens`, and
`reasoning_effort: "xhigh"` with `tool_choice` left at the provider default, the
closing message lands in the authoritative runner transport, and a message that
ends in a non-retryable error fails the run instead of delivering its partial
text.

`tests/pi-worker-session-recording.mjs` proves the native session recording on
the same real-runtime fixture shape (see the recording section above).

Live end-to-end activation (the operator's real provider and credential) is
explicitly **not** claimed from these localhost proofs.
