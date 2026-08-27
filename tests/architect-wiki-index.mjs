#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  ARCHITECT_PROMPT_NAME,
  createArchitect,
} from "../src/architect.mjs";
import {
  WIKI_INDEX_CONTEXT_NAME,
  WIKI_INDEX_CONTEXT_ORDER,
  WIKI_INDEX_HEADER,
} from "../src/wiki-index.mjs";
import { miniSetup } from "../src/official-mini.mjs";
import { miniReviewSetup } from "../src/mini-review.mjs";
import { stripAgentInstructionMessages } from "../src/hide-harness.mjs";

const architectId = "session-63a11000-0000-4000-8000-000000000009";

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

function createArchitectHarness(indexOrError = "") {
  const prompt = createPrompt();
  const notices = [];
  const warnings = [];
  const roots = [];
  const wiki = {
    loadIndex(root) {
      roots.push(root);
      if (indexOrError instanceof Error) throw indexOrError;
      return indexOrError;
    },
  };
  const ctx = {
    get(name) { return name === "qq-wiki" ? wiki : null; },
    logger: { warn(message) { warnings.push(message); } },
  };
  const architect = createArchitect({ ctx });
  const agent = {
    session: {
      id: architectId,
      events: [],
      header: { cwd: "/repo/subdir" },
      append(type, data) { notices.push({ type, data }); },
    },
    ctx: {
      systemPrompt: prompt,
      inject(_deps, bind) { bind(this); },
      on() { return () => {}; },
    },
  };
  return { agent, architect, notices, prompt, roots, warnings };
}

// A missing or empty wiki contributes no prompt channel.
{
  const harness = createArchitectHarness("");
  harness.architect.attach(harness.agent);
  assert.ok(harness.prompt.contexts.has(ARCHITECT_PROMPT_NAME));
  assert.equal(harness.prompt.contexts.has(WIKI_INDEX_CONTEXT_NAME), false);
  assert.deepEqual(harness.roots, ["/repo/subdir"]);
  harness.architect.detach(harness.agent);
}

// The architect receives only the bounded routing index under a short header.
{
  const index = "# Routes\n\n- [Sessions](sessions.md) — changing session lifecycle.\n";
  const harness = createArchitectHarness(index);
  harness.architect.attach(harness.agent);
  const entry = harness.prompt.contexts.get(WIKI_INDEX_CONTEXT_NAME);
  assert.ok(entry);
  assert.equal(entry.order, WIKI_INDEX_CONTEXT_ORDER);
  assert.equal(entry.text(), `${WIKI_INDEX_HEADER}\n\n${index.trim()}`);
  assert.match(entry.text(), /sessions\.md/);
  assert.doesNotMatch(entry.text(), /Contents of sessions\.md/);
  harness.architect.detach(harness.agent);
  assert.equal(harness.prompt.contexts.size, 0);
}

// Refused indexes are never injected and fail on both operator-visible paths.
{
  const harness = createArchitectHarness(new Error("qq-wiki: wiki/index.md exceeds 4096 bytes"));
  harness.architect.attach(harness.agent);
  assert.equal(harness.prompt.contexts.has(WIKI_INDEX_CONTEXT_NAME), false);
  assert.equal(harness.notices.length, 1);
  assert.match(JSON.stringify(harness.notices[0]), /exceeds 4096 bytes/);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /wiki index/i);
}

// Mini implementer and QA mounts own complete personas and never mount wiki index.
for (const setup of [miniSetup, miniReviewSetup]) {
  const prompt = createPrompt();
  let wikiLoads = 0;
  const ctx = {
    systemPrompt: prompt,
    get(name) {
      return name === "qq-wiki" ? { loadIndex() { wikiLoads++; return "- [Never](never.md)"; } } : null;
    },
    tools: {
      get(name) {
        return name === "bash"
          ? { name: "bash", parameters: { type: "object", properties: {} }, async execute() { return {}; } }
          : null;
      },
      restrict() { return () => {}; },
      register() { return () => {}; },
    },
    on() { return () => {}; },
  };
  setup(ctx);
  assert.equal(prompt.contexts.has(WIKI_INDEX_CONTEXT_NAME), false);
  assert.equal(wikiLoads, 0);
}

// Architect AGENTS.md hiding is independent: wiki context is not an
// agent-instructions message and remains available after the dump is stripped.
{
  const harness = createArchitectHarness("- [Routing](routing.md)\n");
  harness.architect.attach(harness.agent);
  const wikiEntry = harness.prompt.contexts.get(WIKI_INDEX_CONTEXT_NAME);
  const messages = [
    { source: { kind: "agent-instructions" }, content: "Contents of AGENTS.md" },
    { source: { kind: "plugin", plugin: "qq-workflows" }, content: wikiEntry.text() },
  ];
  assert.deepEqual(stripAgentInstructionMessages(messages), [messages[1]]);
}

console.log("architect wiki index: ok");
