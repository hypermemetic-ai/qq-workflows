# Controlled Grok reviewer benchmark

This experiment compares **exactly three current review systems** on identical,
frozen changes:

1. current bash-based qq `mini-qa`, route `xai-auth/grok-4.6`;
2. `The-PR-Agent/pr-agent` at exact commit
   `1b6925ba8cc3ef6be09dec704a374da53091926c`, configured as
   `xai/grok-4.6` in shipped plain-diff/JSON mode;
3. `misospace/pr-reviewer-action` v2.2.1 at exact commit
   `54dfb1aac20e1e410ad8f71dc3681b888500a1ec`, configured as `grok-4.6`,
   `tool_mode=off`, with no publication.

The PR-Agent SHA is a pinned post-release main observation from when the release
named v0.44.0 was current; it is not itself the v0.44.0 tag (its package metadata
still says 0.43.0). The immutable SHA is authoritative.

There is no Maki arm and no historical inspection-capped reviewer arm. The old
reviewer's cap truncated inspection before it found defects, so lower latency,
lower tokens, and zero findings are not evidence of review efficiency. Nothing
here restores that behavior or changes product review settings.

## Implementation and runtime status

The rig now includes all three tracked stock launchers, exact external source
blob/tree pins, deterministic corpus provisioning, the trusted xai-auth bridge,
provider capture, serial scheduling, result normalization, blind packets, and
scoring.

Evidence established before the quality matrix:

- Direct live qq-models adapter and bridge calls reached `grok-4.6` through the
  sanctioned host OAuth route and returned provider usage without exposing token
  contents.
- Nonstreaming and streaming bridge calls both returned exact model identity,
  terminal status, usage, and `[DONE]` where applicable.
- The pinned stock misospace `scripts/run_review.sh` completed an offline
  end-to-end compatibility pilot through the capture proxy and bridge using a
  deterministic fake model response. It made one streamed request with model
  `grok-4.6`, stock temperature `0.1`, `max_tokens=8192`, usage enabled, no
  tools, and no `response_format`; its only platform call was the allowed local
  PR-files fixture read.
- Offline source, object, synthetic-fixture, Git geometry, token-accounting,
  schema, bridge, launcher, and adjudication tests pass.

The live three-arm quality matrix has not been run from this checkout's command
sandbox because PID 1 is `bwrap --unshare-net`. That does not mean the OAuth
route or network is absent: both are proven in the normal host namespace. The
tracked `smoke` command is the complete minimal runner path; it does not ask for
an API key or leave launcher work to the operator.

## One-command sanctioned smoke

Choose a private writable runtime root inside the active implementation
worktree (the host state directory may be read-only to delegated shells):

```bash
ROOT="$PWD/.grok-reviewer-live"
python3 experiments/grok-reviewer-benchmark/host/runner.py smoke --root "$ROOT"
```

`smoke` performs, in order:

1. clone exact source SHAs;
2. bootstrap exact `uv 0.9.7` and run PR-Agent's frozen lock install before any
   measured arm;
3. materialize all frozen repository objects and deterministically create the
   disclosed qq-ui synthetic object;
4. verify source blobs/trees and every case's commit/tree/diff/task/standards
   hashes;
5. start the loopback-only xai-auth bridge with a random run-scoped bearer;
6. run `doctor`;
7. run one compatibility pilot per arm on `smoke-001`;
8. run the full three-case matrix serially in the pre-registered order.

To emit the same command as machine-readable, secret-free JSON:

```bash
python3 experiments/grok-reviewer-benchmark/host/runner.py request \
  --root "$PWD/.grok-reviewer-live" \
  --output /tmp/grok-reviewer-host-request.json
```

No provider key, copied OAuth file, or GitHub token is accepted. External
reviewer children receive only an inert capture-proxy credential. The trusted
bridge alone uses qq-models' normal `createAuthStore` against the existing
`QQ_DSH_HOME`/`DSH_HOME`; authorization headers and OAuth fields are never
logged.

## Repaired frozen smoke corpus

Execution inputs and labels are separated. `corpus/smoke.json` is the only
corpus read by `verify`, `doctor`, and `run`. Known defects exist only in
`corpus/truth.smoke.json`, which is accepted by `score` and is never passed or
mounted into reviewer processes.

| Case | Exact geometry | Scale | Scoring-only role |
| --- | --- | ---: | --- |
| `smoke-001` | qq-ui `75ec894…` → `2904675…` | 449 lines / 4 files | known-positive disclosed synthetic mutation |
| `smoke-002` | qq-index `c862e42…` → `c424715…` | 714 lines / 7 files | known-positive real defective head; leading-blank projection repro |
| `smoke-003` | qq-index `c862e42…` → `20baa45…` | 754 lines / 7 files | corrected landed control |

The vanished qq-ui `20d0380…` and qq-index `437fde1…` objects are not benchmark
dependencies and are not claimed as retained originals.

`smoke-001` starts from landed task commit
`e9ed42ee05c2de6fcbed80575e029cca3949da0c`, whose parent is the frozen base. The
tracked `corpus/provision_qq_ui_synthetic.py` changes exactly:

```diff
-if (!projectsScope && project && liveTrackerProjectFilter !== LIVE_TRACKER_OVERVIEW) {
+if (!projectsScope && project) {
```

Fixed commit-tree metadata produces head
`2904675f2025d0c8bf8a597d055ea4ddd927f645` and tree
`bf1ea815e420721f331692b506c0f768780bf2f5`. The provisioner refuses unexpected
source bytes, blob, tree, or commit IDs.

`smoke-002` uses available real defective head
`c4247153a775407b6c9295b6f1c0b27710d5c317`, which has the same leading-blank
README projection defect, and `smoke-003` retains fixed descendant
`20baa457fe65fdc24dbdd1c203c6a308611b2e4f` as its paired control.

All arms receive identical diff bytes, task bytes, empty SHA-pinned standards
context, repository state, and fresh private checkouts. Before and after every
arm the harness checks commit/tree IDs, binary full-index diff SHA-256, changed
line/file counts, task/standards hashes, source integrity, clean repository
state, and output isolation.

## Stock adapters and unavoidable differences

### Current qq Mini QA

`adapters/run_qq_mini_qa.py` uses the shipped `miniQaSetup`, proposal packet,
`RepoOracle`, `bindMiniQaSubmit`, production default-deny tools, and normal
read-only bwrap shell. It is not a generic headless prompt arm and does not enter
the landing/revision state machine. Native DSH response events provide disjoint
usage and exact `xai-auth/grok-4.6` response evidence. A trusted experiment-only
qq-models wrapper delegates unchanged to the pinned plugin while logging only
Responses HTTP attempt model/status/timing; this supplies exact request,
retry, and failure counts without recording prompts, headers, OAuth, or token
contents.

### PR-Agent

`adapters/run_pr_agent.py` runs the shipped entrypoint:

```text
python -m pr_agent.cli --diff-file ... --output ... --json-output ... review
```

It uses exact Dynaconf mappings `CONFIG__MODEL=xai/grok-4.6`, no fallback,
`CONFIG__REASONING_EFFORT=high`, `OPENAI__API_BASE`, and `XAI__KEY` (the inert
proxy bearer). The task is supplied through stock
`PR_REVIEWER__EXTRA_INSTRUCTIONS`, not a PR-description field. Repository/global
settings are disabled so no arm-specific standards are discovered. PR-Agent
uses nonstreaming chat completions, stock temperature 0.2, and at most three key
issues. The bridge records that temperature cannot be forwarded by the
qq-models Responses adapter. PR-Agent has no native approve/request-changes
verdict; normalized pass/fail is explicitly `adapter_findings`, and its findings
have null native severity/confidence/blocker status.

### misospace action

`adapters/run_misospace.py` invokes shipped `scripts/run_review.sh` in a private
copy of the exact head. It pre-seeds stock-supported `pr-object.json` and
`pr.diff`, and puts a fail-closed `gh` shim first on `PATH`. The shim permits only
`api repos/benchmark/local/pulls/1/files?per_page=100`, returning a deterministic
list derived from the exact Git diff; every other call is logged and rejected.

Stock controls remain: stream on, temperature 0.1, `max_tokens=8192`, structured
output off, eight primary retries, `tool_mode=off`, and no publishing. One
compatibility correction is necessary: v2.2.1 action wiring defaults a blank
fallback URL to the primary URL while leaving fallback model blank, but its
driver rejects that combination. The launcher explicitly leaves both fallback
URL and model blank rather than inventing a fallback request. Native
`approve|request_changes` is retained independently of findings, including when
the finding list is empty or contains null file/line locations.

## Bridge and usage accounting

`host/xai_openai_bridge.mjs` exposes only authenticated
`POST /v1/chat/completions` on `127.0.0.1`. It accepts exactly `grok-4.6`, forces
high reasoning when the client cannot request it, translates real qq-models
`{type:"finish", reason}` events, supports stream/nonstream clients, and never
exposes reasoning text as assistant content. Unsupported `response_format`
fails closed. Requested but unforwardable temperature/token caps are recorded as
such in secret-free bridge logs.

Token categories are disjoint:

```text
processed = uncached_input + cache_read + cache_write + output
```

Reasoning is a subset of output and is never added twice. Standard OpenAI prompt
totals are converted back to uncached input by subtracting cache read/write.
For example, 93 uncached + 128 cache-read + 69 output = 290 processed, with 66
reasoning reported separately.

The capture proxy is authoritative for external requests/retries and usage.
PR-Agent's inclusive prompt total is preserved in native JSON but not mislabeled
as uncached input; only comparable completion and total fields are checked.

## Results, blinding, and scoring

Each normalized record preserves:

- wall time, request count, complete provider usage, retries/failures, and
  truncation/context events;
- `native_verdict`, `normalized_verdict`, and `verdict_source` separately;
- raw findings, including null path/line/blocking semantics;
- exact model evidence and effective controls;
- raw reviewer and provider artifacts.

Generate blinded packets only after a completed live run:

```bash
python3 experiments/grok-reviewer-benchmark/benchmark.py blind \
  --run "$ROOT/live/<run-id>/run" --seed 20260828 \
  --output "$ROOT/live/<run-id>/blind"

python3 experiments/grok-reviewer-benchmark/benchmark.py score \
  --run "$ROOT/live/<run-id>/run" \
  --truth experiments/grok-reviewer-benchmark/corpus/truth.smoke.json \
  --adjudication "$ROOT/live/<run-id>/blind/completed-packet.json" \
  --blind-map "$ROOT/live/<run-id>/blind/blind-map.json" \
  --output "$ROOT/live/<run-id>/score.json"
```

Normalize findings into defect clusters before scoring. Primary metrics are
cluster precision, known-defect recall, false positives on the clean case,
blocker precision, and wall time/processed tokens per valid blocker. The
three-case matrix is harness smoke, not decision-grade evidence; expand to a
balanced 8–12 real golden-replay corpus and use a second blinded human for any
product decision.

## Inspect AI verdict

Do not replace or delay this smoke rig with Inspect AI. Inspect does not solve
the host-only OAuth route, external usage capture, fixture integrity, native
launchers, normalization, or blinding. If this becomes a recurring 8–12-case CI
suite, Inspect can wrap the existing `run --case ... --arm ...` boundary for
scheduling, retry/resume, logs, and score-edit provenance while this rig retains
credential, corpus, adapter, usage, artifact, normalization, and adjudication
responsibilities.
