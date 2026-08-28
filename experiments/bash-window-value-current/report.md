# Bash window value: overflow reads and denser 10k selections

## Decision

**Invest in one family for further inspect-only work: the general evidence-first
window pack. Do not enable it or use it as deletion. Do not build the three
specialized class families or their combined route.**

At the exact stock boundary, **2,021 of 17,012 bash first-result bodies
(11.8798%) exceed 10,000 UTF-8 bytes**. They hold 23,789,923 bytes and the stock
prefix clips **3,579,923 tail bytes**. The remaining **14,991 bodies are already
complete reads** and stay byte-identical under every policy.

The clipped tail contains **1,484,385 bytes of named failure-or-hunk evidence**:
1,314,806 bytes match imported `K_fail` predicates and 224,287 match observed
`K_hunk` predicates (the sets overlap). Test tails contain **65,778** union
bytes; mixed tails contain **652,745**. The prefix envelope currently drops all
of that tail evidence.

The general evidence-first policy changes the contents of overflow windows. It
prioritizes named failure lines and observed diff hunks, then fills the remaining
budget with first-seen unique payload in original order. With strict fail-open
behavior it changes global overflow from **2,021 → 988**, making **1,033 selected
results complete**. It returns **403,919 clipped failure/hunk bytes** to the
visible window (27.2112% of the available clipped union). Named evidence density
across the reads rises from **60.5493% to 73.5940%**. It is broad enough to avoid
a class router and the effect is not a handful of bodies.

That is an opportunity, not a safety proof. In a temporary audit of the largest
eligible overflow observations, the stock prefix hid load-bearing tail in
**21/21** bodies, while evidence-first omitted load-bearing middle unique payload
in **21/21**. The selection trades one hidden region for another; it does not
make omitted payload noise. Any follow-up must retain exact omission markers,
fail open, keep the original retrievable, and remain non-default until evidence
risk is resolved.

The class-routed alternatives are not investments. First/last-40 completes 42
reads, listing/search first-50 completes 31, and passing-test fold completes 2.
A combined router completes 745—fewer than general evidence-first—and recovers
less clipped evidence. Their class maintenance and mid-body evidence risk do not
clear no-net-zero.

These are UTF-8 byte/window measurements, not token, spend, price, or cost
claims. Nothing was turned on.

## Method and frozen corpus

The delegated session creation time freezes the cutoff at `1787925121608` ms
(`2026-08-28T13:52:01.608000+00:00`). Session
`session-676456e0-e1b6-4b74-a066-bd044f1bdacf` is excluded and later events are
ignored. The scanner joins every bash call to its first result in the same
session.

The study imports `scan_corpus`, `classify_bash`, `compound_shell`,
`body_shape`, and the entire unchanged keep ladder from
`experiments/bash-filter-opportunity-current/census.py`; the classifier itself
comes from `experiments/cca-mixed-current/replay.py`. Historical commands are
used only by the frozen classifier and mixed-shape counter and are never run.
Classifier reconstruction mismatches are zero. Mixed output remains a whole
first-result body; no cat-vs-test or other subcommand split is attempted.

| coverage | value |
|---|---:|
| archives at/before cutoff | 600 |
| included sessions | 599 |
| bash-issuing sessions | 426 |
| bash first-result bodies/calls | 17,012 |
| joined bodies | 17,005 |
| all bash bytes | 42,231,750 |
| sensitive identity observations | 76 bodies / 243,891 bytes |
| unresolved identity observations | 7 bodies / 0 bytes |
| archive/JSON decode failures | 0 / 0 |
| classifier reconstruction mismatches | 0 |

Byte counts are pre-envelope UTF-8 with replacement for invalid scalar values.
A line crossing byte 10,000 contributes bytes, and a touching-line count, to
both regions. Commands, bodies, selections, excerpts, sample identifiers, and
per-observation rows are not persisted.

## 1. Overflow census

Overflow means **strictly greater than 10,000 bytes**, not greater than 10 KiB.
The earlier ~1,696 figure came from the prior snapshot's `>10 KiB` size stratum
(`>10,240` bytes); it omitted bodies from 10,001 through 10,240 even though the
stock 10,000-byte prefix clips them. The generated result records both thresholds
for the current snapshot: **314** bodies are 10,001–10,240 bytes and **1,707**
are greater than 10 KiB, totaling the 2,021 exact-envelope overflows.

| frozen class | overflow bodies | overflow body bytes | clipped tail bytes | already complete bodies | overflow share of all bash calls |
|---|---:|---:|---:|---:|---:|
| `source_dump` | 371 | 3,929,255 | 219,255 | 250 | 2.1808% |
| `listing` | 69 | 844,112 | 154,112 | 883 | 0.4056% |
| `search` | 166 | 1,981,117 | 321,117 | 566 | 0.9758% |
| `git_diff` | 116 | 1,516,036 | 356,036 | 534 | 0.6819% |
| `git_status` | 1 | 12,630 | 2,630 | 1,303 | 0.0059% |
| `test` | 105 | 1,535,230 | 485,230 | 1,355 | 0.6172% |
| `npm/install/debug_log` | 4 | 43,867 | 3,867 | 77 | 0.0235% |
| `lockfile/json` | 30 | 368,436 | 68,436 | 361 | 0.1763% |
| `write/edit` | 21 | 379,278 | 169,278 | 168 | 0.1234% |
| `mixed/compound` | 1,099 | 12,525,497 | 1,535,497 | 4,875 | 6.4601% |
| `other` | 39 | 654,465 | 264,465 | 4,619 | 0.2292% |
| **total** | **2,021** | **23,789,923** | **3,579,923** | **14,991** | **11.8798%** |

Overflow bodies hold 56.3318% of all bash bytes. This is census context, not a
byte-deletion objective. Bodies already at or below 10,000 total 18,441,827
bytes and are complete reads.

No body exceeds 100,000 bytes, and none exceeds 100 KiB.

### Mixed command shape

Shapes are whole-command operator signatures from the imported helper. They do
not segment result text.

| exclusive mixed shape | all bodies | overflow bodies | overflow body bytes | clipped tail bytes |
|---|---:|---:|---:|---:|
| `&&` | 1,169 | 61 | 683,795 | 73,795 |
| `&&+heredoc` | 313 | 5 | 52,323 | 2,323 |
| `&&+pipe` | 1,060 | 368 | 3,922,769 | 242,769 |
| `&&+pipe+heredoc` | 247 | 36 | 394,488 | 34,488 |
| `heredoc` | 691 | 54 | 859,302 | 319,302 |
| `pipe` | 1,953 | 503 | 5,712,960 | 682,960 |
| `pipe+heredoc` | 541 | 72 | 899,860 | 179,860 |
| **mixed total** | **5,974** | **1,099** | **12,525,497** | **1,535,497** |

## 2. Where signal sits relative to the prefix

Two views are intentionally separate:

1. **Named evidence** applies the imported direct predicates. `K_fail` is a
   diagnostic/failing-name/trace/diff-header match; `K_hunk` is an add/remove
   line after an observed diff; `K_nav` is a narrow navigation match. These can
   overlap structural lines and each other. Headline recovery and density use
   the `K_fail ∪ K_hunk` union without double counting.
2. **Frozen additive ladders** remain unchanged. Their cumulative `K_fail`
   includes `K_struct` by construction. `results.json` reports all cumulative
   rungs, plus the disjoint structural → fail increment → hunk increment → nav
   increment → leftover-unique partition. This prevents structural repeats from
   being mislabeled as failure density.

### Named matches by region

| named set | prefix touching lines | prefix bytes | clipped-tail touching lines | clipped-tail bytes |
|---|---:|---:|---:|---:|
| direct `K_fail` | 26,033 | 19,199,012 | 5,880 | 1,314,806 |
| observed `K_hunk` | 17,328 | 876,541 | 4,559 | 224,287 |
| **`K_fail ∪ K_hunk`** | **42,136** | **19,984,618** | **9,724** | **1,484,385** |
| direct `K_nav` | 61,243 | 29,790,717 | 8,076 | 2,181,777 |

### Failure/hunk evidence clipped, by frozen class

| class | prefix touching lines | prefix evidence bytes | tail touching lines | clipped evidence bytes |
|---|---:|---:|---:|---:|
| `source_dump` | 1,090 | 3,775,686 | 607 | 180,128 |
| `listing` | 701 | 300,612 | 290 | 70,075 |
| `search` | 1,180 | 1,498,588 | 265 | 218,187 |
| `git_diff` | 15,522 | 1,272,894 | 4,640 | 251,227 |
| `git_status` | 1,050 | 122,466 | 3 | 61 |
| **`test`** | **3,654** | **884,266** | **481** | **65,778** |
| `npm/install/debug_log` | 222 | 61,379 | 5 | 660 |
| `lockfile/json` | 323 | 277,666 | 49 | 9,017 |
| `write/edit` | 388 | 114,510 | 316 | 23,772 |
| **`mixed/compound`** | **16,626** | **11,381,062** | **3,008** | **652,745** |
| `other` | 1,380 | 295,489 | 60 | 12,735 |
| **total** | **42,136** | **19,984,618** | **9,724** | **1,484,385** |

The large source/mixed named-byte counts partly reflect long physical lines: a
single diagnostic match makes the whole line evidence under this line-level
ladder. They are priority measurements, not semantic-equivalence claims.

### Disjoint frozen-ladder partition by region

| earliest rung/category | prefix touching lines | prefix bytes | tail touching lines | tail bytes |
|---|---:|---:|---:|---:|
| structural | 35,150 | 666,504 | 8,477 | 219,976 |
| fail increment | 24,780 | 19,115,899 | 5,267 | 1,272,901 |
| hunk increment | 14,059 | 756,073 | 3,033 | 156,253 |
| nav increment | 49,874 | 11,823,267 | 5,577 | 1,076,239 |
| leftover unique after `K_nav` | 148,755 | 6,290,084 | 15,221 | 854,554 |
| **total** | — | **38,651,827** | — | **3,579,923** |

This table accounts for every byte exactly. A crossing physical line can appear
in both touching-line columns, so touching-line counts are not additive body
line totals.

## 3. Window policies

Every policy short-circuits to identity for all 14,991 already-complete bodies.
Sensitive and unresolved bodies are identity too. For an eligible overflow body,
a proposal is accepted only when it is strictly smaller and either:

- all selected content, including exact omitted-count markers, is at most 10,000
  bytes; or
- if selected content still exceeds 10,000, its visible failure/hunk bytes
  strictly exceed the stock prefix.

Otherwise the original body fails open. “Overflow after” therefore means either
an unchanged fail-open body or accepted selected content that itself still
exceeds 10,000 bytes.

| policy | applicable overflow before → after | global overflow before → after | complete selected reads | clipped evidence recovered | applicable evidence density before → after | accepted / fail-open eligible |
|---|---:|---:|---:|---:|---:|---:|
| evidence-first, all classes | 2,021 → 988 | **2,021 → 988** | **1,033** | **403,919** | **60.5493% → 73.5940%** | 1,083 / 928 |
| first/last-40 + `K_fail` | 405 → 363 | 2,021 → 1,979 | 42 | 188 | 72.1545% → 76.4583% | 42 / 361 |
| listing/search first-50 + `K_fail` | 235 → 204 | 2,021 → 1,990 | 31 | 5,836 | 46.7508% → 49.9946% | 32 / 201 |
| passing-test fold | 105 → 103 | 2,021 → 2,019 | 2 | 1,502 | 48.0815% → 48.2950% | 7 / 98 |
| class-aware route | 2,021 → 1,276 | **2,021 → 1,276** | 745 | 297,526 | 60.5493% → 70.1290% | 792 / 1,219 |

Density is named `K_fail ∪ K_hunk` bytes divided by the bytes actually visible
in each selected read, capped at 10,000. It is not “first-10k remaining length.”
For evidence-first, visible named evidence rises from 12,237,006 to 12,640,925
bytes; the 403,919-byte increase is clipped tail evidence brought into the read.
Of that recovery, 328,794 bytes match `K_fail` and 93,604 match `K_hunk`; overlap
means those two values do not sum to the union.

Evidence-first still leaves 988 overflows: 928 eligible proposals failed open,
ten identity exclusions remain unchanged, and 50 accepted selections increase
visible evidence but have more than 10,000 bytes of selected content.

### Evidence-first by class

| class | overflow before → after | clipped evidence recovered / available | evidence density before → after | eligible fail opens |
|---|---:|---:|---:|---:|
| `source_dump` | 371 → 248 | 25,900 / 180,128 | 75.010% → 85.802% | 247 |
| `listing` | 69 → 15 | 20,014 / 70,075 | 28.696% → 42.797% | 12 |
| `search` | 166 → 67 | 34,033 / 218,187 | 54.255% → 69.848% | 62 |
| `git_diff` | 116 → 52 | 94,896 / 251,227 | 61.241% → 74.673% | 28 |
| `git_status` | 1 → 0 | 61 / 61 | 4.160% → 4.792% | 0 |
| **`test`** | **105 → 41** | **31,159 / 65,778** | **48.082% → 54.074%** | **38** |
| `npm/install/debug_log` | 4 → 2 | 4 / 660 | 53.403% → 55.457% | 2 |
| `lockfile/json` | 30 → 9 | 2,809 / 9,017 | 39.346% → 52.066% | 8 |
| `write/edit` | 21 → 4 | 14,318 / 23,772 | 27.539% → 38.239% | 3 |
| **`mixed/compound`** | **1,099 → 541** | **173,881 / 652,745** | **61.895% → 76.118%** | **519** |
| `other` | 39 → 9 | 6,844 / 12,735 | 36.001% → 41.867% | 9 |

Mixed receives only this whole-body evidence-first policy. No source cap,
subcommand split, or optional pipe-last-stage route was evaluated.

### Under-10k footnote

The 14,991 already-complete bodies total 18,441,827 bytes. Their selected bytes
are also 18,441,827 under every policy: **under-10k shrink is zero**. This is an
identity invariant, not a success metric.

## 4. Temporary local audit

The audit selected up to the two largest joined, non-sensitive overflow bodies
from each frozen class: **21 bodies across all 11 classes** (only one overflowing
`git_status` body existed). Review compared bounded prefix-end, tail, and omitted
middle regions. Temporary commands, bodies, selections, identifiers, and
excerpts were deleted; only these aggregate disagreements persist:

- prefix 10k hid at least one load-bearing tail region in **21/21** bodies;
- evidence-first omitted at least one load-bearing middle unique region in
  **21/21** bodies;
- among the six pure source/JSON/log observations checked for head-tail,
  head-tail omitted load-bearing middle unique payload in **4/6**. The two
  exceptions had seven giant physical lines, so first/last-40 selected every
  line and the proposal failed open rather than pretending to cap the body.

Examples of the *kinds* of evidence seen, without retaining excerpts, included
later source/diff implementation, search/listing records, test assertion and
summary output, JSON directives and quantitative fields, operational/session
state, and final sandbox/exit diagnostics. These are sample disagreement counts,
not accuracy estimates.

The key result is symmetric: the stock prefix is not semantically safe either,
but evidence priority is not license to discard middle context. `K_fail` and
`K_hunk` are priority signals inside a bounded read, not definitions of all
load-bearing evidence.

## 5. Investment

| family | overflow/read result | clipped-signal result | evidence/complexity risk | recommendation |
|---|---:|---:|---|---|
| general evidence-first pack | 2,021 → 988; 1,033 complete | 403,919 recovered; density +13.0447 points | high semantic omission risk (21/21 audit), but one generic family, exact markers, strict fail-open | **invest in further inspect-only validation; no default** |
| pure head-tail | 42 complete | 188 recovered | loses load-bearing middle in 4/6 audited; giant lines often make it a no-op | do not build |
| listing/search first-50 | 31 complete | 5,836 recovered | unique match/listing loss plus routing | do not build |
| passing-test fold | 2 complete | 1,502 recovered | successful names/order loss for negligible completion | do not build |
| six-way class-aware route | 745 complete | 297,526 recovered | more policy/router surface and worse measured result than general pack | do not build |

**Investment count: 1**, limited to the general evidence-first window-packer as
a research candidate. Its scale clears the “handful of recovered bodies” bar,
and it does not need a many-class runtime router. The acceptance and omission
markers in this experiment are necessary but not sufficient. Before any product
proposal, follow-up should test whether users can reliably reach omitted original
payload and whether a richer mid-context allocator can reduce the 21/21 audit
disagreement. No production code or default is included here.

## Reproducibility and limits

Run:

```bash
python3 -m unittest discover -s experiments/bash-window-value-current -p 'test_*.py'
python3 experiments/bash-window-value-current/census.py
```

`results.json` contains complete aggregate overflow, shape, signal-location, and
policy breakdowns plus a SHA-256 over 17,012 bodyless observation metrics. It
contains no historical command, result body, selection, excerpt, sample
identifier, or per-observation data. Historical commands are not re-executed.
No product path, runtime route, RTK, paid model, or live pair is used.

Regex and whole-line matches are not semantic-equivalence proofs. A very long
line can become named evidence because of one short match. “Complete selected
read” means the chosen payload and omission markers fit; it does not mean the
original result is represented losslessly. This is a frozen local observational
snapshot, not a forecast for another corpus.
