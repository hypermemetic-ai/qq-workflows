# Mixed bash composition: what is present, then what can be filtered

## Decision

**Keep `mixed/compound` identity.** The current frozen-class census is **5,907
bodies and 22,391,917 bytes**, or **53.5804%** of 41,791,274 bash first-result
bytes. This class is large because it combines real outputs, not because it
contains a comparably large unnamed waste family.

At the physical-line level, **22,046,346 bytes (98.4567%)** are first-seen,
payload-like lines. Exact copies after their first occurrence are only 329,429
bytes (1.4712%), and much of that repetition is evidence which should retain its
multiplicity: diagnostics, diff lines, paths, versions, or result counts. The
observed progress slice is 202 bytes; recognized tool wrappers are zero bytes.

A deliberately broad, count-preserving structural stack saves only **46,319
bytes (0.2069% of mixed bytes)** across 192 bodies. Even a separate high-risk
first/evidence/last slice removes only 84,063 bytes (0.3754%) because named
evidence and context occupy nearly all of the eligible large outputs. Neither
opportunity clears a no-net-zero-complexity bar. Do not add a product default,
runtime class router, or mixed filter for this.

These are UTF-8 byte measurements before the stock 10k presentation envelope.
**Bytes are not tokens, spend, price, or cost**, and this report makes no such
claim.

## Corpus and frozen definition

The snapshot is frozen at this delegated study session's creation time,
`1787915481900` ms (`2026-08-28T11:11:21.900000+00:00`). The study session
`session-401143a9-2d26-4793-a2e9-8c8409f236fe` is excluded. Events after the
cutoff are ignored. Calls are joined to the first result in the same session.

| measure | value |
|---|---:|
| session archives at/before cutoff | 592 |
| included sessions | 591 |
| bash-issuing sessions | 422 |
| bash calls | 16,870 |
| bash first-result bytes | 41,791,274 |
| mixed bodies/calls | 5,907 |
| joined mixed bodies | 5,903 |
| mixed bytes | 22,391,917 |
| mixed byte share | 53.5804% |
| mixed sensitive identity exclusions | 52 bodies / 152,398 bytes |
| mixed unresolved identity exclusions | 4 bodies / 0 bytes |
| archive/JSON decode failures | 0 / 0 |

The census imports the unchanged `classify_bash` and `compound_shell` from
`experiments/cca-mixed-current/replay.py`. It does not revise the 11 classes.
For constituent reporting it repeats the predicates inside `classify_bash` and
asserts their reconstructed final class against the imported classifier for
every bash call; mismatches are **zero**. “No-tag generic-compound” is the
existing final fallback, not a new tag or class.

CCA is not the measurement here and was not invoked. RTK, historical commands,
a paid model, and a live pair were also not invoked.

## 1. What mixed is made of

### Command shape

Operator counts are inclusive because one command can contain `&&`, a pipe, and
a heredoc. The generic fallback is a classifier path and likewise overlaps the
operator forms.

| inclusive shape/path | bodies | bytes | mixed-byte share |
|---|---:|---:|---:|
| pipe | 3,761 | 18,717,752 | 83.5916% |
| `&&` | 2,742 | 8,909,407 | 39.7885% |
| heredoc (`<<`) | 1,765 | 5,004,013 | 22.3474% |
| no-tag generic-compound fallback | 1,068 | 3,166,540 | 14.1414% |
| multi-tag compound path | 4,839 | 19,225,377 | 85.8586% |

The mutually exclusive operator signatures show where the overlap is:

| operator signature | bodies | bytes | mixed-byte share |
|---|---:|---:|---:|
| pipe | 1,943 | 9,761,743 | 43.5949% |
| `&&` + pipe | 1,041 | 6,045,749 | 26.9997% |
| pipe + heredoc | 539 | 1,977,296 | 8.8304% |
| heredoc | 683 | 1,743,471 | 7.7862% |
| `&&` | 1,158 | 1,580,412 | 7.0580% |
| `&&` + pipe + heredoc | 238 | 932,964 | 4.1665% |
| `&&` + heredoc | 305 | 350,282 | 1.5643% |

Pipes dominate bytes, but “pipe” does not identify a disposable output family:
the classifier requires multiple observed intents for the multi-tag path, and
those intents frequently include searches, source dumps, tests, listings, or
diffs.

### Constituent classifier tags

These counts are also inclusive. They use only the nine existing semantic tags
inside the frozen classifier.

| constituent tag | bodies | bytes | mixed-byte share |
|---|---:|---:|---:|
| `search` | 2,064 | 10,501,341 | 46.8979% |
| `source_dump` | 1,370 | 8,984,740 | 40.1249% |
| `test` | 1,555 | 6,693,651 | 29.8932% |
| `listing` | 1,556 | 5,891,713 | 26.3118% |
| `git_diff` | 1,693 | 5,183,115 | 23.1473% |
| `lockfile/json` | 1,193 | 4,769,195 | 21.2987% |
| `write/edit` | 1,166 | 3,172,475 | 14.1679% |
| `git_status` | 1,442 | 2,788,192 | 12.4518% |
| `npm/install/debug_log` | 203 | 738,514 | 3.2981% |

The largest exact combinations are below. There are 254 observed combinations;
`results.json` contains the complete aggregate breakdown. The top 20 account
for 71.7476% of bytes; the remaining 234 combinations are shown as a rollup
rather than a misleading single “other” family.

| constituent combination | bodies | bytes | mixed-byte share |
|---|---:|---:|---:|
| no-tag generic-compound | 1,068 | 3,166,540 | 14.1414% |
| `source_dump+search` | 277 | 2,283,261 | 10.1978% |
| `search+listing` | 457 | 1,712,755 | 7.6489% |
| `test+source_dump` | 179 | 1,474,185 | 6.5836% |
| `test+source_dump+search` | 139 | 1,083,949 | 4.8408% |
| `git_diff+git_status` | 554 | 700,096 | 3.1266% |
| `listing+lockfile/json` | 214 | 679,218 | 3.0333% |
| `git_diff+test` | 114 | 613,151 | 2.7383% |
| `search+listing+lockfile/json` | 122 | 541,357 | 2.4176% |
| `search+lockfile/json` | 139 | 524,695 | 2.3432% |
| `test+search` | 114 | 483,387 | 2.1587% |
| `git_diff+search` | 71 | 406,777 | 1.8166% |
| `test+write/edit` | 175 | 368,752 | 1.6477% |
| `source_dump+search+lockfile/json` | 40 | 341,394 | 1.5246% |
| `git_diff+source_dump` | 44 | 323,732 | 1.4458% |
| `source_dump+lockfile/json` | 39 | 297,136 | 1.3270% |
| `write/edit+lockfile/json` | 99 | 285,363 | 1.2744% |
| `git_status+listing` | 129 | 270,467 | 1.2079% |
| `source_dump+listing` | 42 | 266,718 | 1.1911% |
| `source_dump+search+listing` | 33 | 242,733 | 1.0840% |
| remaining 234 combinations | 1,858 | 6,326,251 | 28.2524% |

This composition argues for keeping payload: searches carry matching lines and
paths; source and JSON dumps carry exact code/configuration; listings carry
paths; tests carry failures, passing/failing names, summaries, and diagnostics;
diffs carry headers and hunks; edit commands often echo the changed material.
The 3.17 MB no-tag fallback is especially unsafe to route by class because the
frozen classifier supplies no semantic constituent tag for it.

### Size strata

| UTF-8 body size | bodies | body share | bytes | mixed-byte share |
|---|---:|---:|---:|---:|
| zero | 4 | 0.07% | 0 | 0.00% |
| 1–255 B | 1,345 | 22.77% | 157,895 | 0.71% |
| 256 B–1 KiB | 1,193 | 20.20% | 701,885 | 3.13% |
| >1–4 KiB | 1,344 | 22.75% | 2,952,806 | 13.19% |
| >4–10 KiB | 1,077 | 18.23% | 7,623,553 | 34.05% |
| >10–100 KiB | 944 | 15.98% | 10,955,778 | 48.93% |
| >100 KiB | 0 | 0.00% | 0 | 0.00% |

Bodies above 4 KiB supply 82.9734% of mixed bytes. Size creates an opportunity
for slicing, but it is not evidence that the middle is waste; the structural
inspection below finds the opposite.

## 2. Filterable structure versus payload

### Disjoint line census

Each physical line is assigned once. Exact repetition takes precedence after a
line's first exact occurrence within a body; the remaining categories describe
first occurrences. “First-seen” means byte-distinct within that body, not a
claim of semantic novelty.

| observed line family | lines | bytes | mixed-byte share | disposition |
|---|---:|---:|---:|---|
| first-seen other / payload-like | 112,161 | 22,046,346 | 98.4567% | keep |
| exact repetition after first occurrence | 15,210 | 329,429 | 1.4712% | inspect; not all disposable |
| routine passing-test line | 154 | 10,953 | 0.0489% | usually keep; medium-risk fold only |
| blank/pure-decoration layout | 1,097 | 4,987 | 0.0223% | disposable when redundant |
| progress update | 7 | 202 | 0.0009% | no viable run to fold |
| recognized tool wrapper | 0 | 0 | 0.0000% | no opportunity |

There are also 365 terminal-control bytes, measured inclusively because they are
substrings of lines. The first-result body extraction already excludes ordinary
tool transport metadata, explaining the zero recognized wrappers.

The 329 KB repeated ceiling must not be equated with drop bytes. Repeated
failures can encode recurrence, repeated paths can be distinct search/listing
records, repeated diff lines can occur in separate hunks, and repeated counts or
versions are later-turn evidence. Short repeats are also smaller than a useful
count marker. After protecting those cases, an independent non-adjacent repeat
fold nets only 35,897 bytes.

### Keep rule derived from later-turn use

This study's keep set was defined from what an agent needs to reason in a later
turn, not inherited from the prior CCA gate:

- every error, warning, failure, exception, panic, assertion, traceback/stack
  frame, and diagnostic context line;
- every diff header, hunk header, added line, and removed line;
- failing names and failure summaries;
- paths, path-plus-line/column locations, search matches, and listings;
- versions and package/tool identities;
- test/file/suite/check totals and passed/failed/skipped/error counts in either
  “label then number” or “number then label” order;
- source, JSON/configuration, edit output, and other first-seen payload;
- first and final progress/repetition instances plus an explicit omitted-count
  marker whenever a fold is evaluated.

The named evidence predicates overlap by design. For example, a diagnostic can
also contain a path, version, and count; they are safety checks, not additive
byte categories.

### Candidate mechanisms and measured opportunity

All candidates were run only on 5,851 joined, non-sensitive bodies (22,239,519
bytes). Fifty-two sensitive bodies and four unresolved mixed calls remain
identity. Each rule fails open per body when its candidate is not shorter.

| structural family | explicit transform / keep rule | changed bodies | independent net bytes | mixed share | evidence risk |
|---|---|---:|---:|---:|---|
| terminal controls | remove ANSI CSI/OSC controls and CR in CRLF; retain printable text | 20 | 365 | 0.0016% | low |
| layout boilerplate | keep at most two consecutive blank lines; shorten pure punctuation separators to three characters | 96 | 17,636 | 0.0788% | low |
| adjacent exact repetition | for runs of ≥3 non-evidence exact lines, keep first and last plus exact omitted count | 6 | 564 | 0.0025% | low |
| non-adjacent exact repetition | for ≥3 non-evidence exact occurrences, keep first and last plus one exact middle-count marker; keep all intervening unique lines | 86 | 35,897 | 0.1603% | low–medium |
| progress runs | for ≥4 recognized progress lines, keep first/final and omitted update count; diagnostics exempt | 0 | 0 | 0.0000% | low–medium |
| passing-test runs | only in test-tagged bodies, fold ≥4 recognized passing lines to first/final/count; failures and diagnostics exempt | 11 | 3,452 | 0.0154% | medium |

The independent values overlap. Applied in table order, the complete stack
changes 192 bodies and nets **46,319 bytes (0.2069%)** after count-marker
bytes. That is the conservative “looks filterable” fraction. It is an upper
estimate for a practical low-risk policy because the stack includes the
medium-risk loss of successful test names and the ordering loss inherent in
non-adjacent folding.

A separate high-risk ceiling applies only to bodies above 10 KiB and retains the
first/last 40 lines plus every named evidence line and two lines of context on
each side. It changes 34 bodies and nets **84,063 bytes (0.3754%)**. The omitted
lines are explicitly first-seen/unique payload, often source or configuration;
therefore this is evidence about what **must stay**, not a proposed filter. It
is not included in the 46,319-byte conservative stack.

## 3. Then how

There is no justified runtime “how” for mixed on this corpus: use **zero mixed
filter families and identity output**. The only concrete implementation shape
worth retaining for a future offline experiment is a structural fold that:

1. parses lines without executing the historical command;
2. skips sensitive and unresolved observations;
3. protects the broad later-turn evidence set above;
4. folds only exact repeated/layout structure, retaining endpoints and exact
   counts;
5. applies per-body only when UTF-8 output is strictly smaller; and
6. otherwise fails open to byte-identical input.

That design is reproducibly modeled here, but its measured 0.2069% opportunity
is too small for a runtime mixed-class selector, regex maintenance, synthesized
markers, tests, and evidence risk. Passing-test folding and unique-payload
slicing should not be added to make the number look larger. Progress and wrapper
families have no current opportunity. None of these structural families is the
CCA mechanism, and CCA was not rerun.

## Reproducibility and limits

Run:

```bash
python3 -m unittest discover -s experiments/mixed-composition-current -p 'test_*.py'
python3 experiments/mixed-composition-current/census.py
```

`results.json` contains the complete aggregate tag combinations, composition,
structure, candidate results, snapshot digest, and a SHA-256 over bodyless
observation metrics. It contains no command, body, excerpt, candidate text, or
per-observation record. Historical commands are never executed.

Regex evidence recognition is deliberately broad and is not a semantic proof.
Exact line novelty is not semantic novelty. The high-risk slice demonstrates
this limit rather than claiming its omitted unique lines are safe. The corpus is
a frozen local observational snapshot, not a forecast of tokens, spend,
latency, or behavior on a different corpus.
