import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildPacket, parseDiffHunks } from "./packet.mjs";
import { brainTicketPath, ensureTicket, ticketPath } from "./ticket.mjs";

const exec = promisify(execFile);

export async function git(cwd, args) {
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
  const status = await git(cwd, ["status", "--porcelain", "--", ".", ":!.zvec-grep", ":!.architect"]);
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
  await git(cwd, ["add", "-A", "--", ".", ":!.zvec-grep", ":!.architect"]);
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
    try { await gh(["pr", "merge", pr.url, "--repo", repo.nameWithOwner, "--merge", "--delete-branch", "--match-head-commit", sha]); }
    catch (error) {
      const actual = JSON.parse(await gh(["pr", "view", pr.url, "--repo", repo.nameWithOwner, "--json", fields]));
      if (actual.state !== "MERGED") throw Object.assign(new Error("Merge outcome is uncertain; preserved branch and PR require inspection", { cause: error }), { failureClass: "uncertain" });
    }
  }
  const actual = JSON.parse(await gh(["pr", "view", pr.url, "--repo", repo.nameWithOwner, "--json", fields]));
  if (actual.state !== "MERGED" || actual.headRefOid !== sha || !actual.mergeCommit?.oid) throw new Error("merged revision could not be verified");
  await git(cwd, ["fetch", remote, `refs/heads/${base}`]);
  await git(cwd, ["merge-base", "--is-ancestor", actual.mergeCommit.oid, "FETCH_HEAD"]);
  try {
    const checkout = await worktreeCheckingOut(cwd, base);
    if (checkout) {
      await git(checkout, ["merge", "--ff-only", `refs/remotes/${remote}/${base}`]);
    } else {
      await git(cwd, ["update-ref", `refs/heads/${base}`, actual.mergeCommit.oid]);
    }
  } catch {
    /* best effort local base ref synchronization */
  }
  await checkpoint("merged", actual);
  return { pr: actual.url, merged: true, headSha: sha, mergeSha: actual.mergeCommit.oid };
}

export function implementerBranchName(kind = "bounded", jobId) {
  const cleanKind = kind || "bounded";
  const tag = String(jobId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return tag ? `architect/${cleanKind}/${tag}` : `architect/${cleanKind}`;
}

export const WORKTREES_DIR = ".qq-worktrees";

export function worktreesRootFor(mainRoot, env = process.env) {
  const configured = String(env?.ARCHITECT_WORKTREES_DIR || env?.QQ_WORKTREES_ROOT || "").trim();
  if (configured) {
    return join(configured, basename(mainRoot));
  }
  return join(dirname(mainRoot), WORKTREES_DIR, basename(mainRoot));
}

export function worktreePathFor(mainRoot, branch, env = process.env) {
  const configured = String(env?.ARCHITECT_WORKTREES_DIR || "").trim();
  if (configured) {
    return join(configured, branch.replaceAll("/", "-"));
  }
  return join(worktreesRootFor(mainRoot, env), branch.replaceAll("/", "-"));
}

export async function createWorktree(cwd, { kind = "bounded", sessionId, branch: customBranch, base = "HEAD" } = {}) {
  const root = await mainRepoRoot(cwd);
  const branch = customBranch || implementerBranchName(kind, sessionId);
  const dest = worktreePathFor(root, branch);

  await mkdir(dirname(dest), { recursive: true });

  let branchExists = false;
  try {
    await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    if (existsSync(dest)) {
      return { cwd: dest, worktree: dest, branch, reused: true };
    }
    await git(root, ["worktree", "add", dest, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, dest, base]);
  }

  // Exclude .architect in the worktree to keep git status clean
  try {
    const gitDir = await git(dest, ["rev-parse", "--git-dir"]);
    const excludePath = join(gitDir.startsWith("/") ? gitDir : join(dest, gitDir), "info", "exclude");
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = "";
    if (existsSync(excludePath)) existing = await readFile(excludePath, "utf8");
    if (!existing.includes(".architect")) {
      await writeFile(excludePath, `${existing}\n.architect\n`, "utf8");
    }
  } catch {
    /* best-effort exclude */
  }

  // Copy ticket into the worktree as .architect/ticket.md
  try {
    let srcTicket = null;
    if (sessionId) {
      const candidate = ticketPath(root, sessionId);
      if (existsSync(candidate)) {
        srcTicket = candidate;
      } else {
        const ticketsDir = join(root, ".architect", "tickets");
        if (existsSync(ticketsDir)) {
          const files = await readdir(ticketsDir);
          const match = files.find(f => f.endsWith(".md") && (f.startsWith(sessionId) || sessionId.startsWith(basename(f, ".md"))));
          if (match) srcTicket = join(ticketsDir, match);
        }
      }
      if (!srcTicket) {
        const brainTicket = brainTicketPath(sessionId);
        if (brainTicket && existsSync(brainTicket)) {
          srcTicket = brainTicket;
        }
      }
    }
    if (!srcTicket) {
      const rootTicket = join(root, ".architect", "ticket.md");
      if (existsSync(rootTicket)) srcTicket = rootTicket;
    }
    if (srcTicket && existsSync(srcTicket)) {
      const destTicketDir = join(dest, ".architect");
      await mkdir(destTicketDir, { recursive: true });
      const content = await readFile(srcTicket, "utf8");
      await writeFile(join(destTicketDir, "ticket.md"), content, "utf8");
    }
  } catch {
    /* ticket copy best-effort if missing */
  }

  return { cwd: dest, worktree: dest, branch, reused: false };
}

export async function mainRepoRoot(cwd) {
  try {
    const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
    const resolved = common.startsWith("/") ? common : join(cwd, common);
    return dirname(resolved);
  } catch {
    return git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd);
  }
}

export function normalizeUriPath(uri) {
  if (typeof uri !== "string" || !uri.trim()) return null;
  let decoded = uri.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  const stripped = decoded.replace(/^file:\/\/(localhost)?/, "");
  return resolve(stripped).replace(/\/+$/, "");
}

export async function cleanWorktreeProjects(mainRoot, worktreePath, options = {}) {
  let target = worktreePath;
  let opts = options;
  if (typeof worktreePath === "object" && worktreePath !== null) {
    opts = worktreePath;
    target = mainRoot;
  } else if (!worktreePath) {
    target = mainRoot;
  }

  const targetNorm = normalizeUriPath(target);
  if (!targetNorm) return [];

  const home = opts?.home || homedir();
  const projectsDir = join(home, ".gemini", "config", "projects");
  if (!existsSync(projectsDir)) return [];

  let entries = [];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }

  const unlinked = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(projectsDir, entry);
    try {
      const content = await readFile(fullPath, "utf8");
      const data = JSON.parse(content);
      const resources = Array.isArray(data?.projectResources?.resources)
        ? data.projectResources.resources
        : [];
      const matches =
        resources.some((r) => {
          const gitUri = normalizeUriPath(r?.gitFolder?.folderUri);
          const folderUri = normalizeUriPath(r?.folderUri);
          return gitUri === targetNorm || folderUri === targetNorm;
        }) || normalizeUriPath(data?.projectResources?.folderUri) === targetNorm;

      if (matches) {
        await unlink(fullPath);
        unlinked.push(fullPath);
      }
    } catch {
      /* ignore unreadable or unparseable project files */
    }
  }
  return unlinked;
}

export async function retireWorktree(cwd, { worktree, branch, force = true, home } = {}) {
  const targetWorktree = worktree || cwd;
  const mainRoot = await mainRepoRoot(targetWorktree);

  let targetBranch = branch;
  if (!targetBranch && existsSync(targetWorktree)) {
    try {
      targetBranch = await currentBranch(targetWorktree);
    } catch {
      targetBranch = null;
    }
  }

  // 1. Remove the worktree
  if (existsSync(targetWorktree)) {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(targetWorktree);
    try {
      await git(mainRoot, args);
    } catch {
      await rm(targetWorktree, { recursive: true, force: true });
      try {
        await git(mainRoot, ["worktree", "prune"]);
      } catch {}
    }
  }

  // 2. Delete the local branch
  if (targetBranch && targetBranch !== "HEAD" && targetBranch !== "main" && targetBranch !== "master") {
    try {
      await git(mainRoot, ["branch", "-d", targetBranch]);
    } catch {
      if (force) {
        try {
          await git(mainRoot, ["branch", "-D", targetBranch]);
        } catch {}
      }
    }
  }

  // 3. Clean up any project JSON files associated with this worktree
  await cleanWorktreeProjects(mainRoot, targetWorktree, { home });

  return { retired: true, worktree: targetWorktree, branch: targetBranch };
}

export async function landWorktree(cwd, { worktree, branch, message, title, body, deleteBranch = true, home } = {}) {
  const targetWorktree = worktree || cwd;
  const mainRoot = await mainRepoRoot(targetWorktree);

  const targetBranch = branch || await currentBranch(targetWorktree);
  if (targetBranch === "HEAD" || targetBranch === "main" || targetBranch === "master") {
    throw new Error(`cannot land branch '${targetBranch}'; requires a dedicated worktree branch`);
  }

  const commitMsg = message || title || `architect: ${targetBranch}`;
  const commitResult = await commitIfDirty(targetWorktree, commitMsg);

  // Determine whether this worktree introduced any changes or commits against base
  let hasChanges = commitResult.committed;
  if (!hasChanges) {
    let base = null;
    try {
      base = await defaultLocalBranch(targetWorktree);
    } catch {
      try {
        base = await defaultBaseRef(targetWorktree);
      } catch {}
    }
    if (base) {
      try {
        const count = await git(targetWorktree, ["rev-list", "--count", `${base}..${targetBranch}`]);
        hasChanges = parseInt(count.trim(), 10) > 0;
      } catch {
        hasChanges = true;
      }
    }
  }

  // If there are no changes or commits to merge (e.g. read-only research worktree),
  // safely retire the worktree and branch without erroring on an empty PR.
  if (!hasChanges) {
    if (deleteBranch) {
      await retireWorktree(mainRoot, { worktree: targetWorktree, branch: targetBranch, force: true, home });
    }
    return {
      landed: true,
      retired: true,
      branch: targetBranch,
      method: "none",
      pr: null,
      mergeSha: null,
    };
  }

  const remote = await hasRemote(targetWorktree);
  let result;
  if (remote) {
    result = await createAndMergePr(targetWorktree, {
      title: title || commitMsg,
      body: body || commitMsg,
      branch: targetBranch,
      expectedHead: commitResult.sha,
    });
  } else {
    result = await fastForwardMain(targetWorktree, { branch: targetBranch });
  }

  if (deleteBranch) {
    await retireWorktree(mainRoot, { worktree: targetWorktree, branch: targetBranch, force: true, home });
  }

  return {
    landed: true,
    branch: targetBranch,
    method: remote ? "pr" : "ff",
    pr: result.pr ?? null,
    mergeSha: result.mergeSha ?? result.sha ?? null,
  };
}

export const land = landWorktree;
