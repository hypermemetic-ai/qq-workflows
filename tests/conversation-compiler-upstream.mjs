#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  BASH_CAP,
  BRIEF_MAX_LINES,
  RECALL_NOTE,
  buildBriefSections,
  buildSections,
  briefOf,
  calibrateCharsPerToken,
  compile,
  compileBrief,
  compileRanked,
  compressBash,
  estimateMessageContentChars,
  extractCommits,
  extractFiles,
  extractGoals,
  extractPreferences,
  filterNoise,
  formatSummary,
  heredocCloseIndex,
  mergePrevious,
  normalize,
  parseCompiledConversation,
  rankBriefBlocks,
  sectionOf,
  selectRankedBriefBlocks,
} from "../src/conversation-compiler/index.mjs";

const text = (value) => [{ type: "text", text: value }];
const user = (value) => ({ role: "user", content: text(value) });
const assistant = (value) => ({ role: "assistant", content: text(value) });
const call = (name, args, sourceIndex) => ({ kind: "tool_call", name, args, sourceIndex });

// normalize/content/sanitize — preserve source block boundaries and supported kinds.
assert.deepEqual(normalize([
  { role: "user", content: [{ type: "text", text: " hello\r\nworld " }, { type: "image", mimeType: "image/png" }] },
  { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", name: "Read", arguments: { file_path: "a.ts" } }] },
  { role: "bashExecution", command: "npm test", output: "ok", exitCode: 0 },
  { role: "toolResult", toolName: "Read", content: text("body") },
]), [
  { kind: "user", text: "hello\nworld", sourceIndex: 0 },
  { kind: "user", text: "[image: image/png]", sourceIndex: 0 },
  { kind: "assistant", text: "answer", sourceIndex: 1 },
  { kind: "tool_call", name: "Read", args: { file_path: "a.ts" }, sourceIndex: 1 },
  { kind: "bash", command: "npm test", output: "ok", exitCode: 0, sourceIndex: 2 },
  { kind: "tool_result", name: "Read", text: "body", sourceIndex: 3 },
]);
assert.deepEqual(normalize([{ seq: 17, role: "assistant", content: [{ type: "tool-call", name: "bash", arguments: '{"command":"npm test"}' }] }]), [
  { kind: "tool_call", name: "bash", args: { command: "npm test" }, sourceIndex: 17 },
]);

// filter-noise — exact conservative tool/string/XML handling, not broad prose regexes.
assert.deepEqual(filterNoise([
  { kind: "tool_call", name: "TodoWrite", args: {} },
  { kind: "tool_result", name: "WebSearch", text: "result" },
  { kind: "user", text: "<system-reminder>generated</system-reminder>", sourceIndex: 1 },
  { kind: "user", text: "Keep this\n<ide_opened_file>x</ide_opened_file>\nrequest", sourceIndex: 2 },
  { kind: "user", text: "ordinary reminder prose", sourceIndex: 3 },
]), [
  { kind: "user", text: "Keep this\n\nrequest", sourceIndex: 2 },
  { kind: "user", text: "ordinary reminder prose", sourceIndex: 3 },
]);
assert.equal(filterNoise([{ kind: "user", text: "Continue from where you left off. Meaningful suffix" }]).length, 0);

// brief/heredoc — adapted from upstream brief.test.ts.
assert.equal(compileBrief([]), "");
assert.equal(compileBrief([
  { kind: "user", text: "question", sourceIndex: 2 },
  { kind: "assistant", text: "line one\nline two", sourceIndex: 4 },
]), "[user]\nquestion (#2)\n\n[assistant]\nline one\nline two (#4)");
assert.equal(compressBash("set -euo pipefail\ncd /repo\ngit status | head -20"), "git status");
assert.equal(compressBash("set -e"), "set -e");
const writer = "cat > /tmp/config.json <<'EOF'\n{\"large\":true}\nsecond body line\nEOF\necho done";
assert.equal(compressBash(writer), "cat > /tmp/config.json <<'EOF'; echo done");
assert.match(compressBash("python3 - <<'PY'\n# setup\nprint('meaningful')\nPY"), /^python3 - <<'PY' print\('meaningful'\)$/);
assert.match(compressBash("sqlite3 app.db <<SQL\n-- comment\nselect count\(\*\) from users;\nSQL"), /select count/);
assert.match(compressBash("ssh host <<'CMD'\n# comment\nsystemctl restart app\nCMD"), /systemctl restart app/);
assert.match(compressBash("python3 - <<'PY' > out.txt\nprint('saved')\nPY"), /print\('saved'\)/);
assert.equal(heredocCloseIndex(["echo $((8 << 20))", "echo after"], 0), -1);
const unclosed = compressBash("python3 - <<'PY'\necho real-command");
assert.match(unclosed, /echo real-command/);
const capped = compressBash(`npm test -- ${"x".repeat(500)}`);
assert.equal(capped.length, BASH_CAP);
assert.ok(capped.endsWith("..."));

const manyTools = buildBriefSections(Array.from({ length: 12 }, (_, index) => call(`Tool${index}`, {}, 10 + index)));
const manyToolText = manyTools.flatMap((section) => section.lines).join("\n");
assert.match(manyToolText, /4 earlier tool-call entries omitted/);
for (let index = 0; index < 4; index += 1) assert.doesNotMatch(manyToolText, new RegExp(`Tool${index}(?!\\d)`));
for (let index = 4; index < 12; index += 1) assert.match(manyToolText, new RegExp(`Tool${index}(?!\\d)`));
assert.equal(manyTools.flatMap((section) => section.lines).filter((line) => /^\* Tool\d/.test(line)).length, 8);

// extraction/build-sections — source algorithms and caps.
const extractionBlocks = [
  { kind: "user", text: "Implement deterministic retries." },
  { kind: "assistant", text: "Tests are still failing because cancellation is broken." },
  { kind: "user", text: "Please use neutral product naming." },
  call("edit", { path: "/repo/src/a.mjs" }, 4),
  call("read", { file_path: "/repo/src/b.mjs" }, 5),
  call("bash", { command: 'git commit -m "fix: retry state"' }, 6),
  { kind: "tool_result", name: "bash", text: "[main abcdef12345] fix: retry state", sourceIndex: 7 },
];
assert.deepEqual(extractGoals(extractionBlocks), ["Implement deterministic retries."]);
assert.deepEqual(extractPreferences(extractionBlocks), ["Please use neutral product naming."]);
const preferenceBlocks = Array.from({ length: 12 }, (_, index) => ({ kind: "user", text: `Please use style${index}.` }));
assert.equal(extractPreferences(preferenceBlocks).length, 10);
assert.deepEqual(extractCommits(extractionBlocks), [{ hash: "abcdef12345", message: "fix: retry state" }]);
const activity = extractFiles(extractionBlocks);
assert.deepEqual([...activity.modified], ["a.mjs"]);
assert.deepEqual([...activity.read], ["b.mjs"]);
const sections = buildSections({ blocks: extractionBlocks });
assert.deepEqual(sections.sessionGoal, ["Implement deterministic retries."]);
assert.deepEqual(sections.outstandingContext, ["Tests are still failing because cancellation is broken."]);
assert.deepEqual(sections.filesAndChanges, ["Modified: a.mjs", "Read: b.mjs"]);
assert.deepEqual(sections.commits, ["abcdef12345: fix: retry state"]);
assert.deepEqual(sections.userPreferences, ["Please use neutral product naming."]);
const fileCap = buildSections({ blocks: Array.from({ length: 12 }, (_, index) => call("read", { path: `f${index}.mjs` }, index)) });
assert.match(fileCap.filesAndChanges[0], /f0\.mjs, f1\.mjs, f2\.mjs, f3\.mjs, f4\.mjs, f5\.mjs, f6\.mjs, f7\.mjs, f8\.mjs, f9\.mjs \(\+2 more\)/);

// rank — exact source weights, adjacency, recency, closure and audited poll penalty.
const score = (block) => rankBriefBlocks([block])[0];
assert.equal(score({ kind: "user", text: "task" }).score, 18);
assert.equal(score({ kind: "assistant", text: "short" }).score, 10);
assert.equal(score(call("edit", { path: "a" })).score, 34);
assert.equal(score(call("bash", { command: "npm test" })).score, 26);
assert.equal(score(call("read", { path: "a" })).score, 6);
assert.equal(score(call("custom", {})).score, 12);
assert.equal(score({ kind: "bash", command: "npm test", output: "", exitCode: 0 }).score, 30);
assert.equal(score({ kind: "bash", command: "false", output: "", exitCode: 1 }).score, 32);
assert.equal(score(call("bash", { command: "git commit -m x" })).score, 26);
assert.equal(score(call("bash", { command: "set -e\nls" })).score, -4);
assert.equal(score(call("bash", { command: "gh pr view 123" })).score, 16);
assert.deepEqual(rankBriefBlocks([{ kind: "user", text: "old" }, { kind: "user", text: "new" }]).map((item) => item.score), [18, 30]);
assert.equal(score({ kind: "assistant", text: "x".repeat(120) }).score, 24);
const adjacent = rankBriefBlocks([
  { kind: "user", text: "request" },
  { kind: "assistant", text: "context" },
  call("edit", { path: "a" }),
  { kind: "assistant", text: "result" },
]);
assert.ok(adjacent[0].reasons.includes("near-important-event"));
assert.ok(adjacent[1].reasons.includes("near-important-event"));
assert.ok(adjacent[3].reasons.includes("after-important-event"));

const polls = Array.from({ length: 4 }, (_, index) => call("bash", { command: `gh pr ${index % 2 ? "checks" : "view"} 123` }, index));
assert.deepEqual(selectRankedBriefBlocks(polls, { maxBlocks: 1, preserveRecentBlocks: 0 }).map((block) => block.sourceIndex), [3]);
const duplicatePaths = [call("edit", { path: "same.mjs" }, 1), call("edit", { path: "same.mjs" }, 2)];
assert.deepEqual(selectRankedBriefBlocks(duplicatePaths, { maxBlocks: 1, preserveRecentBlocks: 0 }).map((block) => block.sourceIndex), [2]);
const duplicateCommands = [call("bash", { command: "npm   test" }, 1), call("bash", { command: "npm test" }, 2)];
assert.deepEqual(selectRankedBriefBlocks(duplicateCommands, { maxBlocks: 1, preserveRecentBlocks: 0 }).map((block) => block.sourceIndex), [2]);
const noResults = selectRankedBriefBlocks([
  { kind: "user", text: "keep", sourceIndex: 1 },
  { kind: "tool_result", name: "read", text: "do not select", sourceIndex: 2 },
  { kind: "assistant", text: "also keep", sourceIndex: 3 },
], { maxBlocks: 2 });
assert.deepEqual(noResults.map((block) => block.sourceIndex), [1, 3]);

// Smart rendered-character budgeting charges recent blocks and scales floor→ceiling.
const hugeRecent = Array.from({ length: 30 }, (_, index) => ({ kind: "assistant", text: `${index}:${"z".repeat(300)}`, sourceIndex: index }));
const budgeted = selectRankedBriefBlocks(hugeRecent, { maxBlocks: 80, preserveRecentBlocks: 16, maxBriefChars: 500 });
assert.ok(compileBrief(budgeted).length <= 500);
const scaled = selectRankedBriefBlocks(hugeRecent, {
  maxBlocks: 80,
  preserveRecentBlocks: 0,
  maxBriefChars: 100,
  maxBriefCharsCeiling: 300,
  briefCharsPerBlock: 10,
});
assert.ok(compileBrief(scaled).length <= 300);

// format/compile/repeated merge — empty sections omitted; bounded old→fresh brief; one recall note.
assert.equal(formatSummary({ sessionGoal: [], filesAndChanges: [], commits: [], outstandingContext: [], userPreferences: [], briefTranscript: "" }), "");
const fresh = compile({ messages: [user("Implement parser."), assistant("Parser implemented.")] });
assert.match(fresh, /^\[Session Goal\]/);
assert.doesNotMatch(fresh, /^## /m);
assert.doesNotMatch(fresh, /None recorded\./);
assert.equal(fresh.split(RECALL_NOTE).length - 1, 1);
const merged = compileRanked({
  messages: [user("Please use ESM modules."), assistant("Fresh implementation is complete.")],
  previousSummary: fresh,
  ranking: { maxBriefChars: 4_400, maxBriefCharsCeiling: 8_000, briefCharsPerBlock: 60 },
});
assert.equal(merged.split(RECALL_NOTE).length - 1, 1);
assert.ok(merged.indexOf("Parser implemented.") < merged.indexOf("Fresh implementation is complete."));
const briefPart = merged.split("\n\n---\n\n")[1];
assert.ok(briefPart.split("\n").length <= BRIEF_MAX_LINES);

// Compiler headings are whole logical lines. Header-looking prose in semantic
// bullets or transcript text cannot terminate or manufacture a section.
const headerTokenTrigger = "Please review the [Commits] tab and fix the failing check.";
const headerTokenSummary = formatSummary({
  sessionGoal: [headerTokenTrigger],
  filesAndChanges: [],
  commits: [],
  outstandingContext: [],
  userPreferences: ["Keep exact source wording."],
  briefTranscript: `[user]\n${headerTokenTrigger}`,
});
assert.equal(sectionOf(headerTokenSummary, "Session Goal"), `[Session Goal]\n- ${headerTokenTrigger}`);
assert.equal(sectionOf(headerTokenSummary, "Commits"), "");
assert.equal(briefOf(headerTokenSummary), `[user]\n${headerTokenTrigger}`);

// Header merge caps preferences at 15 newest entries across repeated compactions.
const preferenceSummary = (start, count) => formatSummary({
  sessionGoal: [], filesAndChanges: [], commits: [], outstandingContext: [],
  userPreferences: Array.from({ length: count }, (_, index) => `preference-${start + index}`),
  briefTranscript: "[user]\ncheckpoint",
});
let preferenceMerged = compile({ messages: [user("Implement preference merge.")], previousSummary: preferenceSummary(0, 10) });
preferenceMerged = compile({ messages: Array.from({ length: 10 }, (_, index) => user(`Please use preference-${10 + index}.`)), previousSummary: preferenceMerged });
const preferenceHeader = preferenceMerged.match(/\[User Preferences\]\n([\s\S]*?)(?:\n\n---|$)/)?.[1] ?? "";
assert.equal(preferenceHeader.split("\n").filter((line) => line.startsWith("- ")).length, 15);
assert.doesNotMatch(preferenceHeader, /preference-0(?:\D|$)/);
assert.match(preferenceHeader, /preference-19/);

// Repeated merges consume wrapped headers as logical bullets, preserving tails.
const longGoal = "Implement " + "continuation-aware deterministic checkpoint merging without losing any preserved words ".repeat(2).trim();
const longCommit = "abcdef12345: " + "preserve every wrapped commit subject word during repeated compaction ".repeat(3).trim();
const oldPaths = [
  `src/compiler/${"first-segment-".repeat(4)}one.mjs`,
  `src/compiler/${"second-segment-".repeat(4)}two.mjs`,
  `src/compiler/${"third-segment-".repeat(4)}three.mjs`,
];
const wrappedPrevious = formatSummary({
  sessionGoal: [longGoal],
  filesAndChanges: [`Modified: ${oldPaths.join(", ")}`],
  commits: [longCommit],
  outstandingContext: [],
  userPreferences: [],
  briefTranscript: "[user]\nprevious checkpoint",
});
const wrappedFresh = formatSummary({
  sessionGoal: ["Implement the fresh follow-up."],
  filesAndChanges: ["Modified: src/compiler/fresh.mjs"],
  commits: ["fedcba98765: fresh commit"],
  outstandingContext: [],
  userPreferences: [],
  briefTranscript: "[user]\nfresh checkpoint",
});
assert.ok(wrappedPrevious.split("\n").some((line) => /^\s+\S/.test(line)), "fixture must exercise physical continuations");
const wrappedMerged = parseCompiledConversation(mergePrevious(wrappedPrevious, wrappedFresh));
assert.ok(wrappedMerged.goals.includes(longGoal));
assert.ok(wrappedMerged.commits.includes(longCommit));
assert.deepEqual(wrappedMerged.files, [`Modified: ${[...oldPaths, "src/compiler/fresh.mjs"].join(", ")}`]);

// token-estimate — all token-bearing content parts and bounded calibration.
assert.equal(estimateMessageContentChars([
  { type: "text", text: "abc" },
  { type: "thinking", thinking: "12345" },
  { type: "toolCall", name: "x", arguments: { a: 1 } },
  { type: "image" },
]), 3 + 5 + 1 + JSON.stringify({ a: 1 }).length + 4_800);
assert.deepEqual(calibrateCharsPerToken(100, undefined), { mode: "heuristic", charsPerToken: 4 });
assert.equal(calibrateCharsPerToken(100, 100).charsPerToken, 2);
assert.equal(calibrateCharsPerToken(1_000, 10).charsPerToken, 6);

console.log("conversation compiler upstream parity: ok");
