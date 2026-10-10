# Paseo to Orca migration

On 2026-10-10 the operator selected stock Orca for the existing projects and
native Codex conversations. Preserve the original thread IDs, working
directories, provider homes, settings and saved context; display recent messages
in terminal-backed Chat. Full history import, replacement chats and written
handoffs are unnecessary. Carry the existing OpenSpec planning preference for
16 ON and two OFF conversations. Send exactly one short explanatory migration
notice on each original thread after transferring its writer ownership.

Use the already-paired main Orca 1.4.203 host and original Codex 0.159.3. The
selected delivery requires no stock upgrade, main restart or custom startup
helper activation. Projects, worktrees and uncommitted work stay in place.
Preserve Paseo records; do not archive workspaces, delete provider data or restart
shared services. Paseo workspace archival can remove a backing worktree.
Independent ISO/Music tasks retain their owners and reach their natural idle
boundary. DecIQ and DecIQ Logic file/runtime cleanup remain out of scope;
registration and client views do not change their applications. See
[native-entry.md](../../docs/native-entry.md) for the broader ownership context.

## Baseline and current state

The selected inventory contains 18 Paseo projects and 17 referenced workspace
locations, represented in Orca by 12 physical cards and 13 distinct original
working directories. All required paths and native files are present. Preserve
the one subdirectory working directory with the verified Codex `--cd` flag.
Latest source/native thread IDs agree for all 18 conversations. Inventory and
registration are separate from live session acceptance.

The Android artifact is `mobile-android-v0.0.52`, package
`com.stably.orca.mobile`, version code 19, size 134,329,673 bytes, SHA-256
`68bd92eda053236cef4b89fbe3272555da1f88a83976a5a20481383fa2e027c3`.
It was downloaded, hash-verified and delivered over Tailscale. The operator
reports installing it, and the phone has authenticated to the intended main
host on port 6768. Its installed APK version has not been verified through ADB.
See the stock [mobile connection guide](https://www.onorca.dev/docs/mobile).

The APK source commit is `37b7f1b679cd63df1f3c840cbe92211410cb17d1`, whose
desktop package is 1.4.214, while the live host is 1.4.203. Protocol 3 with minimum
client/server versions of 2 establishes source compatibility; it does not prove
that every inspected source feature is installed. Pin the original Codex 0.159.3
binary explicitly rather than relying on Orca's inherited `PATH`.

Ten selected logs exceed the structured-chat import's 16 MiB gate. Structured
native chat is disabled on this host. Resume the original native thread through
the stock terminal path and preserve its complete native file. Recent UI messages
and saved provider context are separate concerns. See
[Orca session history](https://www.onorca.dev/docs/agents/session-history).

| Outcome | Recorded state |
| --- | --- |
| Project/workspace mapping | 18 roots/17 locations registered; 12 physical cards/13 original working directories |
| Original thread/settings continuity | All 18 source/native IDs consistent; real 3.07 MiB pilot verified on original main/provider |
| Ongoing migration | Active worker at 2026-10-10 19:28:42 UTC: 15 verified, 0 blocked, 3 waiting; coordinator queued last |
| Native Android controls | Same-ID 19.2 MiB synthetic Chat/send/switch/background/reconnect accepted on original Codex 0.159.3 |
| OpenSpec | ON16/OFF2 instruction-driven carryover prepared; explicit-path native child read verified |
| Phone | Main host authenticated and real pilot phone-accepted; installed APK version not ADB-verified |

## Accepted behavior and known limitation

Isolated native testing on the original provider resumed the same thread and
home with a synthetic 19.2 MiB log. After the first message, Chat, send, session
switching, background/resume and disconnect/reconnect passed. These are emulator
results, not physical-phone latency or battery measurements.

The real 3.07 MiB pilot delivered on the existing main 1.4.203 host and original
Codex 0.159.3. Its native provider ID remained unchanged, with exactly one new
migration notice and one assistant response; Chat reached its completed
lifecycle. The operator accepted it on the phone. Its normalized 1.4.203 receipt
and writer fence are recorded; completing that receipt sent no additional turn.

A fresh terminal resume initially shows empty Chat until its first message;
this was reproduced with Codex 0.159.3 and 0.162.1. The operator authorized one
short explanatory migration notice on each original thread, without assigning
a new task. This genuine turn establishes stock session hooks and recent Chat.
CLI `input_accepted` or observation permission alone does not prove a provider
turn or a completed notice. Record one-shot send intent privately before sending
and confirm the assistant's stop before accepting the session.

Installed Orca 1.4.203 has a confirmed manual `worktree.sleep` tab-retention
limitation: the provider stops, but tab/leaf ownership can disappear. The native
Codex file and original conversation context persist. Cold tab UI restoration
is outside this migration's acceptance gate. The stock upstream
[intentional-stop fix](https://github.com/stablyai/orca/pull/22989) exists;
upgrading the host is outside the selected delivery.

## OpenSpec carryover

Project `AGENTS.md` and `openspec/` remain in place. Paseo's process-local
`skills/extraRoots/set` roots do not automatically carry into a new Orca provider;
per-skill enable overrides alone do not discover external skills.

For ON conversations, stock per-launch `developer_instructions` preserves any
prior effective text and source-configured prompt parts, then appends the
approved discussion/planning preference and six central stock skill names,
descriptions and `SKILL.md` paths. OFF conversations retain their prior text
without that appendix. Private replay found no prior effective developer text
in the 18 current config stacks; a no-model prompt probe verified composition.
The skills remain byte-unmodified.

Actual resumed-turn QA confirmed the preference and paths in the Codex 0.159.3
process arguments. A native child given the explicit central
`openspec-explore/SKILL.md` path read it successfully; a name-only lookup failed.
Pass the exact skill path when delegating. This is instruction-driven invocation,
not automatic native catalog discovery, inheritance or Paseo composer-toggle
parity. It installs no global skill and changes no project repositories. Keep
[the existing integration record](../../docs/paseo-openspec.md) as provenance.

## Transfer procedure

The verified stock command shapes are:

```text
orca repo add --path <existing-root> --json
orca project setup-existing-folder --project <id> --host local --path <existing-folder> --kind folder --json
orca terminal create --worktree path:<existing-cwd> --command <verified-resume-command> --json
```

1. Keep inventory, launch settings, one-shot send intents and receipts under
   `~/.local/state/paseo-orca-migration-20261010`, accessible only to the operator.
   Commit no project names, path lists, IDs, prompts, credentials or messages.
   Refresh source status and native identity before each transfer.
2. Reuse registered original paths and distinct workspace placement. Reconcile
   existing registrations; do not clone, move, recreate or delete directories.
3. Wait for the source turn and children to settle, then confirm Paseo released
   its provider writer without archiving. Resume the same native thread with
   original `CODEX_HOME` and working directory through the stock terminal form.
   Shell-quote the actual command and pin the original Codex binary.
4. Verify model, reasoning, normal speed, permissions, provider home, title and
   ON/OFF instructions before the first submission. Confirm exactly one writer;
   prevent further Paseo submissions to the transferred thread. Opening an old
   Paseo conversation can revive its writer.
5. Send the single authorized explanatory notice on the original thread.
   Confirm original recent Chat, genuine hook/session identity and assistant
   completion. A displayed card or live terminal alone does not pass acceptance.
6. Record the actual outcome and settings privately. Bulk transfer follows only
   after the real pilot passes. Transfer the coordinating conversation last,
   after the other 17 are verified; let busy sessions reach natural idle.

The authorized one-off continuation worker was activated after the stored pilot
receipt. It has eight policy tests and processes idle/closed sessions one at a
time, bounded to the original four-hour deadline and 64 tasks. It checks every
30 seconds with two idle samples, source/mode guards and immutable one-shot send
intents. Automatic notice retries are disabled. Running turns and pending permissions
wait naturally. The coordinator transfers only after the other 17 are verified
and its current turn is idle.

The initial 256 MiB worker exhausted its service memory budget before the second
selection, with no new ownership intent, source closure, provider or notice.
Only the verified pilot had transferred. Recovery uses a 768 MiB budget for the
worker and helper Node processes, preserving the original deadline, concurrency
of one and 64-task limit.

Receipts verify 15 original conversations, each with
exactly one notice and acknowledgment, completed Chat/Stop and final expected-writer
fences. The parent-file recovery below passed on its existing pane and original
thread. The operative worker snapshot at 2026-10-10 19:28:42 UTC is active with
15 verified, zero blocked and three waiting: two non-coordinator sessions are
running, one awaiting operator permission, and the coordinator is queued last.
The 768 MiB budget, concurrency of one, 64-task limit and original deadline are
unchanged; automatic notice retries are zero. These remaining conversations are
not yet transferred.

The 2026-10-10 19:03:01 UTC rearm was an earlier checkpoint: the corrected unit
was active with seven verified, zero blocked and eleven waiting. Those counts
are historical, not the current receipt total.

Ten selected final transcript symlinks target a different filesystem outside the
original canonical sessions tree, failing stock's regular-file provenance guard.
No hardlinks or transcript-byte edits were made. A metadata-only trial sent no
notice because stock PTY startup overwrote both home variables. For the ten
proven symlink cases only, the accepted stock route prefixes the
original command with properly quoted explicit original-home assignments to
both `CODEX_HOME` and `ORCA_CODEX_HOME`, and omits optional
`resumeProviderSession` metadata. The pinned plan changes only that prefix in
actual and durable commands for ten mappings; command remainders, stored environment,
settings, working directories, native threads, version, normal tier and account
remain unchanged. Genuine Chat and final writer fences verified this route.
No application, credential or filesystem change is involved. A stopped symlink
session may need this explicit-home CLI route again; that is an inference from
the same guard. Cold tab restoration remains unverified and adds no new gate.

A paginated-fork resume failed to discover its original 122.93 MiB parent, a
regular file beneath a nested directory symlink. Stock Codex 0.159.3
[lineage lookup](https://github.com/openai/codex/blob/01fc69f4/codex-rs/thread-store/src/local/rollout_lineage.rs#L73)
scans managed filenames rather than SQLite's parent path, and
[file scanning](https://github.com/openai/codex/blob/01fc69f4/codex-rs/rollout/src/list.rs#L1615)
skips nested directory/file symlinks; the original parent and database record
exist. The same discovery behavior remains in 0.162.1.

The separately authorized storage correction is performed and verified: one
128,903,879-byte, byte-identical parent is now a regular, non-symlink file under
its existing managed filename in a real original-home sessions directory. The
original remains untouched. Source, native, queued-goal and writable-file ownership
checks all found zero owners. The private identity/hash rollback receipt confirms
unchanged native IDs, history bytes, account/home/settings and no SQLite edits.
The recovered session then received its single notice and acknowledgment on the
same existing pane and original thread, completed Chat and passed its writer
fence. This separate parent placement does not change the application; the
explicit-home CLI route above itself remains filesystem-change-free.

The stock send schema accepts optional `agentPrompt` only when true. Omitting an
unsupported false value repaired the retained-pane send before any notice was
sent, preserving the original one-shot intent.

The 2026-10-10 18:33 UTC snapshot used the original 256 MiB cap: one verified
pilot and 17 queued, including four running, with zero permission waits or
blocked sessions. The coordinator was busy and queued last. The private owner/progress receipt is
`oneoff-worker-progress-private.json` in the migration state directory. These
are activation-time counts; worker activation does not mean all 18 are migrated.

## Experiment corrections and recovery

An experimental QA controller asserted eight hook entries against an actual
nine-entry list, swallowed `AssertionError` as an empty error, exited zero and
left a stale eight-entry receipt. The earlier hook-hash-drift claim is withdrawn:
the original eight definitions match after Trust. The original `hooks.state`
inventory had zero entries; eight disabled fixture entries were synthetic.
No effective unrelated settings change is approved by those experiments.

The desktop-startup helper experiment in
[PR #239](https://github.com/hypermemetic-ai/qq-workflows/pull/239) is closed and
unmerged. It is not retained or activated for delivery. Earlier GUI startup
restored five old tabs and two Codex resumes with zero selected-session overlap;
those old records remain intact. No further upgrade or startup experiments are
part of this migration.

Completion requires the selected projects/workspaces to retain their files and
identity, every transferred session to use its original native thread and
verified settings, accepted recent Chat and the connected Android client.
Record partial transfers and running work explicitly.

If resume fails, preserve the native file and receipt. Confirm Orca's writer
stopped before returning that thread to Paseo. Restart, archive, deletion and
history conversion are not default recovery actions. Preserve old Paseo records
and native logs for separate archive-readability checks; files alone do not prove
old UI readability after a provider is removed.
