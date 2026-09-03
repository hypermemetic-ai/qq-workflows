# `@hypermemetic-ai/qq-workflows`

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. The package description explicitly states that core still boots when this plugin is absent. The package entry point and root export are [`src/plugin.mjs`](src/plugin.mjs); the complete supported subpath surface is declared in [`package.json`](package.json).

## Run the established checks

```sh
npm test
```

This is the only repository command declared in `package.json`. It runs the tracked Node test suite in sequence after clearing `GIT_DIR` and `GIT_WORK_TREE`. No install, build, start, or development command—and no runtime version—is established by the available package metadata.

## Find the right boundary

| Area | Start here | Focused checks |
| --- | --- | --- |
| Plugin and exported tool surface | [`src/plugin.mjs`](src/plugin.mjs), [`src/tools.mjs`](src/tools.mjs), [`package.json`](package.json) | [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs), [`tests/snapshots.mjs`](tests/snapshots.mjs) |
| Workflow architecture and repository context | [`src/architect.mjs`](src/architect.mjs), [`src/repository-index.mjs`](src/repository-index.mjs) | [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs) |
| GitHub PR landing | [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs), [`src/git.mjs`](src/git.mjs) | [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs), [`tests/land-child-retirement.mjs`](tests/land-child-retirement.mjs) |
| Mini and QA variants | [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-swe-v2.mjs`](tests/mini-swe-v2.mjs), [`tests/mini-qa.mjs`](tests/mini-qa.mjs), [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |
| Research workflows and evidence | [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-store.mjs`](src/research-store.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/mini-research.mjs`](tests/mini-research.mjs) |
| Conversation compilation | [`src/conversation-compiler/index.mjs`](src/conversation-compiler/index.mjs) and its [`src/conversation-compiler/`](src/conversation-compiler/index.mjs) modules | [`tests/conversation-compiler.mjs`](tests/conversation-compiler.mjs), [`tests/conversation-compiler-upstream.mjs`](tests/conversation-compiler-upstream.mjs) |
| Child session, compaction, and isolation | [`src/child-conversation-services.mjs`](src/child-conversation-services.mjs), [`src/child-compaction.mjs`](src/child-compaction.mjs), [`src/child-isolation.mjs`](src/child-isolation.mjs) | [`tests/child-conversation-services.mjs`](tests/child-conversation-services.mjs), [`tests/child-compaction.mjs`](tests/child-compaction.mjs), [`tests/child-isolation.mjs`](tests/child-isolation.mjs) |

Prefer the matching focused test while iterating, then run `npm test`. Changes to [`src/official-mini.mjs`](src/official-mini.mjs), [`src/child-settlement.mjs`](src/child-settlement.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), or [`src/git.mjs`](src/git.mjs) merit broader verification: these are the highest-fan-in relative modules in the repository evidence. [`src/land.mjs`](src/land.mjs), [`src/architect.mjs`](src/architect.mjs), and [`src/plugin.mjs`](src/plugin.mjs) are also the most frequently changed source entry points in the recent history sample.

## Further repository detail

- Conversation-compiler provenance: [`src/conversation-compiler/ATTRIBUTION.md`](src/conversation-compiler/ATTRIBUTION.md)
- Grok reviewer benchmark workspace: [`experiments/grok-reviewer-benchmark/README.md`](experiments/grok-reviewer-benchmark/README.md), with adapter notes in [`experiments/grok-reviewer-benchmark/adapters/README.md`](experiments/grok-reviewer-benchmark/adapters/README.md)

Treat `src/` as the published package content: `package.json` lists only that directory in `files`; tests and experiments are repository support material rather than package files.
