# Tasks

## 1. Planning and worker contract

- [x] 1.1 Add the grilling-based adapter, pinned MIT reference and native worker/review guidance; verify skill metadata and independently review planning versus implementation behavior.
- [x] 1.2 Add T3 profile instructions and document the architecture choices; verify the instructions distinguish parent and worker roles and keep OpenSpec as the sole artifact authority.

## 2. Isolated installation

- [x] 2.1 Implement the dedicated profile/settings installer and private backups; verify fixture tests cover source isolation, existing-provider preservation, conflicts and idempotence.
- [x] 2.2 Document install and rollback commands and the fresh-thread workflow; verify the installer command in an isolated profile using the machine's real source configuration and login.

## 3. Integration and delivery

- [x] 3.1 Verify the existing login, actual Codex skill discovery, T3 provider selection, worktree/full-access settings and server health; report the observed integration evidence.
- [x] 3.2 Resolve independent review findings and validate the change; sync the new capability into main specs, archive it, and verify the resulting maintained specification.
- [x] 3.3 Commit, push and land through qq-workflows' PR path; activate the landed sources and verify final Git and T3 state.

## Validation evidence

The 14 installer fixture tests and skill metadata validation pass. Native Codex
app-server discovers the adapter and six core skills from the isolated profile,
reports the existing ChatGPT login, full access and native delegation. No model
turn was started. An independent disposable Git/OpenSpec exercise verified the
planning-only boundary, worker worktree ownership, actual diff review,
requirement-preserving sync, archive and local Git integration. Both review
findings about pre-merge finalization and the relocated worker configuration
dependency were resolved and rereviewed.

Live activation requires the landed permanent checkout. Keep this setup change
active for the initial installation PR; after activation, sync and archive it in
a final documentation PR. This installation dependency does not change the
future workflow's ordinary single-branch code/spec/archive delivery contract.

Installation PR #246 is merged and the permanent checkout activated. Native
Codex authenticated and discovered all seven skills for all 26 registered
projects. The authenticated live T3 `server.getSettings` API confirmed
`OpenSpec Architect`, the dedicated home, full access and worktree defaults.
The service stayed active; no model turn or user thread was created. The
task-only verification bearer session was revoked and the fixture removed.

Live T3 normalization omits its default full-access field on some settings
writes. A final regression ensures semantically equivalent settings pass drift
checks without formatting changes; an explicitly wrong runtime mode is repaired.
The maintained specification's five requirements match the delta and all three
main specifications pass strict validation. The final documentation PR carries
the synced spec, archive and this compatibility fix.
