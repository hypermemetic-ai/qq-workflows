#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  ARCHITECT_PROMPT_NAME,
  createArchitect,
} from "../src/architect.mjs";
import {
  loadRepositoryIndexContext,
  REPOSITORY_INDEX_CONTEXT_NAME,
  REPOSITORY_INDEX_CONTEXT_ORDER,
  REPOSITORY_INDEX_HEADER,
  renderRepositoryIndexContext,
  repositoryRoot,
} from "../src/repository-index.mjs";
import { miniSetup } from "../src/official-mini.mjs";
import { miniQaSetup } from "../src/mini-qa.mjs";

const architectId = "session-63a11000-0000-4000-8000-000000000009";
const sessionCwd = "/repo/subdir";
const MISSING = Symbol("missing service");

function createPrompt() {
  const contexts = new Map();
  const sections = [];
  return {
    contexts,
    sections,
    context(entry) {
      if (contexts.has(entry.name)) throw new Error(`duplicate context ${entry.name}`);
      contexts.set(entry.name, entry);
      return () => { contexts.delete(entry.name); };
    },
    section(entry) {
      sections.push(entry);
      return () => { sections.splice(sections.indexOf(entry), 1); };
    },
    variable() { return () => {}; },
    suppressRuntimeContext() { return () => {}; },
  };
}

function createArchitectHarness({ service = MISSING, lookupError = null, loadIndex } = {}) {
  const prompt = createPrompt();
  const notices = [];
  const warnings = [];
  const indexLookups = [];
  let rebind;
  const ctx = {
    get(name, optional) {
      if (name !== "qq-index") return null;
      indexLookups.push([name, optional]);
      if (lookupError) throw lookupError;
      return service === MISSING ? null : service;
    },
    logger: { warn(message) { warnings.push(message); } },
  };
  const architect = createArchitect({ ctx, loadIndex });
  const agent = {
    session: {
      id: architectId,
      events: [],
      header: { cwd: sessionCwd },
      append(type, data) {
        const event = { type, data };
        this.events.push(event);
        if (type === "user/message") notices.push(event);
      },
    },
    ctx: {
      systemPrompt: prompt,
      inject(_deps, bind) {
        rebind = () => bind(this);
        rebind();
      },
      on() { return () => {}; },
    },
  };
  return {
    agent,
    architect,
    indexLookups,
    notices,
    prompt,
    rebind: () => rebind(),
    warnings,
  };
}

assert.equal(REPOSITORY_INDEX_CONTEXT_NAME, "qq-workflows:repository-index");
assert.equal(REPOSITORY_INDEX_CONTEXT_ORDER, 15);
assert.match(REPOSITORY_INDEX_HEADER, /Repository index/);
assert.match(REPOSITORY_INDEX_HEADER, /routing only/);
assert.match(REPOSITORY_INDEX_HEADER, /source and tests remain authoritative/);
assert.equal(repositoryRoot(sessionCwd), sessionCwd);
assert.equal(renderRepositoryIndexContext(" \n\t"), "");

// A genuinely absent optional service contributes neither context nor error.
{
  const calls = [];
  const result = loadRepositoryIndexContext({
    ctx: { get(...args) { calls.push(args); return null; } },
    cwd: sessionCwd,
  });
  assert.deepEqual(calls, [["qq-index", false]]);
  assert.deepEqual(result, { context: null, error: null });

  const harness = createArchitectHarness();
  assert.doesNotThrow(() => harness.architect.attach(harness.agent));
  assert.ok(harness.prompt.contexts.has(ARCHITECT_PROMPT_NAME));
  assert.equal(harness.prompt.contexts.has(REPOSITORY_INDEX_CONTEXT_NAME), false);
  assert.deepEqual(harness.indexLookups, [["qq-index", false]]);
  assert.deepEqual(harness.notices, []);
  assert.deepEqual(harness.warnings, []);
  harness.architect.detach(harness.agent);
}

// An installed service returning an empty index is also an expected no-context result.
{
  const roots = [];
  const harness = createArchitectHarness({
    service: { loadIndex(root) { roots.push(root); return " \n\t"; } },
  });
  assert.doesNotThrow(() => harness.architect.attach(harness.agent));
  assert.deepEqual(roots, [sessionCwd]);
  assert.equal(harness.prompt.contexts.has(REPOSITORY_INDEX_CONTEXT_NAME), false);
  assert.deepEqual(harness.notices, []);
  assert.deepEqual(harness.warnings, []);
  harness.architect.detach(harness.agent);
}

// The landed service supplies bounded routing content using the session root.
{
  const roots = [];
  const index = "# Routes\n\n- [Sessions](sessions.md) — changing session lifecycle.\n";
  const harness = createArchitectHarness({
    service: { loadIndex(root) { roots.push(root); return index; } },
  });
  harness.architect.attach(harness.agent);
  assert.deepEqual(roots, [sessionCwd]);
  const entry = harness.prompt.contexts.get(REPOSITORY_INDEX_CONTEXT_NAME);
  assert.ok(entry);
  assert.equal(entry.order, REPOSITORY_INDEX_CONTEXT_ORDER);
  assert.equal(entry.text(), `${REPOSITORY_INDEX_HEADER}\n\n${index.trim()}`);
  assert.match(entry.text(), /sessions\.md/);
  assert.doesNotMatch(entry.text(), /Contents of sessions\.md/);
  assert.equal(harness.architect.detach(harness.agent), true);
  assert.equal(harness.prompt.contexts.size, 0);
  assert.equal(harness.architect.detach(harness.agent), false);
}

// A projection already bounded by qq-index remains normal routing content. The
// adapter preserves its explicit cutoff marker and route to the full README.
{
  const projection = [
    "# Routes 🧭",
    "",
    "- [Sessions](sessions.md) — changing session lifecycle.",
    "",
    "> **Repository index truncated for prompt injection.**",
    "> Continue with the complete [README.md](README.md).",
  ].join("\n");
  const harness = createArchitectHarness({
    service: { loadIndex() { return projection; } },
  });
  assert.doesNotThrow(() => harness.architect.attach(harness.agent));
  const entry = harness.prompt.contexts.get(REPOSITORY_INDEX_CONTEXT_NAME);
  assert.ok(entry);
  assert.equal(entry.text(), `${REPOSITORY_INDEX_HEADER}\n\n${projection}`);
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.notices, []);
  harness.architect.detach(harness.agent);
}

// Tests can inject loadIndex directly; the override wins without service lookup.
{
  const roots = [];
  const harness = createArchitectHarness({
    lookupError: new Error("service lookup must be bypassed"),
    loadIndex(root) {
      roots.push(root);
      return "- [Routing](routing.md)";
    },
  });
  harness.architect.attach(harness.agent);
  assert.deepEqual(roots, [sessionCwd]);
  assert.deepEqual(harness.indexLookups, []);
  assert.ok(harness.prompt.contexts.has(REPOSITORY_INDEX_CONTEXT_NAME));
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.notices, []);
  harness.architect.detach(harness.agent);
}

// Lookup, load, and malformed-return failures all remain fail-open. Architect
// emits each repeated failure once on the log and operator-visible channels.
for (const scenario of [
  {
    name: "lookup",
    options: { lookupError: new Error("qq-index lookup failed") },
    detail: /lookup failed/,
  },
  {
    name: "I/O load",
    options: {
      service: { loadIndex() { throw new Error("qq-index: failed to read README.md (EIO)"); } },
    },
    detail: /failed to read README\.md \(EIO\)/,
  },
  {
    name: "malformed return",
    options: { service: { loadIndex() { return { routes: [] }; } } },
    detail: /loadIndex returned a malformed index/,
  },
]) {
  const direct = scenario.name === "lookup"
    ? loadRepositoryIndexContext({
      ctx: { get() { throw scenario.options.lookupError; } },
      cwd: sessionCwd,
    })
    : loadRepositoryIndexContext({
      ctx: { get() { return scenario.options.service; } },
      cwd: sessionCwd,
    });
  assert.equal(direct.context, null, `${scenario.name} direct context`);
  assert.match(direct.error?.message ?? "", scenario.detail, `${scenario.name} direct error`);

  const harness = createArchitectHarness(scenario.options);
  assert.doesNotThrow(() => harness.architect.attach(harness.agent), scenario.name);
  assert.ok(harness.prompt.contexts.has(ARCHITECT_PROMPT_NAME));
  assert.equal(harness.prompt.contexts.has(REPOSITORY_INDEX_CONTEXT_NAME), false);
  harness.rebind();
  assert.equal(harness.warnings.length, 1, `${scenario.name} log warning count`);
  assert.equal(harness.notices.length, 1, `${scenario.name} operator warning count`);
  assert.match(harness.warnings[0], /repository index was not injected/i);
  assert.match(harness.warnings[0], scenario.detail);
  assert.match(JSON.stringify(harness.notices[0]), scenario.detail);
  harness.architect.detach(harness.agent);
}

// Mini implementer and QA personas never request or mount repository index.
for (const setup of [miniSetup, miniQaSetup]) {
  const prompt = createPrompt();
  let indexLoads = 0;
  const agent = { id: "mini-repository-index-test" };
  const ctx = {
    agent,
    systemPrompt: prompt,
    get(name) {
      if (name === "qq-core") return { surface: { allow(actual, names) {
        assert.equal(actual, agent);
        assert.deepEqual(names, ["bash"]);
      } } };
      return name === "qq-index" ? {
        loadIndex() { indexLoads++; return "- [Never](never.md)"; },
      } : null;
    },
    tools: {
      get(name) {
        return name === "bash"
          ? { name: "bash", parameters: { type: "object", properties: {} }, async execute() { return {}; } }
          : null;
      },
      register() { return () => {}; },
    },
    on() { return () => {}; },
  };
  setup(ctx);
  assert.equal(prompt.contexts.has(REPOSITORY_INDEX_CONTEXT_NAME), false);
  assert.equal(indexLoads, 0);
}

console.log("architect repository index: ok");
