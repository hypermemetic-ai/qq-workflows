#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as miniDocs from "../src/mini-docs.mjs";
import { MINI_SWE_COMPLETION_COMMAND, MINI_PAGER_EXPORT } from "../src/official-mini.mjs";

const WRITER_PROMPT = "You are the unattended architect-orientation wiki writer.";

function createAgentContext() {
  const sections = [];
  const registeredTools = [];
  const restrictions = [];
  const listeners = [];
  const operations = [];
  const hostCalls = [];
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

  const ctx = {
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
      restrict(spec) {
        operations.push("restrict");
        const record = { spec, active: true };
        restrictions.push(record);
        return () => { record.active = false; };
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
    ctx,
    hostCalls,
    listeners,
    operations,
    registeredTools,
    restrictions,
    sections,
    runtimeSuppressed: () => runtimeSuppressed,
  };
}

function docsAgent(id, ctx, header = { kind: miniDocs.MINI_DOCS_KIND }) {
  return { session: { id, header }, ctx, steers: [], steer(message) { this.steers.push(message); } };
}

assert.equal(miniDocs.name, "qq-mini-docs");
assert.deepEqual(miniDocs.inject, ["agents"]);
assert.equal(miniDocs.MINI_DOCS_KIND, "mini-docs");
assert.equal(miniDocs.MINI_DOCS_COMPLETION_COMMAND, "echo COMPLETE_DOCS_AND_EXIT");
assert.equal(miniDocs.isMiniDocsCompletionCommand("  echo COMPLETE_DOCS_AND_EXIT\n"), true);
assert.equal(miniDocs.isMiniDocsCompletionCommand("echo COMPLETE_DOCS_AND_EXIT && true"), false);
assert.equal(miniDocs.isMiniDocsAgent({ header: { kind: "mini-docs" } }), true);
assert.equal(miniDocs.isMiniDocsAgent({ session: { header: { agentPreset: "mini-docs" } } }), true);
assert.equal(miniDocs.isMiniDocsAgent({ session: { header: { kind: "mini" } } }), false);

// Persona, bash-only catalog, and Mini's model-visible command-only schema.
const mounted = createAgentContext();
miniDocs.miniDocsSetup(mounted.ctx, { env: { QQ_WIKI_WRITER_PROMPT: WRITER_PROMPT } });
assert.equal(mounted.runtimeSuppressed(), true);
assert.deepEqual(mounted.sections, [{
  name: "deployment:persona",
  order: 0,
  text: WRITER_PROMPT,
  complete: true,
}]);
assert.deepEqual(mounted.operations.slice(0, 2), ["restrict", "register:bash"]);
assert.deepEqual(
  mounted.restrictions.filter((record) => record.active).map((record) => record.spec),
  [{ allow: ["bash"] }],
);
assert.deepEqual(mounted.registeredTools.map((tool) => tool.name), ["bash"]);
assert.deepEqual(Object.keys(mounted.registeredTools[0].parameters.properties), ["command"]);
assert.equal("sandbox_permissions" in mounted.registeredTools[0].parameters.properties, false);
assert.equal(mounted.registeredTools[0].isConcurrencySafe(), false);
assert.equal(mounted.listeners.length, 2);

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
miniDocs.miniDocsSetup(formatMount.ctx, { env: { QQ_WIKI_WRITER_PROMPT: WRITER_PROMPT } });
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
miniDocs.miniDocsSetup(validFormatMount.ctx, { env: { QQ_WIKI_WRITER_PROMPT: WRITER_PROMPT } });
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
nextGeneration.miniDocsSetup(mounted.ctx, { env: { QQ_WIKI_WRITER_PROMPT: "replacement writer" } });
assert.equal(mounted.sections.length, 1);
assert.equal(mounted.sections[0].text, "replacement writer");
assert.deepEqual(mounted.registeredTools.map((tool) => tool.name), ["bash"]);
assert.equal(mounted.restrictions.filter((record) => record.active).length, 1);
assert.equal(mounted.listeners.length, 2);

// Config env wins; process env is the fallback; blank config env fails loudly.
const originalPrompt = process.env.QQ_WIKI_WRITER_PROMPT;
try {
  delete process.env.QQ_WIKI_WRITER_PROMPT;
  const missingEnvMount = createAgentContext();
  assert.throws(
    () => miniDocs.miniDocsSetup(missingEnvMount.ctx),
    /non-blank QQ_WIKI_WRITER_PROMPT/,
  );

  process.env.QQ_WIKI_WRITER_PROMPT = "process writer";
  const processEnvMount = createAgentContext();
  miniDocs.miniDocsSetup(processEnvMount.ctx);
  assert.equal(processEnvMount.sections[0].text, "process writer");

  const configEnvMount = createAgentContext();
  miniDocs.miniDocsSetup(configEnvMount.ctx, { env: { QQ_WIKI_WRITER_PROMPT: "config writer" } });
  assert.equal(configEnvMount.sections[0].text, "config writer");

  const blankEnvMount = createAgentContext();
  assert.throws(
    () => miniDocs.miniDocsSetup(blankEnvMount.ctx, { env: { QQ_WIKI_WRITER_PROMPT: " \n\t" } }),
    /non-blank QQ_WIKI_WRITER_PROMPT/,
  );
  assert.equal(blankEnvMount.sections.length, 0);
  assert.equal(blankEnvMount.registeredTools.length, 0);
} finally {
  if (originalPrompt === undefined) delete process.env.QQ_WIKI_WRITER_PROMPT;
  else process.env.QQ_WIKI_WRITER_PROMPT = originalPrompt;
}

// apply() mounts only live/new mini-docs agents, including agentPreset detection.
const candidates = [
  ["live-kind", { kind: "mini-docs" }],
  ["live-preset", { agentPreset: "mini-docs" }],
  ["live-mini", { kind: "mini" }],
  ["live-review", { kind: "mini-review" }],
  ["live-architect", { kind: "architect" }],
  ["live-chair", {}],
].map(([id, header]) => {
  const harness = createAgentContext();
  return { agent: docsAgent(id, harness.ctx, header), harness };
});
const applyListeners = [];
const applyCtx = {
  get(service) {
    if (service === "agents") return { list: () => candidates.map(({ agent }) => agent) };
    return undefined;
  },
  on(type, fn) { applyListeners.push({ type, fn }); return () => {}; },
};
miniDocs.apply(applyCtx, { env: { QQ_WIKI_WRITER_PROMPT: WRITER_PROMPT } });
assert.deepEqual(candidates.map(({ harness }) => harness.registeredTools.length), [1, 1, 0, 0, 0, 0]);
assert.deepEqual(candidates.map(({ harness }) => harness.sections.length), [1, 1, 0, 0, 0, 0]);

const createdListener = applyListeners.find((record) => record.type === "agent/created").fn;
const createdDocsHarness = createAgentContext();
createdListener({ agent: docsAgent("created-docs", createdDocsHarness.ctx) });
assert.deepEqual(createdDocsHarness.registeredTools.map((tool) => tool.name), ["bash"]);
const createdChairHarness = createAgentContext();
createdListener({ agent: docsAgent("created-chair", createdChairHarness.ctx, {}) });
assert.equal(createdChairHarness.registeredTools.length, 0);

// Keep the no-Land/no-submit/no-commit fence explicit in this adapter.
const source = readFileSync(new URL("../src/mini-docs.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /bindMiniSubmit|armChildSettlement|adoptImplementer|adoptReviewer|git\s+commit|submit_review/);
assert.match(source, /wrapMiniBash\(tools\.get\("bash"\), \{ interceptCompletion: false \}\)/);

console.log("mini-docs tests passed");
