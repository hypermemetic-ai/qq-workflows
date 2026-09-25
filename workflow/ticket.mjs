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

export async function readTicket(cwd, sessionId, options = {}) {
  const path = sessionId ? await resolveTicketSource(cwd, sessionId) : ticketPath(cwd);
  const content = await readFile(path, "utf8");
  const sections = listSections(content);
  if (typeof options === "string") {
    options = { section: options };
  }
  const { section, sectionsOnly, listSections: shouldList } = options;
  if (shouldList || sectionsOnly) {
    return { path, sections };
  }
  if (section) {
    const sectionContent = extractSection(content, section);
    return { path, section, content: sectionContent, text: sectionContent, sections };
  }
  return { path, content, text: content, sections };
}

export async function updateTicket(cwd, content, sessionId, options = {}) {
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  if (typeof sessionId === "object" && sessionId !== null) {
    options = sessionId;
    sessionId = options.sessionId;
  }
  const { section } = options;
  const path = sessionId ? ticketPath(cwd, sessionId) : ticketPath(cwd);

  let newContent = content;
  if (section) {
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      try {
        current = await readFile(templatePath(cwd), "utf8");
      } catch {
        current = await loadPackagedTemplate();
      }
    }
    newContent = replaceSection(current, section, content);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, newContent, "utf8");
  return { path, content: newContent, text: newContent };
}

export function listSections(markdown) {
  const source = String(markdown ?? "");
  const matches = source.matchAll(/^##[ \t]+([^\r\n]+)$/gm);
  const sections = [];
  for (const match of matches) {
    sections.push(match[1].trim());
  }
  return sections;
}

export function replaceSection(markdown, heading, newContent) {
  const source = String(markdown ?? "");
  const name = String(heading ?? "").replace(/^\[/, "").replace(/\]$/, "");
  const pattern = new RegExp(`^##[ \\t]+(?:\\[${escapeRegExp(name)}\\]|${escapeRegExp(name)})[ \\t]*$`, "im");
  const match = pattern.exec(source);
  const trimmed = String(newContent ?? "").trim();
  if (match) {
    const headerLine = match[0];
    const start = match.index + headerLine.length;
    const rest = source.slice(start);
    const next = /^##[ \t]+/m.exec(rest);
    const afterSection = next ? rest.slice(next.index) : "";
    const replacement = `${headerLine}\n\n${trimmed}\n\n`;
    return source.slice(0, match.index) + replacement + afterSection.replace(/^\r?\n+/, "");
  }
  // Heading not found: append to the end
  const sep = source.endsWith("\n\n") ? "" : (source.endsWith("\n") ? "\n" : "\n\n");
  return `${source}${sep}## ${heading}\n\n${trimmed}\n`;
}

export async function archiveAndClearTicket(root, sessionId, { prNumber } = {}) {
  if (!sessionId) return null;
  const srcPath = await resolveTicketSource(root, sessionId).catch(() => null);
  if (!srcPath || !existsSync(srcPath)) return null;

  const content = await readFile(srcPath, "utf8");
  const template = await loadPackagedTemplate();
  let baseTemplate = template;
  try {
    baseTemplate = await readFile(templatePath(root), "utf8");
  } catch {}

  // If already matches the template or is empty, no need to archive
  if (!content.trim() || content.trim() === baseTemplate.trim() || content.trim() === template.trim()) {
    return { archived: false, path: srcPath, cleared: false };
  }

  const archiveDir = join(root, ".architect", "tickets", "archive");
  await mkdir(archiveDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prTag = prNumber ? `-pr${prNumber}` : "";
  const archiveName = `${basename(srcPath, ".md")}${prTag}-${timestamp}.md`;
  const archivePath = join(archiveDir, archiveName);

  await writeFile(archivePath, content, "utf8");
  await writeFile(srcPath, baseTemplate, "utf8");

  return {
    archived: true,
    archivePath,
    path: srcPath,
    cleared: true,
  };
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

bounded — direct execution, with targeted architect review and inexpensive correction where sufficient. A clear plan can make substantial work suitable for bounded.
open — coordinated implementation and independent review when complexity and the choices left to the executor warrant the additional machinery.
research — investigation, spike, or benchmark.

## Problem

The objective and situation to change; state the desired outcome and hard boundaries.

## Acceptance

State what must be true for this change to be acceptable in its intended use. Include only constraints, assumptions and accepted limitations that materially affect that judgment.

## Testing plan

Describe the evidence and checks needed to establish acceptance, including meaningful failure cases. Identify mandatory verification and any agreed limits on it.

## [open]

### Budget

Time we will spend. The solution fits this.

### Solution

Intended outcome and any necessary constraints. Leave implementation methods and routine decisions to the worker.

### Rabbit holes

Holes we can see from here, and how each one is closed.

### No-gos

What we are leaving out so this fits the budget.
`;
