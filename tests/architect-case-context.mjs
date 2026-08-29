#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CASE_CONTEXT_NAME,
  CASE_MAX_CHARS,
  CASE_VARIABLE_NAME,
  EMPTY_CASE,
  WORKING_MEMORY_EMPTY_NOTICE,
  createCaseStore,
  isWorkingMemoryEmpty,
  renderCaseContext,
} from "../src/casefile.mjs";
import { ARCHITECT_PROMPT, ARCHITECT_PROMPT_NAME, createArchitect } from "../src/architect.mjs";
import { buildArchitectTools } from "../src/tools.mjs";


assert.equal(isWorkingMemoryEmpty(""), true);
assert.equal(isWorkingMemoryEmpty("# Working memory\n"), true);
assert.equal(isWorkingMemoryEmpty(EMPTY_CASE), true);
assert.match(EMPTY_CASE, /Empty: no plan has been recorded/);
assert.equal(isWorkingMemoryEmpty(`# Working memory\n\n${WORKING_MEMORY_EMPTY_NOTICE}\n\nReal plan.`), false);
assert.equal(isWorkingMemoryEmpty("# Plan\n\nDo the work."), false);

const architectId = "session-63a11000-0000-4000-8000-000000000001";
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const GROUP_AT = /^\{\{([^{}]*)\}\}/;

function interpolate(input, variables, kind = "context") {
  const text = input.text;
  let result = "";
  let last = 0;
  for (let open = text.indexOf("{{"); open >= 0; open = text.indexOf("{{", last)) {
    const group = GROUP_AT.exec(text.slice(open));
    if (group === null) {
      if (text.indexOf("}}", open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}"`);
      }
      result += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "${group[0]}" in ${kind} "${input.name}"`);
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables);
      throw new Error(`unknown prompt variable "${group[0]}" in ${kind} "${input.name}"; registered variables: ${known.join(", ") || "(none)"}`);
    }
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`prompt variable "${group[0]}" has no value for this assembly (${kind} "${input.name}")`);
    }
    result += text.slice(last, open) + value;
    last = open + group[0].length;
  }
  return result + text.slice(last);
}

function createPrompt() {
  const contexts = new Map();
  const variables = new Map();
  return {
    contexts,
    variables,
    context(entry) {
      if (contexts.has(entry.name)) throw new Error(`duplicate context ${entry.name}`);
      contexts.set(entry.name, entry);
      return () => { contexts.delete(entry.name); };
    },
    variable(name, provider) {
      if (variables.has(name)) throw new Error(`duplicate variable ${name}`);
      variables.set(name, provider);
      return () => { variables.delete(name); };
    },
  };
}

{
  assert.equal(renderCaseContext({ body: "" }), "");
  assert.equal(renderCaseContext({ body: "   \n" }), "");
  assert.equal(
    renderCaseContext({ body: "# Title\n\nKeep going." }),
    `Working memory:\n\n{{${CASE_VARIABLE_NAME}}}`,
  );
  assert.equal(
    renderCaseContext({ body: "# Title", taskId: "230" }),
    `Working memory (230):\n\n{{${CASE_VARIABLE_NAME}}}`,
  );
}

{
  const body = [
    "Please review this change: {{task}}",
    "",
    "<diff>",
    "{{diff}}",
    "</diff>",
  ].join("\n");
  assert.throws(
    () => interpolate(
      { name: CASE_CONTEXT_NAME, text: `Working memory:\n\n${body}` },
      { provider: "xai-auth", model: "grok-4.6", cwd: "/work" },
    ),
    /unknown prompt variable "\{\{task\}\}"/,
  );
  const rendered = interpolate(
    { name: CASE_CONTEXT_NAME, text: renderCaseContext({ body }) },
    { provider: "xai-auth", model: "grok-4.6", cwd: "/work", [CASE_VARIABLE_NAME]: body },
  );
  assert.equal(rendered, `Working memory:\n\n${body}`);
  assert.match(rendered, /\{\{task\}\}/);
  assert.match(rendered, /\{\{diff\}\}/);
}

{
  const body = [
    "# Mini-Review Agent",
    "",
    "Instance template documents {{task}} and {{diff}} as host-filled groups.",
  ].join("\n");
  const prompt = createPrompt();
  let binder;
  const cases = {
    load() { return { text: body }; },
    taskId() { return "230"; },
    open() {},
    ensure() {},
  };
  const architect = createArchitect({
    ctx: { get: () => null },
    cases,
  });
  const agent = {
    session: { id: architectId, events: [], header: { cwd: "/tmp" } },
    ctx: {
      systemPrompt: prompt,
      inject(_deps, fn) {
        binder = fn;
        fn(this);
      },
      on() { return () => {}; },
    },
  };
  architect.attach(agent);
  assert.equal(typeof binder, "function");
  assert.ok(prompt.contexts.has(ARCHITECT_PROMPT_NAME));
  assert.ok(prompt.contexts.has(CASE_CONTEXT_NAME));
  assert.ok(prompt.variables.has(CASE_VARIABLE_NAME));

  const template = prompt.contexts.get(CASE_CONTEXT_NAME).text();
  assert.equal(template, renderCaseContext({ body, taskId: "230" }));
  const value = prompt.variables.get(CASE_VARIABLE_NAME)();
  assert.equal(value, body);
  const snapshot = interpolate(
    { name: CASE_CONTEXT_NAME, text: template },
    { provider: "xai-auth", model: "grok-4.6", cwd: "/tmp", [CASE_VARIABLE_NAME]: value },
  );
  assert.equal(snapshot, `Working memory (230):\n\n${body}`);
  assert.match(snapshot, /\{\{task\}\}/);
  assert.match(snapshot, /\{\{diff\}\}/);

  binder(agent.ctx);
  assert.equal(prompt.contexts.size, 2);
  assert.equal(prompt.variables.size, 1);
  assert.equal(prompt.variables.get(CASE_VARIABLE_NAME)(), body);

  cases.load = () => ({ text: "" });
  assert.equal(prompt.contexts.get(CASE_CONTEXT_NAME).text(), "");
  assert.equal(prompt.variables.get(CASE_VARIABLE_NAME)(), "");

  architect.detach(agent);
  assert.equal(prompt.contexts.size, 0);
  assert.equal(prompt.variables.size, 0);
}

{
  assert.match(ARCHITECT_PROMPT, /plan document/i);
  assert.match(ARCHITECT_PROMPT, /operator approv/i);
  assert.match(ARCHITECT_PROMPT, /delegate/i);

  const dir = mkdtempSync(join(tmpdir(), "qq-plan-doc."));
  try {
    const cases = createCaseStore(dir);
    const caseWrite = buildArchitectTools({ cases }).find((tool) => tool.name === "case_write");
    assert.ok(caseWrite);
    assert.match(caseWrite.description, /patch|rewrite/i);
    let concluded = 0;
    const exec = {
      agent: { session: { id: architectId } },
      concludeTurn() { concluded++; },
    };

    const rewritten = await caseWrite.execute({ text: "# Plan\n\nOld step.\nRepeat.\nRepeat.\n" }, exec);
    assert.equal(rewritten.status, "ok");
    assert.equal(cases.load(architectId).text, "# Plan\n\nOld step.\nRepeat.\nRepeat.\n");

    const patched = await caseWrite.execute({ old_string: "Old step.", new_string: "Approved step." }, exec);
    assert.equal(patched.status, "ok");
    assert.match(cases.load(architectId).text, /Approved step\./);

    const beforeRefusal = cases.load(architectId).text;
    const nonUnique = await caseWrite.execute({ old_string: "Repeat.", new_string: "Once." }, exec);
    assert.equal(nonUnique.status, "refused");
    assert.match(nonUnique.reason, /not unique/i);
    assert.equal(cases.load(architectId).text, beforeRefusal);

    const replacedAll = await caseWrite.execute({ old_string: "Repeat.", new_string: "Once.", replace_all: true }, exec);
    assert.equal(replacedAll.status, "ok");
    assert.doesNotMatch(cases.load(architectId).text, /Repeat\./);
    assert.equal(cases.load(architectId).text.match(/Once\./g)?.length, 2);

    const beforeOversize = cases.load(architectId).text;
    const oversized = await caseWrite.execute({ text: "x".repeat(CASE_MAX_CHARS + 1) }, exec);
    assert.equal(oversized.status, "refused");
    assert.match(oversized.reason, new RegExp(String(CASE_MAX_CHARS)));
    assert.equal(cases.load(architectId).text, beforeOversize);

    const oversizedPatch = await caseWrite.execute({
      old_string: "Approved step.",
      new_string: "x".repeat(CASE_MAX_CHARS),
    }, exec);
    assert.equal(oversizedPatch.status, "refused");
    assert.match(oversizedPatch.reason, new RegExp(String(CASE_MAX_CHARS)));
    assert.equal(cases.load(architectId).text, beforeOversize);
    assert.equal(concluded, 0, "plan document edits must not conclude the architect turn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const listeners = [];
  const followups = [];
  const appended = [];
  const event = { type: "turn/end", data: { turn: 1, reason: "complete" } };
  const session = {
    id: architectId,
    header: { cwd: "/tmp" },
    events: [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { turn: 1, source: { kind: "operator" } } },
      event,
    ],
    append(type, data) { appended.push({ type, data }); },
  };
  const architect = createArchitect({
    ctx: { get: () => null },
    cases: { open() {}, ensure() {} },
    folder: { decide: () => ({ action: "keep" }) },
  });
  const agent = {
    status: "running",
    session,
    followup(message) { followups.push(message); },
    ctx: {
      on(type, fn) {
        const record = { type, fn };
        listeners.push(record);
        return () => {};
      },
    },
  };
  architect.attach(agent);
  for (const listener of listeners.filter((record) => record.type === "session/event")) {
    await listener.fn(session, event);
  }
  assert.equal(followups.length, 0, "turns without plan writes must not receive a write gate followup");
  const request = listeners.find((record) => record.type === "agent/request");
  assert.ok(request, "architect installs the context guard");
  assert.equal(await request.fn({ turn: 1, step: 1 }, async () => "assembled"), "assembled");
  const mark = appended.find((entry) => entry.type === "hook/result");
  assert.ok(Number.isSafeInteger(mark?.data?.talking), "assemble mark retains the measured token count");
  assert.ok(Number.isSafeInteger(mark?.data?.q));
  architect.detach(agent);
}
