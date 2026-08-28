import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MINI_REVIEW_GLOB_LIMIT,
  MINI_REVIEW_GREP_LIMIT,
  MINI_REVIEW_VIEW_BYTE_LIMIT,
  MINI_REVIEW_VIEW_LINE_LIMIT,
} from "./mini-review-v2.mjs";
import { truncateObservation } from "./observation.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/i;

function sideOf(value) {
  const side = value ?? "head";
  if (side !== "head" && side !== "base") throw new Error('side must be "head" or "base"');
  return side;
}

export function validateRepoPath(value, { label = "path" } = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty repository-relative path`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) throw new Error(`${label} must be repository-relative`);
  if (value.includes("\\")) throw new Error(`${label} must use / separators`);
  if (value.split("/").some((part) => part === "..")) throw new Error(`${label} must not contain ..`);
  return value;
}

function globRegex(pattern) {
  validateRepoPath(pattern, { label: "pattern" });
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function trimFinalEmptyLine(lines) {
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function parseChangedLineIndex(source, headPaths = new Set()) {
  const index = new Map();
  let path = "";
  let headLine = 0;
  let pureDeleteAnchor = null;
  let hunkAdded = false;
  const finishHunk = () => {
    if (path && pureDeleteAnchor !== null && !hunkAdded && headPaths.has(path)) {
      if (!index.has(path)) index.set(path, new Set());
      index.get(path).add(pureDeleteAnchor);
    }
    pureDeleteAnchor = null;
    hunkAdded = false;
  };
  for (const row of String(source ?? "").split("\n")) {
    const file = row.match(/^\+\+\+ (?:b\/)?(.*)$/);
    if (file) {
      finishHunk();
      path = file[1] === "/dev/null" ? "" : file[1];
      continue;
    }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      finishHunk();
      headLine = Number(hunk[1]);
      pureDeleteAnchor = headLine;
      continue;
    }
    if (pureDeleteAnchor === null) continue;
    if (row.startsWith("+") && !row.startsWith("+++")) {
      if (path) {
        if (!index.has(path)) index.set(path, new Set());
        index.get(path).add(headLine);
      }
      hunkAdded = true;
      headLine++;
    } else if (row.startsWith(" ")) {
      headLine++;
    }
  }
  finishHunk();
  return index;
}

export class RepoOracle {
  #baseSha;
  #headSha;
  #gitDir;
  #command;
  #changedLinePromise = null;

  constructor(baseSha, headSha, options = {}) {
    if (!SHA.test(String(baseSha ?? "")) || !SHA.test(String(headSha ?? ""))) {
      throw new Error("RepoOracle requires full base and head commit SHAs");
    }
    if (typeof options.gitDir !== "string" || options.gitDir.length === 0) {
      throw new Error("RepoOracle requires the capsule git directory");
    }
    this.#baseSha = String(baseSha);
    this.#headSha = String(headSha);
    this.#gitDir = options.gitDir;
    this.#command = options.command ?? this.#runGit.bind(this);
    Object.freeze(this);
  }

  get baseSha() { return this.#baseSha; }

  get headSha() { return this.#headSha; }

  get gitDir() { return this.#gitDir; }

  async #runGit(args, options = {}) {
    try {
      const result = await execFileAsync("git", [`--git-dir=${this.#gitDir}`, "-c", "core.quotePath=false", ...args], {
        encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        timeout: options.timeout ?? 30_000,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (error) {
      return {
        code: Number.isInteger(error?.code) ? error.code : 1,
        stdout: error?.stdout ?? (options.encoding === null ? Buffer.alloc(0) : ""),
        stderr: error?.stderr ?? error?.message ?? "git command failed",
      };
    }
  }

  #revision(side) {
    return sideOf(side) === "head" ? this.#headSha : this.#baseSha;
  }

  async grep({ query, path, side } = {}) {
    if (typeof query !== "string" || query.length === 0) throw new Error("query must be a non-empty string");
    if (query.includes("\0")) throw new Error("query must not contain NUL");
    const revision = this.#revision(side);
    const args = ["grep", "-F", "-n", "-I", "-e", query, revision, "--"];
    if (path !== undefined) args.push(`:(literal)${validateRepoPath(path)}`);
    const result = await this.#command(args);
    if (result.code === 1 && !String(result.stdout).length) return "MATCHES 0";
    if (result.code !== 0) throw new Error(String(result.stderr || "git grep failed").trim());
    const prefix = `${revision}:`;
    const rows = trimFinalEmptyLine(String(result.stdout).split("\n"))
      .map((row) => row.startsWith(prefix) ? row.slice(prefix.length) : row)
      .map((row) => {
        const match = row.match(/^(.*):(\d+):(.*)$/);
        return match ? `${match[1]}:${match[2]}|${match[3]}` : row;
      });
    const truncated = rows.length > MINI_REVIEW_GREP_LIMIT;
    const visible = rows.slice(0, MINI_REVIEW_GREP_LIMIT);
    return truncateObservation([
      `MATCHES ${rows.length}`,
      ...visible,
      ...(truncated ? [`[TRUNCATED: showing ${MINI_REVIEW_GREP_LIMIT} of ${rows.length} matches]`] : []),
    ].join("\n"));
  }

  async glob({ pattern, side } = {}) {
    const matcher = globRegex(pattern);
    const revision = this.#revision(side);
    const result = await this.#command(["ls-tree", "-r", "--name-only", revision]);
    if (result.code !== 0) throw new Error(String(result.stderr || "git ls-tree failed").trim());
    const paths = trimFinalEmptyLine(String(result.stdout).split("\n")).filter((path) => matcher.test(path));
    const truncated = paths.length > MINI_REVIEW_GLOB_LIMIT;
    return truncateObservation([
      `PATHS ${paths.length}`,
      ...paths.slice(0, MINI_REVIEW_GLOB_LIMIT),
      ...(truncated ? [`[TRUNCATED: showing ${MINI_REVIEW_GLOB_LIMIT} of ${paths.length} paths]`] : []),
    ].join("\n"));
  }

  async view({ path, start_line: startLine, end_line: endLine, side } = {}) {
    const safePath = validateRepoPath(path);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error("view requires integer start_line and end_line bounds");
    }
    if (startLine < 1 || endLine < startLine) throw new Error("view bounds must be positive and end_line must not precede start_line");
    const selectedSide = sideOf(side);
    const revision = this.#revision(selectedSide);
    const tree = await this.#command(["ls-tree", revision, "--", `:(literal)${safePath}`]);
    if (tree.code !== 0) throw new Error(String(tree.stderr || "git ls-tree failed").trim());
    const entry = String(tree.stdout).split("\n").find((row) => row.endsWith(`\t${safePath}`));
    if (!entry) return `ERROR path not found: ${safePath} @ ${selectedSide}`;
    const meta = entry.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t/);
    if (!meta || meta[2] !== "blob") return `ERROR path is not a file: ${safePath} @ ${selectedSide}`;
    if (meta[1] === "120000") return `SYMLINK ${safePath} @ ${selectedSide} (not followed)`;
    const blob = await this.#command(["cat-file", "blob", meta[3]], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    if (blob.code !== 0) throw new Error(Buffer.isBuffer(blob.stderr) ? blob.stderr.toString("utf8").trim() : String(blob.stderr).trim());
    const bytes = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(blob.stdout ?? "");
    if (bytes.includes(0)) return `BINARY ${safePath} @ ${selectedSide} (content not shown)`;
    const lines = trimFinalEmptyLine(bytes.toString("utf8").split("\n"));
    const total = lines.length;
    if (startLine > total) return `ERROR start_line ${startLine} is past end of ${safePath} (${total} lines)`;
    const requestedEnd = Math.min(endLine, total);
    const cappedEnd = Math.min(requestedEnd, startLine + MINI_REVIEW_VIEW_LINE_LIMIT - 1);
    const visible = lines.slice(startLine - 1, cappedEnd).map((line, offset) => `${startLine + offset}|${line}`);
    let byteTruncated = false;
    let observation = "";
    while (true) {
      const actualEnd = visible.length ? startLine + visible.length - 1 : startLine - 1;
      const truncated = cappedEnd < requestedEnd || byteTruncated;
      observation = [
        `FILE ${safePath} @ ${selectedSide}`,
        `LINES ${startLine}-${actualEnd} OF ${total}`,
        ...visible,
        ...(truncated ? [`[TRUNCATED: requested lines ${startLine}-${requestedEnd}]`] : []),
      ].join("\n");
      if (Buffer.byteLength(observation, "utf8") <= MINI_REVIEW_VIEW_BYTE_LIMIT || visible.length === 0) break;
      visible.pop();
      byteTruncated = true;
    }
    return truncateObservation(observation);
  }

  async changedLines() {
    if (!this.#changedLinePromise) {
      this.#changedLinePromise = (async () => {
        const [tree, diff] = await Promise.all([
          this.#command(["ls-tree", "-r", "--name-only", this.#headSha]),
          this.#command(["diff", "--no-ext-diff", "--no-textconv", "-U0", "--no-color", `${this.#baseSha}...${this.#headSha}`, "--"]),
        ]);
        if (tree.code !== 0) throw new Error(String(tree.stderr || "cannot inspect head tree").trim());
        if (diff.code !== 0) throw new Error(String(diff.stderr || "cannot inspect changed lines").trim());
        const paths = new Set(trimFinalEmptyLine(String(tree.stdout).split("\n")));
        return parseChangedLineIndex(diff.stdout, paths);
      })();
    }
    return this.#changedLinePromise;
  }

  async validateFindings(findings) {
    if (!Array.isArray(findings)) throw new Error("findings must be an array");
    const changed = await this.changedLines();
    return findings.map((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error(`finding ${index + 1} must be an object`);
      const keys = Object.keys(finding).sort().join(",");
      if (keys !== "body,line,path") throw new Error(`finding ${index + 1} must contain only path, line, and body`);
      const path = validateRepoPath(finding.path, { label: `finding ${index + 1} path` });
      if (!Number.isInteger(finding.line) || finding.line < 0) throw new Error(`finding ${index + 1} line must be a non-negative integer`);
      if (typeof finding.body !== "string" || !finding.body.trim()) throw new Error(`finding ${index + 1} body must be non-empty`);
      if (!changed.has(path)) throw new Error(`finding ${index + 1} path is not in the diff: ${path}`);
      if (!changed.get(path).has(finding.line)) {
        throw new Error(`finding ${index + 1} line is not a HEAD-side changed line: ${path}:${finding.line}`);
      }
      return { path, line: finding.line, body: finding.body.trim() };
    });
  }
}
