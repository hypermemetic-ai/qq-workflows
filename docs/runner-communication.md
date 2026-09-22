# Runner communication (phase 2a)

Production components for communication between the workflow coordinator and a
runner worker's live Pi session: a shared runtime API
(`workflow/communication.mjs`), the production receiver loaded inside the
worker Pi (`workflow/communication-receiver.mjs`, carried through the existing
worker extension seam), three coordinator-authored model-facing tools, and the
adapter's validated enable/binding/settle/drain handshake. Phase 2b will wire
`operations.mjs` and `bin/mcp-server.mjs` to this API; nothing in this phase
changes a default launch: an absent binding preserves the exact prior behavior.

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
  "recipientAgent": "agents/<architect-session-uuid>",
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
additionally refuses a binding on any seat other than the runner
(`binding_invalid_seat`), an attempt the record does not name
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
