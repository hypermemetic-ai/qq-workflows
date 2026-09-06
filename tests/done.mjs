#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  formatResearcherWake,
  formatReviewerWake,
  formatTeacherWake,
  routeDone,
} from "../paseo-plugin/host/workflow/done.mjs";

assert.deepEqual(routeDone({ role: "teacher" }), { action: "wake_architect", wake: "teacher" });
assert.deepEqual(routeDone({ role: "researcher" }), { action: "wake_architect", wake: "researcher" });
assert.deepEqual(routeDone({ role: "implementer", kind: "bounded" }), {
  action: "commit_pr_merge",
  reviewer: false,
});
assert.deepEqual(routeDone({ role: "implementer", kind: "open" }), { action: "commit_spawn_reviewer" });
assert.deepEqual(routeDone({ role: "reviewer", findings: [] }), { action: "pr_merge", findings: [] });
assert.throws(() => routeDone({ role: "reviewer" }), /findings/);
assert.throws(() => routeDone({ role: "reviewer", findings: null }), /findings/);
assert.throws(() => routeDone({ role: "reviewer", findings: { path: "a.ts" } }), /findings/);
assert.deepEqual(
  routeDone({
    role: "reviewer",
    reviewRound: 1,
    findings: [{ path: "src/a.ts", line: 3, body: "off-by-one" }],
  }),
  {
    action: "spawn_implementer_same_worktree",
    findings: [{ path: "src/a.ts", line: 3, body: "off-by-one" }],
    reviewRound: 2,
  },
);
assert.equal(
  routeDone({
    role: "reviewer",
    reviewRound: 2,
    findings: [{ path: "src/a.ts", line: 3, body: "still wrong" }],
  }).action,
  "wake_architect",
);

const teacher = formatTeacherWake({ parked_question: "Which kind?", answer: "bounded" });
assert.match(teacher, /Parked question: Which kind\?/);
assert.match(teacher, /Answer: bounded/);
assert.equal(
  formatResearcherWake({ answer: "Use ACP.\n- https://example", sources: ["https://ignored"] }),
  "Use ACP.\n- https://example",
);
const review = formatReviewerWake({
  findings: [{ path: "src/a.ts", line: 3, body: "still wrong" }],
  packet: {
    files: [{ path: "src/a.ts", sha: "abc", hunks: [{ header: "@@ -1,1 +1,1 @@", newStart: 1 }] }],
  },
});
assert.match(review, /src\/a.ts:3 still wrong/);
assert.match(review, /src\/a.ts @ abc/);
assert.match(review, /@@ -1,1 \+1,1 @@/);
