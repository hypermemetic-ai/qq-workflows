# Bash window contract: measure the middle hole

## Decision

**Keep stock C1. Build nothing. Investment count: 0.**

Stock is already the natural log shape: below 10,000 Unicode code points it is
identity; at or above 10,000 it is the first 5,000 source points, one exact
omitted-count marker, and the last 5,000 source points. This is true in the DSH
`truncateObservation` path and in Mini's `output_head` / `output_tail` template.
C1 is shipped baseline behavior, not an investment in this study.

The middle hole does contain useful material. On the **278 pre-envelope overflow
bodies whose full text is actually present in the frozen archive**, C1's hole
contains 616,418 code points on direct fail lines, 223,996 on observed hunk
lines, and 1,395,474 on locator lines. These sets overlap. Test and mixed bodies
account for meaningful portions of each.

C2 does not return enough of that middle as a readable document. Across the
evaluable set it recovers only 14 fully hidden fail lines, no fully hidden
hunk lines, and two fully hidden locator lines. Ten of the 14 newly visible
fail/hunk lines lose both original immediate physical-line neighbors. The
accepted documents replace their single C1 holes with 144 marked structural
holes; across
accepted and fail-open documents C2 has 414 markers versus C1's 278.

A bounded side-by-side audit agrees that this is not an investable improvement.
On 19 raw overflow bodies across the ten classes with evaluable examples, C1
would prompt a narrower re-read in 15 and carried wrong-edit/location/state risk
in 13; C2's counts were 14 and 12. C2 helped one failure-heavy test document,
but exact-repeat markers made other completed structured/mixed documents harder
to associate locally. A runtime contract for this handful of useful recoveries
and a one-body audit improvement is the prohibited handful/no-net-zero trade.

Nothing was enabled. No product source, default, router, RTK, live pair, model
judge, reorder, collage, or alternate selection family is included.

## 1. The actual envelope and what the archive contains

Production counts Unicode code points, not UTF-8 bytes:

- `src/observation.mjs::truncateObservation` returns identity only when
  `chars < 10000`; otherwise it emits 5,000 head points, the environment marker,
  and 5,000 tail points.
- `src/official-mini.mjs::formatSummaries` and
  `src/mini-swe-v2.mjs::renderMiniSweObservation` use the same threshold and
  5,000/5,000 split, represented as JSON `output_head`, `output_tail`, and
  `elided_chars`.

The first-result scanner imports the exact stored text block. It does not recover
text already omitted by either production path. The census therefore normalizes
stored observations before measuring them:

| stored shape | bodies | handling |
|---|---:|---|
| raw text | 8,236 | stored text is the logical output |
| Mini identity JSON | 7,081 | logical output is the JSON `output` field; JSON escaping is not a second overflow |
| Mini head+tail JSON | 1,503 | already C1; 5,000-point fields and reported hole are counted, but hole text is unavailable |
| DSH head+tail text | 192 | already C1; exact 5,000/marker/5,000 shape is counted, but hole text is unavailable |

This correction matters. There are **1,973 logical overflows**, not the prior
serialized-body count. Of those, 1,695 are already-windowed archived C1 results.
Their 336,921,742 reported middle points are genuinely absent from the corpus;
the study records their size but does not invent a ladder or signal composition
for them and does not apply C2 to their serialization a second time. The full
pre-envelope text is available for 278 overflows, covering a 2,636,482-point
measurable middle. The other 15,039 logical bodies are under the cap and remain
identical under both contracts.

This observability limit is a primary result, not an assumption that the missing
stock holes contain no evidence. It prevents a broad safety claim for either
contract. It also prevents the invalid conclusion that repacking already-capped
Mini JSON is a C2 completion.

## 2. Real head / hole / tail census

All counts below are Unicode code points. `H/M/T` means head / middle hole /
tail. The first table includes known hole sizes for already-windowed bodies even
when the hole text itself is unavailable.

| frozen class | logical overflows | raw/evaluable | already C1 | all logical H/M/T chars |
|---|---:|---:|---:|---:|
| git_diff | 116 | 43 | 73 | 580,000 / 1,499,772 / 580,000 |
| git_status | 1 | 1 | 0 | 5,000 / 2,630 / 5,000 |
| listing | 68 | 16 | 52 | 340,000 / 13,997,514 / 340,000 |
| lockfile/json | 30 | 8 | 22 | 150,000 / 1,094,435 / 150,000 |
| mixed/compound | 1,071 | 111 | 960 | 5,355,000 / 283,329,837 / 5,355,000 |
| npm/install/debug_log | 4 | 2 | 2 | 20,000 / 30,473 / 20,000 |
| other | 39 | 16 | 23 | 195,000 / 4,884,830 / 195,000 |
| search | 166 | 15 | 151 | 830,000 / 21,000,286 / 830,000 |
| source_dump | 352 | 0 | 352 | 1,760,000 / 4,282,010 / 1,760,000 |
| test | 105 | 52 | 53 | 525,000 / 9,120,715 / 525,000 |
| write/edit | 21 | 14 | 7 | 105,000 / 315,722 / 105,000 |
| **all** | **1,973** | **278** | **1,695** | **9,865,000 / 339,558,224 / 9,865,000** |

### Frozen-ladder location on the measurable subset

The next table covers only the 278 raw bodies for which all regions are present.
`K_fail`, `K_hunk`, and `K_nav` are the imported cumulative ladders and therefore
overlap. `structural` and `leftover unique` are disjoint partition endpoints.
No predicate or ladder was revised.

| frozen class | structural H/M/T | K_fail H/M/T | K_hunk H/M/T | K_nav H/M/T | leftover unique H/M/T |
|---|---:|---:|---:|---:|---:|
| git_diff | 4,476 / 19,435 / 14,705 | 41,233 / 95,314 / 77,471 | 134,156 / 232,569 / 158,383 | 150,409 / 260,006 / 176,040 | 64,591 / 71,668 / 38,960 |
| git_status | 4 / 0 / 1,264 | 271 / 102 / 1,372 | 271 / 102 / 1,372 | 4,932 / 2,536 / 2,759 | 68 / 94 / 2,241 |
| listing | 4,103 / 16,352 / 11,188 | 14,175 / 66,625 / 24,920 | 14,175 / 68,296 / 25,221 | 53,842 / 106,941 / 70,726 | 26,158 / 26,990 / 9,274 |
| lockfile/json | 6,777 / 8,078 / 9,790 | 7,850 / 8,860 / 11,568 | 7,850 / 8,860 / 11,568 | 15,139 / 14,714 / 19,315 | 24,861 / 36,024 / 20,685 |
| mixed/compound | 25,471 / 52,088 / 33,275 | 105,283 / 284,645 / 133,391 | 133,969 / 321,339 / 162,437 | 396,615 / 790,916 / 411,695 | 158,385 / 211,544 / 143,305 |
| npm/install/debug_log | 564 / 480 / 1,692 | 929 / 480 / 1,846 | 1,254 / 480 / 1,846 | 4,382 / 580 / 5,240 | 5,618 / 2,479 / 4,760 |
| other | 2,831 / 10,692 / 8,121 | 5,316 / 13,773 / 11,121 | 5,316 / 13,773 / 11,121 | 38,796 / 151,971 / 39,501 | 41,204 / 101,555 / 40,499 |
| search | 275 / 1,141 / 1,936 | 20,941 / 183,968 / 29,559 | 20,941 / 183,968 / 29,559 | 43,845 / 232,563 / 50,927 | 31,155 / 20,242 / 24,073 |
| source_dump | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| test | 21,845 / 62,840 / 44,825 | 45,022 / 86,382 / 60,258 | 45,486 / 86,873 / 60,321 | 99,020 / 167,565 / 102,683 | 160,980 / 271,900 / 157,317 |
| write/edit | 2,586 / 16,455 / 7,841 | 8,436 / 28,065 / 13,054 | 8,436 / 28,065 / 13,054 | 44,324 / 107,311 / 44,871 | 25,676 / 58,883 / 25,129 |
| **all measurable** | **68,932 / 187,561 / 134,637** | **249,456 / 768,214 / 364,560** | **371,854 / 944,325 / 474,882** | **851,304 / 1,835,103 / 923,757** | **538,696 / 801,379 / 466,243** |

The exact disjoint measurable-hole partition is 187,561 structural; 580,653
`K_fail` increment; 176,111 `K_hunk` increment; 890,778 `K_nav` increment; and
801,379 leftover unique points. Those sum to the 2,636,482-point measurable
hole. Structural text is a small minority; unique and named payload dominate.

### Test and mixed holes

These are the two requested headline classes:

- **Test:** 105 logical overflows. Full text is available for 52 and already
  windowed for 53. The total logical hole is 9,120,715 points; 439,465 are
  measurable and 8,681,250 are unavailable. In the measurable hole, cumulative
  `K_fail` / `K_hunk` / `K_nav` are 86,382 / 86,873 / 167,565, structural is
  62,840, and leftover unique is 271,900. Direct fail / hunk / locator lines
  account for 38,084 / 491 / 96,627 points.
- **Mixed/compound:** 1,071 logical overflows. Full text is available for 111 and
  already windowed for 960. The total logical hole is 283,329,837 points;
  1,002,460 are measurable and 282,327,377 are unavailable. In the measurable
  hole, cumulative `K_fail` / `K_hunk` / `K_nav` are 284,645 / 321,339 /
  790,916, structural is 52,088, and leftover unique is 211,544. Direct fail /
  hunk / locator lines account for 235,564 / 45,480 / 700,959 points. Mixed text
  remains one first-result body; it is never segmented by subcommand.

Failures at a run's end are already in C1's tail. These counts concern evidence
in the middle, not the prior study's fictional clipped tail.

## 3. Document contracts and fidelity

### C1 — stock head+tail

C1 is identity under 10,000 points. On overflow its source projection is head
5,000 followed by tail 5,000, in original order, with one explicit middle
marker. It has one middle hole and reaches the original ending. This is the
baseline, not a proposed build.

### C2 — in-place elision, complete or fail open

C2 is also identity under the cap. On overflow it may remove only contiguous
runs in the safe subset of imported `K_struct`: blank/layout decorators,
recognized progress, and exact repeats after their first occurrence. The broad
frozen rung also marks every ANSI- or CRLF-bearing line; C2 retains first-seen
payload on those lines rather than deleting a whole unique line to remove an
encoding detail. This is a stricter use of unchanged frozen flags, not a revised
ladder.

Every retained source line stays in original order. Each omitted run gets an
exact character-and-line-count marker at that location. C2 is accepted only if
the **entire marked document** is strictly below 10,000 code points. Otherwise
it returns stock C1 on the original. It never elides and then applies head+tail.

“Subsequence” is measured on the source projection after removing explicit
markers. On all 278 evaluable overflows, C1 and C2 each have zero subsequence
violations. Under-cap shrink is zero.

| fidelity measure, evaluable overflow only | C1 | C2 |
|---|---:|---:|
| source-projection subsequence violations | 0 | 0 |
| marker holes | 278 | 414 |
| interior marker holes | 278 | 412 |
| unmarked continuation / structural false completeness | 0 | 0 |

Accepted C2 documents have 144 markers, 136 more holes than their
single-hole C1 forms. Markers prevent silent gluing, but marker count and local
placement still matter for readability.

### Hole evidence returned by C2

A “fully hidden line” is a whole physical line inside C1's middle hole. Evidence
on fail-open bodies remains missing because C2 returns C1 unchanged.

| direct line kind | C1 hole chars | fully hidden lines | C2 recovered lines | still missing on fail-open | structural overlap still elided on accepted bodies |
|---|---:|---:|---:|---:|---:|
| fail | 616,418 | 2,745 | 14 | 2,630 | 101 |
| hunk | 223,996 | 4,710 | 0 | 4,710 | 0 |
| locator | 1,395,474 | 6,084 | 2 | 6,070 | 12 |

The 14 newly visible fail/hunk lines occur on two accepted bodies. Only two keep
both original immediate physical-line neighbors; two keep one; **ten keep
neither**. An explicit nearby marker is not a test name, path, or hunk header.
C2 therefore recovers named evidence without reliably recovering its action
neighborhood.

Both contracts have explicit omission markers and reach the original end, so
the structural unmarked-continuation count is zero. The audit also found no
false-complete or glued-event body. This does not claim that a marker makes a
document semantically complete; it only rules out an unmarked continuation.

## 4. Temporary readability audit

The audit selected up to two raw pre-envelope overflows per frozen class: one C2
completion with the most C1-hole direct signal where available plus the largest
fail-open, otherwise the two largest fail-opens. Only one raw `git_status`
overflow existed, and no raw `source_dump` overflow existed. This yielded 19
bodies across ten classes: four sampled C2 completions and 15 fail-opens. The
same body was judged under C1 and C2.

| bounded judgment | C1 | C2 |
|---|---:|---:|
| would prompt a narrower re-read | 15 / 19 | 14 / 19 |
| could induce wrong edit/location/state | 13 / 19 | 12 / 19 |
| false-complete appearance | 0 / 19 | 0 / 19 |
| glued-together events | 0 / 19 | 0 / 19 |

C2 helped a failure-heavy test document by exposing middle failure sections and
common repeated diagnostics. It did not rescue any hunk line in the aggregate.
Other accepted documents gained many tiny markers among repeated structured
fields or repeated report metrics, weakening local association and still
prompting a re-read. Fail-open bodies were exactly C1, as required.

All commands, bodies, windows, sample identifiers, and excerpts used for this
review were temporary and deleted. Only the aggregate counts above persist.
They are bounded disagreement counts, not accuracy estimates.

## 5. Footnotes, reproducibility, and limits

Completion and density do not choose the contract. For completeness only, C2
turns 8 of 278 evaluable overflows into whole marked documents. Visible direct
fail/hunk/locator source density is 58.4706% for C1 and 58.2756% for C2 across
those documents; C2 removes repeated signal text as well as recovering a little
middle evidence. There is no density win to substitute for fidelity.

UTF-8 totals are retained only as a results footnote. Every threshold, window,
hole, marker acceptance check, and report headline uses Unicode code points.

The delegated cutoff is `1787925121608` ms
(`2026-08-28T13:52:01.608000+00:00`). The scanner imports that cutoff, the
first-result join, frozen 11-class classifier, shell shape helper, and unchanged
keep ladders through `experiments/bash-window-value-current/census.py`.
Historical commands are classification metadata only and are never executed.

Run:

```bash
python3 -m unittest discover -s experiments/bash-window-contract-current -p 'test_*.py'
python3 experiments/bash-window-contract-current/census.py
```

`results.json` is aggregate-only and contains no command, body, selected window,
excerpt, sample identifier, or per-observation row. The study cannot classify
336,921,742 middle points already absent from archived stock observations. A
future study would need pre-envelope capture, but that is not an investment in
C2 and does not justify a runtime change now.

**Final investment count: 0. Keep C1 stock head+tail.**
