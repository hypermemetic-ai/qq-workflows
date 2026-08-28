# Current DSH corpus: mixed-class CCA re-measure

## Decision

**Drop mixed CCA.** Keep mixed bash observations as identity. If CCA remains an
experiment, tests-only is the surviving policy hypothesis; this report does not
turn it on or revalidate tests on the current corpus.

Across the complete current mixed census, gated CCA saves **449,362 bytes**, or
only **2.0247% of mixed bytes**. It accepts 239 of 5,796 evaluated bodies
(**4.12%**) covering 6.50% of evaluated mixed input bytes; 95.88% of bodies are
passthrough. The gate catches 50 dirty candidates and accepted registered
evidence loss is zero, but this means the gate remains necessary for a small,
sparse save. Mixed adds only **1.0835 percentage points** to current corpus-byte
reduction. That is not material enough to justify CCA plus class selection plus
an evidence gate under the operator's no-net-zero-complexity bar.

The old largest-20 sample still looks much better (13.2774% gated now versus
14.5514% before), but the all-body census shows that it is a size-biased fixture,
not a sound basis for a mixed-wide policy. Do not project that sample rate.

This is an offline byte measurement, not a token, price, latency, or spend
measurement. **Bytes are not tokens or cost.**

## Corpus census and comparison

The snapshot is frozen at the delegated study session's creation time,
`1787895040748` ms. The study session itself is excluded. Calls are joined to
the first result in the same session, matching the prior study.

| measure | prior cutoff | current | change |
|---|---:|---:|---:|
| sessions | 459 | 586 | +127 (+27.67%) |
| bash-issuing sessions | 337 | 419 | +82 (+24.33%) |
| bash calls | 13,637 | 16,776 | +3,139 (+23.02%) |
| bash first-result bytes | 29,341,881 | 41,472,665 | +12,130,784 (+41.34%) |
| mixed bodies/calls | 4,269 | 5,852 | +1,583 (+37.08%) |
| mixed bytes | 15,927,490 | 22,194,080 | +6,266,590 (+39.34%) |
| mixed byte share | 54.2824% | 53.5150% | -0.7675 pp |

Of 5,852 current mixed calls, 5,848 have a first result. The unchanged sensitive
predicate leaves 52 joined bodies (152,398 bytes) as identity, and four
unresolved zero-byte calls are identity. CCA evaluates all remaining **5,796**
joined, non-sensitive bodies (22,041,682 bytes). There were no archive decode,
zstd, or CCA failures.

## Recovered classifier: unchanged

The replay copies the prior 11-class classifier logic and precedence from
`historical-observation-corpus/study.py` (source SHA-256
`dd090d49786adfffa00701a36bbf48812e4f9a60ce80f1ff746f825784df8784`).
The taxonomy remains:

`source_dump`, `listing`, `search`, `git_diff`, `git_status`, `test`,
`npm/install/debug_log`, `lockfile/json`, `write/edit`, `mixed/compound`, and
`other`.

Relevant recovered behavior:

- `git_diff` is tagged by `git diff`, `git show`, `git log -p`,
  `git format-patch`, or an output line beginning `@@ `. `git status` and
  `git diff --name/--stat` also produce the old status tag.
- `test` is tagged by the frozen command regex covering pytest, unittest,
  `cargo test`, `go test`, npm/pnpm/yarn tests, `node --test`, vitest, jest,
  mocha, `test-qq`, `run-tests`, and verifier.
- Mixed is **not** “any shell operator.” It is selected when at least two
  observed class intents occur in a command the old `compound_shell` recognizes
  (`&&`, heredoc, or a single pipe), or by the old longer generic-compound
  fallback. A narrow one-intent pipeline keeps its semantic class.
- Non-mixed precedence remains `git_diff`, `git_status`, `test`,
  `npm/install/debug_log`, `write/edit`, `source_dump`, `search`, `listing`,
  then `lockfile/json`.

No RTK, new class, revised regex, or runtime class router is involved.

## Full mixed replay

All byte values below are UTF-8 **before** any stock 10k presentation envelope.
Sensitive and unresolved bodies are included in the mixed-wide denominator as
identity.

| path | mixed input | output | saved | mixed save |
|---|---:|---:|---:|---:|
| CCA ungated | 22,194,080 | 21,604,261 | 589,819 | 2.6576% |
| CCA plus gate | 22,194,080 | 21,744,718 | **449,362** | **2.0247%** |

On the 5,796 evaluated bodies alone, the corresponding rates are 2.6759%
ungated and 2.0387% gated. CCA reports `changed:true` on 3,386 bodies, but only
284 candidates are shorter and 2,097 are larger; the remainder of changed
candidates are byte-equal. The gate accepts 239 bodies and rejects 5,557.

### Gate decisions

The gate requires `changed:true`, a strictly smaller UTF-8 candidate, and exact
Counter retention (including duplicate multiplicity) for diff hunk lines,
failing-name lines, and diagnostic lines. Gate precedence is unchanged.

| decision/reason | bodies | candidate input bytes | candidate saved bytes before fail-open |
|---|---:|---:|---:|
| `accepted` | 239 | 1,432,122 | **449,362** |
| `changed_false` | 2,410 | 10,856,965 | 0 |
| `not_shorter` | 3,102 | 9,369,188 | -3,572 |
| `diff_hunk_loss` | 3 | 30,560 | 17,131 |
| `test_failing_name_loss` | 17 | 181,228 | 71,175 |
| `diagnostic_loss` | 25 | 171,619 | 55,723 |
| `cca_error` | 0 | 0 | 0 |

There are **50 unique dirty candidates**. Category incidences overlap: 3 lose a
diff-hunk occurrence, 19 lose a failing-name occurrence, and 47 lose a
diagnostic occurrence. Five dirty candidates receive the earlier
`not_shorter` reason; the other 45 receive an evidence-loss reason. Every reject
fails open to identity.

Accepted registered evidence-loss bodies: **0**. CCA reports `critical:true` on
1,959 evaluated bodies and on 85 accepts; this is analysis only and never enters
the decision.

## Apples-to-apples largest-20 comparison

The prior broad replay deliberately selected the 20 largest joined,
non-sensitive mixed bodies with at least 500 characters. This replay retains the
same comparison slice, while using the all-body census for the recommendation.

| measure | prior largest 20 | current largest 20 | change |
|---|---:|---:|---:|
| input bytes | 775,926 | 806,503 | +30,577 |
| ungated saved bytes | 123,616 | 117,791 | -5,825 |
| ungated save | 15.9314% | 14.6052% | -1.3263 pp |
| gated saved bytes | 112,908 | 107,083 | -5,825 |
| gated save | 14.5514% | 13.2774% | -1.2739 pp |
| accepted | 8/20 | 7/20 | -1 |
| dirty candidates | 1 | 1 | unchanged |
| accepted evidence-loss | 0 | 0 | unchanged |

The current dirty sample candidate is again 40,617 input bytes with a
10,712-byte ungated candidate save and is rejected for
`test_failing_name_loss`. The sample accepts 35% of bodies, versus only 4.12%
in the census. That gap is why the old ~14.55% sample result does not survive as
a mixed-class policy result.

## Corpus-wide policy projection

Only mixed was re-measured. To answer “what remains if tests stay in and diffs
stay identity,” the projection carries forward the prior **ungated test** sample
rates (tests did not need the mixed gate): 56.3120% for the old explicit
vitest/pytest/tsc/cargo-test label stratum and 38.3452% for the unmatched test
stratum. These labels are weighting metadata only; no RTK is run.

| component | current corpus bytes | method | saved bytes |
|---|---:|---|---:|
| tests: matched stratum | 135,259 | prior rate carried forward | 76,167.0 |
| tests: unmatched stratum | 2,302,542 | prior rate carried forward | 882,914.9 |
| mixed | 22,194,080 | current all-body CCA + gate | **449,362** |
| `git_diff` | 2,659,378 | identity | 0 |
| every other class | 14,181,406 | identity | 0 |
| **total corpus** | **41,472,665** | tests + gated mixed | **1,408,443.9 (3.3961%)** |

The “every other class” display value is intentionally not used as an input to
arithmetic; total minus tests, mixed, and diffs is 14,181,406 bytes. The exact
machine-readable projection is in `results.json`.

- Tests-only carried-forward projection: **2.3126%** of current corpus bytes.
- Mixed's measured increment: **1.0835 percentage points**.
- Tests plus gated mixed: **3.3961%**, down from the old selected projection of
  **10.8155%**.
- Tests plus *ungated* mixed would be 3.7348%, but it is inadmissible because 50
  mixed candidates are dirty.

The test portion is a carry-forward projection, not a current test re-measure or
an accuracy claim.

## Method and reproducibility

- Input: `/home/qqp/.local/state/qq/sessions/**/session.jsonl.zstd`.
- Snapshot: 586 included session UUIDs; set SHA-256
  `ebf7688975795497c0ec682baed451bba00e7f4e177ddebf67dcc1eb918f7072`.
- CCA: `@linger-alpha/cca@0.2.0`, commit
  `fd9c022d364643fd80413201fb51a537c9020a86` with package, compressor, rules,
  and bridge checksums pinned by `replay.py`.
- The persistent JSON-lines transport calls the same synchronous
  `compressObservation` operation as the recovered one-shot bridge. On 10 early
  plus the 20 largest bodies, all 30 marker-stripped candidates were
  byte-identical and gate-relevant metadata matched. Only CCA's unused
  `compressedChars` marker-path length differed.
- CCA receives the historical replay assumption `exitCode: 0`; historical exit
  status is not available as structured data here.
- CCA's default `head_tail` behavior is not disabled. The CCA marker is removed
  before gating. The stock DSH 10k envelope is not part of byte comparison.
- Commands are parsed as metadata and never executed. Bodies go only to local
  pinned CCA over stdin. No command, body, candidate, excerpt, paid model, live
  pair, or other compressor is persisted or invoked.
- `results.json` stores aggregates plus a SHA-256 over 5,796 bodyless records,
  not the records themselves.

Run:

```bash
python3 -m unittest discover -s experiments/cca-mixed-current -p 'test_*.py'
python3 experiments/cca-mixed-current/replay.py --scan-only
python3 experiments/cca-mixed-current/replay.py
```

## Limits and product posture

The gate guarantees exact occurrence retention only for the three registered
line categories; it is not a semantic-equivalence proof. Sensitive bodies are
identity and not evaluated. Test savings are inherited from the prior study,
not newly measured.

No product code changed. Do not add mixed CCA, RTK, a runtime class router, or a
default-on path. Do not run another live mini pair for this decision. Keep the
product posture inspect-only unless the operator asks for a separate tests-only
measurement or implementation.
