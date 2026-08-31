# Repeated paired Grok reviewer benchmark

This experiment compares exactly two review systems on the same frozen changes:

1. the production bash-based qq `mini-qa` reviewer at exact source commit
   `54966c350fe7c7fc57af76f4bc449abef68b9d55`, routed as
   `xai-auth/grok-4.6`;
2. stock `The-PR-Agent/pr-agent` at exact source commit
   `1b6925ba8cc3ef6be09dec704a374da53091926c`, invoked through its shipped
   plain-diff/JSON entrypoint as `xai/grok-4.6`.

The PR-Agent SHA is a pinned post-v0.44.0-main observation; the immutable SHA,
required file blobs, and required source tree in `config.json` are authoritative.
Both arms target exact provider response model `grok-4.6` and high reasoning.
Neither arm can publish.

`misospace/pr-reviewer-action` is **not an active arm**. Its adapter and old
evidence may remain as an archive, but provisioning, readiness, bridge clients,
execution, reports, tests, and scoring require only `qq-mini-qa` and `pr-agent`.
A generic two-message Grok prompt is also not production Mini-QA.

## Current truth

**There are zero valid paired observations. No valid qq Mini-QA versus PR-Agent
comparison exists until the paired host-native `smoke-001` pilot succeeds.**

The retained successful misospace result and the fresh plain-prompt Grok host
session are not observations in this experiment. The earlier benchmark attempt
was launched below a `bwrap --unshare-net` shell and stopped before a model
request. These facts must not be described as a completed or partial two-arm
comparison.

Implementation and tests make no paid model calls. The operator/parent performs
live execution only after landing these changes.

## Why the host launcher exists

The benchmark controller already owns the pinned adapters, exact model checks,
provider capture, usage normalization, timing, findings normalization, frozen
corpus validation, blinding, and scoring. It must run unchanged in the normal
host namespace so:

- its xai-auth bridge can read the existing host OAuth store in place;
- PR-Agent can reach that bridge over loopback;
- the Mini-QA headless DSH child inherits normal provider network access.

The production Mini-QA repository shell remains read-only/no-network bwrap. The
launcher does not weaken ordinary child isolation or add a second model adapter.

`src/grok-benchmark-host.mjs` integrates with the already-running qq
`webServer`. It installs routes only when `webServer.host` is exactly
`127.0.0.1` and independently rejects non-loopback peers. There is no command,
executable, argument-array, environment, source, or provider-credential input.
The only launch payload fields are `runtime_root`, `run_id`, and
`repeat_count`; the route itself selects the fixed `pilot` or `matrix` command.
Only one benchmark job may run at once.

## Run-scoped enablement descriptor

The routes fail closed unless the service checkout contains the regular file
`.grok-reviewer-benchmark-launch.json`. It must:

- be at that exact path under the qq-workflows repository (no symlink);
- be owned by the qq service UID, mode exactly `0600`, and have one hard link;
- use schema `qq.grok-reviewer-benchmark-launch/v1`;
- contain a 43–128 character URL-safe random bearer token;
- pin one canonical existing runtime root strictly contained by the repository;
- pin one safe run ID (`[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`);
- expire in the future and no more than 24 hours after validation.

Example shape (the real token is private and must not be committed or logged):

```json
{
  "schema": "qq.grok-reviewer-benchmark-launch/v1",
  "token": "<43-128 URL-safe random characters>",
  "runtime_root": "/home/qqp/projects/qq-workflows/.grok-reviewer-wave-live-v3",
  "run_id": "qq-vs-pr-agent-v1",
  "expires_at": "<ISO-8601 time within the next 24 hours>"
}
```

The descriptor is gitignored. Remove it after the matrix or cancellation.
Requests authenticate with `Authorization: Bearer <token>`. The launcher never
returns, logs, copies, or passes this token to the runner. It also starts the
runner with a small allowlisted, credential-free environment; the bridge reads
host OAuth state from its normal filesystem location and exposes only random
synthetic loopback credentials to reviewer processes.

## Fixed host routes

All routes are under:

`/api/qq-workflows/grok-reviewer-benchmark`

- `POST /pilot` — fixed `host/runner.py pilot`; requires `repeat_count: 1`.
- `POST /matrix` — fixed `host/runner.py matrix`; allows `repeat_count: 1..5`.
- `GET /status` — authenticated polling for the current/last job.
- `POST /cancel` with `{}` — terminate the tracked process tree. The benchmark
  controller propagates TERM to reviewer/proxy sessions and escalates after one
  second; the runner does the same for the benchmark and bridge after three
  seconds; the host retains a five-second top-level KILL fallback.

A launch body is exactly:

```json
{
  "runtime_root": "/home/qqp/projects/qq-workflows/.grok-reviewer-wave-live-v3",
  "run_id": "qq-vs-pr-agent-v1",
  "repeat_count": 1
}
```

The status response does not contain a token. Durable mode-`0600`, secret-free
artifacts are written below:

`<runtime_root>/host-jobs/<run_id>-<pilot|matrix>/`

They include `stdout.log`, `stderr.log`, and atomically updated `status.json`.
HMR/plugin disposal unregisters all routes and awaits cancellation of a live
process tree. Both Python controller layers register detached child sessions,
close the spawn/registration race, and reap descendant groups before exiting, so
the host cannot report `cancelled` while a bridge or paid reviewer remains live.

## Required execution staging and spend guard

Use the already verified cached runtime root. Do not provision or make provider
calls during implementation/QA. The fixed host commands intentionally pass no
runtime-source arguments: `pilot` and `matrix` default to the owner-controlled,
canonical clones at `<runtime_root>/runtime-pins/qq-models` and
`<runtime_root>/runtime-pins/qq-core`, then verify their frozen commit/tree/package
content before bridge startup. Missing, symlinked, escaping, writable-by-other, or
incorrect pins fail closed; there is no fallback to mutable sibling checkouts.
Direct CLI source overrides remain available only for offline/operator diagnostics.

1. Create the private descriptor for one run ID.
2. Launch exactly one paired pilot via `POST /pilot` with `repeat_count: 1`.
   This runs both arms concurrently on `smoke-001` only.
3. Poll `/status`. If the pilot fails, stop. Preserve and return its host-job,
   bridge, doctor, provider, raw output, and normalized artifacts. Never
   substitute a generic prompt result.
4. Verify both pilot observations have exact source/model/config evidence,
   `grok-4.6` request and response identity, wall time, complete disjoint usage,
   requests/retries/failures/context/truncation counts, verdicts, and complete
   findings/raw artifacts.
5. Only after that gate, launch `POST /matrix` once with `repeat_count: 3`.

`host/runner.py matrix` also checks durable successful paired pilot evidence for
the same runtime root and run ID before starting its bridge. It does not rerun a
pilot. The intended matrix is therefore exactly:

- 3 independent passes;
- 3 frozen cases per pass;
- 2 concurrent arms per case wave;
- 18 normalized observations total.

Each observation uses a fresh worktree, private HOME, reviewer process, and qq
session. Passes are indexed from 1 and stored under
`passes/pass-001` through `passes/pass-003`.

## Frozen corpus and input isolation

`corpus/smoke.json` fixes three cases:

- `smoke-001`: disclosed deterministic qq-ui synthetic change;
- `smoke-002`: repaired qq-index positive case;
- `smoke-003`: repaired qq-index nominally clean case.

Before every arm invocation, the controller verifies commit, tree, binary diff,
task, and standards hashes. It creates a detached worktree and verifies after
execution that the reviewer did not mutate it. Every arm receives the same
base/head/diff/task/standards packet and never receives truth, another arm's
outputs, prior findings, OAuth contents, or publication credentials.

Known-defect truth remains in `corpus/truth.smoke.json`, outside reviewer input.

## Arm behavior

### Production qq Mini-QA

`adapters/run_qq_mini_qa.py` starts the pinned qq-core headless DSH composition,
loads the exact pinned production Mini-QA source and model plugin, and preserves
production repository-bash isolation. It creates distinct fresh canonical
launcher and review session UUIDs. The instrumented model wrapper records only
provider attempt model/status/timing; it does not replace prompt, auth, model, or
response processing.

Provider response events are authoritative for qq usage. The adapter retains
native Mini-QA verdict/findings and the DSH session/provider artifacts.

### Stock PR-Agent

`adapters/run_pr_agent.py` invokes the pinned stock CLI:

```text
python -m pr_agent.cli --diff-file <frozen.patch> --output <native.md> --json-output <native.json> review
```

It uses stock plain-diff/head-file enrichment and JSON output, no repo/global
settings, no fallback models, no tools, no response format, no output cap,
`reasoning_effort=high`, stock requested temperature `0.2`, at most three key
issues, and a neutral 600-second AI timeout. The capture proxy stores complete
request/response evidence and authoritative provider usage.

## Usage and telemetry

Every valid normalized observation retains:

- pass, arm, case, exact source pin/tree/blob evidence;
- configured client route and exact provider request/response model evidence;
- complete secret-free effective configuration;
- wall-clock start/end and duration;
- request count, retries, failures, truncation events, and context events;
- uncached input, cache-read, cache-write, output, reasoning, and processed
  tokens;
- native and normalized verdict semantics;
- complete normalized findings and all raw artifacts.

Token categories do not double count: `input_tokens` is uncached input;
cache-read and cache-write are disjoint input categories; reasoning is retained
as a subset of generated output and is not added to output again;
`processed_tokens` is the provider total rather than a recomputation from
potentially overlapping categories.

## Aggregate reports

Every completed `benchmark.py run` writes:

- `run.json` — pass-indexed wave and observation manifest;
- `aggregate.json` — full machine-readable per-arm/per-case and overall metrics,
  failures, all token/telemetry fields, verdict counts, and exact normalized
  finding recurrence by fingerprint/pass;
- `report.json` — concise medians/ranges/totals by arm and case plus overall;
- `report.md` — the concise human-readable table and recurring findings.

Reports are deterministic functions of retained normalized observations. They
state explicitly that three passes provide descriptive medians/ranges only and
do not establish statistical significance.

## Blinding and scoring

Create an adjudication packet after a successful run:

```bash
python3 experiments/grok-reviewer-benchmark/benchmark.py blind \
  --run <matrix-run-directory> \
  --seed 20260831 \
  --output experiments/grok-reviewer-benchmark/adjudication/paired-v1
```

`packet.json` omits arm and pass identity. Private mode-`0600` `blind-map.json`
retains arm, pass, case, and finding index. Seeded blind IDs and packet ordering
are deterministic. Complete the rubric, then score:

```bash
python3 experiments/grok-reviewer-benchmark/benchmark.py score \
  --run <matrix-run-directory> \
  --truth experiments/grok-reviewer-benchmark/corpus/truth.smoke.json \
  --adjudication <completed-packet.json> \
  --blind-map <blind-map.json> \
  --output <score.json>
```

Scoring retains every pass when totaling time/tokens and preserves known-defect,
cluster, clean-case, and blocker metrics. Repeated n=3 scoring remains
descriptive; it is not a significance claim.

## Offline verification

These tests use only local fixtures/inert subprocesses and make no paid calls:

```bash
python3 -m unittest discover \
  -s experiments/grok-reviewer-benchmark/tests -v
npm test
```

The Node host-launcher test uses a temporary inert Python runner to validate
fixed argv, authentication, descriptor constraints, one-job locking, polling,
and cancellation/disposal of nested detached controller and reviewer sessions.
The Python tests also cover TERM-ignoring descendants and cancellation racing a
new registration. The bridge tests use
`tests/fixtures/fake_grok_adapter.mjs` only.
