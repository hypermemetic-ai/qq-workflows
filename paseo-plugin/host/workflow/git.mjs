import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPacket, parseDiffHunks } from "./packet.mjs";

const exec = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trimEnd();
}

export async function isGitRepo(cwd) {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function isDirty(cwd) {
  const status = await git(cwd, ["status", "--porcelain", "--", ".", ":!.zvec-grep"]);
  return status.trim().length > 0;
}

export async function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function revParse(cwd, ref = "HEAD") {
  return git(cwd, ["rev-parse", ref]);
}

export async function blobSha(cwd, path, ref = "HEAD") {
  try {
    return await git(cwd, ["rev-parse", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

export async function commitIfDirty(cwd, message = "architect implementer") {
  if (!(await isDirty(cwd))) return { committed: false, sha: await revParse(cwd).catch(() => null) };
  await git(cwd, ["add", "-A", "--", ".", ":!.zvec-grep"]);
  await exec("git", ["commit", "-m", message], { cwd, encoding: "utf8" });
  return { committed: true, sha: await revParse(cwd) };
}

const DEFAULT_BASE_REFS = ["origin/main", "main", "origin/master", "master"];

export async function hasRemote(cwd) {
  try {
    const text = await git(cwd, ["remote"]);
    return text.trim().length > 0;
  } catch {
    return false;
  }
}

export async function defaultLocalBranch(cwd) {
  for (const name of ["main", "master"]) {
    try {
      await revParse(cwd, `refs/heads/${name}`);
      return name;
    } catch {
      /* try the next local default branch */
    }
  }
  throw new Error("no local main or master branch");
}

export function parseWorktreePorcelain(text) {
  const trees = [];
  let current = {};
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") {
      if (current.worktree) trees.push(current);
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) current.worktree = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") current.detached = true;
  }
  if (current.worktree) trees.push(current);
  return trees;
}

export async function worktreeCheckingOut(cwd, branch) {
  const trees = parseWorktreePorcelain(await git(cwd, ["worktree", "list", "--porcelain"]));
  return trees.find((item) => item.branch === branch)?.worktree ?? null;
}

export async function fastForwardMain(cwd, { branch, main } = {}) {
  const head = branch ?? await currentBranch(cwd);
  const target = main ?? await defaultLocalBranch(cwd);
  if (head === target) {
    return { merged: true, method: "already-on-main", branch: target };
  }
  try {
    await git(cwd, ["merge-base", "--is-ancestor", target, head]);
  } catch {
    throw new Error(`cannot fast-forward ${target} to ${head}`);
  }
  const expected = await revParse(cwd, target);
  const intended = await revParse(cwd, head);
  const checkout = await worktreeCheckingOut(cwd, target);
  if (checkout) {
    await git(checkout, ["merge", "--ff-only", intended]);
  } else {
    await git(cwd, ["update-ref", `refs/heads/${target}`, intended, expected]);
  }
  if (await revParse(cwd, target) !== intended) throw new Error("local landing revision changed unexpectedly");
  return { merged: true, method: "ff", branch: target, from: head, sha: intended };
}

export async function defaultBaseRef(cwd) {
  for (const ref of DEFAULT_BASE_REFS) {
    try {
      await revParse(cwd, ref);
      return ref;
    } catch {
      /* try the next default branch name */
    }
  }
  throw new Error("no default/base branch (origin/main, main, origin/master, master)");
}

export async function mergeBase(cwd, base, head = "HEAD") {
  return git(cwd, ["merge-base", base, head]);
}

export async function buildReviewPacket(cwd, { base, head = "HEAD" } = {}) {
  const baseRef = base ?? await defaultBaseRef(cwd);
  const headSha = await revParse(cwd, head);
  const baseSha = await mergeBase(cwd, baseRef, headSha);
  const diff = await git(cwd, ["diff", "--unified=0", baseSha, headSha]);
  const files = [];
  for (const file of parseDiffHunks(diff)) {
    files.push({
      ...file,
      sha: await blobSha(cwd, file.path, headSha ?? "HEAD"),
    });
  }
  return buildPacket({ baseSha, headSha, files });
}

export async function createAndMergePr(cwd, { title, body, branch, expectedHead, checkpoint = async () => {} } = {}) {
  const head = branch ?? await currentBranch(cwd);
  if (head === "HEAD") throw new Error("publication requires a named branch");
  const sha = await revParse(cwd, head);
  if (expectedHead && sha !== expectedHead) throw new Error("head changed since review; refusing publication");
  const remotes = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (!remote) throw new Error("publication requires an unambiguous remote");
  const gh = async args => (await exec("gh", args, { cwd, encoding: "utf8" })).stdout.trim();
  const remoteUrl = await git(cwd, ["remote", "get-url", "--push", remote]);
  const repo = JSON.parse(await gh(["repo", "view", remoteUrl, "--json", "nameWithOwner,defaultBranchRef"]));
  const base = repo.defaultBranchRef.name;
  if (head === base) throw new Error("publication requires a separate implementation branch");
  await checkpoint("push_pending", { remote, head, sha, repo: repo.nameWithOwner });
  await git(cwd, ["push", remote, `${sha}:refs/heads/${head}`]);
  const remoteSha = (await git(cwd, ["ls-remote", remote, `refs/heads/${head}`])).split(/\s+/)[0];
  if (remoteSha !== sha) throw new Error("pushed branch revision does not match intended revision");
  const fields = "url,state,headRefOid,mergeCommit,baseRefName";
  const find = async () => {
    const matches = JSON.parse(await gh(["pr", "list", "--repo", repo.nameWithOwner, "--head", head, "--base", base, "--state", "all", "--json", fields]));
    return matches.find(pr => pr.headRefOid === sha && pr.state !== "CLOSED");
  };
  let pr = await find();
  if (!pr) {
    const dir = await mkdtemp(join(tmpdir(), "architect-pr-"));
    try {
      const file = join(dir, "body.md");
      await writeFile(file, body ?? "");
      await checkpoint("pr_pending", { head, base, sha });
      try {
        await gh(["pr", "create", "--repo", repo.nameWithOwner, "--head", head, "--base", base, "--title", title || `architect: ${head}`, "--body-file", file]);
      } catch (error) {
        pr = await find();
        if (!pr) throw Object.assign(new Error("PR creation outcome is uncertain; inspect remote before retrying", { cause: error }), { failureClass: "uncertain" });
      }
      pr ??= await find();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  if (!pr) throw new Error("intended PR could not be identified");
  await checkpoint("merge_pending", { pr: pr.url, sha });
  if (pr.state !== "MERGED") {
    try { await gh(["pr", "merge", pr.url, "--repo", repo.nameWithOwner, "--merge", "--match-head-commit", sha]); }
    catch (error) {
      const actual = JSON.parse(await gh(["pr", "view", pr.url, "--repo", repo.nameWithOwner, "--json", fields]));
      if (actual.state !== "MERGED") throw Object.assign(new Error("Merge outcome is uncertain; preserved branch and PR require inspection", { cause: error }), { failureClass: "uncertain" });
    }
  }
  const actual = JSON.parse(await gh(["pr", "view", pr.url, "--repo", repo.nameWithOwner, "--json", fields]));
  if (actual.state !== "MERGED" || actual.headRefOid !== sha || !actual.mergeCommit?.oid) throw new Error("merged revision could not be verified");
  await git(cwd, ["fetch", remote, `refs/heads/${base}`]);
  await git(cwd, ["merge-base", "--is-ancestor", actual.mergeCommit.oid, "FETCH_HEAD"]);
  await checkpoint("merged", actual);
  return { pr: actual.url, merged: true, headSha: sha, mergeSha: actual.mergeCommit.oid };
}
