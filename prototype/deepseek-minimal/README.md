# DeepSeek Harness Minimal + `read_image` + seat-scoped search — configured worker harness

Status: **promoted and verified in this worktree; not installed.** The operator
config still selects the default harness (`codex`), so nothing changes for a
running system until `harness: "deepseek-minimal"` is set. See
[`PROMOTION.md`](./PROMOTION.md) for operator configuration, install steps,
rollback, the runtime-root layout, and the live deployment-gate receipt.

This directory is the prototype that was reviewed and landed at `3751433`, now
extended into the production path: `workflow/worker-config.mjs` validates a
central `harness` selector and `buildWorkerLaunch` emits this adapter's launch
spec. The prototype's own runtime, model loop, and pins are unchanged.

## What it demonstrates

An opt-in worker runtime built from the **audited pinned** DeepSeek Harness
(`deepseek-ai/deepseek-harness` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`,
version `0.1.6-alpha.2`), driven over the SDK JSON‑RPC stdio protocol with the
`sdk-minimal` profile plus overlays, whose model-facing tool surface is
**baseline minimal (`bash`) + `read_image`**, plus - for the implementer and
reviewer seats only - **one named semantic-search tool**,
`mcp__zvec_grep__zvec_grep_search`, served by a small root-bound MCP gateway in
front of the operator's `zg` (zvec-grep) daemon. The final answer is translated
into the event contract `bin/mcp-server.mjs` already consumes.

Verified at runtime (not by source inspection):

| Claim | Evidence |
| --- | --- |
| Real pinned harness boots isolated `sdk-minimal` | `tests/t1`; runtime receipt `<runtime-root>/provenance.json` |
| Persistent bash: cwd + exported env survive calls; disposable file written | `tests/t1` |
| Runner-seat tools = `bash` + `read_image` (no read/write/edit/search/complete_task) | `tests/t2`, `.architect/artifacts/deepseek-minimal/evidence/tool-surface.json` |
| Seat-scoped search: implementer/reviewer expose exactly `bash` + `read_image` + `mcp__zvec_grep__zvec_grep_search`; runner is unchanged | `tests/t2`, `tests/t7`, `tests/t11` |
| Gateway binds the seat's own worktree root (never the runtime cwd, never the main repo) and injects `freshness: wait_for_fresh` + `autoUpdate: true`; those three fields are absent from the model schema and override attempts are refused | `tests/t10`, `tests/t11`, `.architect/artifacts/deepseek-minimal/evidence/search-gateway.json` |
| A missing worktree index is created once (`zg index <root>`, no rebuild/drop/ignore) on the FIRST search, deduplicated, and reused; no search means no indexing | `tests/t10`, `tests/t11` |
| Unavailable/timeout/cancellation/failed-index are explicit errors; only "No matches." means no matching content; stale results are reconciled or labelled, never passed off as current | `tests/t10` |
| A root that cannot mount the gateway fails a search seat closed instead of silently losing the tool | `tests/t8`, `tests/deepseek-minimal.mjs` |
| `read_image` produces a real image on the next outbound request | `tests/t3`, `tests/t7`, `.architect/artifacts/deepseek-minimal/evidence/read-image-receipts.json` |
| Files-reference path backed by a mock upload whose bytes decode | `tests/t3` (upload sha256 = fixture sha256, PNG 3×2 decodes) |
| Inline base64 fallback when the Files endpoint fails | `tests/t3` (base64 decodes to the same sha256) |
| Model `deepseek-flash`, literal effort `max` (`output_config.effort`), provider route `deepseek-official` | `tests/t2`, `tests/t3`, `tests/t7` |
| Success bridges through the existing `completeTask` + validator + backstop | `tests/t4`, `tests/t7` |
| Over-cap answer / `max-tokens` / provider error deliver **no** result | `tests/t4`, `tests/t7` |
| Foreign-session events ignored | `tests/t4` (unit level on `SessionTranslator`) |
| `data_points` is an explicit `[]` | `tests/t4` |
| Reviewer PASS/FAIL parsing sees only the final answer | `tests/t5`, `tests/t7` |
| Cancellation tears down harness + shell descendants, graceful and forced | `tests/t6`, `tests/t7` |
| A bounded wait over a quiet harness does not crash the adapter; a >30 s shell call completes | `tests/t9` |
| All seats launch through `buildWorkerLaunch`; runner missing identity/transport fails closed | `tests/t7`, `tests/deepseek-minimal.mjs` |
| Production uses the configured credential; never the mock dummy | `tests/t7`, live receipt |
| Runtime materializes at a fresh private destination, plugin deps relinked | `tests/t8` |
| Official base maps to `https://api.deepseek.com/anthropic` with no double `/v1` | `tests/deepseek-minimal.mjs` |
| Live gate: real harness + production adapter vs official endpoint, 2 requests | `PROMOTION.md` → live deployment gate |

## Layout

```
prototype/deepseek-minimal/
  PIN.json                       pinned commit/version/provider route/model/effort
  profile/read-image-only.patch.yml   overlay applied AFTER the sdk-minimal bundle
  profile/zvec-grep-gateway.patch.yml seat-scoped search overlay (implementer/reviewer only)
  gateway/                       root-bound zvec-grep search gateway (MCP stdio, one tool)
  plugin/dsh-tool-read-image-only/    Cordis wrapper registering ONLY upstream read_image
  scripts/setup-runtime.mjs      clone+install+build+link+provenance (idempotent, relocatable)
  scripts/live-smoke.mjs         budgeted live gate through the production entrypoint
  mock/mock-provider.mjs         scripted Messages + Files provider with a wire journal
  mock/png.mjs                   dependency-free PNG encode/decode (proves decodability)
  adapter/runtime.mjs            modes, runtime resolution/provenance, endpoint guard, env scrub
  adapter/harness-client.mjs     JSON-RPC stdio client + bounded escalating teardown
  adapter/translate.mjs          session events -> parent contract, terminal gate
  adapter/worker.mjs             one seat turn; runner completion bridge; exit codes
  tests/                         t1..t11 + run.mjs
  PROMOTION.md                   promotion record: config, runtime, install, rollback, live gate
```

Generated artifacts (gitignored): runtime at `$XDG_STATE_HOME/qq-workflows/
deepseek-minimal-runtime` (or `QQ_DEEPSEEK_RUNTIME_ROOT`), receipts under
`.architect/artifacts/deepseek-minimal/`.

## Reproduce

```bash
# 1. Materialize the pinned runtime outside every checkout:
#    clone ddefc45, pnpm install, build host libs + native addon, prepare the
#    Harness home, copy both overlays + the wrapper plugin + the search gateway
#    and link their dependencies, write provenance.json. Idempotent; honors
#    --runtime-root / QQ_DEEPSEEK_RUNTIME_ROOT. Re-run it after pulling this
#    change: a root that predates the gateway deliberately fails search seats
#    closed until it is re-materialized.
node prototype/deepseek-minimal/scripts/setup-runtime.mjs

# 2. Runtime tests (real harness, local scripted provider)
node prototype/deepseek-minimal/tests/run.mjs          # or npm run test:prototype

# 3. Repository regression suite (unmodified, runtime-independent)
npm test
```

Drive one seat by hand against the mock (mock mode is the default and is
loopback-only):

```bash
node -e "import('./prototype/deepseek-minimal/mock/mock-provider.mjs').then(async m => {
  const mock = await m.startMockProvider({ scenario: { turns: [{ blocks: [{ type: 'text', text: 'FINAL: hello' }], stopReason: 'end_turn' }] } });
  console.log(mock.url); await new Promise(() => {});
})" &
node prototype/deepseek-minimal/adapter/worker.mjs \
  --seat implementer --cwd /tmp/scratch --prompt 'say hello' --base-url http://127.0.0.1:<port>
```

Production mode is the *explicit* other path (`--production`), reachable only
through `buildWorkerLaunch` when the operator config selects this harness; it
resolves the credential through the existing operator mechanism and exits `2`
(`provider_credential_required`) rather than falling back to the dummy.

## Pinned inputs (no substitution)

* provider route `deepseek-official`, model literal `deepseek-flash`, effort
  `max`, protocol `messages` — all in `PIN.json`, applied by
  `adapter/runtime.mjs`; `initialize` also caps output with `maxTokens`.
* worktree cwd = `--cwd`; seat instructions = `agents/<role>/agent.md` body.
* `--seat` is **always explicit** and never inferred from the prompt or cwd;
  `runner` additionally requires `QQ_RUNNER_ID` and an absolute
  `QQ_RUNNER_RESULT_FILE` under the platform temp directory, else it fails
  closed before any work.
* Mock mode **must** be loopback (`http://127.0.0.1|localhost|::1`); anything
  else exits 2 before spawning anything. Production mode requires `--production`
  and a validated `https` endpoint (loopback `http` is accepted for tests only),
  built from the operator pin by the central mapping — never inferred from a
  protocol string, and never silently routed to an arbitrary host.
* Credentials: mock mode gets the dummy `prototype-dummy-key`; production gets
  the operator's resolved key. The adapter scrubs routing, Codex, and every
  `*KEY|*PASSWORD|*SECRET|*TOKEN*` variable from the environment it hands the
  harness, so no credential reaches a shell/tool child; receipts record
  `apiKeyIsDummy`/presence, never a value.
* Reasoning effort is emitted verbatim: the mock asserts
  `output_config.effort === "max"` from the actual request body, and the live
  receipt reads `reasoningEffort: max` from the harness's own `request/header`.
* `maxTokens` is emitted only when the operator sets `max_output_tokens`. The
  mock-only `DEFAULT_MAX_TOKENS = 8192` is never carried into production; unset
  leaves the upstream `llm-deepseek` default (256 000) in force.

### Why a source build, not the published package

`@deepseek-ai/dsh@0.1.6-alpha.2` is published and installs fine, but
`@deepseek-ai/dsh-tool-fs` only exports `Config/apply/inject/name`; the named
`applyReadImageTool` export lives in `src/` and the packaged `files` list drops
`src/`. `read_image` is therefore *unreachable* from the packaged build, and
`apply` would drag `read`/`write`/`edit` in (see
`packages/fs/tool-fs/src/index.ts`). The pinned source checkout keeps the
`./src/*` export, which `plugin/dsh-tool-read-image-only/index.mjs` imports
verbatim — no re-implementation.

### Why the built CLI, not `tsx apps/cli/src/bin.ts`

Loading the TypeScript entry through `tsx` applies the monorepo's `paths`
aliases to some importers and `node_modules` resolution to others (the harness's
internal plugin loader bypasses the alias hooks). That produced **two**
`@deepseek-ai/dsh-tools` module instances, so
`ctx.tools[TOOL_RUNTIME_SCHEDULER]` was `undefined` and every tool call failed
with `Cannot read properties of undefined (reading 'prepare')`. The built CLI
(`apps/cli/lib/bin.js`) gives one module graph per package. TypeScript *inside*
the checkout still loads: Node strips types when the wrapper imports
`@deepseek-ai/dsh-tool-fs/src/read-image.ts` (the package directory is not
under a `node_modules` path).

### Why the overlay links live in the Harness home

Cordis resolves an entry name against the base URL of the patch layer that
declared it. Bundle rows anchor inside the checkout; `--patch` overlay rows
anchor at `$DSH_HOME/profiles/sdk-minimal/` (a pnpm project with no
dependencies). `setup-runtime.mjs` therefore links
`dsh-tool-read-image-only`, `@deepseek-ai/dsh-fs-local`, and
`@deepseek-ai/dsh-attachment-local` into that profile's `node_modules` — the
same place `dsh plugin add <x>` would install them, but offline, pinned by path,
and re-linked at whatever runtime root the setup materializes.
(`fs-local` + `attachment-local` are the services `read_image` needs;
`tool-fs` itself is deliberately *not* mounted.) The search overlay's row
resolves `@deepseek-ai/dsh-mcp-client` from the same `node_modules`, and the
gateway it spawns resolves `@modelcontextprotocol/server` + `client` from
`<root>/gateway/node_modules` — both linked by the same setup phase, which is
why the runtime root is self-contained and relocatable.

## Seat-scoped search (`mcp__zvec_grep__zvec_grep_search`)

The implementer and reviewer seats may locate code semantically through the
operator's existing local zvec-grep daemon. Nothing global is patched and no
daemon restart is required.

* **Seat scoping.** `setup-runtime.mjs` materializes a second, seat-scoped
  overlay (`profile/zvec-grep-gateway.patch.yml`). `adapter/runtime.mjs` appends
  it - and only it - for the seats in `SEARCH_SEATS` (`implementer`,
  `reviewer`); the runner never receives it, so its surface and argv are
  unchanged. The overlay mounts exactly one server row through the pinned
  `@deepseek-ai/dsh-mcp-client`, which publishes the gateway's single tool as
  `mcp__zvec_grep__zvec_grep_search`. The layer also disables the bundle's
  generic MCP *resource* tools, because the bridge would otherwise add
  `list_mcp_resources` / `read_mcp_resource` / `list_mcp_resource_templates`
  and the gateway serves no resources.
* **Bound root.** The adapter resolves the seat's `--cwd` worktree and passes it
  as `QQ_ZVEC_GREP_ROOT`; the overlay also sets the gateway's `cwd` to it, so the
  root never depends on the runtime's own working directory. The gateway refuses
  any caller-supplied `root`, `freshness`, `autoUpdate`, or unknown option, and
  never queries a second root.
* **Injected freshness.** Every forwarded request carries the bound root plus
  `freshness: wait_for_fresh` and `autoUpdate: true`. Those three fields are
  removed from the model-facing input schema (projected into the harness's
  JSON-Schema subset) and are injected by the gateway, so the model can neither
  choose a root nor ask for possibly-stale results.
* **Official tool description.** The published `zvec_grep_search` description is
  the pinned snapshot's own upstream text
  (`gateway/zvec-grep-search.tool.json`), re-derived at gateway load with exactly
  one reviewed substitution: the hidden-root reference ("an existing workspace
  index") becomes the bound worktree's index. Retained query/filter option
  descriptions stay verbatim, and the `freshness`/`background_refresh` response
  guidance is kept because those are response fields, not hidden inputs. The
  gateway fails closed if a refreshed snapshot no longer carries the reviewed
  wording, so no authored prose - and no indexing or waiting implementation
  detail - is ever published as tool documentation.
* **Index creation.** If the bound worktree has no index, the FIRST search gets
  `INDEX_MISSING`, the gateway runs exactly `zg index <root>` (the operator's
  existing local embedding configuration and ignore rules; no `--rebuild`,
  `--drop`, `--no-ignore`, and never another root's storage) and retries once.
  Concurrent first searches share that one creation. Existing indexes are simply
  queried with `wait_for_fresh`; there is no index CLI call at role, phase, or
  landing boundaries, and a run that never searches never touches the index.
* **Honest outcomes.** Missing `zg`, a failed/again-missing index, a bounded
  timeout, and cancellation each return an explicit error that names
  `rg`/direct file reads as the fallback. Only the upstream's "No matches." reply
  is treated as "the worktree has no matching content". A reply that stays
  `possibly_stale` after the bounded reconcile retry is returned *with* an
  explicit warning, never as current.
* **Lifecycle.** The gateway is spawned by the bridge on stdio; when the harness
  disposes it (turn end, cancel, shutdown) the gateway closes and reaps the `zg`
  stdio child, so no orphan survives a run. The gateway's stdout carries MCP
  only; diagnostics go to bounded stderr.
* **Disk retention.** Indexes live in `<worktree>/.zvec-grep` and are **not**
  deleted when a worker finishes: dropping or copying indexes would touch
  resources this runtime does not own. The daemon's own idle eviction closes
  watchers; the on-disk index remains until the operator removes it.
* **Fail-closed materialization.** For a search seat, `resolveRuntime` verifies
  the runtime root actually carries the gateway, its reviewed tool snapshot, its
  MCP protocol links, the overlay, and the bridge package. dsh treats a plugin
  row that fails to activate as a warning, so without this check a stale runtime
  root would silently run the seat *without* search; instead the adapter exits
  `2` with the missing paths and the `setup-runtime.mjs` remedy.

## Adapter contract

`stdout` carries **only** newline-delimited parent-contract JSON:

* `{"type":"item.started"|"item.completed","item":{"type":"tool_call","tool":…}}`
  for tool activity (`handleRunnerEvent`/`handleExecutionStreamEvent` read these),
* `{"type":"item.completed","item":{"type":"prototype_intermediate_text",…}}`
  for superseded model text (trajectory only — never clean output),
* `{"type":"item.completed","item":{"type":"reasoning",…}}` for thinking,
* `{"type":"item.completed","item":{"type":"agent_message","text":…}}` for the
  final answer, and only after the terminal gate passed.

`stderr` carries bounded, payload-free diagnostics (`code: explanation`).
Exit codes: `0` completed, `1` any non-success terminal / missing terminal /
over-cap answer, `2` adapter or configuration failure, `143`/`130` cancelled.

Terminal discipline: **only** `turn/end` with `reason.kind === "completed"`
plus a non-empty final answer within the parent's 16,384-character cap may succeed.
`max-tokens`, `error`, `blocked`, `aborted`, `interrupted`, no terminal at all,
and an over-cap answer all fail closed with a bounded diagnostic — never
truncated, never reported as success. Superseded text and reasoning are excluded
from clean output so they cannot influence the reviewer verdict.

Completion: for the `runner` seat the adapter calls the **existing**
`completeTask({response, data_points: []})` from `bin/mcp-server.mjs` and then
re-validates the transport file with the existing
`validateRunnerResultPayload`; the parent's existing backstop
(`checkRunnerTransportBackstop`) is what finally authorizes success. No atomic
writer is duplicated and `complete_task` is **not** exposed to the model. The
runner role contract's "## Completion" section is the single rewritten part of
the seat instructions (`PROTOTYPE_COMPLETION_SECTION` in `adapter/runtime.mjs`),
because the unmodified contract would order the model to call a tool this
runtime does not expose. All other role and task boundaries are byte-identical
to `agents/<role>/agent.md`.

Cancellation: the harness is spawned as its own process-group leader; teardown
is bounded and escalating (`shutdown` JSON-RPC → `SIGTERM` to the group →
`SIGKILL` to the group), and the worker exits 143/130. Only this run's group is
signalled.

## Limitations

* The harness exposes `bash` and `read_image`; the implementer and reviewer
  seats additionally receive `mcp__zvec_grep__zvec_grep_search`, and all three
  seats keep their role text unchanged except for the short workspace-search
  guidance, their final-answer cap sentence, and the runner's completion
  section above.
  `data_points` is always an explicit `[]` (documented metadata, not silently
  dropped information).
* Session-identity filtering is verified at unit level (`SessionTranslator`);
  the runtime tests did not script a foreign in-process session.
* The pinned `TurnEndReasonMap` has no `refusal` kind; provider refusals surface
  as `blocked`/`error`. The gate rejects **every** non-`completed` kind, so the
  refusal case is covered generically rather than by name.
* Compaction, skills, spill, subagents, and the bundled editors are absent by
  design (same as `sdk-minimal`); bash + `read_image` cover the
  implementer/reviewer work.
* Search is *optional* infrastructure: the daemon and its watchers are lazy and
  evicted after idle, `zg` availability is not guaranteed, and index freshness
  depends on the operator's daemon. The gateway therefore waits for the current
  epoch, reconciles once at most, and labels whatever it cannot prove fresh. The
  index is created only for an authorized dispatched worktree whose seat actually
  searches; no remote embedding provider or copied credential is introduced.
* The runtime requires a full `pnpm install` + `build:lib:host` +
  `build:native-system` of the pinned checkout (~2 GB, minutes). The `shutdown`
  handshake reaches the native system addon, so the native build is part of the
  documented setup. `tests/t8` shares an already-built pinned upstream to
  exercise destination materialization without a second multi-GB build.
* No benchmark or latency comparison was run (out of scope by operator decree).

## Adoption status

Promoted; see [`PROMOTION.md`](./PROMOTION.md) for the exact operator
configuration, runtime setup/provenance, install and rollback steps, the
verification matrix, and the passed live deployment gate plus its remaining
request budget. Rollback is config-only: set `"harness": "codex"` or delete the
field.
