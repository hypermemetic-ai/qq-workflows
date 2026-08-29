#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearch } from "../src/research.mjs";
import { createResearchStore } from "../src/research-store.mjs";
import { MINI_SWE_COMPLETION_COMMAND } from "../src/mini-swe-v2.mjs";

const scratch = mkdtempSync(join(tmpdir(), "qq-research-run."));
const repo = join(scratch, "repo"); mkdirSync(repo);
writeFileSync(join(repo, "README.md"), "fixture repository\n");
const parentId = "session-44444444-4444-4444-8444-444444444444";
const parent = { session: { id: parentId, header: { cwd: repo } }, options: {} };
const sent = [];
const children = [];

function childContext() {
  const registered = [];
  const surfaceCalls = [];
  const sections = [];
  const listeners = [];
  const hostBashCommands = [];
  const baseBash = {
    name: "bash",
    description: "bash",
    parameters: { command: { type: "string" } },
    async execute(args) {
      hostBashCommands.push(args?.command);
      return {
        kind: "foreground",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 0,
        stdout: { text: "host bash fixture", truncated: false },
        stderr: { text: "", truncated: false },
      };
    },
  };
  const ctx = {
    registered, surfaceCalls, sections, listeners, hostBashCommands,
    systemPrompt: {
      section(value) { sections.push(value); return () => {}; },
      suppressRuntimeContext() {},
    },
    tools: {
      get(name) { return name === "bash" ? (registered.find((tool) => tool.name === name) ?? baseBash) : registered.find((tool) => tool.name === name); },
      register(tool) { registered.push(tool); return () => {}; },
    },
    effect(fn) { return fn(); },
    on(type, fn) { listeners.push({ type, fn }); return () => {}; },
    get(name) {
      if (name === "tools") return this.tools;
      if (name === "systemPrompt") return this.systemPrompt;
      if (name === "qq-core") return {
        surface: { allow(agent, names) { surfaceCalls.push({ agent, names: [...names] }); } },
      };
      return undefined;
    },
  };
  return ctx;
}

const agents = {
  async create(options) {
    const ctx = childContext();
    const child = {
      session: { id: options.sessionId, header: { ...options.meta }, events: [] },
      ctx,
      options: options.agentOptions ?? {},
      followups: [],
      followup(message) { this.followups.push(message); },
    };
    ctx.agent = child;
    options.setup?.(ctx);
    const handle = { agent: child, async dispose() {} };
    children.push(child);
    return handle;
  },
};
let coreRootLookups = 0;
const ctx = {
  get(name) {
    if (name === "qq-relay") return {
      async send(message) { sent.push(message); return { status: "sent" }; },
    };
    if (name === "qq-core") return {
      gitRootForDelegate(cwd) {
        coreRootLookups++;
        assert.equal(cwd, repo);
        return repo;
      },
    };
    if (name === "qq") throw new Error("research must prefer the qq-core handle");
    return null;
  },
};
const parentDir = join(scratch, "research");
const store = createResearchStore(parentDir);
const provider = {
  async search() { return [{ title: "Fixture", url: "https://fixture.test/evidence", snippet: "lead" }]; },
  async get(url) { return { source: url, status: 200, contentType: "text/html", content: "<p>fixture evidence supports the answer</p>" }; },
};
const research = createResearch({ ctx, store, agents, parentDir, webProvider: provider, env: {} });
const started = await research.invoke({ agent: parent, question: "What does the fixture show?" });
assert.equal(started.status, "ok", started.reason);
assert.equal(coreRootLookups, 1);
assert.equal(children.length, 1);
assert.equal(children[0].session.header.kind, "mini-research");
assert.deepEqual(children[0].ctx.surfaceCalls, [{ agent: children[0], names: ["bash"] }]);
const researchBash = children[0].ctx.registered.find((tool) => tool.name === "bash");
assert.equal((await researchBash.execute({ command: "web-search 'fixture'" }, { agent: children[0] })).exitCode, 0);
assert.equal((await researchBash.execute({ command: "web-get W001" }, { agent: children[0] })).exitCode, 0);
writeFileSync(join(started.workspace, "answer.md"), "The fixture supports the answer [W001].\n");
let concluded = 0;
const completed = await researchBash.execute({ command: MINI_SWE_COMPLETION_COMMAND }, {
  agent: children[0], concludeTurn() { concluded++; },
});
assert.equal(completed.exitCode, 0, completed.stderr?.text);
assert.equal(concluded, 1);
assert.equal(children.length, 2, "accepted research spawns one fresh review context");
const review = children[1];
assert.equal(review.session.header.kind, "mini-review");
assert.deepEqual(review.ctx.surfaceCalls, [{ agent: review, names: ["bash"] }]);
assert.deepEqual(review.ctx.registered.map((tool) => tool.name), ["bash", "submit_review"]);
const reviewBash = review.ctx.registered.find((tool) => tool.name === "bash");
assert.equal(reviewBash.isConcurrencySafe(), false);
assert.deepEqual(Object.keys(reviewBash.parameters.properties), ["command"]);
const ordinaryBash = await reviewBash.execute({ command: "web-search 'not intercepted'" }, { agent: review });
assert.equal(ordinaryBash.exitCode, 0);
assert.equal(review.ctx.hostBashCommands.length, 1);
assert.match(review.ctx.hostBashCommands[0], /; web-search 'not intercepted'$/);
assert.match(review.ctx.sections.find((section) => section.name === "deployment:persona").text, /ordinary bash/);
assert.match(review.followups[0].content[0].text, /Use ordinary bash in this capsule/);
const submit = review.ctx.registered.find((tool) => tool.name === "submit_review");
const reviewResult = await submit.execute({ findings: [] }, { agent: review, concludeTurn() {} });
assert.equal(reviewResult.status, "ok", reviewResult.reason);
assert.equal(sent.length, 1);
assert.equal(sent[0].to, parentId);
assert.match(sent[0].message, /Citation check: passed/);
assert.match(sent[0].message, /Review findings: 0/);
assert.match(sent[0].message, /Answer path:/);
assert.equal(store.load(started.runId).status, "completed");
console.log("research fixture: ok");
