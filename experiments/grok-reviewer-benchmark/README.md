# Controlled Grok reviewer benchmark

This experiment compares **exactly three current review systems** on paired,
frozen changes:

1. the current bash-based qq `mini-qa` reviewer on `xai-auth/grok-4.6`;
2. `The-PR-Agent/pr-agent` v0.44.0 at
   `1b6925ba8cc3ef6be09dec704a374da53091926c`, in plain-diff/JSON mode with
   `xai/grok-4.6`;
3. `misospace/pr-reviewer-action` v2.2.1 at
   `54dfb1aac20e1e410ad8f71dc3681b888500a1ec`, with stock review behavior,
   `tool_mode=off`, no publishing, and `grok-4.6`.

There is no fourth arm. In particular, the historical inspection-capped
structured reviewer is not a comparator: its cap truncated inspection before it
found issues, so its latency, token use, and zero-finding behavior are not
quality/efficiency evidence. Nothing here restores or recommends that behavior.
No product source or production review setting is changed by this experiment.

## Current status and exact host boundary

The frozen corpus and offline harness are ready. The tracked host runtime now
contains:

- `host/runner.py`, which provisions the exact public source pins and frozen Git
  objects, verifies every corpus hash, starts the bridge, runs `doctor`, and then
  runs the serial smoke;
- `host/xai_openai_bridge.mjs`, a loopback-only OpenAI chat-completions facade
  over the normal qq-models `xai-auth` adapter. It reads host OAuth through the
  existing store and gives the capture proxy only a random run-scoped synthetic
  key; no provider key is accepted or copied;
- the experiment-only DSH headless Mini QA adapter, which reuses production
  `miniQaSetup`, `RepoOracle`, task-artifact/proposal-packet rendering, the
  read-only bwrap shell, and native session usage; and
- offline HTTP, usage, object-provisioning, Git-geometry, and task-packet tests.

The live smoke is still **not started**. This implementation shell is PID 1 under
`bwrap --unshare-net --clearenv`; it cannot reach public Git, the host OAuth
route, or a host loopback listener. The exact sanctioned handoff is machine
readable—no key or generic runner bundle is requested:

```bash
python3 experiments/grok-reviewer-benchmark/host/runner.py request \
  --root "$HOME/.local/state/qq/grok-reviewer-smoke" \
  --output /tmp/grok-reviewer-host-request.json
```

The normal host executes the emitted `host_command` (currently
`host/runner.py provision --root ...`). Provisioning fetches the exact PR-Agent
and misospace pins and imports locally retained blocked-head objects before
fetching the missing reachable base/control objects. At this checkout's sandbox
boundary the two pinned external trees are not yet present, so their release
entry points cannot honestly be bound or tested here. Do not run the matrix or
substitute inferred flags until those provisioned trees have been inspected and
the two stock launchers are tracked. This is the one remaining source/runner
continuation, not a credential request. No private auth file was inspected or
copied.

## Frozen smoke corpus

`corpus/smoke.json` contains only neutral case IDs and immutable execution
inputs. Labels/known defects are isolated in `corpus/truth.smoke.json`, which is
accepted only by `score`; neither `run` nor a launcher receives its path.

| Case | Frozen geometry | Scale | Role (scoring-only) |
| --- | --- | ---: | --- |
| `smoke-001` | qq-ui `e0dd0db…` → `20d0380…` | 299 changed lines / 4 files | known-positive original head |
| `smoke-002` | qq-index `c862e42…` → `437fde1…` | 687 changed lines / 7 files | known-positive original head; leading-blank projection repro |
| `smoke-003` | qq-index `c862e42…` → `20baa45…` | 754 changed lines / 7 files | corrected, landed control |

The qq-index task is the exact uncontaminated task artifact. The qq-ui task is
the exact operator-authored description of the separate all-project-overview
follow-on, extracted without the preceding workflow/review history. All arms get
identical task bytes. `standards.md` is deliberately empty: repository state and
task acceptance criteria are shared, while each stock reviewer's own system
prompt remains stock. The empty context is itself SHA-256 pinned.

Before **every arm**, the harness resolves full commit and tree IDs and verifies:

- the binary/full-index diff SHA-256;
- task and standards SHA-256;
- changed-line/file counts; and
- availability of both exact revisions.

Git subprocesses delete inherited `GIT_*` geometry and install deterministic,
noninteractive Git config. This is important on the host checkout, where
inherited geometry otherwise points unrelated paths at the active task
worktree. Each arm gets a newly initialized detached checkout backed by a
read-only object alternate, no remote, a clean status, and an empty output
directory. Source and sandbox integrity are checked again after the arm.

## Reproducing preflight and run

Run host provisioning from the normal qq execution namespace, not from an
implementation/QA bwrap:

```bash
ROOT="$HOME/.local/state/qq/grok-reviewer-smoke"
python3 experiments/grok-reviewer-benchmark/host/runner.py provision \
  --root "$ROOT" \
  --qq-workflows-source /home/qqp/projects/qq-workflows
```

`provision` creates private detached source checkouts and bare object-complete
fixture repositories under `ROOT`, then calls the same `case_integrity` checks
used immediately before every arm. It deletes inherited `GIT_*` geometry and
fails closed on a wrong pin, dirty tracked source, unavailable object, or hash
mismatch. It needs ordinary public HTTPS but no GitHub token argument.

After the two pinned external release launchers are tracked, the normal host runs:

```bash
python3 experiments/grok-reviewer-benchmark/host/runner.py run \
  --root "$ROOT" \
  --qq-core-source /home/qqp/projects/qq-core \
  --qq-models-source /home/qqp/projects/qq-models \
  --qq-dsh-home "$HOME/.local/state/qq" \
  --pr-agent-launcher /tracked/run-pr-agent-plain-diff \
  --misospace-launcher /tracked/run-misospace-action
```

The runner pins qq-core's DSH lock blob and qq-models' source tree before
starting anything. It checks only that the normal xai-auth marker exists; the
bridge's existing auth-store implementation owns all reads/refreshes. The bridge
binds exactly `127.0.0.1`, accepts exact `grok-4.6` text/no-tool traffic, allows
one request at a time, and records only secret-free model/usage/error metadata.
`benchmark.py` starts its existing capture proxy in front of this bridge. Stock
external reviewers receive only the capture proxy's inert key; qq stays on its
native `xai-auth/grok-4.6` path.

Runs are serial and use the balanced schedule in `config.json`, with a recorded
10-second cooldown. Exact command arrays, source pins, effective configuration,
start/finish times, and wall-clock duration are retained. Reviewer processes get
a fresh private HOME/XDG/TMP tree; truth and other-arm artifacts are never
passed.

## Model/settings parity and unavoidable differences

All provider requests and responses must identify exact provider model
`grok-4.6`; aliases/fallbacks fail validation. Client model strings remain the
stock tool forms (`xai-auth/grok-4.6`, `xai/grok-4.6`, and `grok-4.6`) and are
recorded separately from provider identity.

The target reasoning effort is high, with no experiment-imposed temperature or
output cap. The qq route uses its current high setting. PR-Agent requests high
where the pinned LiteLLM/xAI path supports it. Misospace keeps defaults unless a
compatibility setting is required. Every launcher must dump actual effective
values and any ignored/unsupported setting; the harness does not pretend unlike
controls are equivalent. Other unavoidable differences are stock behavior:
qq has iterative read-only bash, PR-Agent enriches an exact plain diff from head
files, and misospace has tools off.

## Usage and raw artifacts

`capture_proxy.py` stores secret-free metadata plus exact request/response bodies
for each external provider call. Authorization headers are never persisted.
It supports JSON and SSE usage. For streaming requests it adds only
`stream_options.include_usage=true`, retaining and hashing both original and
forwarded request bytes; prompts and generation controls are unchanged. It
normalizes:

- authoritative proxy request count for external arms and host-log count for qq;
- input and output tokens;
- cache-read and cache-write tokens;
- reasoning tokens; and
- processed tokens.

`processed_tokens` is provider total where supplied, otherwise input + output.
Reasoning is recorded separately and **never added again**. Streaming cumulative
usage uses the largest/final record instead of summing chunks. PR-Agent's
accumulated `--json-output` usage is compared field-by-field with captured
responses. Misospace proxy usage is authoritative because action output is
incomplete. The qq launcher must preserve host response logs, supply their exact
request/response model evidence and normalized usage, and cross-check any
separately reported totals. External request/response model evidence comes
straight from the proxy.

Each arm artifact retains native stdout/stderr, native structured output,
provider request/response bodies, normalized findings/verdict, retries,
failures, truncation/context events, integrity records, and elapsed time. `runs/`
and `adjudication/` are gitignored because raw diffs/prompts/outputs can be
sensitive and large.

## Blinded adjudication and scoring

After a successful run:

```bash
python3 experiments/grok-reviewer-benchmark/benchmark.py blind \
  --run experiments/grok-reviewer-benchmark/runs/smoke-001 \
  --output /private/adjudication/smoke-001 --seed 20260821
```

`packet.json` randomizes findings and hides arm identity. Give only that file and
the frozen repositories/diffs to independent adjudicators; keep
`blind-map.json` sealed until completion. For every finding they record:

- introduced by the diff;
- concrete reproducible trigger;
- behavior claim correctness;
- actionable path/line;
- duplicate status and normalized defect cluster;
- known-defect match, if any;
- blocker/non-blocker severity; and
- confidence from 1–5.

Then score with the sealed map and scoring-only truth:

```bash
python3 experiments/grok-reviewer-benchmark/benchmark.py score \
  --run experiments/grok-reviewer-benchmark/runs/smoke-001 \
  --truth experiments/grok-reviewer-benchmark/corpus/truth.smoke.json \
  --adjudication /private/adjudication/smoke-001/completed.json \
  --blind-map /private/adjudication/smoke-001/blind-map.json \
  --output /private/adjudication/smoke-001/score.json
```

The summary reports defect-cluster precision, known-defect recall, false-positive
clusters on clean cases, blocker precision, wall time/tokens per valid blocker,
and all token dimensions. Valid newly discovered defects on a nominally clean
case are reported separately rather than mislabeled false positives.

## Tests

```bash
python3 -m unittest discover \
  -s experiments/grok-reviewer-benchmark/tests -p 'test_*.py' -v
```

The tests are offline and do not invoke reviewers or provider endpoints.
