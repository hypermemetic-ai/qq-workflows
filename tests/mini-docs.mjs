#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as miniDocs from "../src/mini-docs.mjs";
import { internals as pluginInternals } from "../src/plugin.mjs";
import { MINI_SWE_COMPLETION_COMMAND, MINI_PAGER_EXPORT } from "../src/official-mini.mjs";

const WRITER_PROMPT = "You are the unattended repository-index writer.";

function createAgentContext({ withCore = true } = {}) {
  const sections = [];
  const registeredTools = [];
  const surfaceCalls = [];
  const listeners = [];
  const operations = [];
  const hostCalls = [];
  const provided = new Map();
  const provideCalls = [];
  let runtimeSuppressed = false;

  const hostBash = {
    name: "bash",
    description: "Host bash with host-only controls",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        sandbox_permissions: { type: "string" },
      },
    },
    async execute(args) {
      hostCalls.push(args);
      return {
        kind: "foreground",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 0,
        stdout: { text: "host bash ran\n", truncated: false },
        stderr: { text: "", truncated: false },
      };
    },
  };

  const agent = { id: "mini-docs-mount" };
  const qqCore = withCore ? { surface: { allow(actualAgent, names) {
    operations.push("allow");
    surfaceCalls.push({ agent: actualAgent, names: [...names] });
  } } } : undefined;
  const ctx = {
    agent,
    get(name) {
      assert.equal(name, "qq-core");
      return provided.get(name) ?? qqCore;
    },
    provide(name, value) {
      operations.push(`provide:${name}`);
      provideCalls.push({ name, value });
      provided.set(name, value);
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {
          const index = sections.indexOf(section);
          if (index >= 0) sections.splice(index, 1);
        };
      },
      suppressRuntimeContext() { runtimeSuppressed = true; },
    },
    tools: {
      get(toolName) {
        if (toolName !== "bash") return undefined;
        return [...registeredTools].reverse().find((tool) => tool.name === toolName) ?? hostBash;
      },
      register(tool) {
        operations.push(`register:${tool.name}`);
        registeredTools.push(tool);
        return () => {
          const index = registeredTools.indexOf(tool);
          if (index >= 0) registeredTools.splice(index, 1);
        };
      },
    },
    effect(effect) { return effect(); },
    on(type, fn) {
      const record = { type, fn };
      listeners.push(record);
      return () => {
        const index = listeners.indexOf(record);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };

  return {
    agent,
    ctx,
    hostCalls,
    listeners,
    operations,
    provideCalls,
    registeredTools,
    surfaceCalls,
    sections,
    runtimeSuppressed: () => runtimeSuppressed,
  };
}

function docsAgent(id, ctx, header = { kind: miniDocs.MINI_DOCS_KIND }) {
  const agent = { session: { id, header }, ctx, steers: [], steer(message) { this.steers.push(message); } };
  ctx.agent = agent;
  return agent;
}

assert.equal(miniDocs.name, undefined, "mini-docs is an adapter, not a Cordis plugin");
assert.equal(miniDocs.apply, undefined, "mini-docs stays an adapter mounted by the host plugin");
assert.equal(miniDocs.MINI_DOCS_KIND, "mini-docs");
assert.equal(miniDocs.MINI_DOCS_COMPLETION_COMMAND, "echo COMPLETE_DOCS_AND_EXIT");
assert.equal(miniDocs.isMiniDocsCompletionCommand("  echo COMPLETE_DOCS_AND_EXIT\n"), true);
assert.equal(miniDocs.isMiniDocsCompletionCommand("echo COMPLETE_DOCS_AND_EXIT && true"), false);
assert.equal(miniDocs.isMiniDocsAgent({ header: { kind: "mini-docs" } }), true);
assert.equal(miniDocs.isMiniDocsAgent({ session: { header: { agentPreset: "mini-docs" } } }), true);
assert.equal(miniDocs.isMiniDocsAgent({ session: { header: { kind: "mini" } } }), false);

// Persona, bash-only catalog, and Mini's model-visible command-only schema.
const mounted = createAgentContext();
miniDocs.miniDocsSetup(mounted.ctx, { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } });
assert.equal(mounted.runtimeSuppressed(), true);
assert.deepEqual(mounted.sections, [{
  name: "deployment:persona",
  order: 0,
  text: WRITER_PROMPT,
  complete: true,
}]);
assert.deepEqual(mounted.operations.slice(0, 2), ["allow", "register:bash"]);
assert.deepEqual(mounted.surfaceCalls, [{ agent: mounted.agent, names: ["bash"] }]);
assert.deepEqual(mounted.registeredTools.map((tool) => tool.name), ["bash"]);
assert.deepEqual(Object.keys(mounted.registeredTools[0].parameters.properties), ["command"]);
assert.equal("sandbox_permissions" in mounted.registeredTools[0].parameters.properties, false);
assert.equal(mounted.registeredTools[0].isConcurrencySafe(), false);
assert.equal(mounted.listeners.length, 2);

// A headless writer profile without qq-core receives a frozen no-op surface
// before inherited-tool setup, then mounts the persona and bash wrapper.
const headlessMount = createAgentContext({ withCore: false });
miniDocs.miniDocsSetup(headlessMount.ctx, { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } });
assert.equal(headlessMount.provideCalls.length, 1);
assert.equal(headlessMount.provideCalls[0].name, "qq-core");
assert.equal(Object.isFrozen(headlessMount.provideCalls[0].value), true);
assert.equal(Object.isFrozen(headlessMount.provideCalls[0].value.surface), true);
assert.equal(typeof headlessMount.provideCalls[0].value.surface.allow, "function");
assert.deepEqual(headlessMount.operations.slice(0, 2), ["provide:qq-core", "register:bash"]);
assert.equal(headlessMount.sections[0].text, WRITER_PROMPT);
assert.deepEqual(headlessMount.registeredTools.map((tool) => tool.name), ["bash"]);

// The docs sentinel concludes successfully without reaching host bash or Land.
const completionAgent = docsAgent("session-docs-complete", mounted.ctx);
let concluded = 0;
const completion = await mounted.registeredTools[0].execute(
  { command: " \necho COMPLETE_DOCS_AND_EXIT\t" },
  { agent: completionAgent, concludeTurn() { concluded++; } },
);
assert.equal(completion.kind, "foreground");
assert.equal(completion.exitCode, 0);
assert.equal(concluded, 1);
assert.equal(mounted.hostCalls.length, 0);

// Mini's implementation sentinel is ordinary bash because interception is disabled.
const miniCompletion = await mounted.registeredTools[0].execute(
  { command: MINI_SWE_COMPLETION_COMMAND },
  { agent: docsAgent("session-mini-sentinel", mounted.ctx), concludeTurn() { assert.fail("Mini sentinel must not conclude docs"); } },
);
assert.equal(miniCompletion.exitCode, 0);
assert.equal(mounted.hostCalls.length, 1);
assert.equal(mounted.hostCalls[0].command, `${MINI_PAGER_EXPORT}; ${MINI_SWE_COMPLETION_COMMAND}`);

// A combined docs-looking command is not the exact sentinel and reaches host bash.
await mounted.registeredTools[0].execute(
  { command: "echo COMPLETE_DOCS_AND_EXIT && true" },
  { agent: docsAgent("session-combined", mounted.ctx) },
);
assert.equal(mounted.hostCalls.length, 2);
assert.equal(mounted.hostCalls[1].command, `${MINI_PAGER_EXPORT}; echo COMPLETE_DOCS_AND_EXIT && true`);

// Tool-less responses get Mini-style retries, capped when the third miss occurs.
const formatMount = createAgentContext();
miniDocs.miniDocsSetup(formatMount.ctx, { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } });
const formatSessionEvent = formatMount.listeners.find((record) => record.type === "session/event").fn;
const formatTurnStopping = formatMount.listeners.find((record) => record.type === "agent/turn-stopping").fn;
const formatAgent = docsAgent("session-docs-format", formatMount.ctx);
formatSessionEvent(formatAgent.session, {
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text: "I am done." }] } },
});
formatTurnStopping({ agent: formatAgent });
formatTurnStopping({ agent: formatAgent });
formatTurnStopping({ agent: formatAgent });
formatTurnStopping({ agent: formatAgent });
assert.equal(formatAgent.steers.length, 2);
for (const steer of formatAgent.steers) {
  const text = steer.content[0].text;
  assert.match(text, /bash/);
  assert.match(text, /echo COMPLETE_DOCS_AND_EXIT/);
}

// A bash response resets misses and does not steer.
const validFormatMount = createAgentContext();
miniDocs.miniDocsSetup(validFormatMount.ctx, { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } });
const validSessionEvent = validFormatMount.listeners.find((record) => record.type === "session/event").fn;
const validTurnStopping = validFormatMount.listeners.find((record) => record.type === "agent/turn-stopping").fn;
const validFormatAgent = docsAgent("session-docs-valid-format", validFormatMount.ctx);
validSessionEvent(validFormatAgent.session, {
  type: "assistant/message",
  message: { content: [{ type: "tool-call", name: "bash", arguments: { command: "pwd" } }] },
});
validTurnStopping({ agent: validFormatAgent });
assert.equal(validFormatAgent.steers.length, 0);

// Completion state suppresses format recovery even if a later event lacks bash.
const completionSessionEvent = mounted.listeners.find((record) => record.type === "session/event").fn;
const completionTurnStopping = mounted.listeners.find((record) => record.type === "agent/turn-stopping").fn;
completionSessionEvent(completionAgent.session, {
  type: "assistant/message",
  message: { content: [{ type: "text", text: "finished" }] },
});
completionTurnStopping({ agent: completionAgent });
assert.equal(completionAgent.steers.length, 0);

// A new module generation replaces all lifts instead of stacking them.
const nextGeneration = await import(`../src/mini-docs.mjs?hmr=${Date.now()}`);
nextGeneration.miniDocsSetup(mounted.ctx, { env: { QQ_INDEX_WRITER_PROMPT: "replacement writer" } });
assert.equal(mounted.sections.length, 1);
assert.equal(mounted.sections[0].text, "replacement writer");
assert.deepEqual(mounted.registeredTools.map((tool) => tool.name), ["bash"]);
assert.deepEqual(mounted.surfaceCalls, [
  { agent: mounted.agent, names: ["bash"] },
  { agent: mounted.ctx.agent, names: ["bash"] },
]);
assert.equal(mounted.listeners.length, 2);

// Config env wins; process env is the fallback; blank config env fails loudly.
const originalPrompt = process.env.QQ_INDEX_WRITER_PROMPT;
try {
  delete process.env.QQ_INDEX_WRITER_PROMPT;
  const missingEnvMount = createAgentContext();
  assert.throws(
    () => miniDocs.miniDocsSetup(missingEnvMount.ctx),
    /non-blank QQ_INDEX_WRITER_PROMPT/,
  );

  process.env.QQ_INDEX_WRITER_PROMPT = "process writer";
  const processEnvMount = createAgentContext();
  miniDocs.miniDocsSetup(processEnvMount.ctx);
  assert.equal(processEnvMount.sections[0].text, "process writer");

  const configEnvMount = createAgentContext();
  miniDocs.miniDocsSetup(configEnvMount.ctx, { env: { QQ_INDEX_WRITER_PROMPT: "config writer" } });
  assert.equal(configEnvMount.sections[0].text, "config writer");

  const blankEnvMount = createAgentContext();
  assert.throws(
    () => miniDocs.miniDocsSetup(blankEnvMount.ctx, { env: { QQ_INDEX_WRITER_PROMPT: " \n\t" } }),
    /non-blank QQ_INDEX_WRITER_PROMPT/,
  );
  assert.equal(blankEnvMount.sections.length, 0);
  assert.equal(blankEnvMount.registeredTools.length, 0);
} finally {
  if (originalPrompt === undefined) delete process.env.QQ_INDEX_WRITER_PROMPT;
  else process.env.QQ_INDEX_WRITER_PROMPT = originalPrompt;
}

// A failed surface assignment aborts before persona, bash lookup, or registration.
let failedLookups = 0;
let failedRegistrations = 0;
const failedSurfaceMount = createAgentContext();
failedSurfaceMount.ctx.get = () => ({
  surface: { allow() { throw new Error("docs surface failed"); } },
});
failedSurfaceMount.ctx.tools.get = () => { failedLookups++; return undefined; };
failedSurfaceMount.ctx.tools.register = () => { failedRegistrations++; return () => {}; };
assert.throws(
  () => miniDocs.miniDocsSetup(failedSurfaceMount.ctx, { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } }),
  /docs surface failed/,
);
assert.equal(failedLookups, 0);
assert.equal(failedRegistrations, 0);
assert.equal(failedSurfaceMount.provideCalls.length, 0, "an existing real core is never replaced");
assert.equal(failedSurfaceMount.sections.length, 0);

// Host apply/sync owns lifecycle; the adapter entry remains available explicitly.
const explicitHarness = createAgentContext();
const explicitAgent = docsAgent("explicit-docs", explicitHarness.ctx);
assert.equal(miniDocs.ensureMiniDocsMounted(explicitAgent, { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } }), true);
assert.deepEqual(explicitHarness.registeredTools.map((tool) => tool.name), ["bash"]);
const unrelatedHarness = createAgentContext();
assert.equal(miniDocs.ensureMiniDocsMounted(docsAgent("not-docs", unrelatedHarness.ctx, { kind: "mini-code" }), { env: { QQ_INDEX_WRITER_PROMPT: WRITER_PROMPT } }), false);
assert.equal(unrelatedHarness.registeredTools.length, 0);

// The plugin's live-child synchronization path mounts mini-docs by either
// header marker. A mini-code child receives its own adapter, never mini-docs.
const syncPrompt = process.env.QQ_INDEX_WRITER_PROMPT;
try {
  process.env.QQ_INDEX_WRITER_PROMPT = WRITER_PROMPT;
  const pluginDocsHarness = createAgentContext();
  const pluginDocsAgent = docsAgent("plugin-docs", pluginDocsHarness.ctx, { agentPreset: "mini-docs" });
  assert.equal(pluginInternals.syncLiveDelegationChild(null, pluginDocsAgent), false);
  assert.equal(pluginDocsHarness.sections[0].text, WRITER_PROMPT);
  assert.deepEqual(pluginDocsHarness.registeredTools.map((tool) => tool.name), ["bash"]);
  await pluginDocsHarness.registeredTools[0].execute(
    { command: miniDocs.MINI_DOCS_COMPLETION_COMMAND },
    { agent: pluginDocsAgent },
  );
  assert.equal(pluginDocsHarness.hostCalls.length, 0, "plugin-mounted docs bash intercepts docs completion");

  const pluginCodeHarness = createAgentContext();
  const pluginCodeAgent = docsAgent("plugin-code", pluginCodeHarness.ctx, { kind: "mini-code" });
  assert.equal(pluginInternals.syncLiveDelegationChild(null, pluginCodeAgent), false);
  assert.equal(pluginCodeHarness.sections.some(({ text }) => text === WRITER_PROMPT), false);
  await pluginCodeHarness.registeredTools[0].execute(
    { command: miniDocs.MINI_DOCS_COMPLETION_COMMAND },
    { agent: pluginCodeAgent },
  );
  assert.equal(pluginCodeHarness.hostCalls.length, 1, "mini-code does not receive the docs completion wrapper");
} finally {
  if (syncPrompt === undefined) delete process.env.QQ_INDEX_WRITER_PROMPT;
  else process.env.QQ_INDEX_WRITER_PROMPT = syncPrompt;
}

// Keep the no-Land/no-submit/no-commit fence explicit in this adapter.
const source = readFileSync(new URL("../src/mini-docs.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /bindMiniSubmit|armChildSettlement|adoptImplementer|adoptReviewer|git\s+commit|submit_review/);
assert.match(source, /wrapMiniBash\(tools\.get\("bash"\), \{ interceptCompletion: false \}\)/);

console.log("mini-docs tests passed");
