// qq-workflows Architect profile for pi.
//
// This extension is injected only into the Architect provider entry
// (`pi --no-extensions --extension <this file>`), so every restriction here is
// scoped to that selectable profile: an ordinary pi session, an Orca session, a
// plain Codex CLI session, or a Paseo Codex agent never loads it.
//
// It owns four things:
//   1. the FINAL system prompt (full replacement, asserted at the provider
//      boundary, with repository instructions re-included through one
//      controlled mechanism),
//   2. the tool surface (read-only local inspection + native workflow tools; no
//      shell, editor, or write tool),
//   3. the Architect compaction policy (the shared pi setting disables
//      automatic compaction, which must not become silent context overflow),
//   4. completion delivery: idle results start a turn, busy results are queued
//      or steered without interrupting the operator's active work, deduped by
//      stable event ID and recovered from durable state after a restart.
//
// Restart recovery is not gated on a specific session_start reason. The pi
// runtime in use emits `startup` for a fresh CLI session, for `--session <file>`
// (the shape Paseo opens), and after a Paseo `agent reload`; `resume`/`new`/
// `fork` come from the SDK runtime and `reload` from `/reload`. Recovery
// therefore runs for every reason, once the session is ready (see below), and is
// always ownership-checked, so a replay can only reach the session that owns the
// job.
//
// Acknowledgement, not acceptance. A steered completion is a custom message
// whose `details` carry the stable event/job identity; pi persists those details
// verbatim into the session entry (`appendCustomMessageEntry` on message_end).
// That entry is the receipt: when it is observed, the durable notification and
// job records advance to `delivered` with the observation recorded as evidence.
// The check is deferred to a later task on purpose — pi writes the entry AFTER
// its extension handlers returned, so acking inside the handler would claim more
// than pi committed. Until a receipt exists the record stays `queued` (volatile)
// and recovery reconciles it from the same evidence: an event the session
// retained is acknowledged, an event the session never held is re-delivered to
// its owner, and anything that cannot be proven is retained as outcome-unknown
// instead of being duplicated. See the README for the remaining crash-boundary
// limits (pi offers no transaction across queue, session write, and our record).
//
// Two details are load bearing for that reconciliation, and both come from the
// runtime rather than from this profile's design:
//   * a completion steered by a release that predates the identity metadata is
//     an entry with the exact text and no `details`. It is preserved as evidence
//     (not discarded) and only read through an exact content correspondence, so
//     an upgrade never mistakes "no identified entry" for "never received";
//   * the deferred check is bound to the session that scheduled it. pi's context
//     throws from every guarded getter once the session was replaced or reloaded,
//     so the captured context is used, a failure is never read as absence, and
//     the check never falls back to the session that replaced it (see
//     `sessionEvidence` and `scheduleReceiptCheck`).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ARCHITECT_COMPACTION,
  ARCHITECT_COMPLETION_CUSTOM_TYPE,
  ARCHITECT_DELIVERY,
  ARCHITECT_DENIED_TOOLS,
  ARCHITECT_EXTENSION_FILE,
  ARCHITECT_PROFILE_ENV,
  ARCHITECT_PROMPT_MARKER,
  ARCHITECT_READ_ONLY_TOOLS,
  PI_COMPACTION_DEFAULTS,
  assembleArchitectSystemPrompt,
  enforceProviderPayloadPrompt,
  inspectAssembledPrompt,
  inspectCompactionPolicy,
  loadArchitectPrompt,
  readPiCompactionSettings,
} from "../workflow/architect-profile.mjs";
import { createWorkflow, WORKFLOW_TOOLS, WORKFLOW_TOOL_NAMES } from "../workflow/operations.mjs";
import { loadManagedExecutionLauncher } from "./managed-execution.mjs";
import { resolveSessionKey } from "../workflow/session.mjs";

export const ARCHITECT_EXTENSION_NAME = "qq-architect";
export const ARCHITECT_ALLOWED_TOOLS = [...ARCHITECT_READ_ONLY_TOOLS, ...WORKFLOW_TOOL_NAMES];

// In-flight accepted completions: the exact events this process handed to a LIVE
// session's message queue whose retention has not been observed yet.
//
// pi's `hasPendingMessages()` is not that signal: it reports
// `pendingMessageCount`, which only counts user-prompt steers/follow-ups, while
// an Architect completion is queued with `sendCustomMessage(..., "steer")` into
// the agent's own steering queue. Recovery must not treat such an event as
// "proven absent" and re-steer a second copy.
//
// The registry is process-scoped on purpose. `/reload` re-evaluates this module
// (pi loads extensions with `moduleCache: false`) and builds a fresh extension,
// but the agent object — and the steer queue on it — survives the reload, so the
// knowledge has to outlive the module instance. It dies with the process,
// exactly like the queue it mirrors: after a real restart the durable record and
// the persisted session evidence decide, as before.
export const LIVE_DELIVERIES_SYMBOL = Symbol.for("qq-architect.live-deliveries");

function liveDeliveries() {
  const existing = globalThis[LIVE_DELIVERIES_SYMBOL];
  if (existing && typeof existing.get === "function" && typeof existing.set === "function") return existing;
  const registry = new Map();
  Object.defineProperty(globalThis, LIVE_DELIVERIES_SYMBOL, { value: registry, enumerable: false, configurable: true, writable: false });
  return registry;
}

// Bounded: an event holds at most until its run settles or its receipt is
// observed; the caps only guard a pathological long-lived process.
const LIVE_SESSION_LIMIT = 16;
const LIVE_EVENT_LIMIT = 64;

function liveSession(sessionKeyValue, { create = false } = {}) {
  const registry = liveDeliveries();
  const key = String(sessionKeyValue ?? "__default__");
  let session = registry.get(key);
  if (!session && create) {
    session = new Map();
    registry.set(key, session);
    while (registry.size > LIVE_SESSION_LIMIT) registry.delete(registry.keys().next().value);
  }
  return session ?? null;
}

export function capturePath(env = process.env) {
  return env?.QQ_ARCHITECT_PROMPT_CAPTURE || null;
}

function recordCapture(entry, env) {
  const path = capturePath(env);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* capture is diagnostics only; never break the session */
  }
}

// Build the pi tool definitions. `typebox` is resolved lazily because pi loads
// this file with jiti (where typebox is available) while the repository's Node
// tests exercise the same definitions without that dependency.
async function toolSchemas(tools) {
  let Type = null;
  try {
    ({ Type } = await import("typebox"));
  } catch {
    Type = null;
  }
  if (!Type) return tools.map((tool) => tool.parameters);
  return tools.map((tool) => Type.Unsafe(tool.parameters));
}

function effectiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function createArchitectExtension(pi, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const workflowFactory = options.workflowFactory ?? ((config) => createWorkflow(config));
  const executionLauncher = options.executionLauncher ?? loadManagedExecutionLauncher();
  const compaction = { ...ARCHITECT_COMPACTION, ...(options.compaction ?? {}) };
  const now = options.now ?? (() => Date.now());
  // Delivery/recovery readiness is scheduled, never inline: a session_start
  // handler runs while pi is still opening the session, and a turn fabricated
  // there would race pi's own initialization (and the operator's first prompt).
  const schedule = options.schedule ?? ((fn) => setTimeout(fn, ARCHITECT_DELIVERY.readyDelayMs));
  // Receipt verification is deferred on purpose: pi appends the session entry
  // after its extension handlers returned, so the evidence may only be read on a
  // later task (see the file header).
  const scheduleReceipt = options.scheduleReceipt ?? ((fn) => setTimeout(fn, ARCHITECT_DELIVERY.receiptDelayMs));
  const loadPrompt = options.loadPrompt ?? loadArchitectPrompt;
  // Effective pi compaction settings are READ through their documented channel
  // (settings files); the profile never writes them, so a divergence is
  // observed and reported instead of silently assumed.
  const loadCompactionSettings = options.readCompactionSettings ?? readPiCompactionSettings;

  const state = {
    ownedPrompt: null,
    systemPrompt: null,
    activeTools: [],
    lastCtx: null,
    lastCompactionAt: 0,
    compacting: false,
    compactionRuntime: null,
    compactionPolicy: null,
    compactionPolicyNotified: false,
    deliveries: [],
    // Completion receipts, keyed by the stable event ID carried in the custom
    // message details. `receipts` holds expectations that are not yet proven
    // consumed (nothing is claimed for them); `acknowledged` holds the receipts
    // that were observed, so a send that returns after the observation reports
    // the confirmed fact instead of the volatile queue result.
    receipts: new Map(),
    acknowledged: new Map(),
    receiptChecks: [],
    // Which session the extension is running: pi replaces the session under the
    // same extension process (newSession/fork/switchSession, and every start
    // other than `/reload`, which continues the session it was reloaded into).
    // Receipt expectations are stamped with it, so evidence read after a
    // replacement can never acknowledge a completion of the session that is gone.
    sessionGeneration: 0,
    // Cancellation handles for deferred receipt checks, dropped when the session
    // they were scheduled for is replaced. Invalidation is the correctness
    // mechanism (see `scheduleReceiptCheck`); this is only tidiness.
    receiptTimers: new Set(),
    // Notifications offered while the session was still opening. Nothing was
    // sent and nothing was claimed: their durable records stay pending, so the
    // readiness tick below replays them exactly once.
    deferred: [],
    recovery: null,
    recoveries: [],
    sessionReason: null,
    // A session is "ready" only after the deferred tick, i.e. after the
    // session_start handler returned and pi's initialization continuation ran.
    // Until then a completion must not fabricate a turn. An embedder (or a test)
    // may declare the session already ready through `interactive: true`.
    sessionReady: options.interactive ?? false,
    // Observability: whether the operator has sent a message in this process.
    // Wake eligibility deliberately does NOT depend on it.
    operatorActive: false,
    readyPromise: Promise.resolve(null),
  };

  function ensurePrompt() {
    if (!state.ownedPrompt) state.ownedPrompt = loadPrompt();
    return state.ownedPrompt;
  }

  function sessionKey() {
    return resolveSessionKey({ env });
  }

  // The identity pi persists into the session entry. `details` travels with the
  // custom message and is written verbatim by `appendCustomMessageEntry`, which
  // is what makes a consumed completion reconcilable after a restart.
  function completionDetails(notification) {
    return {
      eventId: notification?.eventId ?? null,
      jobId: notification?.jobId ?? null,
      role: notification?.role ?? null,
      kind: notification?.kind ?? null,
      reportId: notification?.reportId ?? null,
    };
  }

  // Normalized text of a message: pi stores user prompts as
  // `[{type:"text", text}]` and custom messages as a plain string.
  function messageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
    return "";
  }

  function entryAt(timestamp) {
    const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // Register an expected receipt. Registering claims nothing: a receipt is only
  // written once the owning session provably retained the event.
  function expectReceipt({ eventId, jobId = null, role = null, text = null, kind = null } = {}) {
    if (typeof eventId !== "string" || !eventId) return null;
    const existing = state.receipts.get(eventId) ?? { eventId, checks: 0, receipt: null, session: state.sessionGeneration };
    const next = {
      ...existing,
      jobId: jobId ?? existing.jobId ?? null,
      role: role ?? existing.role ?? null,
      kind: kind ?? existing.kind ?? null,
      text: text ?? existing.text ?? null,
      expectedAt: existing.expectedAt ?? now(),
    };
    state.receipts.set(eventId, next);
    // Bounded: the durable records are the real state, this map is only the
    // in-process reconciliation buffer for the current session.
    evictOldest(state.receipts, 64, eventId);
    return next;
  }

  function evictOldest(map, limit, keep) {
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined || oldest === keep) return;
      map.delete(oldest);
    }
  }

  // The live in-flight claim for one event: pi accepted it into this session's
  // message queue and nothing has observed it leave yet. Held in the
  // process-scoped registry (see the module header), keyed by this session.
  function holdInFlight(eventId) {
    if (typeof eventId !== "string" || !eventId) return;
    const session = liveSession(sessionKey(), { create: true });
    session.set(eventId, { at: now() });
    while (session.size > LIVE_EVENT_LIMIT) session.delete(session.keys().next().value);
  }

  function releaseInFlight(eventId) {
    const session = liveSession(sessionKey());
    if (!session) return;
    session.delete(eventId);
    // Nothing is held for this session anymore: drop the empty bucket so a
    // long-lived process never accumulates them.
    if (session.size === 0) liveDeliveries().delete(String(sessionKey() ?? "__default__"));
  }

  function releaseAllInFlight() {
    liveDeliveries().delete(String(sessionKey() ?? "__default__"));
  }

  function inFlightEvents() {
    return [...(liveSession(sessionKey())?.keys() ?? [])];
  }

  function rememberAcknowledged(eventId, receipt) {
    state.acknowledged.set(eventId, receipt);
    evictOldest(state.acknowledged, 128, eventId);
  }

  // What the owning session has durably retained. `null` means no evidence
  // source: recovery must then stay conservative rather than assume absence.
  //
  // Every read of the pi context is guarded, because pi's context is *designed*
  // to throw once its session was replaced: `ctx.sessionManager`, `ctx.ui`,
  // `ctx.isIdle()` and friends all call an internal `assertActive()` that raises
  // "This extension ctx is stale after session replacement or reload" after
  // `newSession()`, `fork()`, `switchSession()`, or `reload()`. A stale context
  // is not evidence of anything — least of all of absence — so this reader
  // returns null and lets recovery stay conservative. It deliberately does NOT
  // fall back to a newer context: that would let one session's entries
  // acknowledge another session's completion.
  function sessionEvidence(ctx = state.lastCtx) {
    let entries = null;
    let sessionFile = null;
    let pendingMessages = null;
    try {
      const manager = ctx?.sessionManager ?? null;
      if (!manager || typeof manager.getEntries !== "function") return null;
      const read = manager.getEntries();
      if (!Array.isArray(read)) return null;
      entries = read;
      if (typeof manager.getSessionFile === "function") sessionFile = manager.getSessionFile() ?? null;
      if (typeof ctx?.hasPendingMessages === "function") pendingMessages = Boolean(ctx.hasPendingMessages());
    } catch {
      return null;
    }
    const receipts = [];
    const unidentified = [];
    const userMessages = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "custom_message") {
        const eventId = entry.details?.eventId;
        if (typeof eventId === "string" && eventId) {
          receipts.push({ eventId, entryId: entry.id ?? null, at: entryAt(entry.timestamp) });
          continue;
        }
        // A completion of THIS profile persisted by a release that predates the
        // identity metadata (PR109 steered the text without `details`). The
        // entry is proof that the session retained a completion, not which event
        // it was, so it is preserved as evidence and recovery only reads it
        // through an exact, unique content correspondence. Discarding it here is
        // what made a consumed completion look like one that never arrived.
        if (entry.customType === ARCHITECT_COMPLETION_CUSTOM_TYPE) {
          const text = messageText(entry);
          if (text) unidentified.push({ entryId: entry.id ?? null, at: entryAt(entry.timestamp), text, customType: entry.customType });
        }
      }
      if (entry.type === "message" && entry.message?.role === "user") {
        const text = messageText(entry.message);
        if (!text) continue;
        const list = userMessages.get(text) ?? [];
        list.push({ entryId: entry.id ?? null, at: entryAt(entry.timestamp) });
        userMessages.set(text, list);
      }
    }
    return {
      sessionFile,
      entries: receipts,
      // Identity-less completions of this profile, kept as evidence (never as a
      // receipt by themselves).
      unidentified,
      userMessages,
      pendingMessages,
      // Per-event truth pi's `hasPendingMessages()` cannot report: completions
      // this process steered into this live session and has not seen consumed.
      // Recovery defers these instead of re-steering a duplicate.
      inFlight: inFlightEvents(),
      at: now(),
    };
  }

  function writeReceipt(pending, receipt) {
    try {
      return ensureWorkflow().acknowledgeDelivery({ eventId: pending.eventId, jobId: pending.jobId ?? null, receipt });
    } catch (err) {
      return { ok: false, acknowledged: false, eventId: pending.eventId, reason: err?.message || String(err) };
    }
  }

  // Expectations are stamped with the session they were registered in. Once pi
  // replaces the session under this extension, an expectation of the session that
  // is gone can never be proven here, so it is dropped instead of being matched
  // against a different session's entries. Nothing durable is lost: the job and
  // notification records stay volatile, and the owning session's own recovery
  // resolves them from its own evidence.
  function dropStaleExpectations() {
    const dropped = [];
    for (const [eventId, pending] of [...state.receipts]) {
      if (pending.session === state.sessionGeneration) continue;
      state.receipts.delete(eventId);
      dropped.push(eventId);
    }
    return dropped;
  }

  // Verify every expected receipt against the owning session's persisted
  // entries. Only a proven event is acknowledged; an unproven one keeps its
  // volatile record (recovery reconciles it later) and is never claimed.
  //
  // Nothing may escape from here into pi: this runs both inside event handlers
  // and on a deferred task, and an exception there ends the session. A failed
  // check claims nothing and proves nothing — it records why and leaves the
  // expectations pending for a later pass or for recovery.
  function flushReceipts(ctx = state.lastCtx) {
    if (state.receipts.size === 0) return { checked: 0, acknowledged: [], pending: [], stale: [] };
    const stale = dropStaleExpectations();
    if (stale.length > 0) recordCapture({ at: now(), kind: "receipt-check", outcome: "stale-session", dropped: stale, generation: state.sessionGeneration }, env);
    try {
      const evidence = sessionEvidence(ctx);
      if (!evidence) {
        recordCapture({ at: now(), kind: "receipt-check", outcome: "no-session-evidence", pending: [...state.receipts.keys()] }, env);
        return { checked: 0, acknowledged: [], pending: [...state.receipts.keys()], stale, reason: "no-session-evidence" };
      }
      const acknowledged = [];
      for (const [eventId, pending] of [...state.receipts]) {
        pending.checks += 1;
        const entry = evidence.entries.find((candidate) => candidate.eventId === eventId) ?? null;
        // The idle branch sends the completion as a regular user message, which
        // carries no identity: the exact text is the only stable link back to it.
        const textEntry = entry ? null : evidence.userMessages.get(pending.text ?? "")?.[0] ?? null;
        if (!entry && !textEntry) continue;
        const receipt = entry
          ? { kind: "pi-session-entry", eventId, entryId: entry.entryId, sessionFile: evidence.sessionFile, at: entry.at ?? null, observedAt: now() }
          : { kind: "session-user-message", eventId, entryId: textEntry.entryId, sessionFile: evidence.sessionFile, at: textEntry.at ?? null, observedAt: now() };
        pending.receipt = receipt;
        const result = writeReceipt(pending, receipt);
        rememberAcknowledged(eventId, receipt);
        state.receiptChecks.push({ at: now(), eventId, jobId: pending.jobId ?? null, kind: receipt.kind, acknowledged: Boolean(result?.ok), durable: Boolean(result?.delivery) });
        if (state.receiptChecks.length > 40) state.receiptChecks.splice(0, state.receiptChecks.length - 40);
        recordCapture({ at: now(), kind: "receipt", eventId, jobId: pending.jobId ?? null, receipt, acknowledged: Boolean(result?.ok), result: result?.reason ?? null }, env);
        if (result?.ok) {
          state.receipts.delete(eventId);
          releaseInFlight(eventId);
          acknowledged.push({ eventId, jobId: pending.jobId ?? null, kind: receipt.kind, state: result.state });
          continue;
        }
        // The router writes the journal after the transport call returned, so a
        // receipt observed earlier is buffered in memory and re-applied: the
        // record is upgraded to `delivered` with this receipt as evidence. A
        // receipt that could not be persisted (the journal is missing or
        // corrupt, or the write failed) is reported, never claimed.
        if (pending.checks >= 4) {
          state.receipts.delete(eventId);
          // This process stops claiming the event is queued; the durable record
          // stays volatile and the next recovery reconciles it from evidence.
          releaseInFlight(eventId);
          acknowledged.push({ eventId, jobId: pending.jobId ?? null, kind: receipt.kind, state: "unrecorded", durable: false, reason: result?.reason ?? null });
        }
      }
      return { checked: evidence.entries.length, acknowledged, pending: [...state.receipts.keys()], stale, sessionFile: evidence.sessionFile };
    } catch (err) {
      recordCapture({ at: now(), kind: "receipt-check", outcome: "failed", error: err?.message || String(err), pending: [...state.receipts.keys()] }, env);
      return { checked: 0, acknowledged: [], pending: [...state.receipts.keys()], stale, reason: "receipt-check-failed", error: err?.message || String(err) };
    }
  }

  // Track a deferred check's handle so a session replacement can cancel it. The
  // scheduler is injectable, so a return value that is neither a cancel function
  // nor a Node timer handle is simply left alone — cancellation is never load
  // bearing (the generation check below is).
  function trackReceiptTimer(handle) {
    if (!handle) return;
    if (typeof handle === "function") {
      state.receiptTimers.add(handle);
      return;
    }
    if (typeof handle === "object" && typeof handle.hasRef === "function") {
      state.receiptTimers.add(() => clearTimeout(handle));
    }
  }

  function cancelReceiptTimers() {
    for (const cancel of state.receiptTimers) {
      try {
        cancel();
      } catch {
        /* cancellation is best effort; the generation check invalidates anyway */
      }
    }
    state.receiptTimers.clear();
  }

  // Schedule a deferred verification of the outstanding expectations.
  //
  // The context of the session that scheduled it is captured, never resolved
  // later: a deferred check must not read a context pi invalidated (every getter
  // then throws, which used to end the session), and it must not be retargeted at
  // the session that replaced it (that would acknowledge one session's completion
  // from another session's entries). When the session changed, the check is a
  // no-op: the expectations are dropped by generation and the durable records
  // stay pending for the owning session's recovery.
  function scheduleReceiptCheck() {
    if (state.receipts.size === 0) return null;
    const generation = state.sessionGeneration;
    const key = sessionKey();
    const ctx = state.lastCtx;
    const check = () => {
      if (state.sessionGeneration !== generation || sessionKey() !== key) {
        recordCapture({ at: now(), kind: "receipt-check", outcome: "stale-schedule", generation, current: state.sessionGeneration }, env);
        return { checked: 0, acknowledged: [], pending: [...state.receipts.keys()], stale: true, reason: "stale-session" };
      }
      return flushReceipts(ctx);
    };
    let handle = null;
    try {
      handle = scheduleReceipt(check);
    } catch (err) {
      recordCapture({ at: now(), kind: "receipt-check", outcome: "schedule-failed", error: err?.message || String(err) }, env);
      return null;
    }
    trackReceiptTimer(handle);
    return handle;
  }

  // Any custom message of this profile that carries an event identity is a
  // completion that reached the session's message stream: message_start is the
  // drain out of pi's queue, message_end the point pi persists it. Both are
  // registrations, not acknowledgements.
  function noteDeliveryMessage(event) {
    const message = event?.message;
    if (message?.role !== "custom" || message.customType !== ARCHITECT_COMPLETION_CUSTOM_TYPE) return false;
    const eventId = message.details?.eventId;
    if (typeof eventId !== "string" || !eventId) return false;
    expectReceipt({
      eventId,
      jobId: message.details?.jobId ?? null,
      role: message.details?.role ?? null,
      text: messageText(message),
    });
    // message_start is the drain out of pi's queue: from here the message is
    // retention (the receipt), not a queued copy recovery could duplicate.
    releaseInFlight(eventId);
    return true;
  }

  function steer(notification, text, reason) {
    const details = completionDetails(notification);
    // The expectation is registered BEFORE the send: a fake/early runtime that
    // consumes the message synchronously inside sendMessage must not be lost,
    // and nothing is claimed before the evidence check. The in-flight claim is
    // registered before the send too: pi queues the custom steer on the agent
    // synchronously, and a synchronous drain (message_start) must clear the
    // claim rather than have it re-added after the fact.
    if (details.eventId) {
      expectReceipt({ ...details, text, kind: "steer" });
      holdInFlight(details.eventId);
    }
    try {
      pi.sendMessage({ customType: ARCHITECT_COMPLETION_CUSTOM_TYPE, content: text, display: true, details }, { deliverAs: "steer" });
    } catch (err) {
      // The send never reached pi's queue; nothing is in flight.
      if (details.eventId) releaseInFlight(details.eventId);
      throw err;
    }
    // Consumption observed while we were sending is the strongest fact: report
    // it so the router records `delivered` instead of the volatile queue state.
    const receipt = details.eventId ? state.acknowledged.get(details.eventId) ?? null : null;
    if (receipt) {
      state.deliveries.push({ eventId: details.eventId, state: "delivered", reason, receiptKind: receipt.kind });
      return { state: "delivered", reason, receipt };
    }
    state.deliveries.push({ eventId: details.eventId, state: "queued", reason });
    return { state: "queued", reason };
  }

  const transport = {
    name: "pi",
    // Ready + idle → start a turn so the completion reaches the operator
    // immediately (including on a reopened session nobody has spoken in yet).
    // Ready + busy → queue/steer, which is delivered between the current turn's
    // tool calls and never aborts or replaces the operator's active work.
    // Not ready → send nothing and claim nothing: the durable record stays
    // pending and the readiness tick (or a later recovery) delivers it.
    deliver: async (notification) => {
      const text = notification?.text ?? "";
      if (!text) return { state: "failed", reason: "empty-notification" };
      if (!state.sessionReady) {
        state.deferred.push({ eventId: notification.eventId, role: notification.role ?? null, at: now() });
        return { state: "failed", reason: "session-opening" };
      }
      const details = completionDetails(notification);
      const ctx = state.lastCtx;
      let idle = false;
      try {
        // Reading a pi context is guarded for the same reason as the receipt
        // path: after a session replacement every getter throws. A session that
        // can no longer be inspected must not be written to either — nothing is
        // claimed, and the durable record stays volatile for the recovery of the
        // session that owns the event.
        idle = typeof ctx?.isIdle === "function" ? ctx.isIdle() : false;
      } catch (err) {
        state.deliveries.push({ eventId: notification.eventId, state: "failed", reason: "stale-session-context" });
        return { state: "failed", reason: "stale-session-context", error: err?.message || String(err) };
      }
      try {
        if (!idle) return steer(notification, text, "session-busy");
        // The idle branch wakes the session with a regular user message (the
        // operator's live wakeup, unchanged). Its receipt is pi starting a turn
        // for this text, confirmed later by the exact session entry.
        if (details.eventId) expectReceipt({ ...details, text, kind: "user-message" });
        pi.sendUserMessage(text);
        const observed = details.eventId ? state.acknowledged.get(details.eventId) ?? null : null;
        const receipt = observed ?? { kind: "turn-started", eventId: details.eventId ?? null, at: now(), confirmed: false };
        state.deliveries.push({ eventId: details.eventId, state: "delivered", receiptKind: receipt.kind });
        return { state: "delivered", receipt };
      } catch (err) {
        // A wake can lose a race with a prompt the operator (or Paseo) submitted
        // in the same instant. Queue instead of failing when that is the cause;
        // report anything else truthfully.
        if (/already processing|streaming/i.test(err?.message ?? "")) return steer(notification, text, "session-busy-race");
        state.deliveries.push({ eventId: notification.eventId, state: "failed", reason: err?.message });
        return { state: "failed", reason: err?.message || String(err) };
      }
    },
  };

  let workflow = null;
  function ensureWorkflow() {
    if (workflow) return workflow;
    workflow = workflowFactory({
      root: cwd,
      sessionKey: sessionKey(),
      env,
      notifierTransport: transport,
      executionLauncher,
    });
    return workflow;
  }

  // ------------------------------------------------------------------- tools
  const tools = WORKFLOW_TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    promptSnippet: tool.description.split(". ")[0],
    parameters: tool.parameters,
    async execute(_toolCallId, params) {
      const result = await ensureWorkflow().callTool(tool.name, params ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        isError: result && result.ok === false ? true : false,
      };
    },
  }));

  function registerTools(schemas) {
    for (let index = 0; index < tools.length; index += 1) {
      pi.registerTool({ ...tools[index], parameters: schemas[index] });
    }
  }

  function enforceToolSurface(ctx) {
    const available = typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool) => tool.name ?? tool) : ARCHITECT_ALLOWED_TOOLS;
    const desired = ARCHITECT_ALLOWED_TOOLS.filter((name) => available.length === 0 || available.includes(name));
    state.activeTools = desired;
    if (typeof pi.setActiveTools === "function") pi.setActiveTools(desired);
    return desired;
  }

  // ------------------------------------------------------------------ events

  // The readiness tick: the session is open, so delivery and restart recovery can
  // run. Every start reason recovers (the pi runtime emits `startup` for a plain
  // CLI session and for `--session <file>`, `resume`/`new`/`fork` from the SDK
  // runtime, and `reload` for `/reload`); ownership is checked per job inside
  // recovery, so a replay can never reach another session.
  async function runReadyTick(reason) {
    state.sessionReady = true;
    const wf = ensureWorkflow();
    const deferred = state.deferred.length;
    state.deferred = [];
    try {
      // Receipts observed before this tick are written first, then recovery runs
      // against the same session evidence: an event this session already holds
      // is acknowledged, and only an event it provably never held is re-sent.
      const receipts = flushReceipts(state.lastCtx);
      const recovered = await wf.recoverDeliveries({ transport, evidence: sessionEvidence(state.lastCtx) });
      state.recovery = recovered;
      const summary = { ...summarizeRecovery(recovered), deferred, receipts: receipts.acknowledged.length, reason, at: now() };
      state.recoveries.push(summary);
      recordCapture({ at: now(), kind: "recovery", reason, deferred, receipts: receipts.acknowledged, recovered: summarizeRecovery(recovered) }, env);
      return recovered;
    } catch (err) {
      state.recovery = { ok: false, error: err?.message || String(err), reason };
      recordCapture({ at: now(), kind: "recovery-failed", reason, deferred, error: err?.message || String(err) }, env);
      return state.recovery;
    }
  }

  function scheduleReady(reason) {
    state.readyPromise = new Promise((resolve) => {
      schedule(() => {
        resolve(runReadyTick(reason));
      });
    });
    return state.readyPromise;
  }

  pi.on("session_start", async (event, ctx) => {
    state.lastCtx = ctx;
    state.operatorActive = false;
    state.sessionReady = options.interactive ?? false;
    ensurePrompt();
    enforceToolSurface(ctx);
    // Record the runtime's effective compaction settings for this session (the
    // window-dependent part of the policy check runs at compaction time).
    const compactionRuntime = loadCompactionRuntime();
    state.compactionPolicy = inspectCompactionPolicy({ settings: compactionRuntime, policy: compaction });
    recordCapture(
      {
        at: now(),
        kind: "compaction-runtime",
        effective: compactionRuntime,
        policy: { ...compaction },
        findings: state.compactionPolicy.findings,
      },
      env,
    );
    const wf = ensureWorkflow();
    if (typeof ctx?.ui?.setStatus === "function") {
      ctx.ui.setStatus(ARCHITECT_EXTENSION_NAME, `architect ${wf.session().sessionId.slice(0, 8)}`);
    }
    const reason = typeof event?.reason === "string" && event.reason ? event.reason : "startup";
    state.sessionReason = reason;
    // A new session start either continues the session this extension was
    // reloaded into (`reload`: same agent, same session file, same steer queue)
    // or replaces it with a different one. The generation identifies the session
    // an outstanding receipt expectation belongs to; a replacement invalidates
    // the deferred checks scheduled for the session that is gone, so no check can
    // ever read the replaced session's context or be retargeted at the new one.
    state.sessionGeneration += 1;
    cancelReceiptTimers();
    if (reason === "reload") {
      // Same session continues: the outstanding expectations still describe the
      // live session (and its queue), so they are re-bound to this generation
      // rather than dropped.
      for (const pending of state.receipts.values()) pending.session = state.sessionGeneration;
    }
    // `/reload` rebuilds this extension around the SAME live agent (and the
    // steer queue on it), so any in-flight claim still describes that queue and
    // must survive. Every other start reason replaces the session the claim was
    // about, so the claim is dropped with it.
    if (reason !== "reload") releaseAllInFlight();
    recordCapture({ at: now(), kind: "session_start", reason, recoveryDeferred: !state.sessionReady }, env);
    if (state.sessionReady) {
      // Already-open session (embedder/test): recover inline, under the caller.
      state.readyPromise = runReadyTick(reason);
      return state.readyPromise;
    }
    scheduleReady(reason);
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const systemPromptOptions = event?.systemPromptOptions ?? {};
    const assembled = assembleArchitectSystemPrompt({
      ownedPrompt: ensurePrompt(),
      contextFiles: systemPromptOptions.contextFiles ?? [],
      skills: systemPromptOptions.skills ?? [],
      cwd: systemPromptOptions.cwd ?? cwd,
    });
    state.systemPrompt = assembled;
    const inspection = inspectAssembledPrompt(assembled);
    recordCapture(
      {
        at: now(),
        kind: "assembled",
        inspection,
        incomingStockMarkers: inspectAssembledPrompt(event?.systemPrompt ?? "").stockMarkers,
        promptChars: assembled.length,
      },
      env,
    );
    return { systemPrompt: assembled };
  });

  // Provider boundary: whatever earlier layers appended, the payload that goes
  // on the wire carries exactly the assembled Architect prompt.
  pi.on("before_provider_request", async (event) => {
    const prompt = state.systemPrompt ?? assembleArchitectSystemPrompt({ ownedPrompt: ensurePrompt(), cwd });
    const enforced = enforceProviderPayloadPrompt(event?.payload, prompt);
    recordCapture(
      {
        at: now(),
        kind: "provider_payload",
        replaced: enforced.replaced,
        path: enforced.path,
        inspection: inspectAssembledPrompt(prompt),
        activeTools: state.activeTools,
      },
      env,
    );
    return enforced.replaced ? enforced.payload : undefined;
  });

  pi.on("tool_call", async (event) => {
    const name = event?.toolName;
    if (typeof name !== "string") return undefined;
    if (ARCHITECT_ALLOWED_TOOLS.includes(name)) return undefined;
    const reason = ARCHITECT_DENIED_TOOLS.includes(name)
      ? `'${name}' is not available in the Architect profile: local mutation and shell execution are deliberately excluded. Delegate through the managed pipeline instead.`
      : `'${name}' is not part of the Architect profile tool surface.`;
    return { block: true, reason };
  });

  // Compaction policy. pi's shared setting disables auto-compaction; this
  // profile compacts itself before the context window is exhausted.
  pi.on("turn_end", async (_event, ctx) => {
    state.lastCtx = ctx;
    scheduleReceiptCheck();
    return maybeCompact(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    state.lastCtx = ctx;
    // The run has fully settled. pi drains its steering queue before a run ends
    // normally, and the interactive abort discards it, so a completion that was
    // never observed draining is no longer provably queued anywhere. The claim
    // is bounded to the run that accepted it: from here the durable record and
    // the persisted evidence decide — one possible re-delivery is preferable to
    // a wakeup permanently blocked by a queue that no longer exists.
    releaseAllInFlight();
    scheduleReceiptCheck();
    return maybeCompact(ctx);
  });

  // Effective pi compaction settings for this session, read once through the
  // documented settings-file channel and cached. A read failure falls back to
  // pi's documented defaults; the profile never writes these files.
  function loadCompactionRuntime() {
    if (state.compactionRuntime) return state.compactionRuntime;
    try {
      state.compactionRuntime = loadCompactionSettings({ cwd, env });
    } catch (err) {
      state.compactionRuntime = { ...PI_COMPACTION_DEFAULTS, sources: [], error: err?.message || String(err) };
    }
    return state.compactionRuntime;
  }

  // Surface a retention divergence once per session: the profile cannot change
  // another scope's settings, so the operator is told instead of being left with
  // an invisible policy mismatch.
  function surfaceCompactionPolicy(ctx, policy) {
    if (!policy || policy.ok || state.compactionPolicyNotified) return false;
    state.compactionPolicyNotified = true;
    recordCapture({ at: now(), kind: "compaction-policy", findings: policy.findings, effective: policy.effective }, env);
    const codes = policy.findings.map((finding) => finding.code).join(", ");
    const detail = `reserveTokens=${policy.effective.reserveTokens}, keepRecentTokens=${policy.effective.keepRecentTokens}${policy.window ? `, context window ${policy.window}` : ""}`;
    if (typeof ctx?.ui?.notify === "function") {
      ctx.ui.notify(
        `qq-workflows Architect: pi's effective compaction settings diverge from this profile's policy (${codes}: ${detail}). The profile still compacts this session at its own threshold; adjust pi's compaction settings if the runtime retention should match the profile.`,
        "warning",
      );
    }
    return true;
  }

  async function maybeCompact(ctx) {
    if (!compaction.enabled) return { compacted: false, reason: "disabled" };
    if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) {
      return { compacted: false, reason: "streaming" };
    }
    if (state.compacting) return { compacted: false, reason: "in-flight" };
    if (typeof ctx?.getContextUsage !== "function" || typeof ctx?.compact !== "function") {
      return { compacted: false, reason: "no-context-api" };
    }
    const usage = ctx.getContextUsage();
    if (!usage || typeof usage.tokens !== "number") return { compacted: false, reason: "no-usage" };
    const window = typeof usage.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : null;
    // The runtime owns the retention budget and the model's reserve; the profile
    // observes both and folds the larger reserve into its own trigger, so a
    // runtime with more headroom compacts earlier instead of overflowing.
    const runtime = loadCompactionRuntime();
    const policy = inspectCompactionPolicy({ settings: runtime, policy: compaction, contextWindow: window });
    state.compactionPolicy = policy;
    surfaceCompactionPolicy(ctx, policy);
    const reserve = Math.max(compaction.reserveTokens, effectiveNumber(runtime.reserveTokens, PI_COMPACTION_DEFAULTS.reserveTokens));
    const fraction = window ? usage.tokens / window : 0;
    const overReserve = window && window > reserve ? usage.tokens >= window - reserve : false;
    const overFraction = fraction >= compaction.triggerFraction;
    if (!overFraction && !overReserve) return { compacted: false, reason: "below-threshold", tokens: usage.tokens, fraction };
    if (now() - state.lastCompactionAt < compaction.minIntervalMs) {
      return { compacted: false, reason: "cooldown", tokens: usage.tokens, fraction };
    }
    state.compacting = true;
    state.lastCompactionAt = now();
    const attempt = { at: now(), tokens: usage.tokens, fraction, window: window ?? null, reason: overReserve ? "reserve" : "threshold" };
    try {
      ctx.compact({
        customInstructions:
          "Preserve the ticket state, operator decisions, open questions, running job ids, report references, and the recovery boundary. Drop raw tool output that is already persisted in a report.",
        onComplete: () => {
          state.compacting = false;
          state.compactions = [...(state.compactions ?? []), { ...attempt, outcome: "completed" }];
          recordCapture({ kind: "compaction", outcome: "completed", ...attempt }, env);
        },
        onError: (error) => {
          state.compacting = false;
          state.compactions = [...(state.compactions ?? []), { ...attempt, outcome: "failed", error: error?.message }];
          recordCapture({ kind: "compaction", outcome: "failed", error: error?.message, ...attempt }, env);
        },
      });
    } catch (err) {
      state.compacting = false;
      return { compacted: false, reason: "compact-threw", error: err?.message };
    }
    return { compacted: true, attempt };
  }

  // Operator-facing recovery command: explicitly replay undelivered completion
  // results with wake semantics, or report that there is nothing to replay.
  pi.registerCommand("qq_recover", {
    description: "Reconcile durable workflow jobs and retry undelivered completion notifications.",
    handler: async (_args, ctx) => {
      state.lastCtx = ctx;
      // An explicit operator command proves the session is open, so manual
      // recovery may wake an idle session even before the readiness tick.
      state.sessionReady = true;
      const wf = ensureWorkflow();
      flushReceipts(ctx);
      // An explicit operator command is the one path allowed to retry an event
      // whose receipt cannot be proven; the automatic tick never does.
      const recovered = await wf.recoverDeliveries({
        transport,
        evidence: sessionEvidence(ctx),
        allowUnverified: true,
      });
      if (typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(
          `qq-workflows recovery: ${recovered.delivery.replayed.length} replayed, ${recovered.delivery.duplicates.length} already delivered, ${recovered.delivery.reconciled.length} acknowledged from this session, ${recovered.delivery.deferred.length} still queued here, ${recovered.delivery.uncertain.length} unverifiable, ${(recovered.delivery.errors ?? []).length} unreconciled, ${recovered.delivery.orphaned.length} owned by another session, ${recovered.jobs.filter((job) => job.status === "interrupted" || job.status === "reconciliation-required").length} needing a decision`,
          "info",
        );
      }
      return recovered;
    },
  });

  // The drain out of pi's queue (`message_start`) and the point pi persists the
  // message (`message_end`). Both only register the expectation: the receipt is
  // verified on a later task, because pi appends the session entry after its
  // extension handlers returned.
  pi.on("message_start", async (event, ctx) => {
    state.lastCtx = ctx ?? state.lastCtx;
    if (noteDeliveryMessage(event)) scheduleReceiptCheck();
  });

  pi.on("message_end", async (event, ctx) => {
    state.lastCtx = ctx ?? state.lastCtx;
    // Observability only: a user message proves the operator has spoken in this
    // session. Wake eligibility does not depend on it — a completion must be
    // able to wake a reopened session the operator has not spoken in yet.
    if (event?.message?.role === "user") state.operatorActive = true;
    noteDeliveryMessage(event);
    scheduleReceiptCheck();
  });

  return {
    name: ARCHITECT_EXTENSION_NAME,
    tools,
    transport,
    state,
    ensureWorkflow,
    runReadyTick,
    sessionEvidence,
    flushReceipts,
    scheduleReceiptCheck,
    completionDetails,
    completionCustomType: ARCHITECT_COMPLETION_CUSTOM_TYPE,
    whenReady: () => state.readyPromise,
    maybeCompact,
    loadCompactionRuntime,
    surfaceCompactionPolicy,
    registerTools,
    enforceToolSurface,
    allowedTools: ARCHITECT_ALLOWED_TOOLS,
    deniedTools: ARCHITECT_DENIED_TOOLS,
    promptMarker: ARCHITECT_PROMPT_MARKER,
    extensionFile: ARCHITECT_EXTENSION_FILE,
    profileEnv: ARCHITECT_PROFILE_ENV,
  };
}

function summarizeRecovery(recovered) {
  return {
    ok: recovered?.ok !== false,
    replayed: recovered?.delivery?.replayed?.length ?? 0,
    duplicates: recovered?.delivery?.duplicates?.length ?? 0,
    reconciled: recovered?.delivery?.reconciled?.length ?? 0,
    deferred: recovered?.delivery?.deferred?.length ?? 0,
    uncertain: recovered?.delivery?.uncertain?.length ?? 0,
    orphaned: recovered?.delivery?.orphaned?.length ?? 0,
    interrupted: (recovered?.jobs ?? []).filter((job) => job.status === "interrupted").length,
    reconciliationRequired: (recovered?.jobs ?? []).filter((job) => job.status === "reconciliation-required").length,
  };
}

export default async function qqArchitect(pi) {
  const extension = createArchitectExtension(pi);
  const schemas = await toolSchemas(WORKFLOW_TOOLS);
  extension.registerTools(schemas);
  return () => {};
}
