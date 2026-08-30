# Approved arm-launcher contract

`benchmark.py` deliberately does not reimplement any reviewer. An approved
runner supplies one command array per arm. Each launcher wraps the stock pinned
entry point, translates its native output into `result.schema.json`, and writes
that JSON to `$BENCH_RESULT_PATH`. Commands are JSON arrays, not shell strings:

```sh
export GROK_BENCH_QQ_COMMAND_JSON='["/approved/bin/run-qq-mini-qa"]'
export GROK_BENCH_PR_AGENT_COMMAND_JSON='["/approved/bin/run-pr-agent-plain-diff"]'
export GROK_BENCH_MISOSPACE_COMMAND_JSON='["/approved/bin/run-misospace-action"]'
```

The harness records each exact array. Do not place credentials in an array.
`run_qq_mini_qa.py` and `qq-arm-plugin/` are the tracked native qq adapter. It
uses the pinned production Mini QA exports and the pinned host DSH/qq-models
runtime; it is not a replacement prompt. The two external command examples
remain contracts until their exact provisioned release entry points are bound.

## Input environment

Every launcher receives:

- `BENCH_ARM_ID`, `BENCH_CASE_ID`;
- `BENCH_REPOSITORY`: a fresh, clean detached checkout at `BENCH_HEAD`;
- `BENCH_BASE`, `BENCH_HEAD`;
- `BENCH_DIFF_PATH`: exact `git diff --binary --full-index --no-ext-diff`
  bytes whose SHA-256 was checked immediately before launch;
- `BENCH_TASK_PATH` and `BENCH_STANDARDS_PATH`, identically hashed for all arms;
- `BENCH_INPUT_MANIFEST` containing only input hashes/commits, never truth;
- `BENCH_TOOL_SOURCE`: the checkout whose pin the harness has verified;
- `BENCH_CLIENT_MODEL`, `BENCH_PROVIDER_MODEL`;
- `BENCH_RESULT_PATH`, `BENCH_OUTPUT_DIR`.

The external arms additionally receive `BENCH_OPENAI_BASE_URL` and
`OPENAI_BASE_URL`, both pointing to the local capture proxy. `OPENAI_API_KEY`
and `XAI_API_KEY` are inert proxy credentials. The bridge key is a random run-scoped synthetic value, not provider auth. It is
visible only to the capture proxy and is never put in a command, reviewer child
environment, header log, or snapshot. Host OAuth remains inside the tracked
xai-auth bridge process. The proxy requests the provider's final usage chunk on
streaming calls and records both original and forwarded request bytes.

No launcher receives a truth/adjudication path or another arm's artifact path.
The output directory and a private HOME/XDG/TMP tree are empty at launch; unrelated
benchmark variables, credentials, and operator-home paths are removed. The qq
launcher must retain the normal Mini QA read-only workspace isolation. PR-Agent plain-diff has head-file access
only through `BENCH_REPOSITORY`. `misospace` runs with `tool_mode=off`. Launchers
must not broaden those surfaces.

## Required stock behavior

### `qq-mini-qa`

Invoke the current repository `mini-qa` production path through the approved
host, using route/model `xai-auth/grok-4.6`. Construct its ordinary task
artifact/proposal packet from the supplied task and exact base/head. Do not
alter the prompt, bash behavior, inspection policy, or product settings. Parse
the durable `submit_review` findings. Set `blocks_merge=true` for each finding,
because current qq fails the review when findings are submitted. Normalize the
host response-log usage as `usage.host_captured`, and provide exact
`provider_evidence.request_models`/`response_models` from that log; preserve the
raw session/tool output under `$BENCH_OUTPUT_DIR`. External-arm model evidence is
filled from the capture proxy, so their launchers may omit `provider_evidence`.

### `pr-agent`

Run `The-PR-Agent/pr-agent` at
`1b6925ba8cc3ef6be09dec704a374da53091926c` (v0.44.0), using its shipped
plain-diff entry point with the exact diff file and checked-out head for file
enrichment. Supply the task bytes as the PR description. Configure
`xai/grok-4.6`, no fallback model, no publishing, and JSON output. Preserve the
native parsed review and JSON output. Translate its accumulated token usage to
`usage.tool_reported`; the harness compares every non-null field to captured
provider responses. Do not substitute a custom review prompt or GitHub PR mode.

### `misospace-pr-reviewer`

Run `misospace/pr-reviewer-action` at
`54dfb1aac20e1e410ad8f71dc3681b888500a1ec` (v2.2.1). Feed an unpublished local
PR/event fixture with the exact base/head, task description, and diff. Use model
`grok-4.6` through the supplied endpoint. Keep default review behavior,
`tool_mode=off`, and publishing disabled; document any compatibility-only
setting in `effective_config`. Preserve its structured findings/verdict. Native
usage may be omitted because the action is incomplete there; proxy response
usage is authoritative.

## Output rules

- `model`, `provider_model`, and `mode` must exactly equal the selected arm in
  `config.json`; the harness rejects aliases or fallback models.
- `effective_config` is a complete secret-free dump, including reasoning,
  temperature, output cap, retries, and unavoidable defaults/differences.
- A pass has no findings; a fail has at least one. Native severity/confidence is
  retained when available. `blocks_merge` captures whether that native finding
  is a blocker under that reviewer's verdict semantics.
- `processed_tokens = input_tokens + output_tokens`. Reasoning is separately
  reported but is normally a subset of output and is never added again.
- Retries, failures, truncation, and context events include all attempts. The qq
  host count is required. External `request_count` may be null because the
  harness replaces it with the authoritative proxy count. Raw native output and response logs stay under the arm output.
- `isolation.prior_findings_visible=false` and `publishing=false` are factual
  attestations, not defaults to assert without enforcing.
