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

## External writable-folder contract

Architect and delegated native-bash tools expose an optional
`writable_paths` request field:

```json
{
  "command": "cargo build",
  "writable_paths": ["~/.cargo"]
}
```

The value is a non-empty, duplicate-free array of directory path strings. It
names recursive external write roots needed by that call; it does not request
read access or `danger-full-access`. Workflow wrappers forward the array
unchanged and intentionally do not decide whether a path is safe.

The host (`qq-core`/DSH) is the authority for resolving a trusted logical
project identity from the session workspace (linked Git worktrees should share
their canonical common Git directory identity), canonicalizing paths,
refusing protected broad roots, obtaining durable project-folder approval,
persisting grants outside the repository, mounting granted roots in the OS
sandbox, and listing/revoking grants. A rejection or cancellation applies only
to the pending request. The approval/UI contract must identify each canonical
folder and project and use a durable outcome (for example,
`allowed-for-project`), not `allowed-once`.

Delegated Mini commands also run inside a workflow-owned metadata/network
isolation wrapper. That inner sandbox must receive canonical authorized roots
through a trusted post-validation host seam (or preserve an already enforced
outer filesystem policy); it must never mount the raw model-supplied strings.
This package's request forwarding is not evidence that a path was approved.
Land implementation children use the latter strategy: after requiring full DSH
filesystem enforcement, their nested network/metadata namespace preserves the
outer mount policy and explicitly re-applies read-only Git metadata. It does not
add mounts from `writable_paths` or mask authorized `$HOME`/temporary children.
QA children retain the narrower read-only inner filesystem.

Current coarse `sandbox_permissions` fields remain visible on architect bash
for migration and exceptional break-glass use. Routine cache and data-folder
access should use `writable_paths`. The Projects operator chair already has its
separate full-access preset, so its wrapper hides and drops path requests as
inapplicable.
