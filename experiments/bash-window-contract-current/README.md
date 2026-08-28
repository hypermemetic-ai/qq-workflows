# Current bash window contract

This directory is an offline, inspect-only comparison of two document shapes:

- **C1 (stock, already shipped):** identity below 10,000 Unicode code points;
  otherwise first 5,000 source points, an exact omitted-count marker, and last
  5,000 source points.
- **C2 (rejected candidate):** identity below the cap; otherwise remove only
  complete in-place runs in a safe subset of the unchanged frozen `K_struct`
  rung (blank/layout, recognized progress, and exact repeats). First-seen
  ANSI/CRLF-bearing payload remains. Accept only when the entire marked document
  is strictly below 10,000 code points; otherwise return C1 on the original,
  never elision plus head+tail.

`census.py` imports the cutoff, first-result join, frozen classifier, and keep
ladders through `../bash-window-value-current/census.py`. Mixed first-result text
stays one body. Historical commands are metadata and are never run.

The scanner normalizes Mini identity JSON to its logical `output`. It recognizes
Mini `output_head`/`output_tail` JSON and DSH truncation-marker text as already
windowed C1. Their reported hole sizes are counted, but unavailable middle text
is never reconstructed, classified, or sent through C2 a second time.

Run:

```bash
python3 -m unittest discover -s experiments/bash-window-contract-current -p 'test_*.py'
python3 experiments/bash-window-contract-current/census.py
```

`results.json` is aggregate-only. It stores no commands, bodies, windows,
excerpts, sample identifiers, or per-observation rows. Temporary audit material
was deleted. No product path, default, RTK, live pair, model judge, or alternate
collage/reorder family is enabled or evaluated. The report recommends zero
investments and keeping C1.
