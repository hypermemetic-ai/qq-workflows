# Frozen ADR-Jev experiment fixtures (historical evidence, test-only)

Copied VERBATIM from the historical binary-vs-ternary experiment artifacts at
`/home/qqp/.local/state/qq-workflows/adr-jev-experiments/binary-vs-ternary-20260922T220341Z/`
(`fixtures/{questions-frozen,passages,candidate-adr,labels-eval}.json`,
`raw/<call>/{request,response}.json`, `runlog.json`).

These files are HISTORICAL EXPERIMENT EVIDENCE used only as deterministic test
fixtures. They are NOT production runtime dependencies and carry no production
recall calibration claim:

* only 2 of the 12 passage states are real excerpts (see `kind` in
  `labels-eval.json`: units `6a8f2f`, `fc72cd`); the other 10 are constructed
  synthetic controls;
* ALL pass2 candidate ADR fixtures are synthetic (`candidate-adr.json`);
* `labels-eval.json` labels are provisional evaluator annotations registered
  before any provider response — never model input, never ground truth;
* `raw/*/request.json` and `raw/*/response.json` are the OBSERVED sanitized
  request bodies and raw provider responses of the 12 recorded binary calls
  (model jev-1.13.0, SystemOne v1). No authorization value is present or was
  ever stored (`meta.json` is deliberately NOT copied: it holds the credential
  source label);
* `runlog.json` is the original call log (provenance for the observed outputs).

Attribution: produced by the adr-jev binary-vs-ternary experiment
(2026-09-22T22:03:41Z run), reused narrowly for deterministic replay and
byte-match wording tests in this repository's test suite.
