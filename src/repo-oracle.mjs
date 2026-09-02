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

function parseRenameSources(source) {
  const fields = String(source ?? "").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const sources = new Map();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const oldPath = fields[index++];
    const newPath = fields[index++];
    if (!/^R\d{1,3}$/.test(status) || !oldPath || !newPath) {
      throw new Error("cannot parse renamed paths");
    }
    sources.set(newPath, oldPath);
  }
  return sources;
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
      const stderr = error?.stderr;
      const diagnostic = stderr !== undefined && stderr !== null && String(stderr).trim()
        ? stderr
        : error?.message || "git command failed";
      return {
        code: Number.isInteger(error?.code) ? error.code : 1,
        stdout: error?.stdout ?? (options.encoding === null ? Buffer.alloc(0) : ""),
        stderr: diagnostic,
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

  async #changedLinesFor(paths) {
    const pathspecs = paths.map((path) => `:(literal)${path}`);
    // A destination-only pathspec turns a rename into a new-file patch. Find
    // rename pairs globally, then keep the potentially large patch path-bounded.
    const [tree, renames] = await Promise.all([
      this.#command(["ls-tree", "-r", "--name-only", this.#headSha, "--", ...pathspecs]),
      this.#command([
        "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z",
        "--find-renames", "--diff-filter=R", `${this.#baseSha}...${this.#headSha}`, "--",
      ]),
    ]);
    if (tree.code !== 0) throw new Error(String(tree.stderr || "cannot inspect head tree").trim());
    if (renames.code !== 0) throw new Error(String(renames.stderr || "cannot inspect changed lines").trim());
    const renameSources = parseRenameSources(renames.stdout);
    const diffPaths = new Set(paths);
    for (const path of paths) {
      const source = renameSources.get(path);
      if (source) diffPaths.add(source);
    }
    const diff = await this.#command([
      "diff", "--no-ext-diff", "--no-textconv", "-U0", "--no-color", "--find-renames",
      `${this.#baseSha}...${this.#headSha}`, "--",
      ...[...diffPaths].map((path) => `:(literal)${path}`),
    ]);
    if (diff.code !== 0) throw new Error(String(diff.stderr || "cannot inspect changed lines").trim());
    const headPaths = new Set(trimFinalEmptyLine(String(tree.stdout).split("\n")));
    return parseChangedLineIndex(diff.stdout, headPaths);
  }

  async validateFindings(findings) {
    if (!Array.isArray(findings)) throw new Error("findings must be an array");
    const normalized = findings.map((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error(`finding ${index + 1} must be an object`);
      const keys = Object.keys(finding).sort().join(",");
      if (keys !== "body,line,path") throw new Error(`finding ${index + 1} must contain only path, line, and body`);
      const path = validateRepoPath(finding.path, { label: `finding ${index + 1} path` });
      if (!Number.isInteger(finding.line) || finding.line < 0) throw new Error(`finding ${index + 1} line must be a non-negative integer`);
      if (typeof finding.body !== "string" || !finding.body.trim()) throw new Error(`finding ${index + 1} body must be non-empty`);
      return { path, line: finding.line, body: finding.body.trim() };
    });
    if (normalized.length === 0) return normalized;
    const changed = await this.#changedLinesFor([...new Set(normalized.map(({ path }) => path))]);
    return normalized.map((finding, index) => {
      if (!changed.has(finding.path)) throw new Error(`finding ${index + 1} path is not in the diff: ${finding.path}`);
      if (!changed.get(finding.path).has(finding.line)) {
        throw new Error(`finding ${index + 1} line is not a HEAD-side changed line: ${finding.path}:${finding.line}`);
      }
      return finding;
    });
  }
}
