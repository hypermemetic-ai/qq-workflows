# Original Pi relay receiver: compatibility proof and integration handoff

Status: **isolated compatibility proof landed and verified; production is NOT
activated.** No live communication is enabled by this dispatch, no production
tool, prompt, adapter, or config file changed, and no service was deployed or
restarted. The change record remains the sole workflow authority; the temporary
relay journal is subordinate transport bookkeeping.

## What was built

| Path | Role |
| --- | --- |
| `tests/fixtures/pi-relay/agent-messages-relay-fixture.mjs` | The original receiver, adapted (see below), loadable through the real Pi extension mechanism |
| `tests/relay-receiver-units.mjs` | Offline supplements: receiver decision boundaries on a stub transport + change-record acknowledgement layering |
| `tests/pi-relay-receiver.mjs` | The real-Pi + real-journal proof (auto-discovered by `node tests/run.mjs`; honestly SKIPPED when installed Pi or qq-relay is absent) |
| `docs/pi-relay-receiver-proof.md` | This document |

## Source provenance and declared adaptations

Source: `/home/qqp/projects/.archive/qq-monolith` commit
`2b4b9898605144530cf385a60eca30d86bb23178` ("fix: prove agent receipts from
durable entries"), file `extensions/agent-messages.ts` (557 lines). The
receiver mechanics are carried over line-for-line where possible: the receiver
poll loop (`client.next` with `consumer_type:"recipient"`,
`consumer_id:"agents/<session-id>"`, generation 0, 30s long-poll), the
`receiveOne` ordering (parse -> durable-receipt check -> dedup marker ->
immediate claim/abort discipline -> injection options -> acknowledge only after
the durable session entry is observable), `receiptEntryMatches`,
`deliveryGuard`, `statusName`, and the injection option selection
(`{triggerTurn:true}` idle, `{triggerTurn:true, deliverAs:"steer"}` busy).

Declared adaptations (each marked `A1`–`A5` in the fixture header):

1. **A1 relay client** — the historical `bin/lib/qq-relay-client.mjs` shim is
   replaced by direct resolution of the INSTALLED client at
   `$QQ_RELAY_INSTALL_ROOT || $HOME/.local/lib/qq/relay/client.mjs` with the
   same export validation. The client is constructed lazily; every transport
   call site keeps the original operation sequence.
2. **A2 role vocabulary** — `bin/lib/roles.mjs` is NOT restored. The valid
   role set is the change record's `JOB_ROLES`
   (runner/implementer/reviewer/execution), imported from
   `workflow/change-record.mjs`. The `.pi/agent-messages.json` project config
   and machine-wide repository role discovery (`roleForRepository`) are
   dropped; the role comes from `QQ_AGENT_ROLE` only.
3. **A3 no machine-wide presence** — presence files, lease renewal, presence
   listing/cards, busy-state event bookkeeping, the `list` tool action and the
   `agent-tasks` command are not restored. Delivery decisions use
   `ctx.isIdle()` exactly as the source revision does.
4. **A4 workflow identity mapping** — message metadata describes the TARGETED
   workflow job: `project` = change-record id (`QQ_AGENT_PROJECT`), `role` =
   the targeted job's role (`QQ_RELAY_FIXTURE_TARGET_ROLE`, falling back to the
   registered role), `tasks` = structured workflow references
   (`job:…`, `attempt:…`, `amendment:…`, `revision:…`, `progress:<seq>`).
   `send` accepts an optional structured `tasks` parameter (additive; absent
   keeps the original behavior).
5. **A5 fixture-only tools** — `fixture_acknowledge_amendment` (appends
   `worker.acknowledged` after validating the pending amendment against this
   session's job/attempt/revision; deterministic command ID
   `ack-<amendmentId>-rev<revision>` makes repeats a change-record dedupe) and
   `fixture_report_progress` (appends `worker.progress` BEFORE pushing the
   return-direction notification). Both refuse when the workflow environment is
   absent. These are NOT production surface; no production tool or prompt was
   defined or modified.

The `agent_messages` tool's model-facing description is the historical wrapper
text from the source revision (minus the removed `list` clause) — historical
test provenance, not approved production copy. All fixture-only model-facing
strings are the dispatch's fixture copy. Coordinator-authored production copy
remains a later ticket.

## Test-only copied adapter (declared patch)

`tests/pi-relay-receiver.mjs` generates a test-only copy of
`workflow/pi-worker/adapter.mjs` at runtime. The delta over the landed source
is asserted in the test:

* import specifiers absolutized to `file:` URLs (mechanical, semantics
  preserving; proven by a control build whose stripped-specifier text is
  byte-identical to the landed source), and
* exactly one semantic line: the `WORKER_PI_EXTENSION` constant points at the
  fixture receiver instead of `worker-tools.mjs`.

The patched-fixture adapter lifecycle is therefore NOT unmodified production
proof; the production adapter is untouched and still loads only
`worker-tools.mjs`.

## Executable proof

```bash
node tests/relay-receiver-units.mjs          # offline, always runs (6/6)
node tests/pi-relay-receiver.mjs             # real Pi + real journal (9/9, ~90s)
npm test                                     # full suite, 23 files, all pass
```

Test infrastructure is authorized and bounded: a temporary real journal service
(installed `qq-relay serve --state-dir <fixture>/xdg/qq-relay`, health-checked,
SIGKILLed in `finally` and on SIGTERM/SIGINT), installed Pi 0.84.x against a
deterministic 127.0.0.1 provider with a dummy key, fresh 0700 temporary state,
bounded waits, every owned process reaped. The fixture root is RETAINED as the
transcript (`$TMPDIR/qq-relay-proof-*`, manifest in `manifest.json`, per-attempt
adapter stdout/stderr, native session recordings, change record, journal state,
wire log). It accumulates under `$TMPDIR` and can be pruned.

## Evidence per required case

1. **Busy receiver — PASS.** The amendment was committed
   (`assignment.revised` + `amendment.submitted`) BEFORE sending; the push went
   through the original `agent_messages` send tool inside a real Pi session;
   the real receiver steered it into the running turn
   (`{triggerTurn:true, deliverAs:"steer"}`). Observed layer timings: journal
   `queued` at send (durable receipt +~2.2s), `delivered` only after the
   durable session entry existed (+~1.0s), `worker.acknowledged` (revision 2,
   attempt-1) as the incorporation event. Queue acceptance, durable session
   receipt, and incorporation are asserted as distinct layers with stable
   `event_id` correlation across status queries.
2. **Worker acknowledgement — PASS.** The deterministic provider emitted the
   fixture-only acknowledgement action for the exact revision after seeing the
   injected envelope; the tool validated attempt/revision against the change
   record. Offline supplements prove that absent, stale, and wrong-attempt
   acknowledgements cannot fulfill a pending amendment, that
   `amendment.accepted` is scoped to the targeted attempt, and that a duplicate
   acknowledgement is a command-ID dedupe that leaves the amendment view
   pinned to the first fulfilment. No production tool/prompt changes.
3. **Idle/settling — PASS with two honest findings.** Real receiver wake on an
   idle runtime was proven separately (return direction, case 5; immediate
   delivery). At the settle boundary, the real adapter lifecycle was exercised
   through the declared-patch copy:
   * 3a (delivery during the final streamed turn): the steer drained into the
     run's continuation; the durable receipt landed in the adapter's native
     session BEFORE exit; the receiver acknowledged before teardown finished.
   * 3b (delivery at the settle/teardown boundary): the boundary push won the
     race in the observed run; the post-exit push reproduced the gap precisely.
   No success is claimed from a queued message on a dead child (see FINDINGS).
4. **Durable receipt, duplicates, restart — PASS with one finding.** 4a: the
   receiver was SIGKILLed between durable receipt and acknowledgement; the
   journal stayed pending (never falsely delivered); a resumed receiver on the
   SAME session acknowledged from durable session evidence with NO reinjection;
   the repeated acknowledgement command was a change-record dedupe. 4b: a
   crash BEFORE any durable receipt left no trace, and the resumed receiver
   injected the envelope again (FINDING; incorporation still applied exactly
   once via the change record). No exactly-once injection is claimed across
   crashes; no inherited in-memory dedup is assumed.
5. **Return direction — PASS.** `worker.progress` was committed to the change
   record BEFORE the push; the notification reached the actual architect Pi
   session; the architect's session recording holds the model-visible envelope
   and its deterministic output quotes the bounded `progress:<seq>` reference.
   A socket status query alone was never used as recipient-wake evidence.
6. **Cancellation — PASS.** `attempt.cancel_intent` was recorded BEFORE the
   SIGINT; the adapter exited 1/130/143 with the abort named on stderr; the
   native trace records the aborted in-flight message (`stopReason:"aborted"`);
   the change record REFUSES a later `attempt.outcome` completed for the
   cancelled attempt ("cancellation intent … forbids a completed outcome").
   Ordinary steering (case 1), the immediate claim/abort discipline, and
   explicit cancellation were exercised as three distinct behaviors.
7. **Session recording and cleanup — PASS.** Retained artifacts show the
   model-visible envelopes (with stable `event_id`/`content_hash` details), the
   fixture tool results/receipt/ack sequence, and one 0600 native session file
   + `qq-worker-session-meta/1` sidecar per adapter attempt. Provider traffic
   stayed on the localhost mock with the dummy key (asserted per request); all
   owned processes are reaped; no operator credentials/config/state touched.

## FINDINGS (recorded observations, not solved properties)

* **F1 (crash-before-receipt reinjection, case 4b).** A crash between queuing
  and durable receipt leaves no trace; redelivery re-injects. Exactly-once
  injection across crashes is NOT a property of this stack. The change record's
  deterministic command IDs are what make incorporation idempotent.
* **F2 (dead-consumer binding, case 3b — the integration gap).** Relay
  obligations are bound to `consumer_id = agents/<pi-session-id>`. When the
  adapter exits on settle, pending obligations stay queued for that dead
  consumer; a relaunched attempt has a NEW session id and never receives them.
  Observed concretely: after adapter exit, a pushed amendment stayed `queued`
  across a bounded observation window with zero receipts.

## Minimal next runner-integration contract

1. **Addressing.** The workflow must own the transport identity:
   record `agents/<pi-session-id>` in the change record at attempt start
   (attempt.started identity), and either resume the SAME session file for
   successor attempts (proven: same session id, durable evidence honored) or
   explicitly re-address pending amendments to the successor attempt in the
   change record before relaunch. Never silently relaunch with a new session id
   while obligations are pending (F2).
2. **Settle/exit boundary.** Before the adapter tears down its runtime, the
   receiver needs a bounded quiesce window (drain pending obligations) or the
   workflow must accept redelivery-on-resume semantics. Queue acceptance and
   even durable receipt must never be reported as incorporation; only
   `worker.acknowledged` in the change record is.
3. **Acknowledgement surface.** The worker's amendment-acknowledgement path
   must become a coordinator-authored production tool writing
   `worker.acknowledged` (the fixture tool is test-only and must not ship).
   The adapter arm in this dispatch deliberately has no acknowledgement path.
4. **Idempotency.** Preserve the deterministic command-ID discipline
   (`ack-<amendmentId>-rev<revision>`); a redelivered envelope after a crash
   must produce at most one incorporation (F1).
5. **Placement.** The receiver runs inside the worker Pi as an extension
   (proven with the real extension-loading mechanism under installed Pi
   0.84.1). Loading it in production requires the worker extension seam
   (`WORKER_PI_EXTENSION`) to carry it — a production change that does NOT
   belong to this dispatch.

## Source landed vs production activated

Landed in this dispatch: the maintained fixture, the offline and real-Pi
proofs, and this handoff. NOT activated: no production extension loading, no
receiver in the production adapter, no broker/persistent service, no config
edits, no model-facing production copy. The proof's adapter arm runs a
test-only copied adapter whose single semantic delta is asserted in the test.
