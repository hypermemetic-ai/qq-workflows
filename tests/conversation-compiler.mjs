#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  COMPILER_MARKER,
  RECALL_NOTE,
  compileConversation,
  compilerBudgetTokens,
  parseCompiledConversation,
} from "../src/conversation-compiler/index.mjs";

const records = [
  { seq: 1, role: "user", content: [{ type: "text", text: "Please fix deterministic retries. Keep the API stable and do not add dependencies." }] },
  { seq: 5, role: "assistant", content: [
    { type: "text", text: "I will inspect the retry workflow and preserve the public API." },
    { type: "tool-call", name: "bash", arguments: { command: "cat <<'EOF' > /tmp/example\n" + "payload\n".repeat(30) + "EOF\nnpm test" } },
  ] },
  { seq: 7, role: "tool-result", toolName: "bash", content: [{ type: "tool-result", callId: "c1", isError: false, content: [{ type: "text", text: "very large output that must not be copied" }] }] },
  { seq: 10, role: "assistant", content: [{ type: "text", text: "Modified retry scheduling. Tests are still failing; verify cancellation." }] },
  { seq: 12, role: "assistant", content: [{ type: "tool-call", name: "edit", arguments: { path: "src/retry.mjs", oldText: "a", newText: "b" } }] },
  { seq: 13, role: "assistant", content: [{ type: "tool-call", name: "bash", arguments: { command: 'git commit -m "fix: deterministic retry"' } }] },
  { seq: 14, role: "tool-result", toolName: "bash", content: [{ type: "text", text: "[main abcdef12345] fix: deterministic retry" }] },
  { seq: 15, role: "assistant", content: [{ type: "text", text: "Committed the implementation. Cancellation is not fixed yet." }] },
];

assert.equal(compilerBudgetTokens(0), 1_100);
assert.equal(compilerBudgetTokens(80), 1_200);
assert.equal(compilerBudgetTokens(500), 2_000);

const first = compileConversation(records);
assert.equal(first, compileConversation(structuredClone(records)), "identical input produces identical output");
assert.match(first, new RegExp(COMPILER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(first, /^\[Session Goal\]$/m);
assert.match(first, /^\[Files And Changes\]$/m);
assert.match(first, /^\[Commits\]$/m);
assert.match(first, /^\[Outstanding Context\]$/m);
assert.doesNotMatch(first, /^## /m);
assert.doesNotMatch(first, /None recorded\./);
assert.match(first, /Modified: src\/retry\.mjs/);
assert.match(first, /abcdef12345: fix: deterministic retry/);
assert.match(first, /\[user\]\n[\s\S]*\(#1\)/);
assert.match(first, /\[assistant\]\n[\s\S]*\* bash "cat <<'EOF' > \/tmp\/example; npm test" \(#5\)/);
assert.match(first, /\* edit "src\/retry\.mjs" \(#12\)/);
assert.doesNotMatch(first, /very large output/);
assert.equal(first.split(RECALL_NOTE).length - 1, 1);

const validSeqs = new Set(records.map(({ seq }) => seq));
for (const match of first.matchAll(/\(#(\d+)/g)) {
  assert.ok(validSeqs.has(Number(match[1])), `emitted DSH seq ${match[1]} resolves`);
}

const parsed = parseCompiledConversation(first);
assert.deepEqual(parsed.goals, ["Please fix deterministic retries. Keep the API stable and do not add dependencies."]);
assert.deepEqual(parsed.files, ["Modified: src/retry.mjs"]);
assert.deepEqual(parsed.commits, ["abcdef12345: fix: deterministic retry"]);
assert.equal(parsed.outstanding.length, 2);

const withoutFormatRetry = compileConversation([
  { seq: 20, role: "user", source: { kind: "plugin", plugin: "qq-workflows" }, content: [{ type: "text", text: "Tool call error:\n<error>Every response needs to call bash.</error>" }] },
  { seq: 21, role: "user", source: { kind: "plugin", plugin: "qq-workflows" }, content: [{ type: "text", text: "Please implement the actual task." }] },
]);
assert.doesNotMatch(withoutFormatRetry, /Tool call error/);
assert.match(withoutFormatRetry, /\(#21\)/);
const withoutInvalidSeq = compileConversation([
  { role: "user", content: [{ type: "text", text: "This must not gain an array-index citation." }] },
  { seq: -1, role: "assistant", content: [{ type: "text", text: "Nor may this." }] },
  { seq: 22, role: "assistant", content: [{ type: "text", text: "Only this durable event remains." }] },
]);
assert.doesNotMatch(withoutInvalidSeq, /array-index|Nor may/);
assert.match(withoutInvalidSeq, /\(#22\)/);

// Existing pre-audit checkpoints migrate once; placeholder bullets and volatile
// outstanding context do not survive into the source-faithful format.
const legacy = `${COMPILER_MARKER}\n\n## Session Goal\n- old goal\n\n## Commits\n- None recorded.\n\n## Outstanding Context\n- stale failure\n\n## User Preferences\n- None recorded.\n\n## Chronological Brief\n- #3 user: old goal\n\n${RECALL_NOTE}`;
const merged = compileConversation([
  { seq: 30, role: "user", content: [{ type: "text", text: "Please use ESM modules." }] },
  { seq: 31, role: "assistant", content: [{ type: "text", text: "Fresh work is complete." }] },
], { previousSummary: legacy });
assert.equal(merged.split(COMPILER_MARKER).length - 1, 1);
assert.equal(merged.split(RECALL_NOTE).length - 1, 1);
assert.doesNotMatch(merged, /None recorded\.|stale failure/);
assert.ok(merged.indexOf("old goal (#3)") < merged.indexOf("Fresh work is complete. (#31)"));
assert.deepEqual(parseCompiledConversation(merged).outstanding, []);

// Markdown headings in a v1 transcript are content, not legacy format markers.
const headingFirst = compileConversation([
  { seq: 32, role: "user", content: [{ type: "text", text: "Please preserve the original implementation plan." }] },
  { seq: 33, role: "assistant", content: [{ type: "text", text: "## Implementation\nThe first implementation is complete." }] },
]);
assert.deepEqual(parseCompiledConversation(headingFirst).goals, ["Please preserve the original implementation plan."]);
assert.match(headingFirst, /^## Implementation$/m);
const headingSecond = compileConversation([
  { seq: 34, role: "user", content: [{ type: "text", text: "Please add the follow-up implementation." }] },
  { seq: 35, role: "assistant", content: [{ type: "text", text: "The follow-up is complete." }] },
], { previousSummary: headingFirst });
assert.match(headingSecond, /Please preserve the original implementation plan\./);
assert.match(headingSecond, /^## Implementation$/m);
assert.match(headingSecond, /The first implementation is complete\./);

// Wrapped semantic bullets retain their continuations across public compactions.
const wrappedGoal = "Please implement continuation-aware checkpoint merging while preserving every word in this deliberately long session goal across repeated deterministic compactions and later follow-up windows.";
const wrappedPaths = [
  `src/compiler/${"first-segment-".repeat(4)}one.mjs`,
  `src/compiler/${"second-segment-".repeat(4)}two.mjs`,
  `src/compiler/${"third-segment-".repeat(4)}three.mjs`,
];
assert.ok(wrappedGoal.length >= 150);
const wrappedFirst = compileConversation([
  { seq: 36, role: "user", content: [{ type: "text", text: wrappedGoal }] },
  { seq: 37, role: "assistant", content: [{ type: "text", text: "The initial wrapped checkpoint is complete." }] },
], { fileOps: { modifiedFiles: wrappedPaths } });
assert.ok(wrappedFirst.split("\n").some((line) => /^\s+\S/.test(line)), "fixture must exercise physical continuations");
const wrappedSecond = compileConversation([
  { seq: 38, role: "user", content: [{ type: "text", text: "Please implement the wrapped checkpoint follow-up." }] },
  { seq: 39, role: "assistant", content: [{ type: "text", text: "The wrapped follow-up is complete." }] },
], { previousSummary: wrappedFirst, fileOps: { modifiedFiles: ["src/compiler/fresh.mjs"] } });
const parsedWrappedSecond = parseCompiledConversation(wrappedSecond);
assert.ok(parsedWrappedSecond.goals.includes(wrappedGoal));
assert.deepEqual(parsedWrappedSecond.files, [`Modified: ${[...wrappedPaths, "src/compiler/fresh.mjs"].join(", ")}`]);

// Brief-only summaries remain mergeable under the DSH framing adaptation.
const longFirst = compileConversation([
  { seq: 40, role: "user", content: [{ type: "text", text: "initial ".repeat(1_800) }] },
  { seq: 41, role: "assistant", content: [{ type: "text", text: "Initial pass complete." }] },
]);
const longSecond = compileConversation([
  { seq: 50, role: "user", content: [{ type: "text", text: "followup ".repeat(1_800) }] },
  { seq: 51, role: "assistant", content: [{ type: "text", text: "Fresh pass complete." }] },
], { previousSummary: longFirst, tokenCalibration: { charsPerToken: 3.5 } });
assert.equal(longSecond.split(COMPILER_MARKER).length - 1, 1);
assert.equal(longSecond.split(RECALL_NOTE).length - 1, 1);
assert.match(longSecond, /\(#40\)/);
assert.match(longSecond, /\(#51\)/);
assert.ok(longSecond.indexOf("Initial pass complete.") < longSecond.indexOf("Fresh pass complete."));

const mergeCheckpointTwice = (previousSummary, firstSeq) => {
  let summary = compileConversation([
    { seq: firstSeq, role: "assistant", content: [{ type: "text", text: "Continuing the current work without changing its requirements." }] },
  ], { previousSummary });
  summary = compileConversation([
    { seq: firstSeq + 1, role: "assistant", content: [{ type: "text", text: "Verification continues with the original context intact." }] },
  ], { previousSummary: summary });
  return summary;
};

// A known header token in prose remains content through at least two summary
// merges; it cannot truncate Session Goal or persist a manufactured section.
const headerTokenTrigger = "Please review the [Commits] tab and fix the failing check.";
const semanticHeaderFirst = compileConversation([
  { seq: 60, role: "user", content: [{ type: "text", text: headerTokenTrigger }] },
]);
const semanticHeaderThird = mergeCheckpointTwice(semanticHeaderFirst, 61);
assert.ok(parseCompiledConversation(semanticHeaderThird).goals.includes(headerTokenTrigger));
assert.ok(semanticHeaderThird.includes(headerTokenTrigger));
assert.doesNotMatch(semanticHeaderThird, /^\[Commits\] tab/m);

// The same mid-line token in a brief-only checkpoint also remains opaque after
// two merges and does not manufacture semantic section garbage.
const briefHeaderCheckpoint = `${COMPILER_MARKER}\n\n[user]\n${headerTokenTrigger} (#70)\n\n---\n\n${RECALL_NOTE}`;
const briefHeaderThird = mergeCheckpointTwice(briefHeaderCheckpoint, 71);
const parsedBriefHeaderThird = parseCompiledConversation(briefHeaderThird);
assert.ok(parsedBriefHeaderThird.brief.includes(`${headerTokenTrigger} (#70)`));
assert.ok(briefHeaderThird.includes(`[user]\n${headerTokenTrigger} (#70)`));
assert.doesNotMatch(briefHeaderThird, /^\[Commits\] tab/m);

// A marker copied into transcript prose is content; only the leading compiler
// marker line is structural.
const copiedMarkerLine = `The pasted token ${COMPILER_MARKER} must remain in this transcript.`;
const markerCheckpoint = `[user]\n${copiedMarkerLine} (#75)\n\n---\n\n${RECALL_NOTE}`;
const markerSecond = compileConversation([], { previousSummary: markerCheckpoint });
assert.ok(markerSecond.includes(copiedMarkerLine));

// A brief-only pasted issue may contain its own blank-line-wrapped markdown
// rule. The compiler-owned outer boundary is independent of that content.
const leadingIssueLines = [
  "[user]",
  "Follow-up issue: preserve this complete pasted report. (#80)",
  "Status: the previous parser discarded everything before the horizontal rule.",
  "Context: this leading text and its role header are source conversation data.",
  "Requirement: repeated child compactions must retain every one of these lines.",
];
const trailingIssueLines = [
  "Acceptance criteria: retain the markdown rule as content too.",
  "Final detail: later transcript content must remain in chronological order.",
];
const issueWithRule = [...leadingIssueLines, "", "---", "", ...trailingIssueLines].join("\n");
const issueCheckpoint = `${COMPILER_MARKER}\n\n${issueWithRule}\n\n---\n\n${RECALL_NOTE}`;
const issueThird = mergeCheckpointTwice(issueCheckpoint, 81);
const parsedIssueThird = parseCompiledConversation(issueThird).brief;
for (const line of [...leadingIssueLines, "---", ...trailingIssueLines]) {
  assert.ok(issueThird.includes(line), `repeated merge lost issue content: ${line}`);
  assert.ok(parsedIssueThird.includes(line), `checkpoint parser lost issue content: ${line}`);
}
assert.ok((issueThird.match(/^---$/gm) ?? []).length >= 2, "content rule and compiler footer both remain");

console.log("conversation compiler DSH adapter: ok");
