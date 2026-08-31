# @hypermemetic-ai/qq-workflows

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. Its plugin entry point is [`src/plugin.mjs`](src/plugin.mjs); the package description explicitly notes that core can boot without this plugin.

## Run the established task

[`package.json`](package.json) declares one script:

```sh
npm test
```

This runs the repository's Node-based `.mjs` test files sequentially. No `start` script, Node version, or package-manager version is specified in the package metadata.

## Find the right boundary

The package export map in [`package.json`](package.json) is the authoritative list of public entry points. For a first change, start with these higher-signal areas rather than scanning every module:

- **Plugin and workflow integration:** [`src/plugin.mjs`](src/plugin.mjs), [`src/architect.mjs`](src/architect.mjs), and [`src/tools.mjs`](src/tools.mjs). Related checks include [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs), [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), and [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs).
- **Git and PR landing:** [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs), and [`src/git.mjs`](src/git.mjs), with [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs), and [`tests/git-geometry.mjs`](tests/git-geometry.mjs).
- **Mini and QA flows:** [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), and [`src/qa-verdict.mjs`](src/qa-verdict.mjs). Start verification at [`tests/mini-swe-v2.mjs`](tests/mini-swe-v2.mjs) and [`tests/mini-qa.mjs`](tests/mini-qa.mjs).
- **Research flows:** [`src/research.mjs`](src/research.mjs) coordinates a boundary whose exported pieces include [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-web.mjs`](src/research-web.mjs), [`src/research-sessions.mjs`](src/research-sessions.mjs), and [`src/research-oracle.mjs`](src/research-oracle.mjs). Their same-named tests are the most direct starting points under [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/research-web.mjs`](tests/research-web.mjs), [`tests/research-sessions.mjs`](tests/research-sessions.mjs), and [`tests/research-oracle.mjs`](tests/research-oracle.mjs).

Source shipped by the package is under `src/`; repository tests remain under `tests/`. Match a source module to its same-named test when one exists, then run the full `npm test` chain because shared modules such as [`src/official-mini.mjs`](src/official-mini.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), and [`src/git.mjs`](src/git.mjs) have broad internal fan-in.

## Experimental work

Work under `experiments/` is separate from the package's exported `src/` surface. Begin benchmark-specific work at [`experiments/grok-reviewer-benchmark/README.md`](experiments/grok-reviewer-benchmark/README.md); the other experiment directories each carry their own tracked README.
