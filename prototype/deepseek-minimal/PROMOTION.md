# DeepSeek Minimal (with vision) — promotion to a configured worker harness

Status: **implemented and verified in this worktree; not installed.** The
operator configuration still selects `codex` (the default when the `harness`
field is absent). Nothing in this promotion changes provider, model, endpoint,
auth, or reasoning effort.

## What was promoted

The prototype's isolated runtime became a second, centrally selected worker
harness behind the existing operator configuration:

* `workflow/worker-config.mjs` gained a validated `harness` selector
  (`codex` | `deepseek-minimal`, absent = `codex`) plus `messages_base_url`
  (explicit endpoint override) and `max_output_tokens` (optional).
* `buildWorkerLaunch` branches on the selected harness. `codex` emits exactly
  the argv it emitted before (rollback path). `deepseek-minimal` emits the
  pinned-harness adapter spec: the adapter process re-reads the *same* central
  config (`QQ_WORKER_CONFIG_FILE` is deliberately retained), so harness, model,
  endpoint, effort, and output cap cannot diverge between parent and worker.
* `prototype/deepseek-minimal/adapter/worker.mjs` runs one seat turn in either
  `mock` (loopback-only, dummy credential) or `production` (explicit
  `--production`, configured endpoint, credential via the existing resolver)
  mode. Mock guards were not weakened: production is a separate path.
* `prototype/deepseek-minimal/scripts/setup-runtime.mjs` materializes the pinned
  runtime at a private, configurable runtime root and re-links every plugin
  dependency at the destination.

* `prototype/deepseek-minimal/gateway/` adds a small root-bound MCP gateway
  that exposes exactly ONE tool, `mcp__zvec_grep__zvec_grep_search`, and
  forwards accepted searches to the operator's existing `zg` daemon over
  `zg server --stdio --mcp-toolset agent`. It is mounted by a second,
  seat-scoped overlay (`profile/zvec-grep-gateway.patch.yml`) applied only for
  the implementer and reviewer seats. See "Seat-scoped zvec-grep search" below.

Unchanged by design: the minimal agent loop (`bash` + `read_image`, plus the
seat-scoped search tool above), the existing `completeTask` transport and
validator, the parent's terminal/backstop gates, health-only `check_runner`,
notification/replay, reviewer verdict parsing, cancellation semantics, and every
provider/model/auth/effort/max pin. No global `zg`/`dsh` package was patched or
updated and no daemon or architect restart is required.

## Operator configuration

```jsonc
// ~/.config/qq-workflows/worker-config.json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "base_url": "https://api.deepseek.com",
  "wire_api": "responses",
  "env_key": "DEEPSEEK_API_KEY",
  "api_key_file": "/home/<user>/.config/qq-workflows/deepseek-api-key",
  "reasoning_effort": "max",

  "harness": "deepseek-minimal",   // NEW: absent = "codex" (unchanged default)
  "max_output_tokens": 32768       // OPTIONAL: absent = upstream default (256000)
}
```

* `base_url` stays the existing pin. For the harness it is mapped, explicitly
  and with tests, to the documented DSH Messages root
  `https://api.deepseek.com/anthropic`; the harness appends `/v1` exactly once.
  Any other host must be named through `messages_base_url`; there is no silent
  arbitrary-host routing and no protocol-string inference.
* `env_key` must remain `DEEPSEEK_API_KEY` for this harness: the pinned
  `sdk-minimal` bundle fixes `apiKeyEnv: DEEPSEEK_API_KEY`. A different name
  fails closed.
* `max_output_tokens` is validated (positive integer, ≤ 1000000) and only
  emitted as the harness `initialize` `maxTokens` when set. Unset leaves the
  upstream `llm-deepseek` default (`DEFAULT_MAX_TOKENS = 256000`) in force; the
  prototype's mock-only 8192 cap is never carried into production.

## Runtime root and setup

The pinned runtime lives **outside every checkout**:

```
default: $XDG_STATE_HOME/qq-workflows/deepseek-minimal-runtime
         (or ~/.local/state/qq-workflows/deepseek-minimal-runtime)
layout : <root>/upstream                              pinned checkout (built)
         <root>/dsh-home                              harness home + profile
         <root>/profile/read-image-only.patch.yml     reviewed overlay copy
         <root>/profile/zvec-grep-gateway.patch.yml   reviewed seat-scoped search overlay
         <root>/plugin/dsh-tool-read-image-only       reviewed wrapper + linked deps
         <root>/gateway                               search gateway + linked MCP SDK
         <root>/provenance.json                       commit/version/lockfile receipt
```

```bash
# materialize (idempotent; honors --runtime-root / QQ_DEEPSEEK_RUNTIME_ROOT)
node prototype/deepseek-minimal/scripts/setup-runtime.mjs

# offline acceptance suites
npm test                 # 10 core test files (no runtime required; includes the
                         # seat-scoped search binding checks)
npm run test:prototype   # 11 real-pinned-harness test files (requires setup)
```

The adapter refuses to start unless `<root>/provenance.json` names the pinned
commit/version and asserts the global `dsh` (0.1.5-rc.1) was not used, and the
checkout at the root reports the pinned version. A mismatched runtime root fails
closed.

**Re-run the setup for the search surface.** An implementer/reviewer seat now
needs the artifacts above (gateway script + reviewed tool snapshot + its MCP
protocol links + the overlay + the `@deepseek-ai/dsh-mcp-client` link in the
profile). dsh reports a plugin row that fails to activate as a *warning*, so a
runtime root materialized before this change would silently run those seats
without search. Instead `resolveRuntime` verifies the artifacts and exits `2`
naming the missing paths, so re-materialize the operator root
(`node prototype/deepseek-minimal/scripts/setup-runtime.mjs`) before dispatching
a seat.

## Seat-scoped zvec-grep search

Implementer and reviewer seats gain exactly one named tool,
`mcp__zvec_grep__zvec_grep_search`, alongside `bash` + `read_image`. The runner
seat is untouched.

* **Scoping.** `adapter/runtime.mjs` appends `--patch
  <root>/profile/zvec-grep-gateway.patch.yml` only for `SEARCH_SEATS`
  (`implementer`, `reviewer`), and only when the seat has an explicit existing
  worktree `cwd`. The overlay mounts one `@deepseek-ai/dsh-mcp-client` row
  (`serverName: zvec_grep`, `failOnStartupError: true`) and disables the
  bundle's generic MCP resource tools, so the published surface is exactly the
  one qualified search tool.
* **Binding and injection.** The adapter passes the resolved worktree as
  `QQ_ZVEC_GREP_ROOT` (the overlay also sets the child `cwd` to it). The gateway
  binds that ONE root, refuses caller-supplied `root`/`freshness`/`autoUpdate`
  and any unknown option, and injects `freshness: wait_for_fresh` with
  `autoUpdate: true` on every forwarded request. Those three fields are removed
  from the model-facing schema (projected into the harness JSON-Schema subset),
  so the model can neither pick a root nor ask for possibly-stale results.
* **Index lifecycle.** Missing index → `INDEX_MISSING` on the first search →
  exactly one `zg index <root>` (operator's existing local embedding config and
  ignore rules; no `--rebuild`, `--drop`, `--no-ignore`, never another root's
  storage) → retry. Concurrent first searches share one creation. An existing
  index is simply queried with `wait_for_fresh`; there is no unconditional index
  CLI at role, phase, or landing boundaries, and a seat that never searches
  never touches the index.
* **Truthful outcomes.** Missing `zg`, failed index creation, a re-reported
  missing index, a bounded timeout, and cancellation each produce an explicit
  error pointing at `rg`/direct file reads. Only the upstream "No matches."
  reply means "no matching content". A reply that stays `possibly_stale` after
  the bounded reconcile retry is returned with an explicit warning, never
  presented as current.
* **Retention.** Indexes live in `<worktree>/.zvec-grep` and are NOT dropped or
  deleted when a worker finishes - doing so would touch resources this runtime
  does not own. The daemon's own idle eviction closes watchers; the on-disk
  index stays until the operator removes it. No watcher/daemon restart is
  required by this change.
* **Deployment verification (operator-side).** After installing and
  re-materializing the root, ONE bounded local index + query against an
  installed worktree using the existing local embedding configuration is the
  intended end-to-end check of real freshness (not a live model benchmark, and
  no broadening of indexed roots). The implementation suite proves the gateway
  against stub MCP servers and a fake `zg` and never contacts the daemon: no
  test indexes or embeds anything.

## Source delta and hash manifest

The seat-scoped search change is a further delta on top of the manifest below:
**24 files** - 16 modified (the two role contracts, the root and prototype
README/PROMOTION docs, `adapter/runtime.mjs`, `adapter/worker.mjs`,
`scripts/setup-runtime.mjs`, `tests/harness.mjs`, prototype tests
`t2`/`t4`/`t6`/`t7`/`t8`/`t9`, and the core `tests/deepseek-minimal.mjs`) plus 8 added
(`gateway/` x4, `profile/zvec-grep-gateway.patch.yml`, `tests/fake-zg.mjs`,
`tests/t10-search-gateway.mjs`, `tests/t11-search-harness.mjs`). The install step
re-derives and records the exact per-file hashes for whatever revision is being
installed, so the manifest below remains the record of the previous promotion
rather than of this follow-up.

The reviewable delta is relative to the original-source snapshot
`cfd4252454f0f0d78e062a84553bfb192197ef5e` (snapshot HEAD
`3751433ae4cfcef9699255689d1958359f95a70a`): **33 source files** — the 25
files the prototype added/changed relative to the baseline, plus this promotion
(9 edits to landed prototype files, 2 edits to baseline files, and 6 new files
including `tests/t9-quiet-window.mjs`).

| Manifest | Contents |
| --- | --- |
| `/home/qqp/experiments/2026-09-19-deepseek-minimal-prototype-source-hashes.sha256` | 33 files of the *original* checkout — the install-time parity check |
| `/home/qqp/experiments/2026-09-19-deepseek-minimal-promotion-delta.sha256` | the 33 delta files at this worktree's state |

Both verify with `sha256sum -c <manifest>` from the matching root
(`/home/qqp/projects/qq-workflows` for the parity manifest; this worktree for
the delta manifest). Copies of both manifests and of the readiness audit
receipt are kept under `.architect/artifacts/deepseek-minimal/` (gitignored).

Excluded from the delta, and never source: `.architect/ticket.md` (ticket
metadata), generated runtime artifacts, credentials, and the generated private
live receipts under `.architect/artifacts/`.

## Install steps (subsequent, authorized operator step)

1. **Parity check.** From `/home/qqp/projects/qq-workflows`, run
   `sha256sum -c /home/qqp/experiments/2026-09-19-deepseek-minimal-prototype-source-hashes.sha256`;
   all 33 entries must report `OK` (verified so in this execution); stop on any
   mismatch.
2. **Backup.** Copy the touched config aside, e.g.
   `cp ~/.config/qq-workflows/worker-config.json ~/.config/qq-workflows/worker-config.json.bak.<ts>`.
3. **Apply the reviewed source delta.** From this worktree,
   `sha256sum -c /home/qqp/experiments/2026-09-19-deepseek-minimal-promotion-delta.sha256`
   (all 33 `OK`), then copy exactly those files into the original checkout,
   creating `prototype/deepseek-minimal/` as needed. Do not copy the excluded
   paths above. The original checkout is not modified by this execution.
4. **Materialize the runtime** with the reviewed setup code (step above). The
   runtime root is new, so this is a fresh clone + frozen-lockfile install +
   host/native builds.
5. **Atomically select the harness.** Write the new config to a temp file in the
   same directory and `mv` it over `worker-config.json`, changing only `harness`
   (and optionally `max_output_tokens`). Keep `provider`, `model`, `base_url`,
   `wire_api`, `env_key`, `api_key_file`, and `reasoning_effort` byte-identical.
6. **Validate with a fresh worker**, not the current architect session:
   ```bash
   node bin/worker-exec.mjs --seat implementer --cwd "$(mktemp -d)" \
     --prompt "Reply with the single word READY"
   ```
   This reaches the real provider (billed). Prefer the offline suites first, and
   at most one bounded live check. Harness selection is read at every launch, so
   a *new* worker picks it up immediately; no session restart is required.

**Do not restart** the current architect or unrelated sessions.

## Rollback

Set `"harness": "codex"` (or delete the field) in
`~/.config/qq-workflows/worker-config.json` — the same atomic write. The Codex
argv is unchanged from before this promotion, so rollback is a config-only
change. `messages_base_url`/`max_output_tokens` are ignored on the Codex path.
The runtime root may stay on disk (it is inert without the selector) or be
removed manually; nothing else references it.

## Live deployment gate (passed)

Exercised through the production entrypoint only — `buildWorkerLaunch` with an
explicit `runner` seat, an operator config selecting `deepseek-minimal`, the
pinned runtime, and the official endpoint `https://api.deepseek.com/anthropic`.

```
seat             runner
task             one harmless shell command + read_image of a synthetic 3x2 red PNG
result           exit 0, terminal "completed", runner transport written and validated
tools observed   bash, read_image
final answer     "SMOKE_SHELL_OK — image smoke-red-3x2.png: width 3 px, height 2 px, dominant colour red. SMOKE_FINAL"
wire header      {provider: deepseek-official, model: deepseek-flash, reasoningEffort: max, maxTokens: 2048}
requests used    2 of 6 (bash and read_image were issued in one assistant step)
wall clock       6.1 s of the 180 s bound
receipt          .architect/artifacts/live-smoke-2026-09-20/LIVE-SMOKE-RECEIPT.json
```

The outgoing request facts are read from the harness's own durable session log
(`request/header`) and the accepted-request count from its
`session-log-deepseek/delivery-accepted` events — no TLS interception and no
credential handling. The smoke's single Files upload
(`file-api-d5d454a9-6f05-4fbb-8f80-56a324682fbf`) was deleted through the
documented Files endpoint (`HTTP 200`); see `LIVE-SMOKE-CLEANUP.json`. **Budget
left for review: 4 of 6 requests** — do not repeat the billed smoke; the offline
suites cover the remaining cases.

## Resolved review defect: quiet-window timeout crash

Independent review reproduced a latent adapter bug in the landed prototype:
`adapter/harness-client.mjs`'s `nextNotification` timeout callback referenced
the promise executor's `resolve` from outside its scope, so any window longer
than the bounded wait (30 s) killed the adapter with `ReferenceError: resolve
is not defined`. Because a shell command that runs longer than 30 s leaves the
runtime quiet for exactly that window, the promotion was not deployment-ready.

The resolver is now hoisted, the timed-out waiter is removed before settling,
and `tests/t9-quiet-window.mjs` covers both the bounded wait directly and a
realistic >30 s `bash` call through the production `buildWorkerLaunch`
entrypoint. The suite count above reflects that file.

## Verification matrix

| Claim | Evidence |
| --- | --- |
| Harness selector validated; absent = codex; unknown rejected | `tests/deepseek-minimal.mjs` |
| Official base maps to `https://api.deepseek.com/anthropic`, no double `/v1`, no silent host routing | `tests/deepseek-minimal.mjs` |
| `max_output_tokens` optional/validated; not silently defaulted to the mock cap | `tests/deepseek-minimal.mjs` |
| All three worker seats (runner/implementer/reviewer) launch the adapter via `buildWorkerLaunch`, explicit seat, no Codex argv, key never in argv; `--seat researcher` is rejected | `tests/deepseek-minimal.mjs`, `tests/worker-launch.mjs`, `t7` |
| Runner seat fails closed without identity/transport before any work | `tests/deepseek-minimal.mjs` + adapter diagnostics |
| Production path presents the configured credential; never the dummy | `t7` (wire), live receipt |
| Production without a credential fails closed (no dummy fallback) | `t7` |
| Credential/transport env never reaches a harness shell child | `t7` (shell probe), `tests/deepseek-minimal.mjs` |
| read_image bytes + bash output reach the model | `t3`, `t7`, live receipt |
| Literal model/effort/max on the outgoing request | `t7` (mock wire), live `request/header` |
| Reviewer closing-answer semantics through the parent parser | `t2`/`t5`, `t7` |
| Runner completion via the existing `completeTask` + validator + backstop | `t4`, `t7` |
| Terminal gates (max_tokens, over-cap) through the production entrypoint | `t4`, `t7` |
| Bounded cancellation of harness + shell descendants | `t6`, `t7` |
| Runtime reproducibility/relocation, relinked plugin deps, fresh destination | `t8` |
| A quiet harness window (>30 s shell operation) is tolerated; no adapter crash | `t9` |
| Unpinned/mismatched runtime root fails closed | `t7`, adapter provenance check |
| Seat-scoped search: implementer/reviewer get exactly the one qualified tool; runner unchanged | `t2`, `t7`, `t11` |
| Bound root is the seat worktree (not the runtime cwd); injected root/`wait_for_fresh`/`autoUpdate`; overrides and admin fields refused; schema hides the injected fields | `t10`, `t11` |
| Index created once on the first search only, deduplicated, reused; no search → no indexing; only the search triggers it | `t10`, `t11` |
| Unavailable/failed-index/timeout/cancel are explicit errors; "No matches." is a normal result; stale is reconciled or labelled; no orphan `zg` child | `t10` |
| A runtime root without the gateway artifacts fails the seat closed (no silently search-less seat) | `t8`, `tests/deepseek-minimal.mjs` |
| Relocated runtime carries the overlay + gateway + MCP protocol links | `t8` |

## Known limitations

* The harness exposes `bash` and `read_image`; the implementer and reviewer
  seats additionally receive `mcp__zvec_grep__zvec_grep_search`. All seats keep
  their role text unchanged except for the short workspace-search guidance,
  their final-answer cap sentence, and the runner seat's completion section,
  which is rewritten because the harness exposes no `complete_task` tool (the
  adapter bridges the closing message through the existing transport).
* Search depends on the operator's `zg` daemon and its local embedding
  configuration; the daemon and its watchers are lazy and evicted after idle,
  and an unindexed worktree is indexed on the first search of a dispatched seat
  (never for a root that was not dispatched, and never by a background job of
  this runtime). When the daemon is unavailable the seat gets an explicit error
  and falls back to `rg`/file reads rather than failing the task.
* `data_points` is always an explicit `[]` for harness workers; this is
  documented metadata, not silently dropped information.
* The harness keeps its per-session model config (`request/header`) recorded
  once per session; `maxTokens`/effort apply to every request in that session.
* The pinned runtime requires a full `pnpm install` + host/native builds
  (minutes, ~2 GB). `t8` shares an already-built pinned upstream to exercise
  destination materialization without a second multi-GB build.
