# Runner communication

Production components for communication between the workflow coordinator and a
runner worker's live Pi session: a shared runtime API
(`workflow/communication.mjs`), the production receiver loaded inside the
worker Pi (`workflow/communication-receiver.mjs`, carried through the existing
worker extension seam), three coordinator-authored model-facing tools, and the
adapter's validated enable/binding/settle/drain handshake. Phase 2b wires BOTH
runner entry points (`workflow/operations.mjs` and `bin/mcp-server.mjs`)
through the ONE shared runner lifecycle (`workflow/runner-lifecycle.mjs`) — see
"Phase 2b: the shared runner lifecycle" below. An absent binding preserves the
exact prior behavior; a launch without a verified receiver never pretends to
steer.

The change record stays the sole workflow authority. The relay journal is
delivery bookkeeping only: it can prove that a message was accepted, delivered,
and receipted, but never that a worker incorporated anything — only a committed
`worker.acknowledged` event does that.

## The binding (`QQ_WORKFLOW_COMMUNICATION`)

The parent passes ONE JSON environment variable to a runner launch:

```json
{
  "schema": "qq-worker-communication-binding/1",
  "stateDir": "/abs/change-state", "changeId": "…", "jobId": "…", "attemptId": "…",
  "actorId": "worker-…", "runtimeActorId": "runtime-…", "role": "runner",
  "recipientAgent": "agents/<workflow-consumer-uuid>",
  "socketPath": "/abs/state/relay/qq-relay.sock",
  "installRoot": "/abs/qq-relay", "drainMs": 8000
}
```

Validation is strict (`validateCommunicationBinding`): exact field allowlist,
absolute paths, change-record identifiers and actor ids, a job role, a
recipient of the form `agents/<bare-pi-session-uuid>`, and `drainMs` bounded to
`[0, 60000]` (default 8000). Absent or blank means communication is DISABLED.
A present but malformed binding throws `binding-invalid` — the adapter refuses
(exit 2) before any process is spawned; communication is never partially
enabled. `workerIsolationEnv` scrubs the variable so it can never be
inherited by a launch that did not explicitly opt in;
`buildPiWorkerLaunch` re-adds it deliberately. The adapter re-validates and
additionally refuses a binding whose role does not match the actual runner,
implementer, or reviewer seat (`binding_invalid_seat`), an attempt the record does not name
(`binding_attempt_unknown`), an attempt whose phase cannot be started
(`binding_attempt_not_launchable`), and a record that cannot be opened
(`binding_record_unavailable`) — all before any provider traffic.

Nothing in the binding is ever taken from a model, a filename, or the runtime's
own claims about itself. The `recipientAgent` field is the return direction
(coordinator-side consumer); the DELIVERY direction recipient is always derived
from the runtime's observed session id.

## Binding the observed session (`bindAttemptReceiver`)

After the runtime is up but before the prompt, the adapter reads the session id
from the runtime itself (`get_state`), requires a bare Pi session UUID
(`assertPiSessionId` — a `session-…` DSH alias is refused explicitly), and
records it against the EXACT started attempt by reusing the existing trusted
`attempt.started.payload.identity` field (no new event kind for binding):
`{ seat, piSession, recipient }` with `recipient = agents/<piSession>`. If the
attempt is already `started`, the recorded identity must match the observed
session exactly — a mismatch is a loud `binding-mismatch` refusal, never a
silent rebind. The deterministic command id is `started-<jobId>-<attemptId>`
(job-qualified because attempt ids are unique per job, while command ids are
unique per record), so a retry with the same observed session is a record
dedupe.

Delivery admission (`submitAmendment`) requires this recorded binding; an
unbound attempt refuses with `not-bound`.

## Closing receiver admission (`closeReceiverAdmission`)

The smallest change-record addition for the communication lifecycle is the new
event kind `attempt.admission_closed` (actor: runtime/operator; idempotent via
the deterministic command id `admission-closed-<jobId>-<attemptId>`). After
closure the reducer REFUSES `amendment.submitted` for that attempt, so a
submission that accepted delivery can never disappear as a successful delivery
of a closed attempt (race-order B). Acknowledgements and outcomes remain
recordable after closure: drain-delivered work may still be incorporated, and
the attempt's finished work may still be reported.

The adapter records the closure AFTER the first settle and BEFORE the drain
window. The closure is a record-level barrier only — the receiver keeps polling
during the drain, so deliveries admitted before the closure can still land.

## The owned relay runtime

`acquireRelayRuntime({ stateDir })` owns a PRIVATE relay child per workflow
state directory: the runtime dir `<stateDir>/relay` is created 0700, its whole
ancestor chain is checked against the relay's own placement fence
(group/other-writable ancestors require the sticky private-child fence), and a
violating placement is reported as the explicit `refused` — before any child is
spawned. A missing install (`QQ_RELAY_INSTALL_ROOT` or
`$HOME/.local/lib/qq/relay`) is the explicit `unavailable`, never a fallback to
a machine-wide service. Readiness is bounded (socket must answer the health
view); a live relay on our private directory that this process did not spawn is
adopted as a SHARED handle whose release never kills it; a dead socket inside
our private directory is unlinked and respawned (the sqlite journal survives,
so recorded obligations stay pending). `release()` drops one hold; the last
local hold stops an OWNED child with SIGTERM (bounded) and then SIGKILL only
when no other process or receiver holds it. The state directory and pending
obligations remain; a graceful exit removes the socket.

On Linux, kernel `flock` serializes acquisition and shutdown across processes.
Rebuildable holder files in private `<stateDir>/relay-runtime/` record PID,
process start ticks, and boot identity. They are transport bookkeeping, never
workflow authority. A bound Pi receiver holds the transport independently of
its parent. Provably dead holders are pruned; uncertain holders prevent
shutdown. If another process still uses an owned relay, release relinquishes
local ownership and leaves the relay available for subsequent shared reuse.
Shared handles never signal that relay, including after their last release.
A runtime-lock failure is explicit unavailable; it never implies delivery.
A live socket that cannot prove relay health is refused, not replaced.

## Delivery: `submitAmendment` and the distinct facts

`submitAmendment` records BEFORE it pushes, in this order:

1. `assignment.revised` — the new assignment revision, job-scoped (durable;
   deterministic command id `revise-<jobId>-r<revision>`);
2. `amendment.submitted` — the delivery obligation, targeted at the exact
   attempt (deterministic command id `submit-<amendmentId>`), committed BEFORE
   any push; the reducer refuses here when the admission is closed;
3. the transport push (`sendAgentMessage`) to the recipient recorded in the
   attempt's binding — with the coordinator-authored update text
   (`pushedUpdateText(revision)`) as the message body and the structured
   references (`change:…`, `job:…`, `attempt:…`, `amendment:…`, `revision:…`)
   as wire metadata, never inside the text.

Idempotency requires the caller-supplied `amendmentId`: the same id meeting an
already-recorded submission is an idempotent return that re-authors nothing and
re-pushes nothing (a second push would be a new relay event the receiver cannot
correlate). Concurrent coordinators race for the next revision number; a loser
recomputes under the record's writer lock (bounded retries), so a race is a
retry — never a corruption and never a lost amendment.

The return distinguishes facts that must never be conflated:

* `recorded` — the change record committed the revision and the submission;
* `delivery.status: "queued"` — the relay journal accepted the obligation;
* `"delivering"` / transport status `delivered` — a receiver claimed it and (for
  `delivered`) acknowledged after a durable Pi session receipt existed
  (RECEIPT evidence, never incorporation);
* `workerAcknowledged` — `worker.acknowledged` for the exact revision by the
  targeted attempt (incorporation);
* `refused` — the record refused the submission (e.g. admission closed
  concurrently); the authored revision stays in the record and nothing was
  pushed;
* `unavailable` — no relay runtime/transport failure; the amendment stays
  recorded and pending for retry.

`inspectAmendment` reports the layers separately: `layers.recorded`,
`layers.receiverReceiptObserved` (transport status `delivered`), and
`layers.workerAcknowledged`.

## The production receiver

`workflow/communication-receiver.mjs` carries the fixture's tested mechanics
unchanged (poll loop, `receiveOne` ordering, receipt matching, delivery guard,
injection options) with four declared production adaptations (P1–P4, documented
in the module header): identity from the binding with bare-UUID-only session
ids, no general-purpose send tool, fixture tools replaced by the production
tools below, and transport resolved from the binding's install root/socket —
never a machine-wide service. The receiver acknowledges a delivery only after
the injected message is durably observable in the Pi session, so a crash cannot
turn an unacknowledged delivery into a lost one (redelivery re-injects; the
deterministic command IDs make incorporation idempotent).

## The three model-facing tools

Registered ONLY on a validated, communication-enabled runner, with
coordinator-authored descriptions carried verbatim in
`COMMUNICATION_TOOL_DESCRIPTIONS`:

* `workflow_read_assignment` — bounded view of the current (or an exact)
  assignment revision with `offset`/`limit` (integer in `[1, 8192]`, default
  4096) pagination: `nextOffset`/`complete` in the details, pending amendment
  refs for THIS attempt (capped at 8) listed separately, and a page boundary is
  never silently reported as `complete` when the entry itself has missing
  continuation parts. Scope is enforced: a revision targeting another job
  refuses.
* `workflow_acknowledge_assignment` — `revision` is required (positive
  integer). Stale (not effective, not targeted, not already acknowledged),
  wrong-target, unknown, and inaccessible revisions refuse. The deterministic
  command IDs are `ack-<amendmentId>-rev<revision>` when an amendment targeted
  this revision at this attempt (any state, so retries resolve the same id),
  else `ack-rev<revision>` (the launch-revision acknowledgement case). Retries
  with identical meaning are record dedupes.
* `workflow_report_progress` — `kind` is `progress` or `blocker`; the message
  is a nonempty string of at most 8192 characters. The record commit happens
  FIRST (`worker.progress` / `worker.blocker`); the committed sequence is
  returned and the push status is reported SEPARATELY. An unavailable transport
  never erases the committed entry: the note stays retrievable and retryable
  through `buildProgressEnvelope` + `publishCommittedProgress` (whose body is
  the committed note verbatim; a sequence that was never committed cannot be
  published — no phantom progress). Sink failures are reported as
  `push: { status: "unavailable" }`; the sink interface is injectable so phase
  2b can reuse the parent's existing notification transport.

## The pushed-update message

When an amendment is pushed, the model receives exactly this text (never a
reconstruction):

> Assignment update available: revision [revision]. Read it with
> workflow_read_assignment, then acknowledge the exact revision after
> incorporating it.

The structured metadata (event/change/job/attempt/amendment ids, content hash)
rides in the message tasks and envelope details, separately from the text.

## The adapter handshake

For a communication-enabled runner the adapter:

1. validates the binding before spawning anything (refusals above);
2. appends `COMMUNICATION_TOOL_NAMES` to the seat's tool allowlist and the
   coordinator-authored `COMMUNICATION_ROLE_PARAGRAPH` verbatim to the seat
   instructions (recorded as `communicationRoleParagraph: true` in the
   summary); the shared contract's tool vocabulary resolves the three names
   (`PI_WORKER_TOOL_EQUIVALENTS`), so a reference on a non-communication
   launch still refuses;
3. binds the observed session after `get_state` (before the prompt);
4. waits for the first settle with the same semantics as before (exit-before-
   settle still classifies honestly), then closes the admission and runs the
   bounded drain window;
5. during the drain, an idle injection that starts another agent run postpones
   final-result selection until THAT run settles — the pre-injection final
   message is never reported as the outcome of the updated assignment; a drain
   window that ends while an injected turn is still in flight refuses honestly
   (`drain_turn_interrupted`, exit 1) instead of reporting stale text as
   success, and the still-pending amendment stays pending in the record;
6. leaves cancellation unchanged: signals record intent first and abort the
   owned process; closure and drain can never turn a cancellation into success.

## Where the proofs live

* `tests/worker-communication.mjs` — offline acceptance: binding matrix,
  record integration (binding/closure/race-order B), tool semantics, adapter
  refusals and the drain handshake against the fake runtime, worker isolation,
  and (when a relay is installed) the owned runtime lifecycle and the delivery
  pipeline, including a multi-process submission/closure race.
* `tests/worker-communication-live.mjs` — the live proof: real pi + the real
  production adapter and extension + a real temporary relay + a deterministic
  localhost provider, with a mid-turn amendment submitted by the coordinator,
  acknowledged by the model, and the return-direction progress push consumed by
  a test-side architect consumer. Skips honestly when pi or the relay is
  absent.
* `tests/relay-receiver-units.mjs` and `tests/pi-relay-receiver.mjs` — the
  receiver mechanics this module reuses (offline units and the real-Pi fixture
  proof, which stays green).

## Phase 2b: the shared runner lifecycle

`workflow/runner-lifecycle.mjs` is the ONE integration layer both runner entry
points use, so record creation, launch/attempt transitions, binding
preparation, amendment composition/submission, status projection, cancellation
intent, result validation/outcome and progress recovery are never implemented
twice. Caller-specific concerns stay adapters: argument names
(`jobId`/`message` native vs `runnerId`/`instruction` MCP), live process
handles, public ids and the notification transport.

### Source of truth and rebuild rules

* The **change record** is the SOLE workflow authority for a dispatched runner
  job: assignment revisions and their raw instructions, amendment submissions,
  transport-push correlation (`amendment.pushed`), worker acknowledgements,
  cancellation intent, receiver admission and validated outcomes. For a newly
  dispatched Pi runner the record follows the DIRECT LOOKUP convention: one
  change record whose `changeId` is the public runner/job id, `jobId` the same
  id, and a fresh attempt UUID per dispatch. This is a lookup convenience, not
  a second authority — every shared API keeps the full multi-job/multi-attempt
  record shape. The record preserves the original task and target constraints
  verbatim (revision 1 IS the exact prompt text) plus launch context (cwd,
  owner/session routing, target paths) on `attempt.launch_intent`.
* The **relay journal** is subordinate durable TRANSPORT bookkeeping: it can
  prove an envelope was accepted (`queued`), delivered/receipted (`delivered`),
  retried or blocked — never that a worker incorporated anything.
* **jobs.json records and MCP RUNNERS trackers** hold live handles or
  REBUILDABLE compatibility projections (identity, live process handles, push
  event-id correlation). They never decide a job's status, cancellation,
  effective revision or terminal outcome: `check_runner`'s communication
  projection (`runnerCommunicationView`) is rebuilt from the authoritative
  record on every read, and the shared recovery (`reconcileRunnerJob`) mirrors a
  settled terminal state INTO the change record — a stale compatibility cache
  can never override it, and reload recovery ingests any explicit, job-bound
  result before a lost process is interpreted (communication-enabled jobs
  included). There is no bulk history migration: existing old jobs stay
  readable and cancellable exactly as before.
* The outcome is pinned to the revision the attempt actually worked against
  (last acknowledged revision, else the job's pin). A completed outcome for
  revision A stays a result for A when a later update B was never acknowledged —
  never silently re-pinned, and B stays visible as a pending/unresolved update
  (bounded references) after terminal completion.

### The workflow consumer address (parent-side relay recipient)

The parent-side recipient is a WORKFLOW CONSUMER address
(`workflowConsumerAddress`): a deterministic UUID-form transport address
derived from the repository root and the coordinator's actual owner routing
(the workflow session key / owner session id). It is scoped to repository +
owner, independent of worker Pi session ids and parent PIDs, and is NEVER named
or asserted as an observed Pi session — MCP coordinators are Codex sessions and
a native coordinator's session identity is not a Pi session either. A restarted
parent for the same owner derives the same address (no identity database); an
unrelated owner derives a different address and never consumes another owner's
obligations. With no owner identity the address falls back to a per-process
(unrecoverable-by-design) form and says so.

One owned relay runtime and one progress consumer serve every runner of the
same parent/owner, shared and REFERENCE-COUNTED: releasing one worker never
destroys another worker's transport or pending messages; the last hold drains
bounded and releases (pending journal obligations survive). Concurrent
acquisitions of the same consumer COALESCE onto one creation (one relay
runtime, one consumer, one prime) instead of racing. The consumer
subscription is established BEFORE any worker is spawned (journal obligations
need a live consumer). Every call registers a PER-JOB route (jobId ->
transport/session routing), and each outgoing notification selects its route
from the VERIFIED notification's job id — a second runner's progress is never
delivered through whichever dispatch closure created the shared consumer
first. Private shared-runtime adoption stays scoped and
ownership-checked; there is no global service discovery or installation, and no
user-facing polling loop or general worker-messaging tool.

### Progress bridging and the acknowledgement layers

Every incoming progress/blocker envelope is verified against the authoritative
record before anything is surfaced (source job/attempt/binding, committed
sequence, committed note verbatim, project slug); the outgoing notification is
REBUILT from the committed note with the exact coordinator-authored wrapper —
transport text and transport tasks are never authority, and forged or
uncommitted payloads are blocked on the journal (no phantom progress):

    Runner [jobId] reported [kind] at sequence [seq] (attempt [attemptId]):
    [committed message]

Notification ids are deterministic (`runner:<jobId>:progress:<changeId>:<attemptId>:<seq>`),
so repeated relay delivery and parent restarts never duplicate an
already-receipted progress notification. The layers, each a distinct fact:

1. **transport/journal receipt** — the relay obligation was acknowledged;
2. **durable notification acceptance** — the existing notification system's
   journal record was written (the relay obligation is acknowledged only AFTER
   this);
3. **the Architect acting on it** — NOT implied by either layer.

A transport failure keeps the obligation retryable (pending work is never
deleted) and recovery rides the existing notification recovery/lifecycle hooks
(no new orchestrator). Where no active Architect transport exists, progress
stays committed and inspectable in the record and is reported as
pending/unavailable — never as delivered.

### Assignment updates (amendments)

`steer_runner` arguments mean an ADDITIONAL instruction. The full new
assignment is composed from the original task + target constraints verbatim and
the ordered amendments' verbatim text (never summarized, never replaced by the
latest message, never concatenated onto an obsolete revision), under the exact
heading and precedence copy:

    ## Assignment updates
    Apply these updates in revision order. A later update takes precedence where it conflicts with an earlier instruction.

Requested updates are PERSISTED before any delivery attempt, with stable
transport request identities (`push-req-<jobId>-<attemptId>-<amendmentId>-<n>`)
and durable push correlation (`amendment.pushed`) so a lost send reply, an
acknowledgement loss or a parent restart can be inspected and safely retried
(`retryPendingRunnerAmendments`) without re-recording, without duplicating a
live obligation, and without relaunching a worker. Before the receiver binding
is observed an update is refused with a clear retryable reason and nothing is
claimed as recorded; after admission closes or the attempt is terminal, a
recorded request stays visible as unresolved and the call returns a refusal
with the reason. Results always distinguish recording, transport receipt and
worker acknowledgement; `delivered:true`/`steered:true` is never returned from
a write or send that merely did not throw.

Worker incorporation command IDs are scoped to job+attempt(+amendment/revision)
(`ack-<jobId>-<attemptId>[-<amendmentId>]-rev<revision>`): global revision
numbering does not make a shared pinned revision unique across jobs or
attempts. Retries with identical meaning are record dedupes (exactly-once
incorporation). Receiver acknowledgement stays a trusted runtime-scoped action;
model arguments never choose routing or actor identity.

### Cancellation, outcomes, and legacy runners

Cancellation records intent in the authoritative record BEFORE the
fingerprint-matched owned process is signalled; a cancelled attempt can never
become a success from later output. The AUTHORITATIVE record decides first on
BOTH surfaces: an already-validated outcome (completed/failed/cancelled) is
never overwritten by a cancellation, its process is never signalled, and the
call reports the validated outcome truthfully; a refused or unavailable record
(a corruption, a lost append, a lost race against a validated success) fails
safely — no cache tombstone, no signal, and no claimed cancellation. A
launched-but-unbound setup failure reaches an honest terminal FAILURE in the
record (a completion requires an observed start), and dispatch failures
release exactly what was acquired. A new Pi runner is never silently
downgraded to legacy steering when communication setup fails.

Discovered process loss (a reload finding no process and no managed result) is
outcome-UNKNOWN: the top level reports `interrupted`, `attempt.outcome` stays
null, and obligations/pending updates remain inspectable — a known FAILED
outcome is never invented from disappearance. An unexpected SIGTERM/SIGINT is
never reported as cancellation (that would fabricate operator intent): with a
recorded intent it is a cancellation; without one it falls through to the
validated explicit-result check and the honest failure verdict with the signal
reported. A communication-enabled runner's result comes only from the
validated explicit transport (identity/attempt bound) or the existing
authority — arbitrary final stdout is never promoted into workflow truth.

### Restart recovery and report retrieval

`check_runner`'s top-level status is RECONSTRUCTED from the authoritative
outcome (a stale running/completed cache is rebuilt from the record — both
directions). On both surfaces a restarted coordinator rebuilds a known runner
from durable state instead of the lost in-memory map: the jobs.json
compatibility projection (identity, owner routing, result transport, owned
process fingerprint) plus the change record (validated outcome, report
reference, launch context) — a missing projection is rebuilt from the record
alone. Both surfaces retrieve durable reports through normal tools (native
`read_report`; MCP `read_report` backed by `workflow/reports.mjs` with bounded
pagination and the terminal `reportId` exposed by `check_runner`, never the
findings themselves), including from a cold process.

Legacy/non-enabled runners have no verified receiver: `steer_runner` returns an
explicit unsupported/refused result with the reason and writes nothing to any
ignored stdin (the refusal is kept in job history/trajectory so historical
check results identify communication unsupported). Existing cancellation,
report retrieval and all other legacy lifecycle behavior are unchanged.
