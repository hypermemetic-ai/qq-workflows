#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHITECT_SYSTEM_PROMPT,
  RESEARCHER_SYSTEM_PROMPT,
  TEACHER_SYSTEM_PROMPT,
} from "../paseo-plugin/host/workflow/prompts.mjs";
import { MINI_SWE_SYSTEM_PROMPT } from "../paseo-plugin/host/workflow/prompts.mjs";

assert.equal(
  ARCHITECT_SYSTEM_PROMPT,
  [
    "You are the architect. The ticket is `.architect/ticket.md`.",
    "",
    "## Recommended Workflow",
    "",
    "Investigate their intent and ask exploratory questions. Contribute architectural judgment; they own intent and private knowledge. Take notes and reasoning on the ticket so the operator can see them. Mark what is not settled. Fill it in as it becomes clear. Delegate when it is ready.",
    "",
    "## Context",
    "",
    "This operator message and your reply, plus at least the previous operator message and your reply, stay in context. Retain additional whole exchanges to reach a 2,048-token conversation floor. Older conversation is dropped.",
    "",
    "## Teacher",
    "",
    "If the operator cannot give an informed opinion on a live question, ask whether the ticket can stay underspecified; they decide. If they want to learn, or the ticket is too consequential to leave open, call teacher. Tell the operator to open that session. When it returns, put the decision in the ticket.",
  ].join("\n"),
);

assert.equal(
  TEACHER_SYSTEM_PROMPT,
  "You are the teacher. The ticket is `.architect/ticket.md`. Start from the ticket. When they can answer the parked question, call done.",
);

assert.equal(
  RESEARCHER_SYSTEM_PROMPT,
  [
    "You obtain knowledge for an architect.",
    "",
    "The question is the user message.",
    "Call done when you have the answer.",
    "First sentence is the answer. Then the sources: file paths and URLs.",
  ].join("\n"),
);

const banned = [
  "case_write",
  "working memory",
  "qq-relay",
  "workflow_send",
  "workflow_status",
  "DSH",
  "dsh",
  "Mini",
  "OCR",
  "Learning",
];
for (const prompt of [ARCHITECT_SYSTEM_PROMPT, TEACHER_SYSTEM_PROMPT, RESEARCHER_SYSTEM_PROMPT]) {
  for (const needle of banned) {
    assert.doesNotMatch(prompt, new RegExp(needle));
  }
}

assert.equal(MINI_SWE_SYSTEM_PROMPT, "You are a helpful assistant that can interact with a computer.");
const researcher = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../runtimes/python/src/researcher.py"),
  "utf8",
);
assert.match(researcher, /Call done when you have the answer/);
assert.doesNotMatch(researcher, /Call final_answer when you have the answer/);
assert.doesNotMatch(researcher, /Do not recommend/);
