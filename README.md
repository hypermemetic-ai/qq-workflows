# `@hypermemetic-ai/qq-workflows`

One repository, one plugin, one version. Named qq workflows live here.
Loading this plugin is how a DSH host gets architect (and later research /
implementation / judgment). Loading qq does not imply workflows.

There is no `run_workflow(name)` dispatcher. Each workflow registers its own
tools. Do not use DSH's model-written workflow tool as the dispatcher. Do not
port Pi delegate / review / land.

## Architect

Noun and verb. One live card (the current concern). No park. Two live objects
are two sessions, or replace.

On attach, hang `workflows:architect` on the live session via qq-relay if that
service is loaded; clear on detach. Relay does not interpret the label.
Architect works without relay except invoke-result delivery.

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
one note, append a withdraw line, or append nothing. Uses the existing
`scribe` execution-profile binding. One-shot. `cacheRetention: none`.

### Lookup tools

- `notes_list` — the notebook. Cheap.
- `notes_expand` — `ctx.sessionQuery.readEvent` on the cited seqs; fallback to
  the live session log.
- `session_search` — only when nothing in the notes names the thing. Wraps
  `searchEvents` when present.

The talking prompt appends. It does not paste the notebook, a map, or a
standing "read the notes" instruction.

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

`compact-basic` is `auto: false` on the qq-console profile. Fat tool dumps are
chopped when they land via the existing tool-result pruner. If the open tail
alone cannot fit after chop: fail visibly. Do not auto-essay.

### Invoke

Talking tool: invoke, keep talking. The talking model does not compile the
packet. Off-session clerk/scribe reads the notebook plus the DSH log (text +
tool names; no reasoning, no dumps) and writes the packet. Starts a live DSH
child session in this host and seeds it with the packet. Alias comes from
qq-relay if loaded. Results come back through qq-relay (`default` steer). If
relay is not loaded, invoke is refused.

Bank / Spawn / Stay are not in this land.

## Out of this land

research / implementation / judgment as products, Impulse UI, a daemon or
second transcript, DSH auto-compact / compact-basic summarizer, beats-as-
chapters, live notebook rewrite, every-turn notebook paste, pinning the
phone, titles as handles, Pi agent-messages.

## Validation

```bash
node tests/test-qq-workflows-plugin.mjs .
tests/test-qq-workflows-boot.sh
```
