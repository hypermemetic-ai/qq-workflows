# `@hypermemetic-ai/qq-workflows`

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. The plugin is optional to the core: the [package metadata](package.json) states that core boots when it is absent.

## Run the established task

The manifest defines one repository script and no start script:

```sh
npm test
```

This runs the tracked Node test suite sequentially. Use the script rather than copying its command: it first unsets `GIT_DIR` and `GIT_WORK_TREE`.

The package root resolves to [`src/plugin.mjs`](src/plugin.mjs). Supported subpath entry points—including architect, land, mini, QA, research, conversation-compiler, and child-workflow services—are listed in the [`exports` map](package.json).

## Repository map

| Boundary | Start here | Focused checks |
| --- | --- | --- |
| Package entry and public surface | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs), [`src/tools.mjs`](src/tools.mjs) | [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs), [`tests/snapshots.mjs`](tests/snapshots.mjs) |
| Architect and PR landing exports | [`src/architect.mjs`](src/architect.mjs), [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs) | [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs) |
| Mini, QA, and research exports | [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/research.mjs`](src/research.mjs) | [`tests/mini-qa.mjs`](tests/mini-qa.mjs), [`tests/mini-research.mjs`](tests/mini-research.mjs), [`tests/research.mjs`](tests/research.mjs) |
| Child/delegation services | [`src/delegation-store.mjs`](src/delegation-store.mjs), [`src/child-conversation-services.mjs`](src/child-conversation-services.mjs), [`src/child-workflow-send.mjs`](src/child-workflow-send.mjs) | [`tests/child-conversation-services.mjs`](tests/child-conversation-services.mjs), [`tests/child-workflow-send.mjs`](tests/child-workflow-send.mjs) |
| Conversation compiler | [`src/conversation-compiler/index.mjs`](src/conversation-compiler/index.mjs) | [`tests/conversation-compiler.mjs`](tests/conversation-compiler.mjs), [`tests/conversation-compiler-upstream.mjs`](tests/conversation-compiler-upstream.mjs) |

File names and export names identify these boundaries; consult the implementation and its tests before assuming runtime behavior.

## Change routing

- **Public entry points:** update the canonical [`exports` map](package.json) with the relevant module. The manifest's declared package file set is `src/`.
- **Repository indexing or architect integration:** start at [`src/repository-index.mjs`](src/repository-index.mjs) and [`src/architect.mjs`](src/architect.mjs); check [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs).
- **Landing behavior:** start at [`src/land.mjs`](src/land.mjs) and [`src/land-tools.mjs`](src/land-tools.mjs); check the land tests above plus [`tests/land-child-retirement.mjs`](tests/land-child-retirement.mjs).
- **Mini documentation or research:** use [`src/mini-docs.mjs`](src/mini-docs.mjs), [`src/mini-research.mjs`](src/mini-research.mjs), and their matching [`mini-docs`](tests/mini-docs.mjs) and [`mini-research`](tests/mini-research.mjs) tests.
- **Conversation compilation:** keep changes within the [`conversation-compiler` entry point](src/conversation-compiler/index.mjs) and its focused tests; upstream attribution is recorded in [`ATTRIBUTION.md`](src/conversation-compiler/ATTRIBUTION.md).

Experimental work is separate from the package surface. For the Grok reviewer benchmark, begin with its [experiment README](experiments/grok-reviewer-benchmark/README.md); the other experiment directories each carry their own tracked README.
