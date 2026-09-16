#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ticketModule from "../workflow/ticket.mjs";
import {
  ensureTicket,
  loadPackagedTemplate,
  openSectionIsEmpty,
  parseKind,
  resolveTicketSource,
  templatePath,
  ticketPath,
} from "../workflow/ticket.mjs";

// Dead tools stay dead: the ticket-tool API and brain mirror are gone.
assert.equal(ticketModule.ticketRead, undefined);
assert.equal(ticketModule.ticketWrite, undefined);
assert.equal(ticketModule.applyTicketEdit, undefined);
assert.equal(ticketModule.brainTicketPath, undefined);

const template = await loadPackagedTemplate();
assert.match(template, /^# Ticket/m);
assert.match(template, /^## Kind/m);
assert.match(template, /^## \[open\]/m);
assert.match(template, /bounded — straightforward work/);
assert.match(template, /open — needs implementer judgment/);
assert.match(template, /research — investigation, spike, or benchmark/);
assert.doesNotMatch(template, /scratch\.md/);

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

// Path helpers
assert.equal(ticketPath("/repo"), join("/repo", ".architect", "ticket.md"));
assert.equal(ticketPath("/repo", "sess-1"), join("/repo", ".architect", "tickets", "sess-1.md"));
assert.equal(templatePath("/repo"), join("/repo", ".architect", "template.md"));

const dir = mkdtempSync(join(tmpdir(), "architect-ticket-"));
try {
  const created = await ensureTicket(dir);
  assert.equal(created.created, true);
  assert.equal(created.text, template);
  assert.equal(created.path, join(dir, ".architect", "ticket.md"));
  assert.equal(readFileSync(join(dir, ".architect", "ticket.md"), "utf8"), template);

  // ensureTicket is idempotent for existing tickets
  const again = await ensureTicket(dir);
  assert.equal(again.created, false);
  assert.equal(again.text, template);

  // Session-scoped tickets are isolated per session id
  const session1 = "session-test-1";
  const session2 = "session-test-2";
  const s1Created = await ensureTicket(dir, { sessionId: session1 });
  assert.equal(s1Created.created, true);
  assert.equal(s1Created.path, join(dir, ".architect", "tickets", `${session1}.md`));
  assert.equal(s1Created.text, template);

  writeFileSync(join(dir, ".architect", "tickets", `${session1}.md`), bounded);
  const s2Created = await ensureTicket(dir, { sessionId: session2 });
  assert.equal(s2Created.created, true);
  assert.equal(s2Created.text, template);
  assert.equal(parseKind(readFileSync(join(dir, ".architect", "tickets", `${session1}.md`), "utf8")), "bounded");

  // resolveTicketSource: exact match
  assert.equal(
    await resolveTicketSource(dir, session1),
    join(dir, ".architect", "tickets", `${session1}.md`),
  );

  // resolveTicketSource: prefix match (short id resolves the full file)
  mkdirSync(join(dir, ".architect", "tickets"), { recursive: true });
  writeFileSync(join(dir, ".architect", "tickets", "abcdef12-3456-7890-abcd-ef1234567890.md"), bounded);
  assert.equal(
    await resolveTicketSource(dir, "abcdef12"),
    join(dir, ".architect", "tickets", "abcdef12-3456-7890-abcd-ef1234567890.md"),
  );

  // resolveTicketSource: reverse prefix (full id resolves a short-named file)
  writeFileSync(join(dir, ".architect", "tickets", "xyz.md"), bounded);
  assert.equal(
    await resolveTicketSource(dir, "xyz-9999"),
    join(dir, ".architect", "tickets", "xyz.md"),
  );

  // resolveTicketSource: unknown session throws, no fallback to .architect/ticket.md
  await assert.rejects(
    () => resolveTicketSource(dir, "no-such-session"),
    /^Error: no ticket resolved for session 'no-such-session'$/,
  );

  // resolveTicketSource: missing session id throws the no-active-ticket error
  await assert.rejects(
    () => resolveTicketSource(dir, undefined),
    /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// resolveTicketSource with no tickets directory at all still throws (no fallback)
const empty = mkdtempSync(join(tmpdir(), "architect-ticket-empty-"));
try {
  await assert.rejects(
    () => resolveTicketSource(empty, "sess-1"),
    /^Error: no ticket resolved for session 'sess-1'$/,
  );
} finally {
  rmSync(empty, { recursive: true, force: true });
}

// archiveAndClearTicket test
const archiveDir = mkdtempSync(join(tmpdir(), "architect-ticket-archive-"));
try {
  const sess = "sess-arch-1";
  await ensureTicket(archiveDir, { sessionId: sess });
  // Overwrite with non-template content
  await ticketModule.updateTicket(archiveDir, "# Real ticket\n\n## Kind\nbounded\n\n## Problem\nReal bug\n", sess);

  const archRes = await ticketModule.archiveAndClearTicket(archiveDir, sess, { prNumber: 42 });
  assert.equal(archRes.archived, true);
  assert.equal(archRes.cleared, true);
  assert.ok(archRes.archivePath.includes("sess-arch-1-pr42-"));
  assert.equal(readFileSync(archRes.archivePath, "utf8"), "# Real ticket\n\n## Kind\nbounded\n\n## Problem\nReal bug\n");

  // Active ticket was reset to template
  const readBack = await ticketModule.readTicket(archiveDir, sess);
  assert.ok(readBack.content.includes("# Ticket"));

  // Archiving when already template does nothing
  const archAgain = await ticketModule.archiveAndClearTicket(archiveDir, sess);
  assert.equal(archAgain.archived, false);
} finally {
  rmSync(archiveDir, { recursive: true, force: true });
}

console.log("Ticket tests passed cleanly.");
