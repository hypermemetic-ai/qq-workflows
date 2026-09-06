#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  assembleArchitectRequest,
  keptPairs,
  rememberPair,
  TICKET_BLOCK_HEADING,
  ticketBlock,
} from "../paseo-plugin/host/fold.mjs";
import { ARCHITECT_SYSTEM_PROMPT } from "../paseo-plugin/host/workflow/prompts.mjs";

const pairs = [
  { operator: "one", architect: "a1" },
  { operator: "two", architect: "a2" },
  { operator: "three", architect: "a3" },
];
assert.deepEqual(keptPairs(pairs), [
  { operator: "two", architect: "a2" },
  { operator: "three", architect: "a3" },
]);

const request = assembleArchitectRequest({
  ticketText: "# Ticket\n\nbounded",
  pairs: [
    { operator: "one", architect: "a1" },
    { operator: "two", architect: "a2" },
  ],
  operatorText: "three",
});

assert.equal(request.instructions, ARCHITECT_SYSTEM_PROMPT);
assert.equal(request.input[0].role, "user");
assert.match(request.input[0].content, new RegExp(TICKET_BLOCK_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(request.input[0].content, /# Ticket/);
assert.deepEqual(
  request.input.slice(1).map((item) => item.content),
  ["two", "a2", "three"],
);
assert.equal(request.input.filter((item) => item.content === "one").length, 0);
assert.equal(ticketBlock("abc").endsWith("abc"), true);

const next = rememberPair(pairs, "four", "a4");
assert.deepEqual(next.map((pair) => pair.operator), ["three", "four"]);
assert.equal(next.length, 2);
