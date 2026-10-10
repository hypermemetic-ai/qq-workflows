# Paseo to Orca migration

On 2026-10-10 the operator selected stock Orca, resuming the existing native
Codex threads with recent messages in Orca's terminal-backed chat view. Do not
create replacement conversations or written handoffs merely to migrate. Full
history import is not required. Projects, worktrees and uncommitted work stay in
place.

This is an operational migration, not another app patch or host upgrade. Preserve
Paseo's records until the transition is verified; do not archive conversations or
workspaces as cleanup. Paseo workspace archival can remove a backing worktree.
Do not restart shared services, delete provider data, or alter the independent
ISO/Music streams. DecIQ and DecIQ Logic remain outside cleanup. The broader
ownership context is in [native-entry.md](../../docs/native-entry.md).

## Baseline and delivery state

The initial inventory found 18 Paseo projects, of which 12 were already registered
in Orca, and 17 workspace records referenced by the selected conversations. All
required directories and native Codex logs were present. Of 18 unarchived Codex
conversations, three were running, nine idle and six closed. These are inventory
counts, not an assertion that each conversation has transferred.

The installed Orca host is 1.4.203 and Codex is 0.159.3. The released Android
candidate is `mobile-android-v0.0.52`, source commit
`37b7f1b679cd63df1f3c840cbe92211410cb17d1`. Its protocol compatibility checks pass
against the installed host. This does not establish installation or pairing on
the operator's phone. See the stock [mobile connection guide](https://www.onorca.dev/docs/mobile).

Orca's structured-chat import has a 16 MiB gate; ten selected logs exceed it.
Structured native chat is currently disabled on this host. Use stock terminal
resume with the original thread ID instead of importing or truncating the native
log. Recent UI messages and the provider's saved conversation context are
different concerns. See [Orca session history](https://www.onorca.dev/docs/agents/session-history).

The verified stock registration forms are:

```text
orca repo add --path <existing-absolute-root> --json
orca project setup-existing-folder --project <project-id> --host local --path <existing-folder> --kind folder --json
orca terminal create --worktree path:<existing-cwd> --command <verified-resume-command> --json
```

These are command shapes, not paste-ready commands. Construct and shell-quote the
resume command from the original provider home, native thread ID and verified
settings. Repository registration and folder binding are separate stock paths;
see the [registration controller](https://github.com/stablyai/orca/blob/37b7f1b679cd63df1f3c840cbe92211410cb17d1/src/main/runtime/runtime-repository-registration-controller.ts#L31)
and [folder setup controller](https://github.com/stablyai/orca/blob/37b7f1b679cd63df1f3c840cbe92211410cb17d1/src/main/runtime/runtime-project-host-setup-controller.ts#L94).
The installed host's command/settings behavior must still be checked during
activation; inspected source is not a live migration receipt.

| Outcome | Recorded state |
| --- | --- |
| Project/workspace mapping | Initial inventory complete; registration and placement pending |
| Existing thread continuity | Source path identified; live ownership transfer pending |
| Native Android controls | Isolated emulator acceptance pending |
| Phone activation | Tailscale pairing and installed-client verification pending |

## Transfer procedure

1. Keep the private inventory, settings snapshots and per-thread receipts under
   `~/.local/state/paseo-orca-migration-20261010`. Restrict access to the operator.
   Do not commit project names, path lists, IDs, prompts, credentials or recent
   message contents. Refresh statuses before each transfer.
2. Register missing projects and existing worktree directories through stock
   Orca operations. Reuse the original paths and preserve distinct workspace
   placement; do not clone, move, recreate or delete directories. Reconcile
   existing Orca registrations before adding duplicates.
3. Verify the stock client on an isolated emulator with synthetic work. Cover
   project and workspace switching, recent chat, input/send, approvals and
   questions, scrolling, keyboard, background/resume and disconnect/reconnect.
   Label emulator results separately from phone and battery evidence.
4. For each original thread, wait for its Paseo turn and dependent children to
   settle. Confirm that Paseo has released its live provider writer without
   archiving the session. Resume the same native Codex thread in Orca with the
   original working directory and `CODEX_HOME`. Never submit to the same thread
   through both clients. Transfer the coordinating conversation last.
5. Check the effective model, reasoning, normal speed, permissions and provider
   home before the first resumed submission. Preserve the approved discussion,
   investigation and OpenSpec planning preference, with implementation normally
   delegated to children. Project `AGENTS.md` and `openspec/` stay in place.
   Verify discovery of the unmodified stock OpenSpec skills: Paseo's process-local
   `skills/extraRoots/set` setting does not automatically carry into a new Orca
   process. Keep [the existing integration record](../../docs/paseo-openspec.md)
   as provenance; add no global custom skill, orchestrator or updater.
6. Record each confirmed Orca session and its settings in the private receipt.
   Prevent further Paseo submissions to transferred threads; opening an old
   Paseo conversation can revive its writer. Verify phone pairing over Tailscale
   and the actual installed client separately from emulator acceptance.

## Acceptance and recovery

Completion requires every selected project/workspace to retain its original
files and worktree identity, every transferred conversation to resume its original
native thread, verified settings and usable recent chat, and a connected Android
client with the required controls working. Merely displaying a project or
starting a terminal is not session acceptance. Record partial transfers and
running work explicitly instead of reporting a whole migration as complete.

If resume fails, preserve the native log and receipt. Confirm the Orca writer has
stopped before returning the thread to Paseo. No restart, archive, delete or
history conversion is the default recovery action. Retained Paseo metadata also
keeps older provider archives readable while their owners remain unresolved.
Session registration, emulator acceptance and phone activation have independent
receipts; source inspection alone proves none of them.
