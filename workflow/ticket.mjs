import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const TICKET_RELATIVE = ".architect/ticket.md";
export const TEMPLATE_RELATIVE = ".architect/template.md";

export function ticketPath(cwd, sessionId) {
  if (sessionId) {
    return join(cwd, ".architect", "tickets", `${sessionId}.md`);
  }
  return join(cwd, TICKET_RELATIVE);
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

// Resolve the on-disk ticket for a session: exact match first, then a unique
// prefix match (either direction), else throw. There is no fallback: a
// missing ticket fails fast so a child can never execute a dead spec.
// Backup files (*-sources.md) never resolve via prefix.
export async function resolveTicketSource(root, sessionId) {
  if (!sessionId) {
    throw new Error("no active ticket: pass sessionId or create .architect/tickets/<id>.md");
  }
  const exact = ticketPath(root, sessionId);
  if (existsSync(exact)) return exact;
  const ticketsDir = join(root, ".architect", "tickets");
  if (existsSync(ticketsDir)) {
    const files = await readdir(ticketsDir);
    const matches = files
      .filter((f) => f.endsWith(".md")
        && !f.endsWith("-sources.md")
        && (f.startsWith(sessionId) || sessionId.startsWith(basename(f, ".md"))))
      .sort();
    if (matches.length === 1) return join(ticketsDir, matches[0]);
    if (matches.length > 1) {
      throw new Error(`ambiguous ticket prefix '${sessionId}': matches ${matches.join(", ")}; use a longer prefix or the exact sessionId`);
    }
  }
  throw new Error(`no ticket resolved for session '${sessionId}'`);
}

export const PROVIDERS = ["muse", "gemini", "deepseek", "codex", "astra"];
export const CANONICAL_PROVIDERS = ["muse", "gemini", "deepseek", "codex"];

export function normalizeProvider(value) {
  if (typeof value !== "string") return value;
  const p = value.trim().toLowerCase();
  if (p === "astra") return "codex";
  return p;
}

export function isKnownProvider(value) {
  if (typeof value !== "string") return false;
  return PROVIDERS.includes(value.trim().toLowerCase());
}

export function assertKnownProvider(value) {
  if (!isKnownProvider(value)) {
    throw new Error(`unknown provider '${value}': expected 'muse' | 'gemini' | 'deepseek' | 'codex' | 'astra'`);
  }
  return normalizeProvider(value);
}

export async function readTicket(cwd, sessionId) {
  const path = sessionId ? await resolveTicketSource(cwd, sessionId) : ticketPath(cwd);
  const content = await readFile(path, "utf8");
  return { path, content, text: content };
}

export async function updateTicket(cwd, content, sessionId) {
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  const path = sessionId ? ticketPath(cwd, sessionId) : ticketPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return { path, content, text: content };
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
    const match = /^(bounded|open|research)\b/i.exec(trimmed);
    if (match) choices.push(match[1].toLowerCase());
  }
  const unique = [...new Set(choices)];
  if (unique.length === 1) return unique[0];
  return null;
}

export function parseProvider(markdown) {
  const section = extractSection(markdown, "Provider");
  if (section == null) return null;
  const choices = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    const match = /^(muse|gemini|deepseek|codex|astra)\b/i.exec(trimmed);
    if (match) choices.push(normalizeProvider(match[1].toLowerCase()));
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
research — investigation, spike, or benchmark.

## Problem

The specific situation that is failing today.

## Testing plan

Behavioral invariants that gate acceptance, and feasible real-world failures that must not happen.

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
