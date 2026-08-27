// Git semantics for workflow landings. Delegated work happens in a self-contained
// clone capsule; the primary repository stays on the base branch.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export const WORKTREES_DIR = ".qq-worktrees";

export function repoRootFor(cwd) {
  return cwd;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 2_000_000,
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
    return await inspectWorktree(run, worktree);
  } catch (error) {
    rmSync(worktree, { recursive: true, force: true });
    throw error;
  }
}
