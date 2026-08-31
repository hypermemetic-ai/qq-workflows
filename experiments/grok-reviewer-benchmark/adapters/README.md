# Active adapter contract

The live benchmark has exactly two approved launchers:

- `run_qq_mini_qa.py` — the current production bash-based qq Mini-QA component;
- `run_pr_agent.py` — pinned stock PR-Agent plain-diff/JSON CLI.

`run_misospace.py` is archived implementation/evidence only. It is not present
in active config, provisioning, readiness, bridge clients, execution, reports,
or required tests.

`qq-models-instrumented/` is not an arm. It delegates to the exact pinned
qq-models plugin and records only Grok HTTP attempt model/status/timing so the qq
arm retains provider-attempt retries/failures as well as DSH response usage. It
does not replace prompts, model behavior, auth, or response processing.

`host/runner.py` fixes the two launcher paths. Commands are recorded as JSON
arrays and never contain credentials. The qq launcher creates a fresh canonical
launcher session UUID on every invocation; the headless review agent has a
separate generated session UUID. PR-Agent uses a neutral 600-second AI timeout,
and both arms record complete secret-free effective config.

Every launcher receives a fresh detached `$BENCH_REPOSITORY`, exact
`BENCH_BASE`/`BENCH_HEAD`, SHA-verified diff/task/standards/input manifest, exact
pinned `$BENCH_TOOL_SOURCE`, model strings, and private output/result paths.
PR-Agent receives only its local capture-proxy URL and inert synthetic bearer.
No launcher receives truth, prior/other-arm findings, host OAuth contents, or
publication credentials.

The result contract preserves native and normalized verdicts separately and
allows fields the stock reviewer does not supply to remain null. Provider usage
uses disjoint uncached/cache input categories and does not double-count
reasoning. Raw native outputs remain under `$BENCH_OUTPUT_DIR`; captured PR-Agent
request/response bodies and authoritative usage remain in the provider artifact
folder.
