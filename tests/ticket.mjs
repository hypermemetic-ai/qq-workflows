#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTicketEdit,
  brainTicketPath,
  ensureTicket,
  loadPackagedTemplate,
  openSectionIsEmpty,
  parseKind,
  ticketRead,
  ticketWrite,
} from "../workflow/ticket.mjs";

const template = await loadPackagedTemplate();
assert.match(template, /^# Ticket/m);
assert.match(template, /^## Kind/m);
assert.match(template, /^## \[open\]/m);
assert.match(template, /bounded — straightforward work/);
assert.match(template, /open — needs implementer judgment/);
assert.match(template, /research — investigation, spike, or benchmark/);

assert.equal(parseKind(template), null);

const templateKind =
  "## Kind\n\nbounded — straightforward work.\nopen — needs implementer judgment.\nresearch — investigation, spike, or benchmark.\n";

const bounded = `${template.replace(
  templateKind,
  "## Kind\n\nbounded\n",
).replace(/## \[open\][\s\S]*$/, "## [open]\n")}\n`;
assert.equal(parseKind(bounded), "bounded");
assert.equal(openSectionIsEmpty(bounded), true);

const open = template.replace(
  templateKind,
  "## Kind\n\nopen\n",
);
assert.equal(parseKind(open), "open");

const research = template.replace(
  templateKind,
  "## Kind\n\nresearch\n",
);
assert.equal(parseKind(research), "research");

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

  // Session-scoped ticket tests
  const session1 = "session-test-1";
  const session2 = "session-test-2";
  const s1Created = await ensureTicket(dir, { sessionId: session1 });
  assert.equal(s1Created.created, true);
  assert.equal(s1Created.path, join(dir, ".architect", "tickets", `${session1}.md`));
  assert.equal(s1Created.text, template);
  assert.equal(readFileSync(join(dir, ".architect", "tickets", `${session1}.md`), "utf8"), template);

  // ticketRead with sessionId
  const s1Read = await ticketRead(dir, undefined, session1);
  assert.equal(s1Read.text, template);
  const s1ReadDirect = await ticketRead(dir, session1);
  assert.equal(s1ReadDirect.text, template);

  // ticketWrite with sessionId
  const s1Modified = await ticketWrite(dir, { text: bounded }, undefined, session1);
  assert.equal(parseKind(s1Modified.text), "bounded");
  assert.equal(readFileSync(join(dir, ".architect", "tickets", `${session1}.md`), "utf8"), bounded);
  assert.equal(readFileSync(brainTicketPath(session1), "utf8"), bounded);
  assert.equal(s1Modified.artifactPath, brainTicketPath(session1));

  // Custom io.home test
  const session3 = "session-test-3";
  const customHome = mkdtempSync(join(tmpdir(), "brain-test-home-"));
  try {
    const s3Custom = await ticketWrite(dir, { text: bounded }, { home: customHome }, session3);
    assert.equal(
      readFileSync(join(customHome, ".gemini", "antigravity-cli", "brain", session3, "ticket.md"), "utf8"),
      bounded,
    );
    assert.equal(
      s3Custom.artifactPath,
      join(customHome, ".gemini", "antigravity-cli", "brain", session3, "ticket.md"),
    );
  } finally {
    rmSync(customHome, { recursive: true, force: true });
  }

  // session-2 starts clean with template, isolated from session-1
  const s2Read = await ticketRead(dir, session2);
  assert.equal(s2Read.text, template);
  assert.equal(parseKind(s2Read.text), null);
  assert.equal(readFileSync(join(dir, ".architect", "tickets", `${session2}.md`), "utf8"), template);

  // Backward compatibility: ticketRead/ticketWrite without sessionId still uses .architect/ticket.md
  const fallbackRead = await ticketRead(dir);
  assert.equal(fallbackRead.path, join(dir, ".architect", "ticket.md"));
  assert.equal(fallbackRead.text, bounded);
} finally {
  rmSync(dir, { recursive: true, force: true });
  try {
    rmSync(join(homedir(), ".gemini", "antigravity-cli", "brain", session1), { recursive: true, force: true });
    rmSync(join(homedir(), ".gemini", "antigravity-cli", "brain", session2), { recursive: true, force: true });
  } catch {}
}

const edited = applyTicketEdit("alpha beta alpha", { old_string: "alpha", new_string: "gamma", replace_all: true });
assert.equal(edited, "gamma beta gamma");
assert.throws(() => applyTicketEdit("alpha beta alpha", { old_string: "alpha", new_string: "gamma" }));
assert.throws(() => applyTicketEdit("hello", { old_string: "missing", new_string: "x" }));
assert.throws(() => applyTicketEdit("hello", { text: "x", old_string: "h", new_string: "y" }));
