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
assert.match(ARCHITECT_SYSTEM_PROMPT(), /Update the ticket collaboratively using `ticket_write`/);
assert.match(
  ARCHITECT_SYSTEM_PROMPT(),
  /Do not call `prepare_worktree` until the operator approves the ticket \(via the Proceed button or explicit confirmation\)/,
);
assert.match(ARCHITECT_SYSTEM_PROMPT(), /When the operator approves the ticket, call `prepare_worktree`/);

assert.equal(
  IMPLEMENTER_SYSTEM_PROMPT,
  [
    "You are the implementer. Work in the checkout.",
    "Follow the ticket and instructions.",
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
