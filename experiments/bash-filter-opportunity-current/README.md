# Current all-bash filter opportunity

This is an offline, inspect-only census of all 11 frozen bash classes. It scans
the first result for each bash call in
`$HOME/.local/state/qq/sessions/**/session.jsonl.zstd`, imports the unchanged
`classify_bash` and `compound_shell` implementation from
`../cca-mixed-current/replay.py`, and measures explicit keep-list ladders plus
class-aware cap candidates.

Historical commands are classifier metadata and are never executed. Full
commands, result text, candidate text, excerpts, and per-observation rows are
never written. `results.json` contains aggregate counts/UTF-8 bytes and a digest
over bodyless metrics only. Sensitive and unresolved observations remain
identity for filter evaluation while staying in census and keep-ladder
denominators.

Run:

```bash
python3 -m unittest discover -s experiments/bash-filter-opportunity-current -p 'test_*.py'
python3 experiments/bash-filter-opportunity-current/census.py
```

The snapshot cutoff and excluded delegated session are frozen in `census.py`.
Measurements are pre-envelope UTF-8 bytes; exact ladder ceilings are split by
original position inside the first 10,000 bytes versus the clipped tail. Compression mechanisms, paid models, historical command execution, runtime
routing, and live pairs are not used.
