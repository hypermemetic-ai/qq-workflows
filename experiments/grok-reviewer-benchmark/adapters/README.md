# Tracked stock launcher contract

The benchmark has exactly three tracked launchers:

- `run_qq_mini_qa.py` — current production-component qq Mini QA;
- `run_pr_agent.py` — pinned PR-Agent plain-diff CLI;
- `run_misospace.py` — pinned misospace stock internal review driver.

`qq-models-instrumented/` is not an arm. It delegates to the exact pinned
qq-models plugin and records only Grok HTTP attempt model/status/timing so the qq
arm has provider-attempt retries/failures as well as DSH response usage. It does
not replace prompts, model behavior, auth, or response processing.

`host/runner.py` registers these paths automatically. Commands are recorded as
JSON arrays and never contain credentials.

Every launcher receives a fresh detached `$BENCH_REPOSITORY`, exact
`BENCH_BASE`/`BENCH_HEAD`, SHA-verified `$BENCH_DIFF_PATH`, `$BENCH_TASK_PATH`,
`$BENCH_STANDARDS_PATH`, and a truth-free `$BENCH_INPUT_MANIFEST`; exact pinned
`$BENCH_TOOL_SOURCE`; model strings; and private result/output paths. External
launchers receive a local capture-proxy URL and inert bearer only. No launcher
receives truth, another arm's outputs, host OAuth contents, or publication
credentials.

The result schema preserves native and normalized semantics separately:

- `native_verdict`: `approve|request_changes|null`;
- `normalized_verdict`: `pass|fail|null`;
- `verdict_source`: `native|adapter_findings|none`;
- finding path, line, severity, confidence, and blocker status may be null when
  the stock reviewer does not supply them.

Do not infer blocker status for PR-Agent. qq submitted findings block under its
production semantics. misospace findings block only when native normalized
severity is explicitly `blocker`; its independent native verdict remains the
review-level merge recommendation.

Provider usage uses disjoint input/cache categories and does not double-count
reasoning. Raw native outputs remain under `$BENCH_OUTPUT_DIR`; external response
bodies and authoritative usage remain in the sibling provider artifact folder.
See the experiment README and `config.json` for exact entrypoints, environment
mappings, compatibility corrections, and unavoidable control differences.
