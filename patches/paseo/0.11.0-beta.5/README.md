# Paseo 0.11.0-beta.5 compatibility port

This candidate keeps the published beta's providers, Pi 0.99 MCP support, and
Codex Speed selector while retaining the existing local OpenSpec planning and Pi
0.99.1 native-admission corrections. Upstream beta.5 still returns from Pi start
before the correlated native prompt acknowledgement; its MCP fix does not replace
the admission correction.

OpenSpec source is on
[qq/openspec-planning-beta](https://github.com/qqp-dev/paseo/tree/qq/openspec-planning-beta).
The exact source/upstream commits, published tarball hashes, full dependency/link
inventory hashes, patch hash and target hashes are in `manifest.json`. The
combined patch changes emitted runtime JS and admission declarations. Existing
source maps remain upstream metadata; consult the patch and source commit for the
patched implementation. Package versions remain `0.11.0-beta.5`; the release-root
provenance distinguishes this owned candidate from an official release.

Published inputs are retained privately at
`~/.local/state/paseo-beta-20261006/`. Stage and verify without changing the live
daemon:

```sh
node scripts/stage-paseo-beta.mjs --stage
node tests/paseo-pi-native-admission.mjs <printed-candidate>
node tests/paseo-pi-native-contract.mjs
node scripts/stage-paseo-beta.mjs --seal
node scripts/stage-paseo-beta.mjs --verify
```

The stager rejects existing candidate paths, copies independently, applies without
fuzz, and verifies all content and relocated links. Verification requires the
read-only seal. Beta activation selects the verified prefix in both the CLI and
service ExecStart, using an independent maintenance unit after all native turns
settle. Registry/native handles, modes, models, thinking, features, configuration,
pairing, receipts and independent processes are checkpointed privately. Persistent
identity remains stable; the local owner credential intentionally rotates.

## Admission and receipt behavior

Pi start waits for the correlated, validated `started`, `queued` or `handled`
acknowledgement, without waiting for model completion. The manager publishes
accepted start, canonical prompt, then staged stream events. Configured
`extends:pi` providers forward this contract; other providers keep their existing
start behavior. An admitted steer is never replaced or resent automatically.

Accepted keyed sends persist `completed`, including subsequent model failure;
repeating the key and fingerprint returns acceptance without dispatch. Explicit
correlated Pi refusals persist `pending` with `nativeRefusal` metadata and replay
that refusal without dispatch. An intentional retry after a definite refusal
uses a new message ID; changed fingerprints conflict.

Timeouts, process/pipe loss, malformed or missing acknowledgements and receipt
commit failures remain outcome unknown. Reconcile them before choosing a new-key
retry; never infer that they were unsent or replay them automatically. Unkeyed
requests have no durable deduplication. The official beta reader treats refusal
metadata as pending/unknown and does not dispatch it.

The offline admission test defaults to this manifest-derived candidate and
official beta. It uses temporary receipts and a fake child, without launching Pi
or making model requests. Preserve receipt files, native histories and independent
services during authorized activation. Never restore an old whole daemon home
or downgrade Pi history. Reassess the need for this patch on each upstream update.
