# `@hypermemetic-ai/qq-workflows`

A private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. It provides an optional plugin—the package metadata explicitly states that core boots when this plugin is absent. The default package entry point is [`src/plugin.mjs`](src/plugin.mjs); [`package.json`](package.json) is the authoritative export and task manifest.

## Run the established checks

The only repository command declared by the package is:

```sh
npm test
```

That script first unsets `GIT_DIR` and `GIT_WORK_TREE`, then runs the Node test programs in sequence. No install, start, or standalone run script is declared in [`package.json`](package.json), so this repository does not establish one here.

## Route a change

The package export map provides the safest high-level map. Start at the declared source boundary, use the focused tests for the same area while iterating, and run the full `npm test` chain before considering the change complete.

| Area | Canonical source entry points | Focused tests |
| --- | --- | --- |
| Plugin and command surface | [`src/plugin.mjs`](src/plugin.mjs), [`src/tools.mjs`](src/tools.mjs), [`src/command.mjs`](src/command.mjs), [`src/settings.mjs`](src/settings.mjs) | [`tests/settings.mjs`](tests/settings.mjs), [`tests/snapshots.mjs`](tests/snapshots.mjs) |
| Architecture and repository context | [`src/architect.mjs`](src/architect.mjs), [`src/repository-index.mjs`](src/repository-index.mjs), [`src/repo-oracle.mjs`](src/repo-oracle.mjs) | [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs), [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs) |
| Mini execution, QA, and docs | [`src/official-mini.mjs`](src/official-mini.mjs) (the `./mini-code` export), [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-swe-v2.mjs`](tests/mini-swe-v2.mjs), [`tests/mini-qa.mjs`](tests/mini-qa.mjs), [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |
| Child-local parent messaging | [`src/child-workflow-send.mjs`](src/child-workflow-send.mjs), bound by durable controllers in [`src/land.mjs`](src/land.mjs) and [`src/research.mjs`](src/research.mjs) | [`tests/child-workflow-send.mjs`](tests/child-workflow-send.mjs), [`tests/workflow-resume.mjs`](tests/workflow-resume.mjs), [`tests/research.mjs`](tests/research.mjs) |
| Research | [`src/research.mjs`](src/research.mjs), [`src/mini-research.mjs`](src/mini-research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-web.mjs`](src/research-web.mjs), [`src/research-sessions.mjs`](src/research-sessions.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/mini-research.mjs`](tests/mini-research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/research-web.mjs`](tests/research-web.mjs), [`tests/research-sessions.mjs`](tests/research-sessions.mjs) |
| Git and PR landing | [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs), [`src/git.mjs`](src/git.mjs) | [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs), [`tests/git-geometry.mjs`](tests/git-geometry.mjs) |
| Child conversations and compilation | [`src/child-conversation-services.mjs`](src/child-conversation-services.mjs), [`src/child-compaction.mjs`](src/child-compaction.mjs), [`src/child-isolation.mjs`](src/child-isolation.mjs), [`src/conversation-compiler/index.mjs`](src/conversation-compiler/index.mjs) | [`tests/child-conversation-services.mjs`](tests/child-conversation-services.mjs), [`tests/child-compaction.mjs`](tests/child-compaction.mjs), [`tests/child-isolation.mjs`](tests/child-isolation.mjs), [`tests/conversation-compiler.mjs`](tests/conversation-compiler.mjs) |

Focused filenames are routing aids, not evidence that a test is exhaustive.

## Repository boundaries

- [`src/`](src/plugin.mjs) contains every declared package export and is the only directory selected by the package `files` field.
- [`tests/`](tests/architect-bash.mjs) contains the package test chain. The chain is explicit in [`package.json`](package.json); add or rename a test there when it must join the standard run.
- [`experiments/`](experiments/grok-reviewer-benchmark/README.md) is outside both the package `files` selection and the `npm test` command. Follow the documentation within an experiment rather than assuming the package workflow; the reviewer benchmark starts at its [`README`](experiments/grok-reviewer-benchmark/README.md).

Because the package is declared with `"type": "module"`, its JavaScript sources and test entry points use the ESM `.mjs` boundary. Changes to public entry points should begin with the export map in [`package.json`](package.json), rather than relying on similarly named files alone.
