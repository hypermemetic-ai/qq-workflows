#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchWorkspace, readManifest } from "../src/research-evidence.mjs";
import { createResearchSessions, SESSION_RAW_EVENT_BOUND } from "../src/research-sessions.mjs";

const scratch = mkdtempSync(join(tmpdir(), "qq-research-sessions."));
const repo = join(scratch, "repo"); mkdirSync(repo);
const workspace = await createResearchWorkspace({ parentDir: join(scratch, "runs"), repoRoot: repo, question: "q" });
const calls = [];
const text = (value) => [{ type: "text", text: value }];
const events = [
  { seq: 1, type: "user/message", data: { content: text("earlier user") } },
  { seq: 2, type: "tool/result", data: { message: { content: text("secret tool output") } } },
  { seq: 3, type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "secret reasoning" }, ...text("visible answer") ] } } },
  { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "bash", arguments: { command: "secret" } }] } } },
  { seq: 5, type: "user/message", data: { content: [{ type: "attachment", name: "secret.bin" }, ...text("later user") ] } },
];
const sessionQuery = {
  async searchSessions(request) {
    calls.push(["search", request]);
    return { items: [{
      header: { id: "session-11111111-1111-4111-8111-111111111111", title: "Prior work" },
      bestMatch: { seq: 3, type: "assistant/message", surface: "assistant", snippet: "visible answer" },
    }] };
  },
  async readEvent(request) {
    calls.push(["read", request]);
    return { target: events[2], events };
  },
};
const sessions = createResearchSessions({ workspace, sessionQuery });
const table = await sessions.search(["visible", "answer"]);
assert.match(table, /S001/);
assert.equal((await readManifest(workspace)).length, 0);
const acquired = await sessions.get("S001");
assert.equal((await readManifest(workspace)).length, 1);
assert.deepEqual(calls.at(-1)[1], {
  sessionId: "session-11111111-1111-4111-8111-111111111111",
  seq: 3, before: SESSION_RAW_EVENT_BOUND, after: SESSION_RAW_EVENT_BOUND,
});
const snapshot = readFileSync(acquired.markdownPath, "utf8");
assert.match(snapshot, /earlier user/);
assert.match(snapshot, /visible answer/);
assert.match(snapshot, /later user/);
assert.doesNotMatch(snapshot, /secret tool|secret reasoning|secret\.bin|tool-call/);
console.log("research sessions: ok");
