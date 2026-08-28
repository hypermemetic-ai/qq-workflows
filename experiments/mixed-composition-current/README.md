# Current mixed-bash composition census

This is an offline, inspect-only census of the frozen classifier's
`mixed/compound` bash class. It scans the first result for each bash call in
`$HOME/.local/state/qq/sessions/**/session.jsonl.zstd`, imports `classify_bash`
and `compound_shell` from `../cca-mixed-current/replay.py`, and measures body
composition plus transparent structural filter candidates.

Historical commands are metadata and are never executed. Full commands, result
bodies, excerpts, and per-observation records are never written. `results.json`
contains aggregates and a digest over bodyless observation metrics only.
Sensitive and unresolved mixed observations are included in composition and are
identity for filter evaluation.

Run:

```bash
python3 -m unittest discover -s experiments/mixed-composition-current -p 'test_*.py'
python3 experiments/mixed-composition-current/census.py
```

The study cutoff and excluded session are frozen in `census.py`. Measurements
are pre-envelope UTF-8 bytes. CCA, RTK, paid models, historical commands, and
live pairs are not invoked.
