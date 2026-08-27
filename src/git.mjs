// Git semantics for workflow landings. Delegated work happens in a self-contained
// clone capsule; the primary repository stays on the base branch.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export const WORKTREES_DIR = ".qq-worktrees";

export function repoRootFor(cwd) {
  return cwd;
}

const COMMAND_MAX_BUFFER = 2_000_000;

function runStreamingCommand(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stderrBytes = 0;
    let stopped = false;
    let timedOut = false;
    let overflowed = false;
    let streamError = null;
    let spawnError = null;
    const timeout = options.timeout ?? 30_000;
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout) : null;
    timer?.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stopped || streamError) return;
      try {
        if (options.onStdout(chunk) === false) {
          stopped = true;
          child.kill();
        }
      } catch (error) {
        streamError = error;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (stderrBytes < COMMAND_MAX_BUFFER) {
        const available = COMMAND_MAX_BUFFER - stderrBytes;
        stderr += Buffer.from(chunk).subarray(0, available).toString("utf8");
      }
      stderrBytes += bytes;
      if (stderrBytes > COMMAND_MAX_BUFFER && !overflowed) {
        overflowed = true;
        child.kill();
      }
    });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (streamError) {
        resolve({ code: 1, stdout: "", stderr: streamError instanceof Error ? streamError.message : String(streamError) });
        return;
      }
      if (spawnError) {
        resolve({
          code: Number.isInteger(spawnError.code) ? spawnError.code : 1,
          stdout: "",
          stderr: stderr || spawnError.message,
        });
        return;
      }
      if (overflowed) {
        resolve({ code: 1, stdout: "", stderr: stderr || "stderr exceeded maxBuffer" });
        return;
      }
      if (timedOut) {
        resolve({ code: 1, stdout: "", stderr: stderr || `command timed out after ${timeout}ms` });
        return;
      }
      // A consumer that has enough evidence may stop a read-only command early.
      if (stopped) {
        resolve({ code: 0, stdout: "", stderr });
        return;
      }
      resolve({ code: Number.isInteger(code) ? code : 1, stdout: "", stderr });
    });
  });
}

export function runCommand(command, args, options = {}) {
  // Large, selectively consumed output must never enter execFile's aggregate
  // stdout buffer. Other commands retain the existing bounded behavior.
  if (typeof options.onStdout === "function") return runStreamingCommand(command, args, options);
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: COMMAND_MAX_BUFFER,
      timeout: options.timeout ?? 30_000,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = Number.isInteger(error.code) ? error.code : 1;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? error.message });
        return;
      }
      resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export function reason(result, fallback) {
  return result?.stderr?.trim() || result?.stdout?.trim() || fallback;
}

export async function checked(run, command, args, options, label) {
  const result = await run(command, args, options);
  if (result?.code !== 0) throw new Error(`${label}: ${reason(result, "command failed")}`);
  return result;
}

export const LAND_GIT_IDENTITY = Object.freeze({
  name: "qqp-bot",
  email: "qqp-bot@aabbcdeffg.com",
});

async function gitConfigValue(run, cwd, key, local = false) {
  const args = local ? ["config", "--local", "--get", key] : ["config", "--get", key];
  const configured = await run("git", args, { cwd });
  if (configured?.code === 1) return "";
  if (configured?.code !== 0) {
    throw new Error(`cannot read Git ${key}: ${reason(configured, "git config failed")}`);
  }
  return configured.stdout.replace(/\r?\n$/, "");
}

async function stampGitIdentity(run, source, capsule) {
  for (const key of ["user.name", "user.email"]) {
    const value = await gitConfigValue(run, source, key);
    if (!value) continue;
    await checked(
      run, "git", ["config", "--local", key, value], { cwd: capsule }, `cannot stamp capsule Git ${key}`,
    );
  }
}

export function gitIdentityArgs(identity = LAND_GIT_IDENTITY) {
  const name = String(identity?.name ?? "").trim();
  const email = String(identity?.email ?? "").trim();
  if (!name || !email) throw new Error("git identity requires name and email");
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

export function slugFor(brief, id = "") {
  const line = String(brief ?? "").trim().split("\n")[0].replace(/^#+\s*/, "");
  const base = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "work";
  const tag = String(id).replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();
  return tag ? `${base}-${tag}` : base;
}

export function branchNameFor(slug) {
  return `feat/${slug}`;
}

export function worktreesRootFor(mainRoot, env = process.env) {
  const configured = String(env?.QQ_WORKTREES_ROOT ?? "").trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("QQ_WORKTREES_ROOT must be an absolute path");
    return join(configured, basename(mainRoot));
  }
  return join(dirname(mainRoot), WORKTREES_DIR, basename(mainRoot));
}

export function worktreePathFor(mainRoot, slug, env = process.env) {
  return join(worktreesRootFor(mainRoot, env), slug);
}

export async function inspectWorktree(run, cwd) {
  if (!cwd || typeof cwd !== "string") throw new Error("not a git worktree");
  const top = await checked(run, "git", ["rev-parse", "--show-toplevel"], { cwd }, "not a git worktree");
  const worktree = await realpath(top.stdout.trim());
  const common = await checked(
    run, "git", ["rev-parse", "--git-common-dir"], { cwd: worktree }, "cannot resolve git common dir",
  );
  const commonDir = common.stdout.trim();
  const gitDir = await realpath(commonDir.startsWith("/") ? commonDir : `${worktree}/${commonDir}`);
  let mainRoot = await realpath(gitDir.endsWith(".git") ? dirname(gitDir) : gitDir);
  if (mainRoot === worktree) {
    const origin = await run("git", ["remote", "get-url", "origin"], { cwd: worktree });
    const originPath = origin?.stdout?.trim();
    if (origin.code === 0 && originPath && existsSync(originPath)) {
      try {
        mainRoot = await realpath(originPath);
      } catch {}
    }
  }
  const branch = await checked(
    run, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: worktree }, "worktree HEAD is detached",
  );
  let baseBranch = "main";
  const mainCheck = await run("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: mainRoot });
  if (mainCheck?.code !== 0) {
    const master = await run("git", ["rev-parse", "--verify", "refs/heads/master"], { cwd: mainRoot });
    if (master?.code === 0) baseBranch = "master";
  }
  const base = await checked(
    run, "git", ["rev-parse", "--verify", baseBranch], { cwd: mainRoot }, `cannot resolve ${baseBranch}`,
  );
  return {
    worktree,
    mainRoot,
    branch: branch.stdout.trim(),
    baseBranch,
    baseRef: base.stdout.trim(),
  };
}

export async function createDelegatedWorktree(run, { cwd, brief, id, env = process.env } = {}) {
  const git = await inspectWorktree(run, cwd);
  const seed = slugFor(brief, id);
  let slug = seed;
  let branch = branchNameFor(slug);
  let worktree = worktreePathFor(git.mainRoot, slug, env);
  for (let n = 2; n <= 51; n += 1) {
    const branchExists = await run("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: git.mainRoot });
    if ((branchExists?.code ?? 1) !== 0 && !existsSync(worktree)) break;
    if (n > 50) throw new Error("could not allocate a unique worktree");
    slug = `${seed}-${n}`;
    branch = branchNameFor(slug);
    worktree = worktreePathFor(git.mainRoot, slug, env);
  }
  mkdirSync(dirname(worktree), { recursive: true });
  // Task-local capsule: clone with shared object alternates for speed while
  // retaining an ordinary .git directory inside the writable capsule.
  const clone = await run("git", ["clone", "--shared", "--no-checkout", git.mainRoot, worktree]);
  if (clone?.code !== 0) {
    rmSync(worktree, { recursive: true, force: true });
    throw new Error(`delegation capsule clone failed: ${reason(clone, "git clone failed")}`);
  }
  try {
    await checked(run, "git", ["checkout", "-b", branch, "HEAD"], { cwd: worktree }, "capsule checkout failed");
    if (!existsSync(join(worktree, ".git", "HEAD"))) {
      throw new Error("delegation capsule clone did not create an internal .git directory");
    }
    await stampGitIdentity(run, git.worktree, worktree);
    return await inspectWorktree(run, worktree);
  } catch (error) {
    rmSync(worktree, { recursive: true, force: true });
    throw error;
  }
}
