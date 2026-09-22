# Managed execution communication and authority

This document defines the managed-execution lifecycle surfaces exposed to the
Architect (native tools) and to MCP coordinators (`bin/mcp-server.mjs`), and
the exact vocabulary every response and report uses. Runner communication is
documented separately in `docs/runner-communication.md`; the worker-facing
tool descriptions and the communication role paragraph are shared verbatim and
are never rewritten here.

## One authoritative change record

Every **new** managed execution is recorded in the ONE append-only change
record (`workflow/change-record.mjs`) before its host process exists, via
`workflow/execution-authority.mjs`:

* parent execution identity (the execution/job id — the record's change id),
  phase ticket and worktree (`phaseId`, `root`), base (`baseRef`), the
  coordinating owner (workflow session key), and the full host launch metadata
  (launch id, request path, kind);
* selected worktree, branch, and actual base SHA as `worktree-base` evidence
  before launching a role (`check_execution.authority.execution.worktreeSelection`);
* immutable original constraints as assignment revision 1 (verbatim — an
  update never rewrites them);
* child role/job/attempt identities and revisions for every implementer and
  reviewer seat, including retries (a retry is a **new attempt on the same
  role job**) and honest same-revision relaunches.

Existing `jobs/`, `EXECUTIONS` and notification files remain rebuildable
views; host requests/results remain subordinate transport artifacts. A host
request is reconstructed and verified against the committed launch metadata
(`verifyHostLaunch`); any forged or edited field (kind, phase, base, owner,
root, launch id, path) fails closed before any work starts.

The committed owner, repository, and observed host fingerprint also govern
recovery and cancellation. Changing those fields in a compatibility job file
cannot authorize a different session. Missing job files are reconstructed by
the owning coordinator from the change records, including report references;
existing notification receipts still prevent duplicate completion delivery.
A compatibility-only success is never promoted into an authoritative outcome.

## Surfaces

Native (workflow tools) and MCP both expose:

| Surface | Behavior |
| --- | --- |
| `dispatch_execution` | Launch the managed pipeline in an owned host on both native and production MCP surfaces. Never auto-relaunched by recovery. |
| `check_execution` | Point-in-time status plus **bounded** role/job/attempt/revision/update/report state rebuilt from the change record on every read. A stale compatibility cache can never override it. |
| `steer_execution` | Submit one additional instruction as an **assignment update** to the exact currently intended active implementer/reviewer attempt. |
| `cancel_execution` | Record authoritative cancellation intent, then signal only the fingerprint-matched owned process. Idempotent. |

`steer_execution` accepts optional `expectAttemptId` / `expectJobId`: the
target is **bound before submission** and re-verified under the record's
writer lock. A phase or attempt change races to a **truthful refusal**
(`target-changed` / `refused`) — never a silent retarget. The composed
instructions are the full assignment view: the attempt's original constraints
verbatim, then every update already targeted at that attempt in committed
revision order (exact updates heading and precedence sentence), then the new
instruction. A retry attempt retains the original constraints and the updates
prior attempts acknowledged; an unacknowledged update stays targeted at its
old attempt — unresolved and visible, never migrated and never silently
dropped. The reviewer seat stays read-only regardless of what an update asks.

## Update lifecycle (always kept distinct)

* **submitted** — the revision and its delivery obligation are committed in
  the record (durable before any push).
* **transport-received** — the attempt's receiver accepted the delivery.
  This is transport receipt, never incorporation.
* **worker-acknowledged** — the attempt recorded `worker.acknowledged` for
  the exact revision: incorporation evidence.
* **fulfilled** — the update was acknowledged and a successful validated
  outcome covering that revision was recorded for the job. Failure,
  cancellation, and a higher retry revision alone do not fulfill it.

`check_execution` reports each update with exactly one of these states. A
result validated against revision A while update B is pending never claims
full fulfillment; the pending obligation blocks automatic landing
(`admitLanding` refuses with the pending list) and stays visible for an
explicit decision.

If an update arrives too late for its attempt, `check_execution` keeps it
submitted or transport-received even after a successful retry. There is no
coordinator tool that acknowledges an instruction on a worker's behalf or
silently withdraws it. Inspect the reports and pending references, cancel an
execution that is still active, then explicitly prepare an approved follow-up
ticket containing the original constraints, unresolved instructions, and
previous job/report references. `dispatch_execution` can deliberately reuse
the preserved phase/worktree via `phaseId`. This starts a new managed attempt;
it does not rewrite the old result or claim the old update was acknowledged.
Recovery never performs that dispatch automatically.

## Cancellation and landing safety

1. The **authoritative cancellation intent** is recorded in the change record
   before any process is signalled (execution attempt and every unsettled
   role attempt).
2. Only a fingerprint-matched **owned** process is signalled. Repeated
   cancellation is idempotent, never signals an unrelated PID, and never
   restarts workers.
3. After an accepted cancellation no further role may spawn and no successful
   outcome can be recorded; a late result is preserved as **durable evidence**
   (`attempt.evidence`) with its report references. The cancelled outcome
   never changes and is never relabelled as success.
4. Landing is admitted exactly once through the record
   (`attempt.landing_admitted`), serialized with cancellation and update
   state. Landing is refused after an accepted cancellation; a cancellation
   after landing admission is refused **truthfully** with the preserved
   landing evidence — rollback is never implied.
5. Disappearance is never a known failed outcome: an attempt without a
   recorded outcome is reported `outcomeKnown: false` (the compatibility view
   says "interrupted — outcome unknown"). Role reports are preserved and
   retrievable for failed and cancelled jobs just as for successes.

## Progress and reports

Committed, role-attributed progress/blocker entries are forwarded through the
**same durable native notifier/receipt path** the completion notifications use
(and the MCP transport adapter routes through) with stable
change/job/attempt/sequence identity
(`execution:<jobId>:progress:<changeId>:<attemptId>:<seq>`). The outgoing
notification is rebuilt from the committed note; transport text is never
authority. Journal state gives replay protection across duplicate deliveries
and parent reloads, owner/attempt isolation is enforced against the recorded
launch owner, and queue acceptance is never reported as receipt. Unforwarded
committed entries stay pending and retryable (`pendingRoleProgress`).

All full reports (pipeline report and per-role reports) are persisted **before
any notification** and retrieved with `read_report`.
If an adapter writes a valid role result and then exits unsuccessfully, its
full findings are retained as the failed attempt's report. Model output alone
does not turn that managed attempt into a success.

When the coordinating parent owns delivery, the host disables the MCP Codex
notifier explicitly (`notificationMode: "parent"`), never by relying on the
absence of ambient Codex environment.

## Unsupported legacy harness communication — explicit report

A seat launched without a workflow communication binding (legacy harness
configurations) has **no** assignment updates and no progress push. Steering
such an execution reports `code: "unsupported"` (native and MCP) with the
configured harness in its reason. The recorded capability distinguishes an
unsupported harness from a Pi receiver whose binding is still arriving — it
is never a silent stdin write pretending delivery. Legacy successful and failed
role reports still remain durable and linked to their attempt outcomes.

Explicit binding validation covers the implementer/reviewer seats **only when
the binding role matches the actual seat**; a binding naming another
seat/attempt is refused before any process is spawned and is never inherited.

## Shared transport and recovery

Relay transport for role updates/progress (parent consumer subscription,
pushed-update envelopes, delivery-correlation retry) reuses the shared runner
lifecycle (`workflow/runner-lifecycle.mjs`). The host supplies each Pi role
with an explicit attempt binding and releases its runtime hold after the role
settles. Other workers retain their own holds. The owning coordinator forwards
committed progress and completion through its existing notification path;
record scans preserve progress even if the relay queue loses a reply.

The production MCP dispatcher uses the same owned host as the native tools.
Its startup and periodic recovery reconstruct durable jobs independently of
`check_execution`. MCP transport acceptance is not proof that the coordinating
model read the notification. A cold MCP process must use the same repository
and owner; tool responses include `cwd`, which can be supplied explicitly.

Bounded landing remains fast-forward-only. Concurrent phases pinned to the
same base can both complete their worker assignments while the later landing
fails after the first advances main. That execution reports the landing
failure and retains its branch and worker report; it never invents success or
automatically relaunches the worker.
