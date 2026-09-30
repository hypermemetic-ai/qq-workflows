# Paseo 0.10.2: local Pi native-admission correction

This is an owned published-package patch, **not** an official Paseo release or a
provider/plugin replacement. Target native contract: Pi **0.99.1**. Package
metadata and original source maps remain upstream 0.10.2; patched emitted JS and
its two admission declarations are identified by the manifest and release-root
provenance. Source-map upstream source text is not the patched runtime.

## Boundary and receipt policy

Pi reserves a provisional turn before `prompt` RPC, then awaits that specific
request's validated `started` / `queued` / `handled` response. Started/queued do
not await model completion. Handled non-slash inputs use synthetic no-turn
completion, without waiting for `agent_settled`. Fast provider events remain
staged by the existing manager until its accepted-start, canonical prompt, then
stream publication. Failed preflight cleans provisional state and throws the
original correlated refusal; the manager alone publishes failed-start.

The Pi session advertises an internal admission marker; configured `extends:pi`
wrappers forward it. Only these sessions await the iterator's first accepted-start
in `startAgentRun`. Their server send/initial-prompt path skips the later racy
live-state start wait. Other providers retain detached start/wait behavior.
Post-admission Pi iterator errors never cause a stale-session retry. Steering
keeps interrupt fallback for unsupported commands, but never replaces/resends
an already-admitted steer, including handled input and terminal-before-ack.

Receipt compatibility deliberately avoids a new state enum:

* Accepted sends persist existing `completed`, regardless of subsequent model
  failure. Same key/fingerprint returns accepted without dispatch.
* Correlated explicit Pi `prompt`/`steer` refusals persist `pending` plus validated
  `nativeRefusal: {requestId, command, message}`. The patched reader replays the
  refusal without dispatch. A changed fingerprint conflicts. An intentional
  retry after a definite refusal uses a **new message ID**.
* Timeout, pipe/exit, missing/malformed/legacy acknowledgements and receipt commit
  loss remain **outcome unknown**, with ordinary pending receipts, no automatic
  replay and no assertion that the input was definitely not sent. Reconcile these
  cases before choosing a new-key retry. Unkeyed requests have no persisted dedup.
* Untouched official 0.10.2 parses the extra metadata by stripping it, sees pending
  and returns unknown without dispatch. It does **not** mistake refusals for
  completed/accepted. Preserve those receipt files on rollback; returning to the
  patch restores the precise replay. Completed receipts remain fully compatible.

Legacy Pi acknowledgements without dispositions fail closed as unknown; legacy
`agentInvoked` or a sampled `get_state` is not native admission evidence. Strict
response validation is scoped to the Pi RPC diagnostic transport; other providers'
JSONL handling is unchanged. Existing legacy probe helpers remain upstream code
but are not used for modern prompt admission.

## Reproduce and stage (no daemon or live configuration changes)

The stager pins the official server tarball, complete installed dependency/link
inventory hash, base package versions, every before/after target, and patch SHA.
It copies independently (no hardlinks), applies without fuzz and verifies the
entire relocated tree and candidate binary. Existing candidate paths fail closed
rather than silently reusing partial trees. Relative links must resolve inside
their own release. Official releases and retained tarballs are never modified.

```sh
node scripts/stage-paseo-native-admission.mjs --stage
node tests/paseo-pi-native-contract.mjs
node tests/paseo-pi-native-admission.mjs
node tests/paseo-pi-admission-stager.mjs
# Inspect syntax/diff, then freeze files/directories read-only:
node scripts/stage-paseo-native-admission.mjs --seal
node scripts/stage-paseo-native-admission.mjs --verify
```

Normal test execution uses the manifest-derived candidate; the integration test
can optionally take an explicit candidate prefix. Its fake child never launches
Pi. Tests execute published runtime/provider/manager/server-handler/receipts,
including an official false-acceptance reproduction, and separately exercise
real Pi SDK prompt/steer methods with offline collaborators (no model request).
RPC-mode mapping has a source anchor, not a live RPC-daemon claim. Negative
staging checks fail before mutation. `--verify` requires the seal and compares it
against the artifact from the current checkout. Runtime package sealing is a
read-only preparation guard, not a security boundary against its owner.

Durable preparation evidence: `~/.local/state/paseo-upgrade/pi-native-admission-preparation/`.

## Guarded landing, activation and rollback

This source phase leaves Git changes uncommitted and **does not activate** either
repair. After managed landing/sync, run `--verify` again **from the final committed
checkout**, and run the offline integration test against that exact prefix. The
candidate name is `0.10.2-qq-pi-admission.<first-16-patch-SHA>`; do not select by a
glob. The full SHA and per-file hashes are authoritative. Earlier unsealed
preparation candidates are not rollout targets.

Architect's already-approved coordinated activation is a separate independent
managed maintenance execution, not a new request for generic approval:

1. Verify the actual maintenance host **and worker** are outside Paseo's cgroup.
   Naturally settle vulnerable jobs/provider turns, preserve independent jobs.
2. Fresh private checkpoint of registry, native history, config/identity,
   receipts, tickets, jobs and terminal restoration state. Never revive
   archived/cancelled work.
3. Install the final outbound workflow release and select this verified candidate
   in the user unit's **ExecStart**, daemon-reload and normal CLI selector, then
   perform the one coordinated Paseo restart. The CLI selector alone is not
   activation; no second live daemon.
4. Resume the same owners/native handles on Pi 0.99.1, preserving Architect
   Sol6.1/xhigh and worker/high settings. Verify actual server/acceptance and
   outbound-module uptake, independent-job continuity and terminal restoration.

Rollback restores the prior unit/CLI selectors to the untouched official 0.10.2
prefix. Preserve candidate-era receipts and native history/checkpoint writes;
**do not restore an old whole home**, delete releases, or downgrade v3 Pi history
as if old Pi were format-equivalent. Official fallback remains subject to the
original false-acceptance bug and reports patched definite refusals as unknown.
No live restart, reload, production send, paid inference or full regression suite
is part of these preparation tests.
