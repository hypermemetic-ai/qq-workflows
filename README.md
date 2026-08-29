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
  `mini-qa`, one optional second `mini-code`/`mini-qa` pass, then land; and
- `delegate({ kind: "research" })`: evidence capsule, `mini-research`,
  `mini-qa`, then an automatic report with no git landing.

An adopted delegation plugin registers `{ kind, invoke, status, send, stop }`
with `service.workflows.register`. It may additionally provide durable
`resume`, live-child ownership/release, and settings hooks. `service.workflows.kinds()` lists delegation
kinds independently from chair names.

The architect exposes one spawn tool, `delegate({ kind })`, for the two shipped
kinds: `implementation` and `research`. The former separate research tool does
not exist. Durable delegations are controlled through the same UUID surface:

- `workflow_status(delegationId)` returns kind, state, current immutable session
  UUID, role, phase epoch, and kind-specific workspace data;
- `workflow_send(...)` steers only the exact current owned live session, with
  optional stale-role and stale-epoch guards;
- `workflow_resume(delegationId, expectedRole?, expectedEpoch?)` re-adopts an
  already-live exact child or resumes the durable current DSH session UUID with
  its preserved transcript/worktree and a deterministic recovery continuation;
  it never accepts or creates a replacement physical session UUID; and
- `workflow_stop(...)` terminalizes the durable delegation and stops its child.

Session aliases are display-only and are never relay identities.

## Live chair snapshots

`service.workflows.snapshots()` is a synchronous, side-effect-free batch read for
in-process consumers such as qq-dashboard. It returns one row for every live
top-level agent and excludes child/subagent sessions:

```js
{
  sessionUuid,                       // stable DSH session UUID
  workflow,                          // string or null
  phase,                             // planning | plan | work | none | unknown
  phaseStartedAt,                    // epoch milliseconds or null
}
```

An unselected chair is `workflow: null`, `phase: "none"`; a selected
non-architect workflow (including the implicit `projects` chair) is `unknown`.
An architect is `planning` while working memory is empty, `plan` while it is
non-empty, and `work` while any built-in implementation or research delegation
is nonterminal. Implementation, research, QA, revision, and landing states all
remain `work`; landed, blocked, and completed records do not. Concurrent runs
keep the chair in `work` until the final active run terminates.

`phaseStartedAt` is backed by an atomic mode-0600 per-parent semantic phase
ledger. Selection, case, and built-in delegation mutations update it, while
`snapshots()` only reads and never creates cases, attaches workflows, or rewrites
state. Same-phase edits and implementation/QA transitions retain the timestamp,
including across plugin replacement. `none` and `unknown` have no semantic start
and always report `null`.

Adopted delegation kinds are not inferred from labels, aliases, case prose, or
`status()` calls. They may opt into architect `work` projection with a
synchronous, side-effect-free
`activeProjection({ parentSessionUuid })`, returning either `true` or `{ active: boolean, phaseStartedAt?: number }`.
An inactive timestamp can authoritatively date the return to `plan/planning`;
without that parent-scoped interface adopted kinds do not affect the chair
phase.

## Working memory

Working memory is the architect's only durable plan document and the exact
semantic source of each delegation task and task artifact. The architect prompt requires `case_write`
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

Implementation children edit a metadata-free workspace beside a host-owned Git
capsule. Their session is pinned to DSH `workspace-write` with approval `never`,
and every Bash command is additionally executed by bubblewrap with only that
workspace writable, ambient credentials cleared, and networking unshared. The
host refuses adoption/recovery unless `sandboxPolicy`, the sandboxed shell, and
the sandbox provider resolve full enforcement for the immutable child cwd.
This is intentionally stronger than DSH file policy alone: DSH documents that
its file sandbox does not restrict network, so qq-workflows also requires a
working bubblewrap network namespace and fails closed without it.

`run_tests` is an implementation-only host capability for the configured suite
(`npm test` by default). It stages ordinary workspace files into the host
capsule, fingerprints the exact commit-eligible tree before and after the suite,
and records bounded output and exit status. A pass is reusable only for the
same tree. `done` invokes that same capability when matching evidence is absent;
a failure leaves implementation live without a commit or QA transition. After
a pass, the host stages and commits—children never write refs or objects.

Before QA, `done` fetches actual `origin/main`. A candidate already contained by
main is rejected as pre-landed. Ordinary parallel main/candidate divergence is
normal: the delegated ancestry base is retained and the bounded proposal packet
uses its triple-dot delta; PR integration remains host-owned. `mini-qa` receives
the exact candidate and test evidence, has no `run_tests`, and keeps its single
Bash tool under DSH `read-only`, approval `never`, cleared credentials, and the
same no-network namespace. QA submits only a verdict. A first QA failure starts
a fresh `mini-code` revision and invalidates old test evidence; a second failure
blocks the delegation. Public phase roles remain `implementation` and `qa`.

After QA passes, the host performs the final `land` verb:

1. recheck clean main/capsule state, ancestry, non-empty delta, and generated paths;
2. push a full candidate SHA to the explicit full heads ref;
3. independently fetch and require the exact remote OID and commit type;
4. resume an existing exact-head PR (including an already merged one) or create
   one explicitly against the origin repository;
5. merge with a head-OID match, verify candidate ancestry on origin, and
   fast-forward local main; and
6. only then remove the workspace/capsule and local diagnostic refs.

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
- `mini-docs` is a host-mounted writer adapter. It has no standalone Cordis
  `apply`; this plugin mounts it from the agent header.

## Packet and artifact lifecycle

Working memory remains semantic task content. Delegation UUIDs, parent/child
session UUIDs, epochs, aliases, and automatic-return notices live in child
headers and durable workflow records; they are not prefixed to working memory,
used for branch slugging, or shown to code/research/QA roles that cannot act on
them. Architects communicate with other architects through relay, never
directly with another architect's children. An architect may communicate with
its own children through the workflow-owned status/send/stop tools.

The first `mini-code` child receives the exact implementation task once. The
host also writes those bytes beneath the sibling capsule's private Git metadata,
with byte count and SHA-256 metadata, and gives children an absolute read-only
pointer. Before every fresh QA or revision handoff, the host rewrites the
artifact from active durable state and verifies its bytes and digest; child
workspaces contain no `.git` entry and cannot poison later context. New handoffs contain
only the artifact pointer/digest, a bounded proposal summary, and a bounded
phase delta. Artifact-backed terminal records drop their duplicate durable
`brief`; blocked worktrees retain the artifact for diagnosis.

Proposal packets never copy a new task into `packet.brief`. They keep at most 24
changed-file previews and 8 hunk pointers; every rendered path/pointer is at
most 240 characters, packet formatting is at most 12,000 characters, and
omitted-file counts/markers are explicit. Phase deltas are at most 4,000
characters and implementation outcomes at most 16,000. Terminal reports contain
status, ref, bounded change summary, QA verdict, and useful diagnostics—not the
original task or session-routing boilerplate. QA tool results remain compact.

Pending implementation phases are crash-safe structured
`qq.delegation-phase-input/v1` records. Legacy records with a pre-rendered
`pendingPhase.message` are never lossily migrated or re-rendered: retries replay
those exact bytes. Legacy packets/briefs remain readable. Canonical v2
implementation IDs are their filenames, so UUID lookup is direct. Dashboard
activity maps retain only `{ id, parentSessionUuid, status }` projections rather
than complete tasks and packets.

Research capsules are the exact-data interface: the initial child reads
`question.md`, and fresh review reads `question.md`, `answer.md`, and
`evidence/manifest.jsonl` rather than receiving copies in its prompt. Answer and
manifest digests are checked across review. Small answers are inlined in the
final report; large answers return a clearly labelled bounded preview plus the
immutable path, UTF-8 byte size, and SHA-256. The complete report is capped at
12,000 characters. Successful research and review children are disposed only
after their respective durable tool result settles; the review additionally
waits for report delivery. Completed-but-unreported reviews remain recoverable.

Reusable Mini behavior still follows the upstream-compatible instance-template
shape. Static role rules remain in those templates because moving them wholesale
into the one-line persona can change Mini format-recovery and provider behavior;
this is the intentional prompt-compatibility tradeoff. Dynamic task/artifact
content is now separate and bounded, which removes the high-impact repeated
prefix data even where the static template is retained.

Before creating a pull request, Land resolves and type-checks the local candidate
as a commit, imports and pushes its full immutable OID to an explicit full heads
ref, exact-queries and fetches that remote ref into a diagnostic evidence ref,
and requires matching OID and commit type. Any missing, ambiguous, mismatched,
or non-commit publication fails before GitHub or cleanup and preserves the local
ref/worktree evidence. GitHub commands are bound to the repository selected from
`origin`; an existing open PR is reused only when base, head branch, and head OID
all match. After ambiguous create errors (including a 504), Land checks for that
exact PR before deciding whether a retry is safe.
