# Current bash 10k window value

This is an offline, inspect-only study of the stock 10,000-byte bash result
window. It measures overflow reads, signal clipped by the prefix, and alternative
window contents. It does not treat shrinking already-complete results as a
success metric.

`census.py` imports the first-result join, frozen 11-class classifier, shell
shape helper, and unchanged keep-ladder predicates from
`../bash-filter-opportunity-current/census.py`. The delegated session cutoff and
exclusion are frozen in this directory. Historical commands are metadata only
and are never executed. Mixed result text is treated as one body and is never
segmented by subcommand.

Run:

```bash
python3 -m unittest discover -s experiments/bash-window-value-current -p 'test_*.py'
python3 experiments/bash-window-value-current/census.py
```

All policies are identity for bodies at or below 10,000 bytes and for sensitive
or unresolved observations. Overflow proposals fail open unless they are
strictly smaller and either form a complete selected result at or below 10,000
bytes or strictly increase visible named failure/hunk evidence. Exact omitted
line counts remain in markers.

`results.json` persists aggregate counts/UTF-8 bytes and a digest over bodyless
metrics only. It contains no commands, result bodies, selected windows,
excerpts, sample identifiers, or per-observation data. The local audit's
bounded review material was temporary and deleted; only aggregate disagreement
counts remain. No product behavior, runtime route, model, RTK, or live pair is
used.
