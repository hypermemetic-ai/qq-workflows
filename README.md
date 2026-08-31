# `@hypermemetic-ai/qq-workflows`

Private ESM package for named DSH workflows, delegation capsules, QA, and GitHub PR landing. The package metadata describes this plugin as optional: the core boots when it is absent.

## Run and test

The only repository task declared in [`package.json`](package.json) is the full test suite:

```sh
npm test
```

The script runs its `.mjs` tests directly with Node in a fixed sequence. For a focused check, run a listed test the same way, for example:

```sh
node tests/land.mjs
node tests/mini-docs.mjs
node tests/research.mjs
```

No install, start, or build script—and no Node engine requirement—is declared in the package metadata.

## Package map

[`package.json`](package.json) is the authoritative export map. Its root entry is [`src/plugin.mjs`](src/plugin.mjs); representative subpath boundaries are:

- workflow and command surfaces: [`src/architect.mjs`](src/architect.mjs), [`src/tools.mjs`](src/tools.mjs), and [`src/command.mjs`](src/command.mjs);
- mini and QA surfaces: [`src/mini.mjs`](src/mini.mjs), [`src/official-mini.mjs`](src/official-mini.mjs), [`src/mini-qa.mjs`](src/mini-qa.mjs), and [`src/mini-docs.mjs`](src/mini-docs.mjs);
- Git and PR-landing surfaces: [`src/git.mjs`](src/git.mjs), [`src/land.mjs`](src/land.mjs), and [`src/land-tools.mjs`](src/land-tools.mjs);
- research surfaces: [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-web.mjs`](src/research-web.mjs), and [`src/research-sessions.mjs`](src/research-sessions.mjs);
- state and artifact surfaces: [`src/phase-store.mjs`](src/phase-store.mjs), [`src/delegation-store.mjs`](src/delegation-store.mjs), [`src/research-store.mjs`](src/research-store.mjs), and [`src/proposal-packet.mjs`](src/proposal-packet.mjs).

Implementation is under `src/`; the root test task draws from `tests/`. The declared package file set is limited to `src/`, so tracked studies under `experiments/` are separate from that package payload. Their own entry points include the [Grok reviewer benchmark README](experiments/grok-reviewer-benchmark/README.md) and the [CCA mixed study decision](experiments/cca-mixed-current/decision.md).

## Change routing

| Change area | Start with | Focused verification |
| --- | --- | --- |
| Architect and repository context | [`src/architect.mjs`](src/architect.mjs), [`src/architect-bash.mjs`](src/architect-bash.mjs), [`src/repository-index.mjs`](src/repository-index.mjs) | [`tests/architect-bash.mjs`](tests/architect-bash.mjs), [`tests/architect-case-context.mjs`](tests/architect-case-context.mjs), [`tests/architect-repository-index.mjs`](tests/architect-repository-index.mjs) |
| Git geometry and landing | [`src/git.mjs`](src/git.mjs), [`src/land.mjs`](src/land.mjs), [`src/land-tools.mjs`](src/land-tools.mjs) | [`tests/git-geometry.mjs`](tests/git-geometry.mjs), [`tests/land.mjs`](tests/land.mjs), [`tests/land-publication.mjs`](tests/land-publication.mjs) |
| Mini QA or docs | [`src/mini-qa.mjs`](src/mini-qa.mjs), [`src/mini-docs.mjs`](src/mini-docs.mjs) | [`tests/mini-qa.mjs`](tests/mini-qa.mjs), [`tests/mini-docs.mjs`](tests/mini-docs.mjs) |
| Research pipeline | [`src/research.mjs`](src/research.mjs), [`src/research-evidence.mjs`](src/research-evidence.mjs), [`src/research-web.mjs`](src/research-web.mjs), [`src/research-sessions.mjs`](src/research-sessions.mjs) | [`tests/research.mjs`](tests/research.mjs), [`tests/research-evidence.mjs`](tests/research-evidence.mjs), [`tests/research-web.mjs`](tests/research-web.mjs), [`tests/research-sessions.mjs`](tests/research-sessions.mjs) |
| Settings | [`src/settings.mjs`](src/settings.mjs) | [`tests/settings.mjs`](tests/settings.mjs) |

Public package entry points are explicit rather than inferred from filenames; keep [`package.json`](package.json) aligned with any intended subpath change. The full test command is also an explicit list rather than a file glob, so a new test joins the suite only when that script includes it.
