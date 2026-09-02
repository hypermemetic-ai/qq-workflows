#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMPILER_MARKER,
  RECALL_NOTE,
  compileConversation,
  compilerBudgetTokens,
  compressHeredoc,
  normalizeText,
  parseCompiledConversation,
  rankBlocks,
  significantWords,
} from "../src/conversation-compiler/index.mjs";

const records = [
  { seq: 1, role: "user", content: [{ type: "text", text: "Please fix deterministic retries. Keep the API stable and do not add dependencies." }] },
  { seq: 5, role: "assistant", content: [
    { type: "text", text: "I will inspect the retry workflow and preserve the public API." },
    { type: "tool-call", name: "bash", arguments: { command: "cat <<'EOF' > /tmp/example\n" + "payload\n".repeat(30) + "EOF\nnpm test" } },
  ] },
  { seq: 7, role: "tool-result", content: [{ type: "tool-result", callId: "c1", isError: false, content: [{ type: "text", text: "very large output that must not be copied" }] }] },
  { seq: 10, role: "assistant", content: [{ type: "text", text: "Modified retry scheduling. Tests pass. Next verify cancellation and commit the fix." }] },
  { seq: 12, role: "assistant", content: [{ type: "tool-call", name: "edit", arguments: { path: "src/retry.mjs", oldText: "a", newText: "b" } }] },
  { seq: 15, role: "assistant", content: [{ type: "text", text: "Committed as abcdef1234567890. Outstanding: verify the cold-resume edge case." }] },
];

assert.deepEqual(significantWords(" **one**  two\n`three` "), ["one", "two", "three"]);
assert.equal(normalizeText(" a\r\n\r\n b\t c "), "a\n\nb c");
const heredoc = compressHeredoc("cat <<'EOF' > x\na\nb\nc\nEOF\necho done");
assert.match(heredoc, /3 lines omitted/);
assert.match(heredoc, /echo done/);
assert.equal(compilerBudgetTokens(0), 1100);
assert.equal(compilerBudgetTokens(80), 1200);
assert.equal(compilerBudgetTokens(500), 2000);
const weighted = [
  { seq: 0, role: "assistant", text: "generic status" },
  { seq: 1, role: "assistant", text: "read search" },
  { seq: 2, role: "assistant", text: "workflow plan" },
  { seq: 3, role: "assistant", text: "modified tests edit" },
  { seq: 4, role: "assistant", text: "commit" },
  { seq: 5, role: "assistant", text: "failure nonzero" },
];
assert.deepEqual(rankBlocks(weighted).map(({ block }) => block.seq), [5, 4, 3, 2, 1, 0]);

const first = compileConversation(records);
const second = compileConversation(structuredClone(records));
assert.equal(first, second, "compiler output is deterministic");
assert.equal(`${first}\n`, readFileSync(new URL("./fixtures/conversation-compiler.golden.md", import.meta.url), "utf8"));
assert.match(first, new RegExp(COMPILER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(first, /## Session Goal/);
assert.match(first, /## Files And Changes/);
assert.match(first, /src\/retry\.mjs/);
assert.match(first, /## Commits/);
assert.match(first, /abcdef1234567890/);
assert.match(first, /## Outstanding Context/);
assert.match(first, /cold-resume/);
assert.match(first, /## User Preferences/);
assert.match(first, /do not add dependencies/i);
assert.match(first, /## Chronological Brief/);
assert.match(first, /#1 user:/);
assert.match(first, /#5 assistant:/);
assert.match(first, /bash\(/);
const bashOnlyPath = compileConversation([{ seq: 1, role: "assistant", content: [{ type: "tool-call", name: "bash", arguments: { command: "cat > src/inferred.mjs" } }] }]);
assert.doesNotMatch(bashOnlyPath, /## Files And Changes/);
const manyCalls = compileConversation([{ seq: 2, role: "assistant", content: Array.from({ length: 12 }, (_, index) => ({ type: "tool-call", name: "tool", arguments: { index } })) }]);
assert.equal((manyCalls.match(/tool\(/g) ?? []).length, 8);
assert.match(manyCalls, /4 additional tool calls omitted/);
assert.doesNotMatch(first, /very large output/);
assert.equal(first.split(RECALL_NOTE).length - 1, 1, "one recall note");
for (const match of first.matchAll(/#(\d+)/g)) {
  assert.ok(records.some(({ seq }) => seq === Number(match[1])), `emitted seq ${match[1]} resolves`);
}
assert.ok(first.length <= 2000 * 4, "ceiling uses four chars per token");

const merged = compileConversation([
  { seq: 20, role: "assistant", content: [{ type: "text", text: "Fresh work is complete. No outstanding tasks remain." }] },
], { previousSummary: first });
assert.equal(merged.split(RECALL_NOTE).length - 1, 1);
assert.ok(merged.indexOf("#20 assistant:") < merged.indexOf("#1 user:"), "fresh brief precedes previous brief");
assert.doesNotMatch(parseCompiledConversation(merged).outstanding.join("\n"), /cold-resume/, "outstanding is fresh-only");

const noisy = Array.from({ length: 140 }, (_, index) => ({
  seq: index,
  role: index % 3 === 0 ? "user" : "assistant",
  content: [{ type: "text", text: index % 11 === 0 ? `Failure ${index}: tests failed in workflow` : `generic progress message ${index} repeated detail` }],
}));
const bounded = compileConversation(noisy);
assert.ok(parseCompiledConversation(bounded).brief.length <= 80);
assert.ok(bounded.length <= 8000);
assert.match(bounded, /#139/);

const unbroken = compileConversation([{ seq: 4, role: "user", content: [{ type: "text", text: "x".repeat(50_000) }] }]);
const withoutFormatRetry = compileConversation([
  { seq: 1, role: "user", source: { kind: "plugin", plugin: "qq-workflows" }, content: [{ type: "text", text: "Tool call error:\n<error>Every response needs to call bash.</error>" }] },
  { seq: 2, role: "user", source: { kind: "plugin", plugin: "qq-workflows" }, content: [{ type: "text", text: "Please implement the actual task." }] },
]);
assert.doesNotMatch(withoutFormatRetry, /Tool call error/);
assert.match(withoutFormatRetry, /#2/);

assert.ok(unbroken.length <= 1_100 * 4);
assert.match(unbroken, /#4/);
const calibrated = compileConversation(noisy, { tokenCalibration: { charsPerToken: 3.5 } });
assert.ok(calibrated.length <= compilerBudgetTokens(noisy.length) * 3.5);

console.log("conversation compiler: ok");
