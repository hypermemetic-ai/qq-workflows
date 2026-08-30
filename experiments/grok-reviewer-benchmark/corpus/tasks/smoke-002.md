# qq-index README orientation and bounded injection

## Objective
Implement the operator-approved two-contract design in `/home/qqp/projects/qq-index`:

1. **Editorial/product contract:** The root `README.md` is a deliberately compact orientation product, designed by content selection and stopping rules rather than an authored-character limit.
2. **Runtime safety/degradation contract:** Keep 10,000 Unicode code points as a total injected-output failsafe. A readable oversized README remains valid and is projected deterministically into a bounded, useful Markdown excerpt with an explicit truncation marker and route to the full `README.md`.

Do not use or land the isolated old README-shortening/split workaround commit `a9318d9...`.

## Authoritative direction
- Root README should prioritize, in order: identity/purpose; established start/run/test commands; selective system/component map; only critical contributor invariants; common-change → canonical source/tests routing; links to authoritative detail.
- Exclude exhaustive inventories/API manuals, repeated lifecycle prose, chronology, long examples, and generated detail.
- Writer guidance/tests must express section priorities, content-selection criteria, and stopping rules—not a raw `README <= 10,000 chars` validity rule.
- 10,000 Unicode code points is the **total injected-output ceiling**, including truncation marker and route.
- Oversize alone must never throw and must not erase all orientation.
- Projection should prefer complete Markdown sections/blocks/paragraphs/lines, avoid broken fenced code blocks, and use a Unicode-safe fallback for an enormous single block.
- Complete authored README validation remains independent of injection cutoff, including links that occur after the cutoff. Structural and I/O errors may still throw.
- Read boundedly/incrementally where feasible without weakening complete authored-content/link validation.

## Acceptance criteria
- Exact 10,000-code-point boundary injects without truncation.
- Overflow does not throw solely because of size.
- Truncated output includes an explicit marker and a route to full `README.md`, all within the 10,000-code-point total budget.
- Unicode/code-point handling is correct (no broken surrogate/code point behavior).
- Projection has sensible whole-section/block/paragraph/line preference; fenced code is not emitted broken.
- Enormous single-block fallback remains useful and Unicode safe.
- Output is deterministic.
- Links in the full authored README are validated even after the injection cutoff.
- Refresh/generation accepts a valid long README.
- Writer/editorial contract tests enforce product priorities and stopping rules, not a character-count ceiling.
- Root README itself is revised if necessary to conform to the compact orientation contract, with useful core first and canonical-detail links.
- Relevant tests/lint/typecheck pass; changes are committed, QA-reviewed, and landed through the implementation workflow.

## Known research
Artifact: `/home/qqp/.local/state/.qq-workflows-research/research-8dbef61c/answer.md`
SHA-256: `2b1a1d40c94e198490ee0246f091629f90b5721416342e7514065b035eca6fef`

## Next steps
1. Inspect current repository and research artifact; locate README ingestion/injection, validation, writer prompts/contracts, and tests.
2. Implement the separated editorial and failsafe contracts with focused tests.
3. Validate authored README independently from bounded injection.
4. Run targeted and broad test suites, review diff for scope and docs quality, commit, hand to QA, and land.

## Delegation packet
Implement all of the above in the current `qq-index` repository. Begin by reviewing the research artifact and the current implementation/tests; do not cherry-pick or reproduce the rejected `a9318d9...` README-splitting workaround. Preserve existing established commands and canonical documentation organization. Make the smallest coherent design that cleanly separates full-document validation from bounded injection projection. Add robust tests covering every acceptance criterion. Update README/editorial writer guidance as needed, run relevant checks, commit changes, and report exact commands/results plus any remaining risks.
