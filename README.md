# `@hypermemetic-ai/qq-workflows`

One repository, one plugin, one version. Named qq workflows live here.
Loading this plugin is how a DSH host gets architect, iterate, and find. The
host binds the plugin when present and runs without it.

A new session has no workflow until the operator picks one with `/workflows`.
The wrapper only selects which registered workflow this chair is running, if
any. It does not own a workflow's store, stitch, or config schema. Sibling
plugins can reversibly join the live registry through
`service.workflows.register(spec)`; the sibling continues to own all workflow
behavior and state.

There is no `run_workflow(name)` dispatcher. Each workflow registers its own
tools. Do not use DSH's model-written workflow tool as the dispatcher. Do not
port Pi delegate / review / land.

Architect and iterate do not share a session. Two methodologies, two chairs.
Architect does not invoke iterate.

## Selection

`/workflows` lists loaded workflow plugins and marks the one selected on this
session. `/workflows architect` attaches architect. `/workflows iterate`
attaches iterate. `/workflows find` attaches find (image-finder sitting).
`/workflows none` (or `off`) clears the selection. `/workflows settings` asks
the selected workflow for its roles; `/workflows settings architect scribe …`
and `/workflows settings iterate desk …` write those roles. Find has no roles.

Selection is per DSH session, restart-safe, default none. One file per session
beside `DSH_HOME` (`config.selectionDir` overrides), mode `0600`. A child
(`origin: subagent`) is never selected as architect, iterate, or find.
Empty `/find` still arms or leaves; it also selects or clears this workflow.

A persisted selection remains visible through `workflows.selected(sessionId)`
when its sibling plugin is absent. It then appears in `/workflows` as
`<name> (selected, unbound)`, attaches nothing, and paints no UI mode chip.
`/workflows none` clears it. Re-registering the sibling immediately restores
its workflow on matching live candidate chairs.

### Sibling registration

Call `workflows.register(spec)` with the six stable fields: `name`,
`candidate(agent)`, idempotent
`ensureAttached(agent)` and `ensureDetached(agentOrId)`, `listSettings()`, and
`writeSettings(role, binding)`. The wrapper validates those fields and keeps a
frozen snapshot. Names must match `/^[a-z][a-z0-9-]{0,31}$/`; `none`, `off`,
`settings`, `architect`, `iterate`, and `find` are reserved. Duplicate live
owners are refused.

Registration returns an idempotent disposer. Disposal detaches the sibling
workflow and removes its live name without erasing durable selection, so a
later registration can reclaim it. The sibling's attach/detach methods own any
`workflows:<name>` relay label; this wrapper does not hang or clear relay labels
for registered siblings. A workflow with no roles conventionally returns
`<name> has no roles` from `listSettings()` and rejects settings writes.

## Architect

Noun and verb. One live card (the current concern). No park. Two live objects
are two sessions, or replace.

Selecting architect attaches notebook, clerk, fold, and tools, and hangs
`workflows:architect` via qq-relay if that service is loaded; selecting
something else or none detaches and clears the hang. Relay does not interpret
the label. Architect works without relay except invoke-result delivery.

Role bindings live in the declared absolute `settingsFile`. Missing or
relative path, or a missing file, is unbound. The wrapper does not read or
write `~/.config/qq/execution-profiles.json`. Architect roles are
talking/scribe; iterate roles are desk/hands/reviewer. Both workflows share
the same attach `settingsFile`; writes touch only their own section.

### Notebook

Workflow-owned store beside `DSH_HOME` (`config.notebookDir` overrides), keyed
to the DSH session id. Mode `0600`, atomic write. Restart does not lose notes.

Card: `{ name, open, notes[], stubs[] }`. Exactly one open card. Notes are
`{ text, startSeq, endSeq }` — short, append-only, citations are DSH seqs.
Supersede by appending a withdraw line. The DSH log is authority.

### Clerk

Off the talking model. After `turn/end` of an operator+architect pair. Never
on send. Never after every tool. Host / land / relay injects that are not
operator talk are skipped.

Each fire reads the whole notebook plus a model-free spine of the new turn
(seq, speaker, tool names, sizes, short extract of user text). Output: append
one note, append a withdraw line, or append nothing. Uses the architect
`scribe` role from `settingsFile` when bound; unbound clerk no-ops. One-shot
via a fresh `sessionId` on each call (DSH `GenerateOptions` has no
`cacheRetention` field).

### Lookup tools

- `notes_list` — the notebook. Cheap.
- `notes_expand` — `ctx.sessionQuery.readEvent` on the cited seqs; fallback to
  the live session log.
- `session_search` — only when nothing in the notes names the thing. Wraps
  `searchEvents` when present.

The talking prompt appends. It does not paste the notebook, a map, or a
standing "read the notes" instruction.

### Rundown

Architect-owned talking tool. This package does not import `qq-tasks`.
At tool-register time, if `ctx.get("qq-tasks")` is present and the chair is
architect, `rundown` registers. Absent: no tool, architect still works.

`rundown` execute calls the tasks service. Tasks runs a one-shot model job
on its own `rundown` role (`provider`, `model`, `effort` on that plugin's
absolute `settingsFile`) and returns a report: what is on the pile, when it
landed, what looks stale, what contradicts. Not a raw file listing. Not a
judgment. Missing path, missing file, or empty role: the tool refuses. Do
not reuse architect `scribe`. Do not write `execution-profiles.json`.

### Fold

After the turn, after clerk. Decision off-session. Apply at the next request
assemble. Never mid-turn. Never block send. Clerk late → skip this turn.

Drop Old when `Old >= ((1-h)/h) * Tail`. Default `h = 0.1`. Keep at least two
operator+architect pairs. Snap to turn boundaries. Never split a pair. Never
drop the latest pair.

Quality ceiling `Q = 256000` tokens of the talking blob. Grok uses `200000`.
When a prefix leaves the talking prompt, the notes whose citations fall in
that span freeze once as the stand-in. Later withdraw lines stay in the store
and do not rewrite the stub.

Durable omit is a plugin-source user message with `surfaceOp: replace` on the
dropped surface range, carrying the frozen stub. This plugin does not call
`ctx.compaction` and does not run compact-basic's summarizer.

`compact-basic` is `auto: false` on the qq profile. Fat tool dumps are
chopped at the next `agent/request` assemble via the existing tool-result
pruner (not from a `session/event` observer — DSH rejects reentrant append).
If the open tail alone cannot fit after chop: fail visibly. Do not auto-essay.

### Invoke

Talking tool: invoke, keep talking. The talking model does not compile the
packet. Off-session clerk/scribe reads the notebook plus the DSH log (text +
tool names; no reasoning, no dumps) and writes the packet. Starts a live DSH
child session in this host and seeds it with the packet. The packet carries
the parent session id and alias as the return address. Alias comes from
qq-relay if loaded. When the child turn ends, the last assistant text is
sent back through `qq-relay.send` with `default` steer. If relay is not
loaded, invoke is refused.

### Leftover offer

After clerk, a hop reads the live card. Obviously unfinished leftovers bank
silently when qq-tasks is loaded. Ambiguous-or-better leftovers compile the
same packet invoke uses and offer hand off, bank, or ignore on the phone.
The talking turn is not held. Missing qq-tasks refuses bank and still offers
hand off and ignore. Spawn / Stay are not in this land.

## Iterate

A desk, not a conversation someone else notes. The operator talks in turns.
The intake (talking) model extracts what it heard — nits, praise, theory,
directive — shows the receipt, and sits. When the operator says go, this
breath's nits go out together to one fresh hands session.

Selecting iterate attaches the journal, wiki, and desk tools, and hangs
`workflows:iterate` via qq-relay if that service is loaded; selecting something
else or none detaches and clears the hang. Relay does not interpret the
label. No pixel tools register on the desk.

### Collect, then go

Requirements arrive in turns. Each turn extracts and shows. Nothing is sent
to hands until the operator says go (`implement` / `go ahead` / same idea).
The receipt is what the desk heard; the next turn can correct it. Ambiguous
input is still recorded as heard.

When go fires, this breath's nits bundle into one fresh hands session — the
desk tools, plus the existing frontend-design-loop fixtures. One live hands
at a time; next go is a new child, not a continuation. Praise-only or a keep
does not send work. Go is refused when qq-relay is not loaded or the reviewer
role is unbound.

### Journal

Workflow-owned store keyed to the DSH session, beside `DSH_HOME`
(`config.journalDir` overrides), mode `0600`, atomic write, restart-safe.
Not a second transcript; DSH log is authority.

Four objects: directive (one living sentence), nit / praise (same object,
polarity flipped, cited by DSH seq), theory (one living paragraph, rare),
and open/closed on nits. Append-only; supersede by appending. A nit closes
when its hands passed review or the operator takes it back.

Every desk turn assembles a stable projection in one order — directive,
theory, open nits / praise, selected wiki index. New items append; the
prefix never reshuffles. Intake writes through tools. The receipt is short.

### Hands, reviewer, wiki

Hands is a fresh DSH child (`origin: subagent`) seeded with a packet compiled
off the talking session: this breath's nits, the directive, the theory, the
keep-outs (praise), and only the selected wiki nodes. The kind pack is the
frontend-design-loop tools plus `qq-ui` presentation write access. One inner
cycle: orient once, change → shoot → maybe one fix, deliver.

Reviewer is an independent one-shot judge on the same journal the desk has.
The hop is given the shots listing and the patch-surface diff, not just the
hands report. Pass honors the directive, does not break praise, and actually
answers the nits. Fail comes back as mail and sits. No silent retry, no
automatic second hands. Reviewer writes nothing.

Passed hands dumps unstructured wiki nodes (no taxonomy). The desk files them
with labels it invents; merging two labels is writing one string. Nodes stay
unlabeled until filed. Next hands never get the whole wiki: the desk
projection carries a cheap index, and the packet carries only the selected
full nodes. Missable on purpose.

## Out of this land

research / implementation / judgment as products, Impulse UI, a daemon or
second transcript, DSH auto-compact / compact-basic summarizer, beats-as-
chapters, live notebook rewrite, every-turn notebook paste, pinning the
phone, titles as handles, Pi agent-messages; for iterate also: a second
workflow repo or process, pixel tools on the desk, a one-nit queue,
unattended score loops, silent retry, hosting the desk or sharing the chair
with architect, whole-wiki dump into hands, the wiki as T-67 pages, a
worktree per nit.

## Validation

```bash
node tests/test-qq-workflows-plugin.mjs .
node tests/test-session-prompt.mjs
tests/test-qq-workflows-boot.sh
node tests/test-qq-tasks.mjs .
tests/test-qq-tasks-boot.sh
```
