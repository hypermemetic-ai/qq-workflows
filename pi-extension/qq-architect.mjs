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

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ARCHITECT_COMPACTION,
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

  function steer(notification, text, reason) {
    pi.sendMessage({ customType: "qq-workflow-completion", content: text, display: true }, { deliverAs: "steer" });
    state.deliveries.push({ eventId: notification.eventId, state: "queued", reason });
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
      const ctx = state.lastCtx;
      const idle = typeof ctx?.isIdle === "function" ? ctx.isIdle() : false;
      try {
        if (!idle) return steer(notification, text, "session-busy");
        pi.sendUserMessage(text);
        state.deliveries.push({ eventId: notification.eventId, state: "delivered" });
        return { state: "delivered" };
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
      const recovered = await wf.recoverDeliveries({ transport });
      state.recovery = recovered;
      const summary = { ...summarizeRecovery(recovered), deferred, reason, at: now() };
      state.recoveries.push(summary);
      recordCapture({ at: now(), kind: "recovery", reason, deferred, recovered: summarizeRecovery(recovered) }, env);
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
    return maybeCompact(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    state.lastCtx = ctx;
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
      const recovered = await wf.recoverDeliveries({ transport });
      if (typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(
          `qq-workflows recovery: ${recovered.delivery.replayed.length} replayed, ${recovered.delivery.duplicates.length} already delivered, ${recovered.delivery.orphaned.length} owned by another session, ${recovered.jobs.filter((job) => job.status === "interrupted" || job.status === "reconciliation-required").length} needing a decision`,
          "info",
        );
      }
      return recovered;
    },
  });

  // Observability only: a user message proves the operator has spoken in this
  // session. Wake eligibility does not depend on it — a completion must be able
  // to wake a reopened session the operator has not spoken in yet.
  pi.on("message_end", async (event) => {
    if (event?.message?.role === "user") state.operatorActive = true;
  });

  return {
    name: ARCHITECT_EXTENSION_NAME,
    tools,
    transport,
    state,
    ensureWorkflow,
    runReadyTick,
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
