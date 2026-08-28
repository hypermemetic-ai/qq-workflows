# All-bash filter opportunity: narrow the keep list, cap pure classes, then decide

## Decision

**Build zero filter families; keep unique payload identity.** Narrowing the keep
list does expose a large arithmetic ceiling, but the ceiling is not evidence
that the bytes are disposable.

The frozen all-bash snapshot contains **16,944 first-result bodies and
42,002,470 pre-envelope UTF-8 bytes**. At the line-level `K_fail` ladder,
**20,666,871 eligible bytes (49.2039% of all bash bytes)** are unique lines not
matched by the keep predicates. Of that ceiling, **18,616,126 bytes occur at
original positions inside each body's first 10,000 bytes** and 2,050,745 are in
the clipped tail. This is the opportunity-first answer: narrowing the prior
greedy list moves the number from a 5,983,650-byte (14.2459%) ceiling to a
20,666,871-byte (49.2039%) ceiling.

It does not clear the evidence test. A local audit of two large eligible bodies
from every frozen class found clearly load-bearing `K_fail` omissions in
**22/22 bodies**. Source/configuration content, search matches, listing/status
records, passing test names and context, edit output, and generic operational
output do not become noise merely because they lack a failure word. `K_nav` and
`K_greedy` also mixed useful evidence with incidental path, transport,
version/count, and plus/minus matches; they are not clean safety boundaries.

The explicit class caps are much smaller than the keep-narrowed ceiling:

- the six pure-class caps independently sum to **930,486 bytes (2.2153%)**
  across 384 bodies;
- the low/medium-risk structural stack saves **147,987 bytes (0.3523%)**
  across 505 bodies;
- stacked together, with per-stage fail-open behavior, they save **1,051,588
  bytes (2.5036%)** across 781 bodies;
- the stack reduces aggregate first-10k candidate length by **857,574 bytes**,
  from 38,430,578 to **37,573,004 bytes remaining**.

The cap portion requires class routing, six policies, marker synthesis, and
ongoing evidence predicates while deliberately discarding unique payload. The
structural portion is too small to justify even that narrower maintenance and
ordering risk. No product default, runtime router, or filter is warranted.
Nothing was turned on.

These are bytes, not tokens, spend, price, or cost.

## Method and frozen corpus

The snapshot cutoff is the delegated study session's creation time,
`1787919339065` ms (`2026-08-28T12:15:39.065000+00:00`). The study session
`session-e2a0fe75-9bf3-42fe-8cff-51886cbab871` is excluded. Events after the
cutoff are ignored. The census joins each bash call to its first result in the
same session.

`census.py` imports the unchanged 11-class `classify_bash` and
`compound_shell` implementation from
`experiments/cca-mixed-current/replay.py`. It copies the predicates only for
constituent-tag reporting and asserts reconstructed final-class equivalence for
every call; mismatches are zero. Historical command strings are classifier
metadata only and are never executed.

| coverage | value |
|---|---:|
| archives at/before cutoff | 598 |
| included sessions | 597 |
| bash-issuing sessions | 425 |
| bash first-result bodies/calls | 16,944 |
| joined bodies | 16,937 |
| all bash bytes | 42,002,470 |
| aggregate `min(body, 10,000)` input bytes | 38,430,578 |
| sensitive identity exclusions | 76 bodies / 243,891 bytes |
| unresolved identity exclusions | 7 bodies / 0 bytes |
| archive/JSON decode failures | 0 / 0 |
| classifier reconstruction mismatches | 0 |

Sensitive and unresolved bodies remain in all census and keep-ladder
denominators. They are byte-identical for every filter evaluation. All byte
counts use UTF-8 with replacement for invalid scalar values and are measured
before the 10,000-byte presentation envelope.

## 1. All-bash census

### Frozen class share

| frozen class | bodies | bytes | byte share |
|---|---:|---:|---:|
| `source_dump` | 605 | 5,298,837 | 12.6155% |
| `listing` | 951 | 2,221,855 | 5.2898% |
| `search` | 731 | 3,228,612 | 7.6867% |
| `git_diff` | 650 | 2,672,461 | 6.3626% |
| `git_status` | 1,304 | 417,103 | 0.9930% |
| `test` | 1,460 | 2,447,838 | 5.8278% |
| `npm/install/debug_log` | 80 | 204,662 | 0.4873% |
| `lockfile/json` | 379 | 1,020,979 | 2.4308% |
| `write/edit` | 188 | 562,014 | 1.3380% |
| `mixed/compound` | 5,942 | 22,494,375 | 53.5549% |
| `other` | 4,654 | 1,433,734 | 3.4135% |
| **total** | **16,944** | **42,002,470** | **100.0000%** |

Mixed remains the majority class, but the rest of this study is all bash. The
other ten classes contribute 19,508,095 bytes, including 5.30 MB of pure source
output and 3.23 MB of pure search output.

### Size strata by class

Cells are `bodies / bytes`. Boundaries apply to pre-envelope UTF-8 body size.

| class | zero | 1–255 B | 256 B–1 KiB | >1–4 KiB | >4–10 KiB | >10–100 KiB | >100 KiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| `source_dump` | 0 / 0 | 14 / 2,117 | 8 / 4,251 | 39 / 110,542 | 226 / 1,791,622 | 318 / 3,390,305 | 0 / 0 |
| `listing` | 0 / 0 | 232 / 28,267 | 264 / 148,927 | 287 / 589,540 | 118 / 804,369 | 50 / 650,752 | 0 / 0 |
| `search` | 0 / 0 | 161 / 15,372 | 128 / 76,413 | 150 / 330,740 | 170 / 1,270,786 | 122 / 1,535,301 | 0 / 0 |
| `git_diff` | 0 / 0 | 178 / 19,123 | 113 / 70,354 | 125 / 281,001 | 148 / 1,087,990 | 86 / 1,213,993 | 0 / 0 |
| `git_status` | 0 / 0 | 1,052 / 118,229 | 169 / 93,875 | 69 / 121,809 | 13 / 70,560 | 1 / 12,630 | 0 / 0 |
| `test` | 1 / 0 | 815 / 69,443 | 315 / 186,211 | 167 / 286,312 | 65 / 451,517 | 97 / 1,454,355 | 0 / 0 |
| `npm/install/debug_log` | 0 / 0 | 21 / 2,262 | 17 / 8,148 | 22 / 49,033 | 16 / 101,352 | 4 / 43,867 | 0 / 0 |
| `lockfile/json` | 0 / 0 | 52 / 6,922 | 98 / 58,878 | 151 / 298,980 | 51 / 319,003 | 27 / 337,196 | 0 / 0 |
| `write/edit` | 0 / 0 | 67 / 6,505 | 55 / 33,804 | 31 / 60,925 | 18 / 122,073 | 17 / 338,707 | 0 / 0 |
| `mixed/compound` | 4 / 0 | 1,351 / 158,808 | 1,199 / 704,678 | 1,358 / 2,984,651 | 1,084 / 7,669,054 | 946 / 10,977,184 | 0 / 0 |
| `other` | 2 / 0 | 4,320 / 334,923 | 184 / 93,180 | 79 / 163,156 | 41 / 299,172 | 28 / 543,303 | 0 / 0 |

### Mixed command shape

Operator rows are inclusive: one command can contain a pipe, `&&`, and a
heredoc. “Generic fallback” is the existing frozen classifier path for a mixed
command without two constituent semantic tags; it overlaps the operator rows.

| inclusive shape/path | bodies | bytes | mixed-byte share |
|---|---:|---:|---:|
| pipe | 3,785 | 18,798,776 | 83.5710% |
| `&&` | 2,774 | 9,007,947 | 40.0453% |
| heredoc (`<<`) | 1,777 | 5,024,466 | 22.3365% |
| generic fallback | 1,073 | 3,177,497 | 14.1257% |
| multi-tag compound | 4,869 | 19,316,878 | 85.8743% |

The exclusive operator signatures show their overlap:

| signature | bodies | bytes | mixed-byte share |
|---|---:|---:|---:|
| pipe | 1,944 | 9,764,453 | 43.4084% |
| `&&` + pipe | 1,057 | 6,106,694 | 27.1476% |
| pipe + heredoc | 539 | 1,977,296 | 8.7902% |
| heredoc | 685 | 1,744,679 | 7.7561% |
| `&&` | 1,164 | 1,598,762 | 7.1074% |
| `&&` + pipe + heredoc | 245 | 950,333 | 4.2248% |
| `&&` + heredoc | 308 | 352,158 | 1.5655% |

First-result mixed text is not segmentable by subcommand. No “cat versus test”
or equivalent output split was attempted, and the optional pipe-last-stage cap
was not evaluated.

## 2. Keep-list sensitivity

### Fixed additive ladders

The line ladders are implemented exactly as follows and are not adjusted based
on the result:

1. **`K_struct`**: physical lines containing layout/decorator content, ANSI or
   CRLF control bytes, recognized progress, or an exact repeat after the first
   occurrence in the same body.
2. **`K_fail`**: `K_struct` plus diagnostics containing error, warning, failure,
   traceback, exception, panic, assertion, or fatal terms; failing names; stack
   frames; and only `diff --git`, `index ..`, `--- `, `+++ `, and `@@ ` headers.
   A plain path, loose `1.0`, `3 files`, or arbitrary `+`/`-` line is not added.
3. **`K_hunk`**: `K_fail` plus full `+`/`-` lines after an observed diff header
   or hunk header, or anywhere in a frozen `git_diff` body. A pre-diff markdown
   list or `ls -l` line is not a hunk.
4. **`K_nav`**: `K_hunk` plus slash paths and `file.ext:line[:column]`
   locations.
5. **`K_greedy`**: the additive prior mixed baseline: path, loose version,
   summary count, diagnostic, or any `+`/`-` line. It is included only to show
   the too-conservative endpoint.

“Keep floor” below means raw bytes in physical lines matched by the union at
that rung. For `K_struct`, it is the raw structural footprint, not the output of
a structural transform. “Candidate-drop ceiling” means unmatched first-seen
lines; exact-repeat/layout/progress opportunity is measured separately under
mechanisms. No unique-line ceiling was applied as a filter.

The positional split is exact in encoded bytes, including a line crossing byte
10,000. “First 10k” is the part at original offsets `[0, 10000)`; “tail” is the
rest. The eligible ceiling excludes sensitive and unresolved bodies. The
identity-excluded column shows unmatched bytes that remain in the descriptive
all-corpus denominator but cannot be filtered.

| ladder | floor lines | floor bytes | floor share | incremental bytes | eligible ceiling lines | eligible ceiling bytes | corpus share | original first 10k | clipped tail | identity-excluded ceiling |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `K_struct` | 43,508 | 885,407 | 2.1080% | 885,407 | 261,793 | 40,884,466 | 97.3382% | 37,571,895 | 3,312,571 | 232,597 |
| `K_fail` | 72,309 | 21,175,065 | 50.4139% | 20,289,658 | 233,086 | 20,666,871 | 49.2039% | 18,616,126 | 2,050,745 | 160,534 |
| `K_hunk` | 89,367 | 22,087,052 | 52.5851% | 911,987 | 216,031 | 19,755,169 | 47.0334% | 17,860,677 | 1,894,492 | 160,249 |
| `K_nav` | 144,156 | 34,868,061 | 83.0143% | 12,781,009 | 161,559 | 7,057,456 | 16.8025% | 6,230,416 | 827,040 | 76,953 |
| `K_greedy` | 163,964 | 35,947,864 | 85.5851% | 1,079,803 | 141,883 | 5,983,650 | 14.2459% | 5,309,267 | 674,383 | 70,956 |

The raw line partition is disjoint and sums to all **307,543 physical lines and
42,002,470 bytes**:

| earliest rung / leftover | lines | bytes | all-bash share |
|---|---:|---:|---:|
| structural | 43,508 | 885,407 | 2.1080% |
| failure-evidence increment | 28,801 | 20,289,658 | 48.3059% |
| hunk increment | 17,058 | 911,987 | 2.1713% |
| navigation increment | 54,789 | 12,781,009 | 30.4292% |
| greedy-only increment | 19,808 | 1,079,803 | 2.5708% |
| leftover after greedy | 143,579 | 6,054,606 | 14.4149% |

The 20.29 MB `K_fail` increment is not 28,801 ordinary short diagnostic lines.
Matching is line-level, so one diagnostic word inside a long serialized
source/JSON/output line keeps the entire physical line. That behavior is
intentional: the study does not pretend that mixed first-result lines can be
sub-segmented safely.

### Keep floor by class

Cells are `matched lines / raw matched bytes`.

| class | input bytes | `K_struct` | `K_fail` | `K_hunk` | `K_nav` | `K_greedy` |
|---|---:|---:|---:|---:|---:|---:|
| `source_dump` | 5,298,837 | 771 / 10,752 | 2,130 / 3,898,599 | 2,153 / 3,900,601 | 2,634 / 4,753,998 | 3,025 / 4,783,840 |
| `listing` | 2,221,855 | 2,758 / 68,577 | 3,391 / 418,812 | 3,527 / 429,491 | 9,796 / 1,638,757 | 14,270 / 1,825,013 |
| `search` | 3,228,612 | 989 / 19,281 | 2,321 / 1,734,382 | 2,324 / 1,734,427 | 4,809 / 2,854,320 | 5,219 / 2,903,207 |
| `git_diff` | 2,672,461 | 6,022 / 87,720 | 11,996 / 969,567 | 23,884 / 1,571,967 | 28,080 / 2,111,867 | 28,486 / 2,134,703 |
| `git_status` | 417,103 | 279 / 7,676 | 1,332 / 130,203 | 1,332 / 130,203 | 4,555 / 348,745 | 4,719 / 355,042 |
| `test` | 2,447,838 | 9,173 / 199,840 | 12,433 / 1,089,681 | 12,460 / 1,090,776 | 14,953 / 1,480,430 | 19,407 / 1,651,168 |
| `npm/install/debug_log` | 204,662 | 530 / 19,084 | 696 / 77,206 | 697 / 77,531 | 905 / 156,615 | 970 / 161,169 |
| `lockfile/json` | 1,020,979 | 2,614 / 51,329 | 2,949 / 331,025 | 2,963 / 332,025 | 4,035 / 712,291 | 4,549 / 759,456 |
| `write/edit` | 562,014 | 1,213 / 31,545 | 1,690 / 158,336 | 1,690 / 158,336 | 3,151 / 389,673 | 3,386 / 410,832 |
| `mixed/compound` | 22,494,375 | 16,518 / 343,634 | 29,359 / 12,015,309 | 34,322 / 12,309,621 | 62,828 / 19,464,776 | 70,081 / 19,943,513 |
| `other` | 1,433,734 | 2,641 / 45,969 | 4,012 / 351,945 | 4,015 / 352,074 | 8,410 / 956,589 | 9,852 / 1,019,921 |

### Eligible candidate-drop ceiling by class

Cells are `unmatched unique lines / bytes (original first-10k bytes; tail
bytes)`. These are ceilings, not proposed deletions.

| class | `K_struct` | `K_fail` | `K_hunk` | `K_nav` | `K_greedy` |
|---|---:|---:|---:|---:|---:|
| `source_dump` | 14,755 / 5,278,023 (5,064,430; 213,593) | 13,401 / 1,390,489 (1,355,072; 35,417) | 13,378 / 1,388,487 (1,353,148; 35,339) | 12,905 / 535,708 (524,999; 10,709) | 12,518 / 506,183 (495,560; 10,623) |
| `listing` | 21,622 / 2,137,811 (2,007,031; 130,780) | 20,992 / 1,787,753 (1,718,960; 68,793) | 20,856 / 1,777,074 (1,710,253; 66,821) | 14,639 / 576,256 (556,956; 19,300) | 10,191 / 390,944 (375,794; 15,150) |
| `search` | 9,946 / 3,193,970 (2,874,061; 319,909) | 8,619 / 1,481,374 (1,379,079; 102,295) | 8,616 / 1,481,329 (1,379,034; 102,295) | 6,144 / 371,687 (343,435; 28,252) | 5,735 / 322,803 (297,316; 25,487) |
| `git_diff` | 35,387 / 2,584,741 (2,253,860; 330,881) | 29,413 / 1,702,894 (1,486,838; 216,056) | 17,525 / 1,100,494 (1,005,477; 95,017) | 13,329 / 560,594 (492,648; 67,946) | 12,923 / 537,758 (470,950; 66,808) |
| `git_status` | 6,154 / 409,427 (407,789; 1,638) | 5,101 / 286,900 (285,323; 1,577) | 5,101 / 286,900 (285,323; 1,577) | 1,878 / 68,358 (67,059; 1,299) | 1,714 / 62,061 (60,762; 1,299) |
| `test` | 25,771 / 2,247,998 (1,840,568; 407,430) | 22,511 / 1,358,157 (998,631; 359,526) | 22,484 / 1,357,062 (997,826; 359,236) | 19,991 / 967,408 (687,191; 280,217) | 15,537 / 796,670 (575,370; 221,300) |
| `npm/install/debug_log` | 1,026 / 185,578 (181,730; 3,848) | 860 / 127,456 (124,264; 3,192) | 859 / 127,131 (123,939; 3,192) | 651 / 48,047 (46,068; 1,979) | 586 / 43,493 (42,332; 1,161) |
| `lockfile/json` | 7,147 / 930,392 (897,908; 32,484) | 6,834 / 651,894 (627,507; 24,387) | 6,820 / 650,894 (626,507; 24,387) | 5,795 / 275,053 (262,164; 12,889) | 5,334 / 230,881 (221,390; 9,491) |
| `write/edit` | 4,083 / 528,942 (380,870; 148,072) | 3,609 / 402,204 (267,776; 134,428) | 3,609 / 402,204 (267,776; 134,428) | 2,149 / 170,942 (108,276; 62,666) | 1,914 / 149,783 (90,971; 58,812) |
| `mixed/compound` | 111,428 / 21,999,819 (20,528,451; 1,471,368) | 98,643 / 10,395,961 (9,530,720; 865,241) | 93,683 / 10,101,934 (9,269,567; 832,367) | 65,373 / 3,006,258 (2,763,616; 242,642) | 58,168 / 2,529,261 (2,332,958; 196,303) |
| `other` | 24,474 / 1,387,765 (1,135,197; 252,568) | 23,103 / 1,081,789 (841,956; 239,833) | 23,100 / 1,081,660 (841,827; 239,833) | 18,705 / 477,145 (378,004; 99,141) | 17,263 / 413,813 (345,864; 67,949) |

## 3. Class-aware caps

### Candidate rules

Every cap is evaluated only on joined, non-sensitive bodies, retains `K_fail`
lines, inserts an omitted-line count marker, and fails open unless strictly
shorter. Frozen `git_diff` handling also protects `K_hunk` lines. The rules are:

- pure `source_dump`: first 40 plus last 40 lines;
- pure `listing`: first 50 lines;
- pure `search`: first 50 nonblank physical match lines;
- pure `test`: if at least four recognized passing-test lines exist, keep the
  first and last plus an exact omitted count; retain failures, diagnostics, and
  summaries;
- pure `lockfile/json`: first 40 plus last 40 lines;
- pure `npm/install/debug_log`: `K_fail` plus last 40 lines;
- pure `git_diff`, `git_status`, `write/edit`, and `other`: identity except for
  structural handling;
- `mixed/compound`: identity for unique lines; structural handling protects
  observed hunks and failure evidence. No whole mixed body is capped because a
  constituent tag says `source_dump`.

The structural stack strips terminal controls/CRLF, normalizes excess blank and
separator layout, folds adjacent and nonadjacent exact repetitions while
retaining endpoints and counts, and folds recognized progress runs. Failure
lines are protected everywhere; hunk lines are protected in diff and mixed
bodies. Each stage also fails open independently.

### Independent opportunity

“First-10k reduction” here differs from the ladder's positional split: it is
`min(input bytes, 10000) - min(candidate bytes, 10000)` summed over bodies.
Thus it measures presentation-length relevance. “Remaining” is the candidate's
aggregate first-10k length in that family's scope, including identity
exclusions.

| family | scope | scope bytes | changed bodies | saved bytes | all-bash share | first-10k reduction | scope first-10k remaining | evidence risk |
|---|---|---:|---:|---:|---:|---:|---:|---|
| terminal controls | all | 42,002,470 | 52 | 1,041 | 0.0025% | 816 | 38,429,762 | low |
| layout | all | 42,002,470 | 263 | 23,463 | 0.0559% | 12,971 | 38,417,607 | low |
| adjacent exact repeat | all | 42,002,470 | 28 | 5,358 | 0.0128% | 4,078 | 38,426,500 | low |
| nonadjacent exact repeat | all | 42,002,470 | 216 | 137,887 | 0.3283% | 75,915 | 38,354,663 | low–medium |
| progress | all | 42,002,470 | 0 | 0 | 0.0000% | 0 | 38,430,578 | low–medium |
| **structural stack** | **all** | **42,002,470** | **505** | **147,987** | **0.3523%** | **83,354** | **38,347,224** | **low–medium** |
| source first/last 40 | `source_dump` | 5,298,837 | 65 | 271,750 | 0.6470% | 269,695 | 4,815,419 | high |
| listing first 50 | `listing` | 2,221,855 | 132 | 302,231 | 0.7196% | 231,195 | 1,836,548 | medium–high |
| search first 50 matches | `search` | 3,228,612 | 41 | 147,595 | 0.3514% | 124,069 | 2,783,426 | high |
| passing-test fold | `test` | 2,447,838 | 111 | 97,159 | 0.2313% | 73,337 | 1,889,271 | medium |
| lockfile/JSON first/last 40 | `lockfile/json` | 1,020,979 | 23 | 82,287 | 0.1959% | 59,916 | 893,611 | high |
| install/debug `K_fail` + last 40 | `npm/install/debug_log` | 204,662 | 12 | 29,464 | 0.0701% | 26,305 | 174,490 | high |

The independent structural rows overlap; their 147,987-byte stack is the
correct combined value. The six cap scopes are disjoint frozen classes, so their
independent values can be summed: 930,486 bytes, 384 changed bodies, and 784,517
bytes of first-10k length reduction. This cap-only stack leaves 37,646,061 of
38,430,578 first-10k bytes.

### Full structural + class-cap stack by frozen class

The final stack applies structural stages first, then the one applicable pure
class cap. The cap sees the structurally transformed text, so stacked class
saves need not equal the arithmetic sum of independent rows.

| class | input bytes | changed bodies | saved bytes | class save | first-10k reduction | class first-10k remaining |
|---|---:|---:|---:|---:|---:|---:|
| `source_dump` | 5,298,837 | 65 | 271,788 | 5.1292% | 269,733 | 4,815,381 |
| `listing` | 2,221,855 | 175 | 301,603 | 13.5744% | 230,363 | 1,837,380 |
| `search` | 3,228,612 | 56 | 146,896 | 4.5498% | 123,370 | 2,784,125 |
| `git_diff` | 2,672,461 | 25 | 811 | 0.0303% | 811 | 2,315,614 |
| `git_status` | 417,103 | 7 | 399 | 0.0957% | 399 | 414,074 |
| `test` | 2,447,838 | 146 | 129,937 | 5.3082% | 92,348 | 1,870,260 |
| `npm/install/debug_log` | 204,662 | 15 | 34,042 | 16.6333% | 30,883 | 169,912 |
| `lockfile/json` | 1,020,979 | 38 | 79,227 | 7.7599% | 56,856 | 896,671 |
| `write/edit` | 562,014 | 12 | 4,209 | 0.7489% | 1,453 | 391,283 |
| `mixed/compound` | 22,494,375 | 206 | 81,082 | 0.3605% | 50,326 | 20,910,067 |
| `other` | 1,433,734 | 36 | 1,594 | 0.1112% | 1,032 | 1,168,237 |
| **total** | **42,002,470** | **781** | **1,051,588** | **2.5036%** | **857,574** | **37,573,004** |

The 81,082 mixed bytes are structural only. Mixed unique payload remains
identity, as required.

## 4. Local sample audit

The audit selected the two largest joined, non-sensitive bodies in each frozen
class: **22 bodies, 722,721 bytes, and 6,550 physical lines**. Review was local
and temporary. The temporary script and output were deleted; no excerpt,
historical command, body, candidate, or observation identifier is in git.

Aggregate disagreement:

- `K_fail` left **4,085 sampled lines** outside its floor. Every sampled body
  (**22/22**) had at least one clearly load-bearing omitted line.
- `K_nav` added **2,044 lines across 19/22 bodies** beyond `K_fail`/`K_hunk`.
  The additions mixed useful source locations and output records with incidental
  transport, spill, embedded URL, and process-path matches.
- `K_greedy` added another **139 lines across 12/22 bodies** beyond `K_nav`.
  Review found both real evidence and incidental loose versions, durations,
  counts, serialized plus/minus lines, and list-like content.

These are sample disagreement counts, not accuracy estimates. They explain why
49.20% at `K_fail` is an arithmetic ceiling rather than a safe keep-narrowed
slice, and why 85.59% at greedy was too conservative without making its 14.25%
leftover safe to delete.

## 5. Investment decision

| considered family | measured byte opportunity | all-corpus first-10k remainder | evidence/complexity risk | recommendation |
|---|---:|---:|---|---|
| structural stack | 147,987 actual saved (0.3523%) | 38,347,224 | low–medium; five stages, exact-count markers, nonadjacent ordering loss | do not build |
| `K_fail`-narrowed unique slice | 20,666,871 ceiling (49.2039%) | 19,814,452 theoretical after deleting all eligible first-10k ceiling bytes | unacceptable; load-bearing omissions in 22/22 audited bodies | do not build |
| six pure-class caps | 930,486 actual independent save (2.2153%) | 37,646,061 | medium to high; unique payload loss plus a six-way class router | do not build |
| passing-test fold alone | 97,159 actual saved (0.2313%) | 38,357,241 all-corpus remainder | medium; loses successful names/order for a small corpus result | do not build |
| full structural + cap stack | 1,051,588 actual saved (2.5036%) | 37,573,004 | combines all maintenance and evidence risks | do not build |

The `K_fail` row's first-10k remainder is deliberately labeled theoretical: it
subtracts the exact 18,616,126-byte positional ceiling from the 38,430,578-byte
input. No such candidate was created or accepted.

**Investment count: 0.** The only low-risk-looking opportunity is too small for
its transforms and markers. The larger opportunities are produced by slicing
unique lines that the frozen classes identify as source, matches, listings,
test evidence, structured data, edits, or mixed output. Combining those caps
makes the percentage larger but does not reduce their evidence risk or router
complexity. Unique payload should remain identity.

## Reproducibility and limits

Run:

```bash
python3 -m unittest discover -s experiments/bash-filter-opportunity-current -p 'test_*.py'
python3 experiments/bash-filter-opportunity-current/census.py
```

`results.json` contains complete aggregate counts, by-class ladder and cap
breakdowns, snapshot metadata, and a SHA-256 over 16,944 bodyless observation
metrics. It contains no full historical command, result body, candidate,
excerpt, or per-observation row. Historical commands are not re-executed. No
runtime class router, product path, paid model, or live pair is used.

Line regexes are not a semantic-equivalence proof. Exact novelty is not semantic
novelty, and line-level matching can retain a long serialized line because of
one short match. The 10,000-byte metrics measure either exact original byte
position (ladders) or aggregate candidate presentation length (caps), as labeled;
they do not claim downstream behavior. This is a frozen local observational
snapshot, not a forecast for another corpus.
