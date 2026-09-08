import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TICKET_RELATIVE = ".architect/ticket.md";
export const TEMPLATE_RELATIVE = ".architect/template.md";

export function ticketPath(cwd, sessionId) {
  if (sessionId) {
    return join(cwd, ".architect", "tickets", `${sessionId}.md`);
  }
  return join(cwd, TICKET_RELATIVE);
}

export function brainTicketPath(sessionId, home = homedir()) {
  if (!sessionId) return null;
  return join(home, ".gemini", "antigravity-cli", "brain", sessionId, "ticket.md");
}

export function templatePath(cwd) {
  return join(cwd, TEMPLATE_RELATIVE);
}

export async function loadPackagedTemplate() {
  return PACKAGED_TEMPLATE_TEXT;
}

export async function ensureTicket(cwd, { readFileFn = readFile, writeFileFn = writeFile, mkdirFn = mkdir, sessionId } = {}) {
  const path = ticketPath(cwd, sessionId);
  try {
    return { path, text: await readFileFn(path, "utf8"), created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let template;
  try {
    template = await readFileFn(templatePath(cwd), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    template = await loadPackagedTemplate();
    await mkdirFn(dirname(templatePath(cwd)), { recursive: true });
    await writeFileFn(templatePath(cwd), template);
  }
  await mkdirFn(dirname(path), { recursive: true });
  await writeFileFn(path, template);
  return { path, text: template, created: true };
}

export function applyTicketEdit(current, input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("ticket_write requires text or old_string/new_string");
  }
  const hasText = Object.hasOwn(input, "text");
  const hasOld = Object.hasOwn(input, "old_string");
  const hasNew = Object.hasOwn(input, "new_string");
  if (hasText) {
    if (hasOld || hasNew) throw new Error("ticket_write: use text or old_string/new_string, not both");
    if (typeof input.text !== "string") throw new Error("ticket_write text must be a string");
    return input.text;
  }
  if (!hasOld || !hasNew) throw new Error("ticket_write requires text or old_string/new_string");
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
    throw new Error("ticket_write old_string and new_string must be strings");
  }
  if (input.replace_all === true) {
    if (!current.includes(input.old_string)) {
      throw new Error("ticket_write old_string not found");
    }
    return current.split(input.old_string).join(input.new_string);
  }
  const index = current.indexOf(input.old_string);
  if (index < 0) throw new Error("ticket_write old_string not found");
  const second = current.indexOf(input.old_string, index + input.old_string.length);
  if (second >= 0) throw new Error("ticket_write old_string matched more than once; pass replace_all");
  return current.slice(0, index) + input.new_string + current.slice(index + input.old_string.length);
}

export async function ticketRead(cwd, io, sessionId) {
  let resolvedIo = io;
  let resolvedSessionId = sessionId;
  if (typeof io === "string") {
    resolvedSessionId = io;
    resolvedIo = {};
  } else if (io && typeof io === "object") {
    if (!resolvedSessionId && io.sessionId) {
      resolvedSessionId = io.sessionId;
    }
  }
  const { path, text } = await ensureTicket(cwd, { ...resolvedIo, sessionId: resolvedSessionId });
  return { path, text };
}

export async function ticketWrite(cwd, input, io = {}, sessionId) {
  let resolvedIo = io;
  let resolvedSessionId = sessionId;
  if (typeof io === "string") {
    resolvedSessionId = io;
    resolvedIo = {};
  } else if (io && typeof io === "object") {
    if (!resolvedSessionId && io.sessionId) {
      resolvedSessionId = io.sessionId;
    }
  }
  const { path, text } = await ensureTicket(cwd, { ...resolvedIo, sessionId: resolvedSessionId });
  const next = applyTicketEdit(text, input);
  const writeFileFn = resolvedIo?.writeFileFn ?? writeFile;
  const mkdirFn = resolvedIo?.mkdirFn ?? mkdir;
  await writeFileFn(path, next);

  let artifactPath = null;
  if (resolvedSessionId) {
    const home = resolvedIo?.home ?? homedir();
    artifactPath = brainTicketPath(resolvedSessionId, home);
    try {
      await mkdirFn(dirname(artifactPath), { recursive: true });
      await writeFileFn(artifactPath, next);
    } catch {
      // Safe creation: ignore mirror write errors so workflow continues
    }
  }

  return { path, text: next, ...(artifactPath ? { artifactPath } : {}) };
}

export function extractSection(markdown, heading) {
  const source = String(markdown ?? "");
  const name = String(heading ?? "").replace(/^\[/, "").replace(/\]$/, "");
  const pattern = new RegExp(`^##[ \\t]+(?:\\[${escapeRegExp(name)}\\]|${escapeRegExp(name)})[ \\t]*$`, "im");
  const match = pattern.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const next = /^##[ \t]+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).replace(/^\n+/, "").replace(/\n+$/, "");
}

export function parseKind(markdown) {
  const section = extractSection(markdown, "Kind");
  if (section == null) return null;
  const choices = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    const match = /^(bounded|open)\b/i.exec(trimmed);
    if (match) choices.push(match[1].toLowerCase());
  }
  const unique = [...new Set(choices)];
  if (unique.length === 1) return unique[0];
  return null;
}

export function openSectionText(markdown) {
  return extractSection(markdown, "[open]") ?? extractSection(markdown, "open") ?? "";
}

export function openSectionIsEmpty(markdown) {
  return openSectionText(markdown).trim() === "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PACKAGED_TEMPLATE_TEXT = `# Ticket

## Kind

bounded — straightforward work.
open — needs implementer judgment.

## Problem

The specific situation that is failing today.

## Testing plan

Behavioral invariants that gate acceptance, and feasible real-world failures that must not happen.

If this repository provides \`.architect/scratch.md\`, use it to plan the test environment. Record any different setup this work needs.

## [open]

### Budget

Time we will spend. The solution fits this.

### Solution

The approach: main pieces and how they connect. Leave room for the implementer.

### Rabbit holes

Holes we can see from here, and how each one is closed.

### No-gos

What we are leaving out so this fits the budget.
`;
