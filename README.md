# qq-workflows

`qq-workflows` is the host for named DSH chairs and durable delegated work. It
ships the `architect`, `find`, and `base` chairs, accepts additional chairs such
as media through `workflows.register`, and accepts additional delegation kinds
through that same registry. `projects` remains an implicit cwd-based chair.
`land` is a tool and final git verb, not a selectable chair or a workflow
machine.

## Chairs and delegations

Chairs are selected with `/workflows`. Delegations are addressed by one durable
UUID and have at most one current physical child session. The host ships:

- `delegate({ kind: "implementation" })`: isolated worktree, `mini-code`,
  `mini-qa`, one optional second `mini-code`/`mini-qa` pass, then land;
- `delegate({ kind: "research" })`: evidence capsule, `mini-research`,
  `mini-qa`, then an automatic report with no git landing; and
- the adopted `docs` contract: qq-wiki registers and autonomously drives a
  hosted `mini-docs` inner pass while retaining ownership of outer publication.
  Docs is not a `/workflows` chair.

An adopted delegation plugin registers `{ kind, invoke, status, send, stop }`
with `service.workflows.register`. It may additionally provide ownership,
resume/release, and settings hooks. `service.workflows.kinds()` lists delegation
kinds independently from chair names.

The architect exposes one spawn tool, `delegate({ kind })`. The former separate
research tool does not exist. Every kind is controlled through the same UUID
surface:

- `workflow_status(delegationId)` returns kind, state, current immutable session
  UUID, role, phase epoch, and kind-specific workspace data;
- `workflow_send(...)` steers only the exact current owned live session, with
  optional stale-role and stale-epoch guards; and
- `workflow_stop(...)` terminalizes the durable delegation and stops its child.

Session aliases are display-only and are never relay identities.

## Working memory

Working memory is the architect's only durable plan document and the exact
source of every delegation packet. The architect prompt requires `case_write`
after every operator message that materially changes the plan, before replying.
A generated empty document says that it is empty; a heading alone is also empty.
Delegation refuses empty working memory.

Fold retains the current and previous operator/architect pairs. It may replace
older history only when working memory is non-empty. If memory is empty, fold
fails visibly rather than claiming unwritten conversation is authoritative.

## Bindings

The host has exactly three model bindings:

- `architecture` for the architect chair;
- `implementation` for `mini-code`, `mini-research`, and worker-like adopted
  children; and
- `qa` for `mini-qa`.

Legacy settings are read only to migrate useful model choices. The dead router
is ignored. The next host settings write persists only these three bindings and
removes old built-in sections while preserving adopted-plugin settings.

## Implementation QA and land

`done` is the implementation child's submission command. Every accepted `done`
compiles a bounded proposal packet and starts `mini-qa`; there is no paint skip,
router model hop, or evidence stamp. A first QA failure starts a fresh
`mini-code` child on the same implementation binding. A second QA failure blocks
the delegation. Public phase roles are only `implementation` and `qa`; look
count remains internal.

After QA passes, the host performs the final `land` verb:

1. recheck clean main and delegated worktrees plus generated-path guards;
2. push the exact reviewed proposal commit;
3. open a pull request against `main`;
4. merge it with a merge commit;
5. fetch and fast-forward local `main`; and
6. remove the capsule/worktree and local proposal branch.

The chair `land` tool is only a fallback for an existing linked worktree or a
retry of a QA-passed but unlanded delegation. It never bypasses QA for a new
submission. Failures retain the capsule for diagnosis or retry.

## Mini adapters

- `mini-code` is the implementation preset. The old preset names are recognized
  only when resuming legacy live children.
- `mini-qa` is a read-only fresh-context reviewer with wrapped bash and
  `submit_review`.
- `mini-research` intercepts standalone evidence acquisition commands inside a
  private capsule. Search leads are not evidence until materialized.
- `mini-docs` is an inner adapter exported for an adopted docs controller. It no
  longer exports a standalone Cordis `apply`; qq-wiki must register and drive
  docs through the host.
