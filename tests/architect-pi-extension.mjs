#!/usr/bin/env node
// The pi Architect profile: owned system prompt at the provider boundary, tool
// surface isolation, compaction policy, identity binding, and completion
// delivery (idle wake vs busy queue) with durable recovery.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArchitectExtension } from "../pi-extension/qq-architect.mjs";
import {
  ARCHITECT_COMPACTION,
  ARCHITECT_EXTENSION_FILE,
  ARCHITECT_PROMPT_MARKER,
  ARCHITECT_PROVIDER_ID,
  ARCHITECT_PROVIDER_LABEL,
  ARCHITECT_READ_ONLY_TOOLS,
  PI_COMPACTION_DEFAULTS,
  architectProviderEntry,
  assembleArchitectSystemPrompt,
  enforceProviderPayloadPrompt,
  inspectAssembledPrompt,
  inspectCompactionPolicy,
  loadArchitectPrompt,
  readPiCompactionSettings,
} from "../workflow/architect-profile.mjs";
import { createWorkflow, WORKFLOW_TOOL_NAMES } from "../workflow/operations.mjs";
import { loadManagedExecutionLauncher } from "../pi-extension/managed-execution.mjs";
import { deliveryPending, readJob, recordTerminal, createJob } from "../workflow/jobs.mjs";
import { createJob as _createJob } from "../workflow/jobs.mjs";
import { agentTransport, callHandlers, fakeContext, fakePi, runnerSpawner, tempRepo, tickQueue, waitForJobTerminal } from "./support/architect-fixtures.mjs";

const { root, env, agentDir } = await tempRepo({ agents: "Repository rule: never edit outside the worktree.\n" });
const capturePath = join(root, "prompt-capture.jsonl");
const stateDir = join(root, ".architect", "state");
const extensionEnv = {
  ...env,
  QQ_ARCHITECT_PROFILE: "1",
  PASEO_AGENT_ID: "paseo-agent-777",
  QQ_ARCHITECT_OWNER_AGENT_ID: "paseo-agent-777",
  QQ_ARCHITECT_PROMPT_CAPTURE: capturePath,
};

function buildExtension({
  interactive = false,
  compaction = null,
  env: overrideEnv = null,
  workflowFactory = null,
  readCompactionSettings = null,
} = {}) {
  const pi = fakePi({ existingTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "task"] });
  // The readiness tick is scheduled, never inline (production uses setTimeout(0));
  // tests drive it explicitly so a still-opening session is observable.
  const scheduled = tickQueue();
  const extension = createArchitectExtension(pi, {
    env: overrideEnv ?? extensionEnv,
    cwd: root,
    interactive,
    schedule: scheduled.schedule,
    ...(compaction ? { compaction } : {}),
    ...(workflowFactory ? { workflowFactory } : {}),
    ...(readCompactionSettings ? { readCompactionSettings } : {}),
  });
  // Mirrors the real load path: pi runs the extension factory (which registers
  // the workflow tools) before the first session event.
  extension.registerTools(extension.tools.map((tool) => tool.parameters));
  return { pi, extension, scheduled };
}

// The deferred readiness tick, as the runtime would run it after session_start
// returned; returns the recovery summary the tick produced.
async function becomeReady({ pi, extension, scheduled }) {
  await scheduled.flush();
  return extension.whenReady();
}

// ---------------------------------------------------------------------------
// P1. Owned prompt: full replacement, controlled inclusion of repo instructions.
// ---------------------------------------------------------------------------
const ownedPrompt = loadArchitectPrompt();
assert.ok(ownedPrompt.startsWith("You are the architect"), "the owned Architecture prompt is loaded from the repository role file");
assert.ok(!ownedPrompt.startsWith("---"), "frontmatter is stripped from the owned prompt");
assert.ok(existsSync(ARCHITECT_EXTENSION_FILE), "the provider entry points at an installed extension file");
assert.equal(ARCHITECT_PROVIDER_ID, "qq-architect");

const assembled = assembleArchitectSystemPrompt({
  ownedPrompt,
  contextFiles: [{ path: join(root, "AGENTS.md"), content: "Repository rule: never edit outside the worktree." }],
  skills: [{ name: "paseo", description: "Paseo reference" }],
  cwd: root,
});
assert.equal(inspectAssembledPrompt(assembled).ok, true);
assert.ok(assembled.includes("Repository rule: never edit outside the worktree."), "repository instructions are preserved through one controlled mechanism");
assert.ok(assembled.includes("paseo: Paseo reference"));
assert.ok(!assembled.includes("expert coding assistant"), "the stock coding prompt is not part of the Architect prompt");
assert.equal(inspectAssembledPrompt(`${assembled}\n\nYou are an expert coding assistant operating inside pi`).ok, false);
assert.equal(inspectAssembledPrompt(`${assembled}${ARCHITECT_PROMPT_MARKER}`).ownedMarkerCount, 2, "a duplicate owned prompt is detectable");
assert.equal(architectProviderEntry().command[1], "--no-extensions", "the Architect launches without global pi extensions");

// Provider-level payload shapes are all normalized to the assembled prompt. The
// list is the set of shapes pi 0.84.1 actually serializes for selectable models:
// Responses `instructions` and `input`, chat-completions/Mistral `messages`
// (`system` or `developer` role), Anthropic `system` blocks, Bedrock `system`
// blocks with a bare `text` field, and Google `systemInstruction` either as a
// string or as `{parts:[{text}]}` inside `config`.
for (const payload of [
  { instructions: "STOCK", input: [] },
  { system: "STOCK" },
  { system: [{ type: "text", text: "STOCK" }] },
  { system: [{ text: "STOCK" }] },
  { system: [{ type: "text", text: "STOCK", cache_control: { type: "ephemeral" } }, { type: "text", text: "STOCK-APPEND" }] },
  { messages: [{ role: "system", content: "STOCK" }, { role: "user", content: "hi" }] },
  { messages: [{ role: "developer", content: "STOCK" }] },
  { input: [{ role: "developer", content: "STOCK" }, { role: "user", content: [{ type: "input_text", text: "hi" }] }] },
  { input: [{ role: "system", content: [{ type: "input_text", text: "STOCK" }] }] },
  { systemInstruction: "STOCK" },
  { systemInstruction: { role: "system", parts: [{ text: "STOCK" }, { text: "STOCK-APPEND" }] } },
  { model: "google/gemini", contents: [], config: { systemInstruction: "STOCK" } },
]) {
  const enforced = enforceProviderPayloadPrompt(payload, "OWNED-PROMPT");
  assert.equal(enforced.replaced, true, `enforced: ${JSON.stringify(payload)}`);
  assert.equal(JSON.stringify(enforced.payload).includes("STOCK"), false, `append removed: ${JSON.stringify(enforced.payload)}`);
  assert.equal(JSON.stringify(enforced.payload).includes("OWNED-PROMPT"), true, `owned prompt present: ${JSON.stringify(enforced.payload)}`);
}
// A text block that carried cache metadata keeps it; unrelated parts survive.
const cacheEnforced = enforceProviderPayloadPrompt(
  { system: [{ type: "text", text: "STOCK", cache_control: { type: "ephemeral" } }, { type: "image", data: "x" }] },
  "OWNED-PROMPT",
);
assert.equal(cacheEnforced.payload.system[0].cache_control.type, "ephemeral");
assert.equal(cacheEnforced.payload.system[1].type, "image");
// A system slot with no text block still receives the owned prompt (inserted),
// because the system instruction must never be someone else's.
const inserted = enforceProviderPayloadPrompt({ messages: [{ role: "system", content: [{ type: "image", data: "x" }] }] }, "OWNED-PROMPT");
assert.equal(inserted.replaced, true);
assert.equal(inserted.payload.messages[0].content[0].text, "OWNED-PROMPT");
assert.equal(inserted.payload.messages[0].content[1].type, "image", "non-text blocks are preserved");
const insertedParts = enforceProviderPayloadPrompt({ systemInstruction: { role: "system", parts: [{ inlineData: {} }] } }, "OWNED-PROMPT");
assert.equal(insertedParts.replaced, true);
assert.equal(insertedParts.payload.systemInstruction.parts[0].text, "OWNED-PROMPT");

// No system slot at all is reported truthfully rather than claimed.
assert.equal(enforceProviderPayloadPrompt({ input: [] }, "x").replaced, false);
assert.equal(enforceProviderPayloadPrompt({ messages: [{ role: "user", content: "hi" }] }, "x").replaced, false);
assert.equal(enforceProviderPayloadPrompt(null, "x").replaced, false);

// ---------------------------------------------------------------------------
// P2. The extension replaces the final prompt and neutralizes Paseo appends.
// ---------------------------------------------------------------------------
const { pi, extension } = buildExtension();
assert.deepEqual(
  pi.registered.map((tool) => tool.name).sort(),
  [...WORKFLOW_TOOL_NAMES].sort(),
  "every native workflow tool (including managed execution delegation) is registered",
);
for (const tool of pi.registered) {
  assert.equal(typeof tool.execute, "function");
  assert.equal(tool.parameters.type, "object");
}

const ctx = fakeContext();
await callHandlers(pi, "session_start", { reason: "startup" }, ctx);
assert.deepEqual(
  pi.activeTools,
  [...ARCHITECT_READ_ONLY_TOOLS, ...WORKFLOW_TOOL_NAMES],
  "the active tool surface is read-only inspection plus native workflow tools",
);
for (const denied of ["bash", "edit", "write"]) {
  assert.equal(pi.activeTools.includes(denied), false, `${denied} must not be active in the Architect profile`);
}
assert.ok(ctx.statuses.some((status) => status.key === "qq-architect"), "the session exposes its workflow identity");

const beforeStart = await callHandlers(
  pi,
  "before_agent_start",
  {
    prompt: "hello",
    systemPrompt: "You are an expert coding assistant operating inside pi\nAvailable tools:\n- bash\n- edit",
    systemPromptOptions: {
      contextFiles: [{ path: join(root, "AGENTS.md"), content: "Repository rule: never edit outside the worktree." }],
      skills: [{ name: "paseo", description: "Paseo reference" }],
      cwd: root,
    },
  },
  ctx,
);
const finalPrompt = beforeStart[0].systemPrompt;
assert.ok(finalPrompt.includes(ARCHITECT_PROMPT_MARKER));
assert.ok(!finalPrompt.includes("expert coding assistant"), "the stock pi coding prompt is fully replaced");
assert.ok(finalPrompt.includes("Repository rule: never edit outside the worktree."));
assert.equal(inspectAssembledPrompt(finalPrompt).ok, true);

// Paseo's generated extension appends to the pi prompt after ours; the provider
// boundary must still carry exactly the owned prompt.
const paseoAppended = `${finalPrompt}\n\nPASEO RUNTIME TOOL INSTRUCTIONS (appended after the Architect profile)`;
const payloadEvent = { payload: { instructions: paseoAppended, input: [] } };
const [enforcedPayload] = await callHandlers(pi, "before_provider_request", payloadEvent, ctx);
assert.ok(enforcedPayload.instructions.startsWith(ARCHITECT_PROMPT_MARKER), "the provider payload starts with the owned prompt");
assert.ok(!enforcedPayload.instructions.includes("PASEO RUNTIME TOOL INSTRUCTIONS"), "an uncontrolled append is removed at the provider boundary");
assert.equal(inspectAssembledPrompt(enforcedPayload.instructions).ok, true);

const capture = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const assembledCapture = capture.find((entry) => entry.kind === "assembled");
assert.ok(assembledCapture, "the assembled prompt is captured for verification");
assert.equal(assembledCapture.inspection.ok, true);
assert.ok(assembledCapture.incomingStockMarkers.length >= 1, "the capture records the stock prompt that was replaced");
const payloadCapture = capture.find((entry) => entry.kind === "provider_payload");
assert.equal(payloadCapture.replaced, true);
assert.equal(payloadCapture.inspection.ok, true);
assert.ok(payloadCapture.activeTools.includes("read_ticket"));

// ---------------------------------------------------------------------------
// P3. Tool guard: no direct mutation path, and workflow tools stay available.
// ---------------------------------------------------------------------------
for (const name of ["bash", "edit", "write", "apply_patch", "task"]) {
  const [blocked] = await callHandlers(pi, "tool_call", { toolName: name }, ctx);
  assert.equal(blocked.block, true, `${name} is blocked`);
  assert.match(blocked.reason, /Architect profile/);
}
for (const name of [...ARCHITECT_READ_ONLY_TOOLS, ...WORKFLOW_TOOL_NAMES]) {
  const [allowed] = await callHandlers(pi, "tool_call", { toolName: name }, ctx);
  assert.equal(allowed, undefined, `${name} is allowed`);
}

// Ticket capability works through the registered tool, scoped to the agent key.
const ticketTool = pi.registered.find((tool) => tool.name === "update_ticket");
const updated = await ticketTool.execute("call-1", { content: "# Ticket\n\n## Problem\n\npaseo-native architect\n" });
assert.equal(updated.details.ok, true);
const readTool = pi.registered.find((tool) => tool.name === "read_ticket");
const readResult = await readTool.execute("call-2", { section: "Problem" });
assert.match(readResult.details.content, /paseo-native architect/);
assert.ok(readResult.details.path.includes(extension.ensureWorkflow().session().sessionId), "the ticket is keyed by the Paseo agent id");

// ---------------------------------------------------------------------------
// P4. Compaction policy: Architect-specific threshold, cooldown, no streaming.
// ---------------------------------------------------------------------------
const bigWindow = 200_000;
const below = fakeContext({ tokens: 10_000, contextWindow: bigWindow });
const [belowResult] = await callHandlers(pi, "turn_end", {}, below);
assert.equal(belowResult.compacted, false);
assert.equal(belowResult.reason, "below-threshold");
assert.equal(below.compactCalls.length, 0);

const above = fakeContext({ tokens: Math.ceil(bigWindow * (ARCHITECT_COMPACTION.triggerFraction + 0.01)), contextWindow: bigWindow });
const [aboveResult] = await callHandlers(pi, "turn_end", {}, above);
assert.equal(aboveResult.compacted, true);
assert.equal(above.compactCalls.length, 1);
assert.match(above.compactCalls[0].customInstructions, /ticket state/);
assert.equal(typeof above.compactCalls[0].onComplete, "function");
assert.equal(above.compactCalls[0].onError.length, 1);

above.compactCalls[0].onComplete();
const streaming = fakeContext({ tokens: bigWindow, contextWindow: bigWindow, idle: false });
const [streamingResult] = await callHandlers(pi, "turn_end", {}, streaming);
assert.equal(streamingResult.compacted, false, "compaction never runs while the operator's turn is streaming");
assert.equal(streamingResult.reason, "streaming");

// Cooldown plus in-flight guard: one attempt per window.
const { pi: compactPi, extension: compactExtension } = buildExtension();
const cooldownCtx = fakeContext({ tokens: bigWindow - 1, contextWindow: bigWindow });
const [first] = await callHandlers(compactPi, "turn_end", {}, cooldownCtx);
assert.equal(first.compacted, true);
const [second] = await callHandlers(compactPi, "turn_end", {}, cooldownCtx);
assert.equal(second.compacted, false);
assert.equal(second.reason, "in-flight", "a second trigger is refused while a compaction is in flight");
assert.equal(cooldownCtx.compactCalls.length, 1);
assert.equal(compactExtension.state.compacting, true);
cooldownCtx.compactCalls[0].onComplete();
assert.equal(compactExtension.state.compacting, false);
const [third] = await callHandlers(compactPi, "turn_end", {}, cooldownCtx);
assert.equal(third.compacted, false);
assert.equal(third.reason, "cooldown", "one compaction per interval bounds a long session");
assert.equal(cooldownCtx.compactCalls.length, 1);

// A profile with compaction disabled never compacts (the policy is explicit, not global).
const { pi: noCompactPi } = buildExtension({ compaction: { enabled: false } });
const [disabledResult] = await callHandlers(noCompactPi, "turn_end", {}, fakeContext({ tokens: bigWindow, contextWindow: bigWindow }));
assert.equal(disabledResult.compacted, false);
assert.equal(disabledResult.reason, "disabled");

// ---------------------------------------------------------------------------
// P4b. The runtime's effective compaction settings are observed, not assumed.
//
// pi 0.84.1's `ctx.compact(options)` accepts only customInstructions (no
// retention budget) and reads `keepRecentTokens`/`reserveTokens` from pi's
// settings files, which this profile must not rewrite. The profile therefore
// READS them through that documented channel, verifies them against its own
// policy, and reports a divergence.
// ---------------------------------------------------------------------------
const settingsFile = join(agentDir, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: false } }), "utf8");
const readBack = readPiCompactionSettings({ cwd: root, env: extensionEnv });
assert.equal(readBack.enabled, false, "the operator's shared setting is honoured, never rewritten");
assert.equal(readBack.keepRecentTokens, PI_COMPACTION_DEFAULTS.keepRecentTokens, "an unset retention budget falls back to pi's own default");
assert.equal(readBack.reserveTokens, PI_COMPACTION_DEFAULTS.reserveTokens);
assert.deepEqual(readBack.sources, [settingsFile], "the settings file that decided the effective policy is reported");
// Project settings override global ones, exactly as pi resolves them.
mkdirSync(join(root, ".pi"), { recursive: true });
writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 5_000 } }), "utf8");
const projectScoped = readPiCompactionSettings({ cwd: root, env: extensionEnv });
assert.equal(projectScoped.keepRecentTokens, 5_000);
assert.equal(projectScoped.enabled, false, "an unmentioned key keeps the global value");
const before = readFileSync(settingsFile, "utf8");

// A retention floor below the profile's is reported, not silently accepted.
const { pi: policyPi, extension: policyExtension } = buildExtension({
  readCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 5_000, sources: ["stub"] }),
});
const policyCtx = fakeContext({ tokens: 10_000, contextWindow: bigWindow });
await callHandlers(policyPi, "session_start", { reason: "startup" }, policyCtx);
const policyCapture = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  .filter((entry) => entry.kind === "compaction-runtime").pop();
assert.ok(policyCapture, "the effective compaction settings are captured for verification");
assert.deepEqual(policyCapture.findings.map((finding) => finding.code), ["retention-below-profile-floor"]);
assert.equal(policyCapture.effective.keepRecentTokens, 5_000);
await callHandlers(policyPi, "turn_end", {}, policyCtx);
assert.equal(policyCtx.notifications.length, 1, "a policy divergence is surfaced to the operator once");
assert.match(policyCtx.notifications[0].message, /retention-below-profile-floor/);
assert.equal(policyCtx.notifications[0].level, "warning");
await callHandlers(policyPi, "agent_settled", {}, fakeContext({ tokens: 10_000, contextWindow: bigWindow }));
assert.equal(policyCtx.notifications.length, 1, "the divergence warning is not repeated every turn");
assert.equal(policyExtension.state.compactionPolicy.effective.keepRecentTokens, 5_000);

// A retention budget that cannot free room inside the window is reported too.
const tightWindow = 40_000;
const { pi: tightPi } = buildExtension({
  readCompactionSettings: () => ({ enabled: true, reserveTokens: PI_COMPACTION_DEFAULTS.reserveTokens, keepRecentTokens: 20_000, sources: ["stub"] }),
});
const tightCtx = fakeContext({ tokens: 30_000, contextWindow: tightWindow });
await callHandlers(tightPi, "turn_end", {}, tightCtx);
assert.equal(tightCtx.notifications.length, 1);
assert.match(tightCtx.notifications[0].message, /retention-exceeds-window-budget/);
assert.equal(tightCtx.compactCalls.length, 1, "the profile still compacts at its own threshold");

// The effective runtime reserve widens the profile's own trigger: with a
// runtime reserve of 100k a 110k-token context must compact even though the
// profile's own 75%-of-window threshold would not fire yet.
const reservePi = buildExtension({
  readCompactionSettings: () => ({ enabled: false, reserveTokens: 100_000, keepRecentTokens: PI_COMPACTION_DEFAULTS.keepRecentTokens, sources: ["stub"] }),
});
const reserveCtx = fakeContext({ tokens: 110_000, contextWindow: bigWindow });
const [reserveResult] = await callHandlers(reservePi.pi, "turn_end", {}, reserveCtx);
assert.equal(reserveResult.compacted, true, "the runtime's reserve is folded into the Architect trigger");
assert.equal(reserveCtx.compactCalls.length, 1);

// The profile only ever reads pi's settings.
const tightDir = join(root, ".pi");
assert.equal(readFileSync(join(tightDir, "settings.json"), "utf8").includes("keepRecentTokens"), true);
assert.equal(readFileSync(settingsFile, "utf8"), before, "the profile never rewrites pi settings");
assert.equal(readdirSync(agentDir).join(","), "settings.json", "no settings backup or sidecar is written");

// Leave the shared fixture root as it was: the rest of this file must observe
// pi's defaults, not the deliberately divergent project settings above.
rmSync(join(root, ".pi", "settings.json"), { force: true });
assert.equal(readPiCompactionSettings({ cwd: root, env: extensionEnv }).keepRecentTokens, PI_COMPACTION_DEFAULTS.keepRecentTokens);

// The policy check itself is pure and truthful, including the window budget.
assert.equal(inspectCompactionPolicy({ settings: { keepRecentTokens: 20_000 }, contextWindow: 200_000 }).ok, true);
assert.equal(inspectCompactionPolicy({ settings: { keepRecentTokens: 1_000 } }).findings[0].code, "retention-below-profile-floor");
assert.equal(inspectCompactionPolicy({ settings: {}, contextWindow: 30_000 }).findings[0].code, "retention-exceeds-window-budget");

// ---------------------------------------------------------------------------
// P5. Completion delivery: idle starts a turn, busy queues without interrupting.
// ---------------------------------------------------------------------------
const { pi: deliveryPi, extension: deliveryExtension } = buildExtension({ interactive: true });
const idleCtx = fakeContext({ idle: true });
await callHandlers(deliveryPi, "session_start", { reason: "startup" }, idleCtx);
await callHandlers(deliveryPi, "message_end", { message: { role: "user" } }, idleCtx);

const idleDelivery = await deliveryExtension.transport.deliver({ eventId: "runner:1:terminal", text: "runner finished" });
assert.equal(idleDelivery.state, "queued", "idle invocation has no receipt yet");
assert.equal(idleDelivery.receipt, undefined, "a void Pi call is not evidence of a retained message");
assert.equal(deliveryPi.sent.at(-1).kind, "user", "an idle completion starts a turn");
assert.equal(deliveryPi.sent.at(-1).content, "runner finished");

idleCtx.idle = false;
const busyDelivery = await deliveryExtension.transport.deliver({ eventId: "runner:2:terminal", jobId: "job-2", role: "runner", text: "runner finished while busy" });
assert.equal(busyDelivery.state, "queued", "queue acceptance is not a receipt");
assert.equal(deliveryPi.sent.at(-1).kind, "message");
assert.equal(deliveryPi.sent.at(-1).options.deliverAs, "steer", "a busy session queues/steers instead of interrupting the active turn");
assert.equal(deliveryPi.sent.at(-1).message.customType, deliveryExtension.completionCustomType);
assert.deepEqual(deliveryPi.sent.at(-1).message.details, {
  eventId: "runner:2:terminal",
  jobId: "job-2",
  role: "runner",
  kind: null,
  reportId: null,
}, "the steered completion carries the stable identity pi persists into the session entry");
assert.equal(deliveryExtension.state.receipts.get("runner:2:terminal").jobId, "job-2", "the receipt expectation is registered before the send");

const emptyDelivery = await deliveryExtension.transport.deliver({ eventId: "runner:3:terminal", text: "" });
assert.equal(emptyDelivery.state, "failed");
assert.equal(emptyDelivery.reason, "empty-notification");

// ---------------------------------------------------------------------------
// P5b. Readiness gate: while pi is still opening the session nothing is sent and
//      nothing is claimed, and the readiness tick then replays the completion to
//      the idle session (a Paseo reopen nobody has spoken in yet still wakes).
// ---------------------------------------------------------------------------
const readinessSessionKey = "paseo-agent-readiness";
const readinessEnv = { ...extensionEnv, PASEO_AGENT_ID: readinessSessionKey, QQ_ARCHITECT_OWNER_AGENT_ID: readinessSessionKey };
const readinessWorkflow = createWorkflow({
  root,
  sessionKey: readinessSessionKey,
  env: readinessEnv,
  spawnFn: runnerSpawner({ response: "readiness findings" }),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "failed", reason: "session closed" }) },
});
const readinessDispatch = readinessWorkflow.dispatchRunner({ task: "ran while this session was closed" });
await waitForJobTerminal(readinessWorkflow.stateDir, readinessDispatch.jobId, { requireDelivery: true });

const { pi: awaitingPi, extension: awaitingExtension, scheduled: awaitingScheduled } = buildExtension({ env: readinessEnv });
const awaitingCtx = fakeContext({ idle: true });
await callHandlers(awaitingPi, "session_start", { reason: "startup" }, awaitingCtx);
assert.equal(awaitingPi.sent.length, 0, "session_start itself never fabricates a turn");
assert.equal(awaitingExtension.state.sessionReady, false, "the session is not ready while the start handler runs");

// A completion offered during opening is neither sent nor claimed: the durable
// record stays pending so recovery can still deliver it exactly once.
const duringOpening = await awaitingExtension.ensureWorkflow().recoverDeliveries({ transport: awaitingExtension.transport });
assert.deepEqual(duringOpening.delivery.replayed, [], "nothing is replayed before the session is ready");
assert.equal(awaitingPi.sent.length, 0, "nothing is queued into pi before the session is ready");
const openingJob = readJob(stateDir, readinessDispatch.jobId);
assert.equal(openingJob.delivery.state, "failed", "an opening-time attempt never claims delivery");
assert.equal(openingJob.delivery.reason, "session-opening");
assert.equal(deliveryPending(stateDir, readinessDispatch.jobId), true, "the undelivered result stays recoverable");

const readyRecovery = await becomeReady({ pi: awaitingPi, extension: awaitingExtension, scheduled: awaitingScheduled });
assert.equal(awaitingExtension.state.sessionReady, true, "the readiness tick opens delivery");
assert.deepEqual(readyRecovery.delivery.replayed.map((entry) => entry.jobId), [readinessDispatch.jobId], "the readiness tick replays the pending completion");
assert.equal(readJob(stateDir, readinessDispatch.jobId).delivery.state, "queued");
assert.equal(awaitingExtension.state.operatorActive, false, "the operator never spoke in this session");
assert.ok(awaitingPi.sent.some((entry) => entry.kind === "user" && entry.content.includes("readiness findings")), "an idle reopened session is woken by the recovered completion");
assert.equal(awaitingPi.sent.filter((entry) => entry.kind === "user").length, 1, "the completion is delivered exactly once");

// ---------------------------------------------------------------------------
// P6. Identity and recovery: durable state survives a session restart.
// ---------------------------------------------------------------------------
const sessionKey = "paseo-agent-777";
const workflow = deliveryExtension.ensureWorkflow();
assert.equal(workflow.session().sessionKey, sessionKey, "the Paseo agent ID is the workflow session key");
assert.equal(workflow.root, root, "the Architect is bound to the repository root it was opened in");

// A completion that never reached the session is replayed on restart, and only
// for its owning agent.
const wf = createWorkflow({
  root,
  sessionKey,
  env: extensionEnv,
  spawnFn: runnerSpawner({ response: "orphaned findings" }),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "failed", reason: "session closed" }) },
});
const orphanDispatch = wf.dispatchRunner({ task: "ran while the session was closed" });
await waitForJobTerminal(wf.stateDir, orphanDispatch.jobId, { requireDelivery: true });
const orphanJob = readJob(stateDir, orphanDispatch.jobId);
assert.equal(orphanJob.status, "completed");
assert.equal(orphanJob.delivery.state, "failed", "a delivery that never landed stays recorded as failed");
assert.ok(orphanJob.terminal.reportId, "the result is durable even though delivery failed");

// `startup` is the reason the pi runtime actually emits for a fresh CLI session
// and for `--session <file>` — the shape Paseo opens. The operator never speaks
// in this scenario: the seed is an undelivered terminal result from before the
// reopen.
const { pi: restartPi, extension: restartExtension, scheduled: restartScheduled } = buildExtension({ env: { ...extensionEnv } });
const restartCtx = fakeContext({ idle: true });
await callHandlers(restartPi, "session_start", { reason: "startup" }, restartCtx);
assert.equal(restartExtension.state.sessionReason, "startup");
// Resume must reproduce the same profile: identical tool surface, owned prompt,
// and prompt enforcement at the provider boundary.
assert.deepEqual(
  restartPi.activeTools,
  [...ARCHITECT_READ_ONLY_TOOLS, ...WORKFLOW_TOOL_NAMES],
  "resume reconstructs the same active tool surface",
);
const [resumePrompt] = await callHandlers(
  restartPi,
  "before_agent_start",
  { prompt: "continue", systemPrompt: "You are an expert coding assistant operating inside pi", systemPromptOptions: { contextFiles: [], skills: [], cwd: root } },
  restartCtx,
);
assert.equal(inspectAssembledPrompt(resumePrompt.systemPrompt).ok, true, "resume keeps the owned Architect prompt");
const [resumePayload] = await callHandlers(
  restartPi,
  "before_provider_request",
  { payload: { instructions: `${resumePrompt.systemPrompt}\n\nSTOCK APPEND AFTER RESUME` } },
  restartCtx,
);
assert.equal(resumePayload.instructions.includes("STOCK APPEND AFTER RESUME"), false);
assert.equal(inspectAssembledPrompt(resumePayload.instructions).ok, true);

const recoveredState = await becomeReady({ pi: restartPi, extension: restartExtension, scheduled: restartScheduled });
assert.ok(recoveredState, "a startup session triggers completion recovery");
assert.equal(restartExtension.state.recoveries.at(-1).reason, "startup", "recovery records the reason the runtime emitted");
assert.equal(restartExtension.state.operatorActive, false, "recovery does not wait for the operator to speak");
assert.ok(recoveredState.delivery.replayed.some((entry) => entry.jobId === orphanDispatch.jobId), "the undelivered result is replayed to its owning session");
assert.equal(readJob(stateDir, orphanDispatch.jobId).delivery.state, "queued");
assert.ok(restartPi.sent.some((entry) => entry.kind === "user" && entry.content.includes("orphaned findings")), "the recovered completion wakes the reopened idle session");
assert.equal(
  readFileSync(capturePath, "utf8").includes('"kind":"recovery"'),
  true,
  "recovery is recorded for verification",
);
assert.equal(
  readFileSync(capturePath, "utf8").includes('"kind":"session_start","reason":"startup"'),
  true,
  "the capture records the runtime session_start reason",
);

// Recovery is reason-independent: the contract must not depend on a reason this
// pi runtime never emits ("create" does not exist; the CLI always starts with
// "startup" and the SDK runtime uses new/resume/fork).
for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
  const agentId = `paseo-agent-${reason}`;
  const reasonEnv = { ...extensionEnv, PASEO_AGENT_ID: agentId, QQ_ARCHITECT_OWNER_AGENT_ID: agentId };
  const reasonWorkflow = createWorkflow({
    root,
    sessionKey: agentId,
    env: reasonEnv,
    spawnFn: runnerSpawner({ response: `${reason} findings` }),
    notifierTransport: { name: "offline", deliver: async () => ({ state: "failed", reason: "session closed" }) },
  });
  const reasonDispatch = reasonWorkflow.dispatchRunner({ task: `ran while ${reason} was closed` });
  await waitForJobTerminal(reasonWorkflow.stateDir, reasonDispatch.jobId, { requireDelivery: true });

  const { pi: reasonPi, extension: reasonExtension, scheduled: reasonScheduled } = buildExtension({ env: reasonEnv });
  await callHandlers(reasonPi, "session_start", { reason }, fakeContext({ idle: true }));
  const reasonRecovery = await becomeReady({ pi: reasonPi, extension: reasonExtension, scheduled: reasonScheduled });
  assert.equal(reasonExtension.state.recoveries.at(-1).reason, reason, `recovery runs for the runtime reason '${reason}'`);
  assert.deepEqual(reasonRecovery.delivery.replayed.map((entry) => entry.jobId), [reasonDispatch.jobId], `'${reason}' replays the undelivered result exactly once`);
  assert.equal(reasonPi.sent.filter((entry) => entry.kind === "user").length, 1, `'${reason}' wakes the idle session once`);
}

// A completion belonging to a different agent is never replayed into this session.
const otherStateDir = join(root, ".architect", "state");
const other = createWorkflow({
  root,
  sessionKey: "paseo-agent-other",
  env: { ...extensionEnv, PASEO_AGENT_ID: "paseo-agent-other" },
  notifierTransport: { name: "offline", deliver: async () => ({ state: "failed", reason: "session closed" }) },
});
const otherJob = createJob({
  stateDir: otherStateDir,
  id: "other-agent-job",
  role: "runner",
  workflow: { sessionKey: "paseo-agent-other", sessionId: other.session().sessionId, root },
  cwd: root,
});
recordTerminal(otherStateDir, otherJob.id, { status: "completed", summary: "another agent's result" });
const secondRecovery = await restartExtension.ensureWorkflow().recoverDeliveries({ transport: restartExtension.transport });
assert.ok(secondRecovery.delivery.orphaned.some((entry) => entry.jobId === otherJob.id), "another agent's pending result is reported as orphaned, never delivered here");

// The operator-facing recovery command reports truthfully.
assert.equal(typeof restartPi.commands.qq_recover.handler, "function");
await restartPi.commands.qq_recover.handler("", restartCtx);
assert.ok(restartCtx.notifications.some((entry) => /qq-workflows recovery/.test(entry.message)));

// ---------------------------------------------------------------------------
// P6b. Managed execution delegation is wired as a library call (no MCP) and
// refuses when the repository pipeline is unavailable.
// ---------------------------------------------------------------------------
const phases = [];
const stubPipeline = {
  // The stub stands in for the installed pipeline, so it must present the same
  // central worker launch contract the real module exposes.
  assertNoProviderOverrides: () => {},
  WORKER_SEATS: ["runner", "implementer", "reviewer"],
  dispatchExecution: async ({ kind, sessionId }) => ({ ok: true, id: "exec-1", status: "running", kind, sessionId }),
  checkExecution: async () => {
    phases.push("checked");
    return phases.length < 2
      ? { status: "running", phase: "implementing" }
      : { status: "completed", phase: "landed", result: { verifiedStory: "landed" }, error: null };
  },
};
const launcher = loadManagedExecutionLauncher({ importModule: async () => stubPipeline });
const launchResult = await launcher({
  kind: "bounded",
  cwd: root,
  sessionId: workflow.session().sessionId,
  onPhase: (phase) => phases.push(phase),
});
assert.equal(launchResult.ok, true);
assert.equal(launchResult.status, "completed");
assert.equal(launchResult.executionId, "exec-1");
assert.ok(phases.includes("implementing"), "phase transitions are reported to the durable record");
await assert.rejects(
  () => loadManagedExecutionLauncher({ importModule: async () => ({}) })({ kind: "bounded", cwd: root, sessionId: "s" }),
  /managed execution pipeline is unavailable/,
  "a missing managed pipeline is reported instead of falling back to a direct mutation path",
);
// A stale pipeline that would launch the seats through some other harness is
// refused rather than silently used.
await assert.rejects(
  () => loadManagedExecutionLauncher({ importModule: async () => ({ dispatchExecution: async () => ({ id: "x" }), checkExecution: async () => ({ status: "completed" }) }) })({ kind: "bounded", cwd: root, sessionId: "s" }),
  /does not use the central worker launch contract/,
  "a pipeline without the central launch contract is refused",
);

const execToolWorkflow = createWorkflow({
  root,
  sessionKey: sessionKey,
  env: extensionEnv,
  notifierTransport: agentTransport({ name: "exec-tool" }),
  executionLauncher: async ({ onPhase }) => {
    onPhase?.("implementing");
    return { ok: true, status: "completed", phase: "landed", result: { verifiedStory: "ok" } };
  },
});
const execDispatch = await execToolWorkflow.callTool("dispatch_execution", { kind: "bounded" });
assert.equal(execDispatch.ok, true);
const execSettled = await waitForJobTerminal(execToolWorkflow.stateDir, execDispatch.jobId, { requireDelivery: true });
assert.equal(execSettled.status, "completed");
assert.equal(execSettled.role, "execution");

// ---------------------------------------------------------------------------
// P7. An unconfigured session never invents a workflow identity.
// ---------------------------------------------------------------------------
const bare = createWorkflow({ root, sessionKey: null, env: { QQ_WORKER_CONFIG_FILE: env.QQ_WORKER_CONFIG_FILE } });
assert.throws(() => bare.session(), /no workflow session identity/);
assert.equal(agentTransport().delivered.length, 0);

console.log("architect pi extension tests passed");
