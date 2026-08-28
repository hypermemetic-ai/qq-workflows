# Current-corpus mixed CCA replay

This is an offline, inspect-only experiment. It scans first bash result bodies
from `$HOME/.local/state/qq/sessions/**/session.jsonl.zstd`, classifies them with
the frozen historical classifier, and invokes pinned CCA only for joined,
non-sensitive `mixed/compound` bodies. Historical commands are never executed.

Run:

```bash
python3 -m unittest discover -s experiments/cca-mixed-current -p 'test_*.py'
python3 experiments/cca-mixed-current/replay.py --scan-only
python3 experiments/cca-mixed-current/replay.py
```

`results.json` contains byte/count aggregates and a deterministic digest over
bodyless observation records. It contains no full command, body, compressed
body, excerpt, or per-observation record. The stock 10k presentation
envelope is deliberately not applied: input/candidate/gated comparisons are
pre-envelope UTF-8 bytes. Sensitive and unresolved mixed observations, plus CCA
errors and gate rejects, are identity.

The default persistent JSON-lines transport reuses the Node process but calls
the same pinned synchronous CCA operation as `cca_bridge.cjs`; representative
marker-stripped candidates were validated byte-for-byte before the replay.
