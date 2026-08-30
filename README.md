# `@hypermemetic-ai/qq-workflows`

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. Its package contract also states that core boots when this plugin is absent. The package root resolves to [`src/plugin.mjs`](src/plugin.mjs); the complete public subpath surface is declared in [`package.json`](package.json).

## Run and test

The manifest declares no `start` script or repository-specific install command. Its single established task is the full test suite:

```sh
npm test
```

That script runs the tracked Node test programs sequentially and stops on the first failure. For focused iteration, run one of the same commands directly—for example, `node tests/land.mjs`—then run `npm test` before finishing.

## Repository map

- **Package integration and workflow composition:** [`src/plugin.mjs`](src/plugin.mjs) is the root entry; [`src/architect.mjs`](src/architect.mjs), [`src/tools.mjs`](src/tools.mjs), and [`src/command.mjs`](src/command.mjs) are declared subpath exports.
- **Git and PR landing:** [`src/git.mjs`](src/git.mjs), [`src/land.mjs`](src/land.mjs), and [`src/land-tools.mjs`](src/land-tools.mjs) are separate exported boundaries.
- **Specialized mini entry points:** the manifest exports [`src/official-mini.mjs`](src/official-mini.mjs) as `./mini-code`, plus [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs), and [`src/mini-research.mjs`](src/mini-research.mjs).
- **Research:** [`src/research.mjs`](src/research.mjs) is accompanied by separately exported evidence, web, session, oracle, and store modules.

These export mappings establish boundaries, not their internal call flow; consult the linked source rather than inferring relationships from filenames.

## Route a change

Use the exported source as the first stop. The filename-aligned tests below are all included in `npm test`; the available evidence does not establish finer ownership.

| Change area | Start in | Focused tests |
| --- | --- | --- |
| Architecture or repository indexing | [`src/architect.mjs`](src/architect.mjs), [`src/repository-index.mjs`](src/repository-index.mjs) | [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs), [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs) |
| Git landing or publication | [`src/git.mjs`](src/git.mjs), [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs) | [`tests/git-geometry.mjs`](tests/git-geometry.mjs), [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs) |
| Mini QA or documentation | [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-qa.mjs`](tests/mini-qa.mjs), [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |
| Research pipeline | [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-web.mjs`](src/research-web.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/research-web.mjs`](tests/research-web.mjs) |
| Settings or child isolation | [`src/settings.mjs`](src/settings.mjs), [`src/child-isolation.mjs`](src/child-isolation.mjs) | [`tests/settings.mjs`](tests/settings.mjs), [`tests/child-isolation.mjs`](tests/child-isolation.mjs) |

## Contributor invariants

- Keep the plugin optional to core behavior, as required by the package description.
- Treat [`package.json`](package.json) as authoritative for public entry points; not every tracked `src/` module is exported.
- Source is ESM (`"type": "module"`), and the package file list is restricted to `src/`.

Tracked experiment entry points are the READMEs for [bash filter opportunity](experiments/bash-filter-opportunity-current/README.md), [bash window contract](experiments/bash-window-contract-current/README.md), [bash window value](experiments/bash-window-value-current/README.md), [mixed CCA](experiments/cca-mixed-current/README.md), [mixed composition](experiments/mixed-composition-current/README.md), and the [controlled Grok reviewer benchmark](experiments/grok-reviewer-benchmark/README.md).
