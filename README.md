# `@hypermemetic-ai/qq-workflows`

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. The package metadata explicitly keeps the plugin optional: core boots when it is absent.

The package root resolves to [`src/plugin.mjs`](src/plugin.mjs). [`package.json`](package.json) is the authority for all supported subpath exports and repository commands.

## Run and test

The only declared script is the full test suite:

```sh
npm test
```

No install, start, or standalone run script is declared. The test command clears `GIT_DIR` and `GIT_WORK_TREE`, then runs the tracked Node test files in sequence.

## Repository map

- [`src/plugin.mjs`](src/plugin.mjs) is the package entry point; [`src/tools.mjs`](src/tools.mjs) is the exported tools surface.
- The export map separates workflow coordination and landing into modules such as [`src/architect.mjs`](src/architect.mjs), [`src/land.mjs`](src/land.mjs), and [`src/git.mjs`](src/git.mjs). These are also among the more frequently changed implementation files, so prefer their focused tests when editing them.
- Mini, QA, documentation, and research have separate exported surfaces: [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs), and [`src/research.mjs`](src/research.mjs).
- State, evidence, and repository-facing support are split into modules including [`src/delegation-store.mjs`](src/delegation-store.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), and [`src/repository-index.mjs`](src/repository-index.mjs).
- Tests live as standalone `.mjs` files and are enumerated explicitly by the `test` script. Experimental work is separate; begin benchmark-related exploration at [`experiments/grok-reviewer-benchmark/README.md`](experiments/grok-reviewer-benchmark/README.md).

## Change routing

| Change area | Start with | Focused checks |
| --- | --- | --- |
| Package entry points or exposed modules | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | Run the full `npm test` suite; no direct plugin test is declared |
| Architecture and repository context | [`src/architect.mjs`](src/architect.mjs), [`src/repository-index.mjs`](src/repository-index.mjs) | [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs), [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs) |
| GitHub PR landing and publication | [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs) | [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs) |
| Mini QA or documentation | [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-qa.mjs`](tests/mini-qa.mjs), [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |
| Research workflow or evidence | [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs) |
| Grok reviewer benchmark host | [`src/grok-benchmark-host.mjs`](src/grok-benchmark-host.mjs), [`experiments/grok-reviewer-benchmark/README.md`](experiments/grok-reviewer-benchmark/README.md) | [`tests/grok-benchmark-host.mjs`](tests/grok-benchmark-host.mjs), [`experiments/grok-reviewer-benchmark/tests/test_host_runtime.py`](experiments/grok-reviewer-benchmark/tests/test_host_runtime.py) |

## Contributor invariants

- Keep modules ESM: the package declares `"type": "module"` and its implementation and tests use `.mjs`.
- Preserve optionality of the plugin relative to core unless the package purpose intentionally changes.
- Only `src/` is included by the package file allowlist; tests and experiments are repository support, not packaged files.
- Add or rename an exported surface in the explicit [`package.json`](package.json) `exports` map, and add any new test to the explicit `test` script if it must run in the established suite.
