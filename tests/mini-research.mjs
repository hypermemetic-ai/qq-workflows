#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchWorkspace, checkAnswerCitations } from "../src/research-evidence.mjs";
import {
  bindMiniResearch,
  MINI_RESEARCH_GLOBAL_ALLOW,
  MINI_RESEARCH_KIND,
  MINI_RESEARCH_TOOLS,
  miniResearchSetup,
  parseResearchCommand,
  wrapMiniResearchBash,
} from "../src/mini-research.mjs";
import { MINI_SWE_COMPLETION_COMMAND } from "../src/mini-swe-v2.mjs";
import { isMiniAgent, LEGACY_MINI_KIND, MINI_KIND } from "../src/official-mini.mjs";

assert.equal(MINI_KIND, "mini-coder");
assert.equal(LEGACY_MINI_KIND, "mini");
assert.equal(isMiniAgent({ header: { kind: "mini-coder" } }), true);
assert.equal(isMiniAgent({ header: { kind: "mini" } }), true, "legacy coding sessions still resume");
assert.equal(MINI_RESEARCH_KIND, "mini-research");
assert.deepEqual(MINI_RESEARCH_TOOLS, ["bash"]);
assert.deepEqual(MINI_RESEARCH_GLOBAL_ALLOW, ["bash"]);
assert.deepEqual(parseResearchCommand("session-search 'one phrase' \"two phrase\""), {
  name: "session-search", args: ["one phrase", "two phrase"],
});
assert.match(parseResearchCommand("web-get W001 | cat").error, /standalone/);
assert.equal(parseResearchCommand("printf ordinary"), null);

const delegated = [];
const base = {
  name: "bash",
  description: "base",
  parameters: { command: { type: "string" } },
  async execute(args) { delegated.push(args); return { kind: "foreground", exitCode: 0, stdout: { text: "native\n" }, stderr: { text: "" } }; },
};
const calls = [];
const agent = { session: { id: "session-22222222-2222-4222-8222-222222222222", header: { kind: MINI_RESEARCH_KIND } }, ctx: {} };
bindMiniResearch(agent, {
  web: {
    async search(query) { calls.push(["web-search", query]); return "W001\tlead\n"; },
    async get(ref) { calls.push(["web-get", ref]); return { ref, path: `evidence/web/${ref}.md`, sha256: "a".repeat(64) }; },
  },
  sessions: {
    async search(args) { calls.push(["session-search", args]); return "S001\tlead\n"; },
    async get(ref) { calls.push(["session-get", ref]); return { ref, path: `evidence/sessions/${ref}.md`, sha256: "b".repeat(64) }; },
  },
  async submit() { return { status: "ok" }; },
});
const wrapped = wrapMiniResearchBash(base);
for (const command of ["web-search 'alpha beta'", "web-get W1", "session-search 'one' 'two'", "session-get S1"]) {
  const result = await wrapped.execute({ command }, { agent });
  assert.equal(result.exitCode, 0, command);
}
assert.deepEqual(calls, [
  ["web-search", "alpha beta"], ["web-get", "W001"],
  ["session-search", ["one", "two"]], ["session-get", "S001"],
]);
assert.equal(delegated.length, 0);
const native = await wrapped.execute({ command: "printf ordinary" }, { agent });
assert.equal(native.exitCode, 0);
assert.deepEqual(delegated, [{ command: "printf ordinary" }], "other bash is unchanged");
const pipeline = await wrapped.execute({ command: "web-search alpha | cat" }, { agent });
assert.equal(pipeline.exitCode, 2);
assert.equal(delegated.length, 1, "evidence pipelines are never sent to native bash");
const laterPipeline = await wrapped.execute({ command: "printf lead | web-search alpha" }, { agent });
assert.equal(laterPipeline.exitCode, 2);
assert.equal(delegated.length, 1);

// The research submit binding refuses absent answers and unknown leads.
const scratch = mkdtempSync(join(tmpdir(), "qq-mini-research."));
const repo = join(scratch, "repo"); mkdirSync(repo);
const workspace = await createResearchWorkspace({ parentDir: join(scratch, "runs"), repoRoot: repo, question: "q" });
const checkingAgent = { session: { id: "session-33333333-3333-4333-8333-333333333333", header: { kind: MINI_RESEARCH_KIND } }, ctx: {} };
bindMiniResearch(checkingAgent, {
  async submit() {
    const check = await checkAnswerCitations(workspace);
    return check.ok ? { status: "ok" } : { status: "refused", reason: check.reason };
  },
});
const checking = wrapMiniResearchBash(base);
let completion = await checking.execute({ command: MINI_SWE_COMPLETION_COMMAND }, { agent: checkingAgent });
assert.equal(completion.exitCode, 1);
assert.match(completion.stderr.text, /answer\.md/);
writeFileSync(workspace.answer, "Unsupported [W999].\n");
completion = await checking.execute({ command: MINI_SWE_COMPLETION_COMMAND }, { agent: checkingAgent });
assert.equal(completion.exitCode, 1);
assert.match(completion.stderr.text, /W999/);

// Mount isolates the preset to bash alone.
const restrictions = [];
const registered = [];
const sections = [];
const mountCtx = {
  systemPrompt: { section(value) { sections.push(value); return () => {}; }, suppressRuntimeContext() {} },
  tools: {
    get(name) { assert.equal(name, "bash"); return base; },
    register(tool) { registered.push(tool.name); return () => {}; },
    restrict(spec) { restrictions.push(spec); return () => {}; },
  },
  effect(fn) { return fn(); },
  on() { return () => {}; },
};
miniResearchSetup(mountCtx);
assert.deepEqual(registered, ["bash"]);
assert.deepEqual(restrictions, [{ allow: ["bash"] }]);
assert.equal(sections[0].complete, true);
console.log("mini-research: ok");
