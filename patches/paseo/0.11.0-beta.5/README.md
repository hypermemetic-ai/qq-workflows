# Paseo 0.11.0-beta.5 OpenSpec integration

This candidate preserves the conversation-local OpenSpec planning toggle,
shared skill roots and existing child-session behavior. Upstream features,
including Codex Speed and Pi MCP, remain intact. The unused local Pi admission
correction has been removed; this artifact adds no Pi-specific customization.

This staged daemon/CLI artifact contains the two OpenSpec integration commits
over upstream beta.5. Its exact source/upstream commits, pinned tarball hashes,
dependency/link inventory and seven emitted-file hashes are in `manifest.json`.
The patch reproduces those source-fork compiled files precisely. Existing source
maps remain upstream metadata; consult the source commit for the patched code.
Package versions stay `0.11.0-beta.5`; release-root provenance identifies the fork.
The later Android ring patch is tracked separately in the
[display-work delivery record](../../../projects/paseo-maintenance/display-work.md).
The installed reduced-motion presentation follow-up and reusable Android emulator
QA pipeline are owned by the separate
[status-indicators delivery record](../../../projects/paseo-maintenance/status-indicators.md).
The later native workspace-input correction and independent covered-chat
evaluation have their own
[mobile responsiveness record](../../../projects/paseo-maintenance/mobile-responsiveness.md),
including source, release and Android activation evidence. These client changes
do not alter this daemon/CLI artifact.

Published inputs are at `~/.local/state/paseo-beta-20261006/`. Reproduce and verify
without changing the live daemon or CLI:

```sh
node scripts/stage-paseo-beta.mjs --stage
node scripts/stage-paseo-beta.mjs --seal
node scripts/stage-paseo-beta.mjs --verify
```

The stager rejects an existing candidate path, copies independently, applies
without fuzz and verifies the full content/link inventory. `--verify` also checks
the read-only seal. The candidate is named
`0.11.0-beta.5-qq-openspec.<first-16-patch-SHA>`; select its exact verified path.

Main-daemon activation requires permission under the Paseo repo's `AGENTS.md`
and an idle boundary that preserves independent processes. Preserve registry,
native histories, receipts, configuration and pairing identity. Never restore an
old whole daemon home or replay an uncertain send. Reassess this integration
against upstream on each update; maintain the needed outcome, then retire deltas.
