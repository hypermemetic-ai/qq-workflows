# `@hypermemetic-ai/qq-workflows`

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. Its main module is [`src/plugin.mjs`](src/plugin.mjs); the package metadata explicitly allows the core to boot when this plugin is absent.

## Commands

No repository-specific install or start script is declared. The established validation command is:

```sh
npm test
```

The test script clears `GIT_DIR` and `GIT_WORK_TREE`, then runs the tracked Node test sequence serially. See [`package.json`](package.json) for the authoritative export map and exact test list.

## System map

Use the package export map as the public-module index; the links below select the main boundaries rather than inventorying every export.

- **Plugin and workflow control:** [`src/plugin.mjs`](src/plugin.mjs) is the package entry point. Start workflow-level changes in [`src/architect.mjs`](src/architect.mjs), with [`src/command.mjs`](src/command.mjs), [`src/context.mjs`](src/context.mjs), and [`src/transition.mjs`](src/transition.mjs) as separately exported surfaces.
- **Delegation, mini execution, and QA:** [`src/official-mini.mjs`](src/official-mini.mjs) backs the `./mini-code` export; [`src/delegation-store.mjs`](src/delegation-store.mjs), [`src/child-isolation.mjs`](src/child-isolation.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), and [`src/qa-verdict.mjs`](src/qa-verdict.mjs) are the corresponding focused entry points.
- **Git and PR landing:** route landing work through [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs), and [`src/git.mjs`](src/git.mjs).
- **Research:** the exported research surface starts at [`src/research.mjs`](src/research.mjs), with separate evidence, web, session, oracle, and store modules under `src/`; begin with [`src/research-evidence.mjs`](src/research-evidence.mjs) when changing the shared evidence layer.

## Change routing

| Change | Canonical source | Closest established tests |
| --- | --- | --- |
| Workflow architecture | [`src/architect.mjs`](src/architect.mjs) | [`tests/architect-bash.mjs`](tests/architect-bash.mjs), [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs), [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs) |
| Landing and publication | [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs) | [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs) |
| Git handling | [`src/git.mjs`](src/git.mjs) | [`tests/git-geometry.mjs`](tests/git-geometry.mjs) |
| QA | [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/qa-verdict.mjs`](src/qa-verdict.mjs) | [`tests/mini-qa.mjs`](tests/mini-qa.mjs) |
| Research pipeline | [`src/research.mjs`](src/research.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/research-web.mjs`](tests/research-web.mjs), [`tests/research-sessions.mjs`](tests/research-sessions.mjs), [`tests/research-oracle.mjs`](tests/research-oracle.mjs) |
| Mini Docs | [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |
| Child isolation | [`src/child-isolation.mjs`](src/child-isolation.mjs) | [`tests/child-isolation.mjs`](tests/child-isolation.mjs) |

Run the full suite after changes to heavily shared modules—especially [`src/official-mini.mjs`](src/official-mini.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), and [`src/child-settlement.mjs`](src/child-settlement.mjs), which have the highest relative-module fan-in.

For the separate reviewer-benchmark workspace, start with [`experiments/grok-reviewer-benchmark/README.md`](experiments/grok-reviewer-benchmark/README.md).
