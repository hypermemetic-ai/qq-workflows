# qq-workflows

`@hypermemetic-ai/qq-workflows` is a private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. Its package contract says the core boots when this plugin is absent. The default entry point is [`src/plugin.mjs`](src/plugin.mjs).

## Run and test

The package declares one command:

```sh
npm test
```

This runs the repository's Node test files in an explicit sequence. No install, start, or other run command is declared; the package metadata also does not specify a Node version or dependency set.

## Repository map

[`package.json`](package.json) is the authoritative package boundary: it marks the package as ESM and private, lists only `src/` as package files, defines every public subpath, and owns the test command.

The main public areas are:

- **Plugin and workflow surfaces:** [`src/plugin.mjs`](src/plugin.mjs), [`src/architect.mjs`](src/architect.mjs), [`src/tools.mjs`](src/tools.mjs), and [`src/command.mjs`](src/command.mjs).
- **Delegation and task artifacts:** [`src/delegation-store.mjs`](src/delegation-store.mjs), [`src/proposal-packet.mjs`](src/proposal-packet.mjs), and [`src/task-artifact.mjs`](src/task-artifact.mjs).
- **Mini and QA surfaces:** [`src/mini.mjs`](src/mini.mjs), [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), and [`src/qa-verdict.mjs`](src/qa-verdict.mjs).
- **Git and landing surfaces:** [`src/git.mjs`](src/git.mjs), [`src/land.mjs`](src/land.mjs), and [`src/land-tools.mjs`](src/land-tools.mjs).
- **Research surfaces:** [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), and [`src/research-web.mjs`](src/research-web.mjs).

These are routing landmarks, not a complete module inventory; consult the export map in [`package.json`](package.json) for the full supported surface. Reviewer-benchmark work has separate guidance in [`experiments/grok-reviewer-benchmark/README.md`](experiments/grok-reviewer-benchmark/README.md).

## Route a change

| Change area | Start with | Focused tests |
| --- | --- | --- |
| Package entry points or exports | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | No same-named plugin test is tracked; run `npm test` |
| Workflow architecture | [`src/architect.mjs`](src/architect.mjs), [`src/architect-bash.mjs`](src/architect-bash.mjs) | [`tests/architecture-pin.mjs`](tests/architecture-pin.mjs), [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs), [`tests/architect-bash.mjs`](tests/architect-bash.mjs) |
| Delegation, proposals, or isolation | [`src/delegation-store.mjs`](src/delegation-store.mjs), [`src/proposal-packet.mjs`](src/proposal-packet.mjs), [`src/child-isolation.mjs`](src/child-isolation.mjs) | [`tests/proposal-packet.mjs`](tests/proposal-packet.mjs), [`tests/packet-lifecycle.mjs`](tests/packet-lifecycle.mjs), [`tests/child-isolation.mjs`](tests/child-isolation.mjs) |
| QA or mini execution | [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs) | [`tests/mini-swe-v2.mjs`](tests/mini-swe-v2.mjs), [`tests/mini-qa.mjs`](tests/mini-qa.mjs) |
| Git or PR landing | [`src/git.mjs`](src/git.mjs), [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs) | [`tests/git-geometry.mjs`](tests/git-geometry.mjs), [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs) |
| Research | [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-store.mjs`](src/research-store.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/research-sessions.mjs`](tests/research-sessions.mjs), [`tests/research-web.mjs`](tests/research-web.mjs), [`tests/research-oracle.mjs`](tests/research-oracle.mjs) |
| Documentation pass behavior | [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |

## Contributor invariants

- Keep the package's ESM contract and public export map in sync with source changes.
- The test command enumerates files rather than discovering them. Adding a test file does not add it to `npm test`; update the script in [`package.json`](package.json).
- [`src/official-mini.mjs`](src/official-mini.mjs) and [`src/research-evidence.mjs`](src/research-evidence.mjs) have the highest relative-module fan-in in the tracked source. Treat changes there as cross-cutting and run the full suite.
- Preserve the package-level contract that the core can boot without this plugin.
