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

## Current status and one unblock

The frozen corpus and offline harness are ready and verified. The three-case
live smoke was **not started** because this shell exposes no `XAI_API_KEY`,
`OPENAI_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`, or `ANTHROPIC_API_KEY`; no local TCP
listener or `qq` CLI is available; and the host-only `xai-auth` route has no
discoverable reusable OpenAI-compatible endpoint. Public fetching of the two
pinned source trees also failed because DNS is unavailable. No private host auth
file was inspected or copied.

The single unblock is an approved benchmark runner bundle that:

- exposes the same Grok 4.6 service through a sanctioned OpenAI-compatible base
  URL/credential bridge without revealing the credential;
- pre-provisions the exact pinned PR-Agent and misospace source checkouts;
- supplies three stock arm launchers satisfying `adapters/README.md`; and
- mounts repositories containing the frozen commit objects.

`benchmark.py doctor` reports all missing pieces under that one runner unblock
and exits 2 before any model call. `status.json` records the secret-free observed
state.

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

The current local repositories that contain all smoke objects can be selected as
follows; an approved runner may mount equivalent object-complete repositories:

```bash
export GROK_BENCH_REPO_QQ_UI=/path/to/object-complete/qq-ui
export GROK_BENCH_REPO_QQ_INDEX=/path/to/object-complete/qq-index
python3 experiments/grok-reviewer-benchmark/benchmark.py verify
```

The approved runner then supplies source locations, command arrays, and bridge:

```bash
export GROK_BENCH_QQ_SOURCE=/path/to/qq-workflows
export GROK_BENCH_PR_AGENT_SOURCE=/path/to/pr-agent-at-1b6925b
export GROK_BENCH_MISOSPACE_SOURCE=/path/to/pr-reviewer-action-at-54dfb1a

export GROK_BENCH_QQ_COMMAND_JSON='["/approved/bin/run-qq-mini-qa"]'
export GROK_BENCH_PR_AGENT_COMMAND_JSON='["/approved/bin/run-pr-agent-plain-diff"]'
export GROK_BENCH_MISOSPACE_COMMAND_JSON='["/approved/bin/run-misospace-action"]'

export GROK_BENCH_BASE_URL=https://sanctioned-openai-compatible.example/v1
read -rsp 'Benchmark bridge credential: ' GROK_BENCH_API_KEY
export GROK_BENCH_API_KEY

python3 experiments/grok-reviewer-benchmark/benchmark.py doctor
python3 experiments/grok-reviewer-benchmark/benchmark.py run --run-id smoke-001
```

Do not put the credential in a command array, config file, artifact, or shell
history. The harness strips credentials and unrelated benchmark variables from reviewer
environments and gives each arm a fresh private HOME/XDG/TMP tree. External
reviewers get only an inert local proxy key; the proxy alone gets the real key.
Runs are serial and use the balanced schedule in `config.json`, with a recorded
10-second cooldown. The exact command array, source pin/blob IDs, full effective
arm config, start/finish times, and wall-clock duration are retained.

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
