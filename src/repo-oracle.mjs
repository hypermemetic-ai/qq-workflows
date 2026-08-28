import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/i;

export function validateRepoPath(value, { label = "path" } = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty repository-relative path`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) throw new Error(`${label} must be repository-relative`);
  if (value.includes("\\")) throw new Error(`${label} must use / separators`);
  if (value.split("/").some((part) => part === "..")) throw new Error(`${label} must not contain ..`);
  return value;
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
