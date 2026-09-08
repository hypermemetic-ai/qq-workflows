#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  ARCHITECT_SYSTEM_PROMPT,
  IMPLEMENTER_SYSTEM_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
} from "../workflow/prompts.mjs";

assert.match(ARCHITECT_SYSTEM_PROMPT(), /\.architect\/tickets\/<sessionId>\.md/);
assert.match(ARCHITECT_SYSTEM_PROMPT("sess-123"), /\.architect\/tickets\/sess-123\.md/);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /## Guidelines/);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /## Teaching/);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /call `prepare_worktree`/);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /call `land`/);
assert.doesNotMatch(ARCHITECT_SYSTEM_PROMPT(), /ticket_write/);
assert.doesNotMatch(ARCHITECT_SYSTEM_PROMPT(), /ticket_read/);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /Ask questions one at a time with recommendations\./);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /Populate ticket and testing plan collaboratively with the operator/);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /RequestFeedback: false/);
assert.match(
  ARCHITECT_SYSTEM_PROMPT(),
  /Do not call `prepare_worktree` until the operator approves \(via Proceed button or explicit confirmation\)/,
);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /When the operator approves the ticket, call `prepare_worktree`/);

assert.equal(
  IMPLEMENTER_SYSTEM_PROMPT,
  [
    "You are the implementer. Work in the checkout.",
    "Implement .architect/ticket.md.",
    "When finished, report your answer.",
  ].join("\n"),
);

assert.equal(
  REVIEWER_SYSTEM_PROMPT,
  [
    "You are the reviewer. The ticket is `.architect/ticket.md`.",
    "Follow its testing plan. Do not change project code.",
    "Report findings. Empty findings means it passed.",
  ].join("\n"),
);

console.log("Prompts tests passed cleanly.");
