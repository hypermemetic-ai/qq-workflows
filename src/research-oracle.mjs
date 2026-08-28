import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  MINI_REVIEW_GLOB_LIMIT,
  MINI_REVIEW_GREP_LIMIT,
  MINI_REVIEW_VIEW_BYTE_LIMIT,
  MINI_REVIEW_VIEW_LINE_LIMIT,
} from "./mini-review-v2.mjs";
import { truncateObservation } from "./observation.mjs";

export const RESEARCH_ORACLE_ROOTS = Object.freeze(["question.md", "answer.md", "evidence", "repo"]);

function validatePath(value, { allowEmpty = false, label = "path" } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error(`${label} must be a capsule-relative path`);
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${label} must be a capsule-relative path using / separators`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || (!allowEmpty && part === ""))) throw new Error(`${label} must not contain .. or empty components`);
  if (value && !RESEARCH_ORACLE_ROOTS.some((root) => value === root || value.startsWith(`${root}/`))) {
    throw new Error(`${label} is outside the research capsule surfaces`);
  }
  return value;
}

function globRegex(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.includes("\0") || pattern.includes("\\")
    || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)
    || pattern.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("pattern must be a safe capsule-relative glob");
  }
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") { index++; source += "(?:.*/)?"; }
        else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function trimFinalEmpty(lines) {
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function boundedLines(text, limit) {
  const lines = trimFinalEmpty(String(text ?? "").split("\n"));
  return lines.slice(0, limit);
}

export class ResearchOracle {
  #root;
  #repoRootPromise;

  constructor(root) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error("ResearchOracle requires an absolute capsule root");
    this.#root = root;
    this.#repoRootPromise = realpath(join(root, "repo"));
  }

  get root() { return this.#root; }

  async #resolve(relativePath, { mustBeFile = false } = {}) {
    const safe = validatePath(relativePath);
    const candidate = resolve(this.#root, safe);
    const rootRelative = relative(this.#root, candidate);
    if (rootRelative.startsWith(`..${sep}`) || rootRelative === ".." || isAbsolute(rootRelative)) throw new Error("path escapes research capsule");
    let actual;
    try { actual = await realpath(candidate); }
    catch { throw new Error(`path not found: ${safe}`); }
    if (safe === "repo" || safe.startsWith("repo/")) {
      const repoRoot = await this.#repoRootPromise;
      const repoRelative = relative(repoRoot, actual);
      if (repoRelative.startsWith(`..${sep}`) || repoRelative === ".." || isAbsolute(repoRelative)) throw new Error(`repo path escapes project: ${safe}`);
    } else {
      const actualRelative = relative(this.#root, actual);
      if (actualRelative.startsWith(`..${sep}`) || actualRelative === ".." || isAbsolute(actualRelative)) throw new Error(`path escapes capsule: ${safe}`);
    }
    const info = await lstat(actual);
    if (mustBeFile && (!info.isFile() || info.isSymbolicLink())) throw new Error(`path is not a regular file: ${safe}`);
    return { safe, actual, info };
  }

  async #walk(relativePath, output) {
    const resolved = await this.#resolve(relativePath);
    if (resolved.info.isFile()) { output.push(relativePath); return; }
    if (!resolved.info.isDirectory()) return;
    const entries = await readdir(resolved.actual, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" && (relativePath === "repo" || relativePath.startsWith("repo/"))) continue;
      const child = `${relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.#walk(child, output);
      else if (entry.isFile()) output.push(child);
      if (output.length > 10_000) throw new Error("capsule path enumeration limit exceeded");
    }
  }

  async glob({ pattern } = {}) {
    const regex = globRegex(pattern);
    const paths = [];
    for (const root of RESEARCH_ORACLE_ROOTS) {
      try { await this.#walk(root, paths); } catch (error) {
        if (!/path not found/.test(error?.message ?? "")) throw error;
      }
    }
    const matches = paths.filter((path) => regex.test(path));
    const selected = matches.slice(0, MINI_REVIEW_GLOB_LIMIT);
    return truncateObservation([
      `MATCHES ${selected.length}${matches.length > selected.length ? ` OF ${matches.length}` : ""}`,
      ...selected,
      ...(matches.length > selected.length ? ["[TRUNCATED]"] : []),
    ].join("\n"));
  }

  async grep({ query, path = "" } = {}) {
    if (typeof query !== "string" || !query) throw new Error("grep query must be a non-empty literal string");
    if (query.includes("\0")) throw new Error("grep query must not contain NUL");
    const roots = [];
    if (path) {
      const safe = validatePath(path);
      const resolved = await this.#resolve(safe);
      if (resolved.info.isFile()) roots.push(safe);
      else await this.#walk(safe, roots);
    } else {
      for (const root of RESEARCH_ORACLE_ROOTS) {
        try { await this.#walk(root, roots); } catch (error) {
          if (!/path not found/.test(error?.message ?? "")) throw error;
        }
      }
    }
    const matches = [];
    let total = 0;
    for (const file of roots) {
      let bytes;
      try { bytes = await readFile((await this.#resolve(file, { mustBeFile: true })).actual); } catch { continue; }
      if (bytes.includes(0) || bytes.length > 4 * 1024 * 1024) continue;
      const lines = trimFinalEmpty(bytes.toString("utf8").split("\n"));
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].includes(query)) continue;
        total++;
        if (matches.length < MINI_REVIEW_GREP_LIMIT) matches.push(`${file}:${index + 1}:${lines[index]}`);
      }
    }
    return truncateObservation([
      `MATCHES ${matches.length}${total > matches.length ? ` OF ${total}` : ""}`,
      ...matches,
      ...(total > matches.length ? ["[TRUNCATED]"] : []),
    ].join("\n"));
  }

  async view({ path, start_line: startLine, end_line: endLine } = {}) {
    const safe = validatePath(path);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error("view bounds must be positive and end_line must not precede start_line");
    }
    const { actual } = await this.#resolve(safe, { mustBeFile: true });
    const bytes = await readFile(actual);
    if (bytes.includes(0)) return `BINARY ${safe} (content not shown)`;
    const lines = trimFinalEmpty(bytes.toString("utf8").split("\n"));
    if (startLine > lines.length) return `ERROR start_line ${startLine} is past end of ${safe} (${lines.length} lines)`;
    const requestedEnd = Math.min(endLine, lines.length);
    const cappedEnd = Math.min(requestedEnd, startLine + MINI_REVIEW_VIEW_LINE_LIMIT - 1);
    const visible = lines.slice(startLine - 1, cappedEnd).map((line, offset) => `${startLine + offset}|${line}`);
    let byteTruncated = false;
    let observation;
    while (true) {
      const actualEnd = visible.length ? startLine + visible.length - 1 : startLine - 1;
      const truncated = cappedEnd < requestedEnd || byteTruncated;
      observation = [
        `FILE ${safe}`,
        `LINES ${startLine}-${actualEnd} OF ${lines.length}`,
        ...visible,
        ...(truncated ? [`[TRUNCATED: requested lines ${startLine}-${requestedEnd}]`] : []),
      ].join("\n");
      if (Buffer.byteLength(observation, "utf8") <= MINI_REVIEW_VIEW_BYTE_LIMIT || visible.length === 0) break;
      visible.pop();
      byteTruncated = true;
    }
    return truncateObservation(observation);
  }

  async validateFindings(findings) {
    if (!Array.isArray(findings)) throw new Error("findings must be an array");
    let answerLines = 0;
    try { answerLines = boundedLines(await readFile(join(this.#root, "answer.md"), "utf8"), Number.MAX_SAFE_INTEGER).length; }
    catch { throw new Error("answer.md is unavailable for review findings"); }
    return findings.map((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)
        || Object.keys(finding).sort().join(",") !== "body,line,path") {
        throw new Error(`finding ${index + 1} must contain only path, line, and body`);
      }
      if (finding.path !== "answer.md") throw new Error(`finding ${index + 1} must point to answer.md`);
      if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > answerLines) {
        throw new Error(`finding ${index + 1} line is outside answer.md`);
      }
      if (typeof finding.body !== "string" || !finding.body.trim()) throw new Error(`finding ${index + 1} body must be non-empty`);
      return { path: "answer.md", line: finding.line, body: finding.body.trim() };
    });
  }
}

export function createResearchOracle(root) { return new ResearchOracle(root); }
