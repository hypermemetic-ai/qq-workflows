#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTicketEdit,
  ensureTicket,
  loadPackagedTemplate,
  openSectionIsEmpty,
  parseKind,
  ticketRead,
  ticketWrite,
} from "../paseo-plugin/host/workflow/ticket.mjs";

const template = await loadPackagedTemplate();
assert.match(template, /^# Ticket/m);
assert.match(template, /^## Kind/m);
assert.match(template, /^## \[open\]/m);
assert.match(template, /bounded — straightforward work/);
assert.match(template, /open — needs implementer judgment/);

assert.equal(parseKind(template), null);

const bounded = `${template.replace(
  "## Kind\n\nbounded — straightforward work.\nopen — needs implementer judgment.\n",
  "## Kind\n\nbounded\n",
).replace(/## \[open\][\s\S]*$/, "## [open]\n")}\n`;
assert.equal(parseKind(bounded), "bounded");
assert.equal(openSectionIsEmpty(bounded), true);

const open = template.replace(
  "## Kind\n\nbounded — straightforward work.\nopen — needs implementer judgment.\n",
  "## Kind\n\nopen\n",
);
assert.equal(parseKind(open), "open");

const dir = mkdtempSync(join(tmpdir(), "architect-ticket-"));
try {
  const created = await ensureTicket(dir);
  assert.equal(created.created, true);
  assert.equal(created.text, template);
  assert.equal(readFileSync(join(dir, ".architect/ticket.md"), "utf8"), template);
  mkdirSync(join(dir, ".architect"), { recursive: true });
  const again = await ticketRead(dir);
  assert.equal(again.text, template);
  const replaced = await ticketWrite(dir, {
    old_string: "The specific situation that is failing today.",
    new_string: "The login button 500s.",
  });
  assert.match(replaced.text, /The login button 500s/);
  const whole = await ticketWrite(dir, { text: bounded });
  assert.equal(parseKind(whole.text), "bounded");
  assert.equal(openSectionIsEmpty(whole.text), true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const edited = applyTicketEdit("alpha beta alpha", { old_string: "alpha", new_string: "gamma", replace_all: true });
assert.equal(edited, "gamma beta gamma");
assert.throws(() => applyTicketEdit("alpha beta alpha", { old_string: "alpha", new_string: "gamma" }));
assert.throws(() => applyTicketEdit("hello", { old_string: "missing", new_string: "x" }));
assert.throws(() => applyTicketEdit("hello", { text: "x", old_string: "h", new_string: "y" }));
