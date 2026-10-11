# OpenSpec Architect in T3 Code

T3 uses stock Codex with a dedicated profile at `~/.t3/codex`. The planning
adapter follows Matt Pocock's grilling approach: investigate the code, work
through consequential decisions with the engineer, and make grounded
recommendations. The pinned MIT reference is in the adapter's `references/`.
OpenSpec remains the artifact authority; no parallel framework plan is created.

Start a fresh **OpenSpec Architect** conversation in the selected T3 project:

> Use $t3-openspec-architect to plan [change]. Discuss the architecture with me
> and produce the OpenSpec proposal, delta specs, design and tasks.

Planning stops at a validated change contract. When ready:

> Implement and deliver this change. Delegate the work and review the results.

The parent stays the architect. Native Codex workers receive bounded ownership,
separate worktrees for independent tasks, and permission to edit, test and fix
their assignments. The architect reviews actual diffs and acceptance evidence,
integrates accepted commits, syncs the deltas into maintained specs, and archives
the change. Implementation, updated specs and archive land through the project's
normal Git/PR path together. An archived change on an unmerged branch is still
pending delivery.

New T3 threads default to worktrees and full implementation access. Those access
settings do not authorize coding during a planning-only request. Use the normal
write-capable interaction mode for planning artifacts; Codex Plan mode is
read-only. Existing threads need a fresh conversation to load the new profile.
Projects with an OpenSpec root use their existing schema and any configured
store. Projects without one need OpenSpec initialization when adopting this
workflow; the installer does not initialize every project indiscriminately.

## Install and verify

Install from the permanent, landed qq-workflows checkout. Skill links depend on
that checkout remaining present; do not activate from a disposable worktree.

```bash
cd /home/qqp/projects/qq-workflows
/home/qqp/.local/bin/qq-job -- python3 scripts/install-t3-openspec.py
python3 scripts/install-t3-openspec.py --check
/home/qqp/.local/bin/qq-job -- node scripts/verify-t3-openspec.mjs "$PWD"
```

The installer preserves unrelated T3 settings and provider instances. It copies
source Codex configuration and global instructions into the dedicated profile,
sets full access and native delegation, references the existing login, and links
six unchanged OpenSpec core skills plus the adapter. Source-relative custom
agent configuration files remain bound to their original files. No credentials
are printed or committed. Unowned target profile files and conflicting links
are refused before writes. Changes to owned files receive private backups under
`~/.t3/backups/t3-openspec-architect-*` with a restoration manifest.

Rerun the installer after changing source Codex configuration or instructions;
these are snapshots, while authentication and skills are linked. `--check`
reports drift without writes. The native verifier checks the account, actual
skill discovery and effective permissions/delegation through `codex app-server`.
It makes no model turn. Multiple workspace paths may be supplied.

T3 watches `~/.t3/userdata/settings.json`. If a particular version does not adopt
the new settings immediately, restart `t3code.service` when its threads are idle.
The existing listening address and project registry are unchanged.

## Roll back

In T3's provider settings, point Codex back to the original `~/.codex` home and
restore your preferred thread defaults. Start fresh threads. If the installer
replaced existing T3 settings, restore that settings file from its private backup
using the original path recorded in `manifest.json`. A first installation with
no prior settings can be reversed by removing only the installer-added Codex
home/setup/binary fields, provider display name and thread defaults from the
settings JSON; retain any subsequent unrelated settings. The dedicated profile
can remain unused. Do not delete the original Codex home or login.

## Validation

```bash
/home/qqp/.local/bin/qq-job -- python3 tests/t3-openspec-install-test.py
openspec validate --all --strict
```

Installer tests exercise isolation, idempotence, provider preservation, private
backups, ownership conflicts and relocated agent configuration dependencies.
An independent disposable workflow exercise additionally covers planning-only
behavior, isolated implementation, diff review, requirement-preserving spec
sync, archive and native Git integration.
