import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildPacket, parseDiffHunks } from "./packet.mjs";
import { archiveAndClearTicket, resolveTicketSource } from "./ticket.mjs";
import { registerStateExclude } from "./state-exclude.mjs";
import { stateDirFor } from "./session.mjs";

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

// Porcelain -z gives literal, repository-relative names (including the second
// name of a rename/copy), without quoting or newline ambiguity. Do not pass
// ignored operational directories as negative pathspecs to status or add.
export async function changedPaths(cwd) {
  const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (!stdout) return [];
  const fields = stdout.split("\0");
  if (fields.pop() !== "") throw new Error("incomplete git status output");
  const changes = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record.length < 4 || record[2] !== " ") throw new Error("invalid git status output");
    const xy = record.slice(0, 2);
    // In -z format the destination precedes the source for renames/copies.
    const paths = [record.slice(3)];
    if (/[RC]/.test(xy)) {
      if (++i >= fields.length) throw new Error("incomplete git rename output");
      paths.push(fields[i]);
    }
    changes.push({ xy, paths });
  }
  return changes;
}

// The runner profile is project-owned source, but only at this exact
// repository-relative path. Every other architect/index path remains operational.
export function operationalPath(path) {
  if (path === ".architect/test-runner.json") return false;
  return [".zvec-grep", ".architect"].some(dir => path === dir || path.startsWith(`${dir}/`));
}

export async function isDirty(cwd) {
  return (await changedPaths(cwd)).some(change => change.paths.some(path => !operationalPath(path)));
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
  const changes = await changedPaths(cwd);
  const assertNoStagedOperationalPaths = entries => {
    for (const { xy, paths } of entries) {
      if (xy[0] !== " " && xy[0] !== "?" && paths.some(operationalPath)) {
        throw new Error("refusing commit: excluded operational path is already staged");
      }
    }
  };
  assertNoStagedOperationalPaths(changes);
  const eligible = changes.filter(change => change.paths.some(path => !operationalPath(path)));
  if (!eligible.length) return { committed: false, sha: await revParse(cwd).catch(() => null) };

  // Staged-only entries are already in the index. In particular, a staged
  // rename's old name is no longer in the index or worktree: git add on that
  // old name would fail with "pathspec did not match any files".
  const toStage = new Set();
  for (const { xy, paths } of eligible) {
    if (xy === "??" || xy[1] !== " ") {
      // A staged rename/copy has removed its source from the index; any
      // recreated source appears as its own untracked/modified record.
      const stagePaths = /[RC]/.test(xy[0]) ? paths.slice(0, 1) : paths;
      for (const path of stagePaths) if (!operationalPath(path)) toStage.add(path);
    }
  }
  const paths = [...toStage];
  for (let i = 0; i < paths.length; i += 100) {
    await git(cwd, ["add", "-A", "--", ...paths.slice(i, i + 100).map(path => `:(literal)${path}`)]);
  }
  // Recheck the complete index before committing; a pre-staged operational
  // file (including either side of a boundary rename) must never be committed.
  assertNoStagedOperationalPaths(await changedPaths(cwd));
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

export async function hasImplementationChanges(cwd, branch) {
  if (await isDirty(cwd)) return true;
  let base = null;
  try {
    base = await defaultLocalBranch(cwd);
  } catch {
    try {
      base = await defaultBaseRef(cwd);
    } catch {}
  }
  if (!base) return false;
  try {
    const targetBranch = branch || await currentBranch(cwd);
    const count = await git(cwd, ["rev-list", "--count", `${base}..${targetBranch}`]);
    return parseInt(count.trim(), 10) > 0;
  } catch {
    return false;
  }
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

// New managed work must not inherit an independently dirty/stale checkout's
// HEAD. Resolve the remote's actual default branch, fetch it, and pin the SHA
// before worktree creation. A failed verification never falls back to cached
// refs. Explicit bases and existing phase branches are handled separately.
export async function freshDefaultBase(cwd) {
  const remotes = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
  if (!remotes.length) {
    const ref = await defaultLocalBranch(cwd);
    return { ref, sha: await revParse(cwd, `refs/heads/${ref}`), source: "local-default" };
  }
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (!remote) throw new Error("multiple remotes without origin: specify an explicit base for the new phase");
  const remoteGit = async (args) => {
    const { stdout } = await exec("git", args, {
      cwd, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trimEnd();
  };
  const advertised = await remoteGit(["ls-remote", "--symref", "--exit-code", "--", remote, "HEAD"]);
  const head = advertised.split("\n").find((line) => /^ref: refs\/heads\/[^\s]+\s+HEAD$/.test(line));
  if (!head) throw new Error(`remote '${remote}' has no verifiable default branch; specify an explicit base`);
  const remoteBranch = head.match(/^ref: (refs\/heads\/[^\s]+)/)[1];
  const branch = remoteBranch.slice("refs/heads/".length);
  const tracking = `refs/remotes/${remote}/${branch}`;
  await remoteGit(["fetch", "--no-tags", "--", remote, `+${remoteBranch}:${tracking}`]);
  return { ref: `${remote}/${branch}`, sha: await revParse(cwd, tracking), source: "fetched-remote-default" };
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

// A remote PR receipt is independent of synchronization of the local default
// checkout. Never use a cached tracking ref as proof of the remote tip.
const syncDiagnostic = error => String(error?.message ?? error).slice(0, 300);
const syncRecovery = "Inventory and save local edits first; compare git status and HEAD with the observed remote tip, then reconcile this checkout separately (preservation-first).";

export async function synchronizeDefaultCheckout(cwd, { remote, base, mergeSha } = {}) {
  const ref = `refs/heads/${base}`;
  const disposition = { localCheckout: "not_synced", status: "local_sync_skipped", branch: base, ref,
    checkout: null, localHead: null, observedRemoteSha: null, mergeSha, recovery: syncRecovery };
  const fail = async (status, reason) => {
    // A ref may have moved independently while inspecting it. Never report a
    // count calculated against an earlier local OID as if it described HEAD.
    disposition.localHead = await git(cwd, ["rev-parse", "--verify", ref]).catch(() => null);
    delete disposition.behind;
    if (disposition.localHead && disposition.observedRemoteSha) {
      try {
        await git(cwd, ["merge-base", "--is-ancestor", disposition.localHead, disposition.observedRemoteSha]);
        disposition.behind = Number(await git(cwd, ["rev-list", "--count", `${disposition.localHead}..${disposition.observedRemoteSha}`]));
        if (await git(cwd, ["rev-parse", "--verify", ref]).catch(() => null) !== disposition.localHead)
          delete disposition.behind;
      } catch { /* divergence or missing object: no safe count */ }
    }
    return { ...disposition, status, reason: syncDiagnostic(reason) };
  };
  try {
    // Verify the remote's advertised default, not just a provider response or
    // the local cached origin/HEAD. Never advance a different local branch.
    const remoteHead = await git(cwd, ["ls-remote", "--symref", "--", remote, "HEAD"]);
    if (!remoteHead.split("\n").includes(`ref: refs/heads/${base}\tHEAD`))
      return fail("local_sync_skipped", "remote default branch could not be verified against the PR base");
    // FETCH_HEAD is populated by this fetch, not by a possibly stale
    // refs/remotes/* cache. Pin the fetched object and reject a moving tip.
    await git(cwd, ["fetch", "--no-tags", "--", remote, `refs/heads/${base}`]);
    const tip = await revParse(cwd, "FETCH_HEAD");
    disposition.observedRemoteSha = tip;
    await git(cwd, ["merge-base", "--is-ancestor", mergeSha, tip]);
    const advertised = (await git(cwd, ["ls-remote", "--exit-code", "--", remote, `refs/heads/${base}`])).split(/\s+/)[0];
    if (advertised !== tip) return fail("local_sync_skipped", "remote default advanced during observation; inspect the new tip before retrying");
  } catch (error) {
    return fail("local_sync_skipped", `remote default observation failed: ${syncDiagnostic(error)}`);
  }
  try {
    const checkout = await worktreeCheckingOut(cwd, base);
    disposition.checkout = checkout;
    const old = await git(cwd, ["rev-parse", "--verify", ref]).catch(() => null);
    disposition.localHead = old;
    if (!old) return fail("local_sync_skipped", "local default branch is missing; create/reconcile it manually");
    const tip = disposition.observedRemoteSha;
    try {
      await git(cwd, ["merge-base", "--is-ancestor", old, tip]);
      disposition.behind = Number(await git(cwd, ["rev-list", "--count", `${old}..${tip}`]));
    } catch { return fail("local_sync_conflicted", "local default diverged from the observed remote tip"); }
    if (checkout) {
      if (await git(checkout, ["symbolic-ref", "HEAD"]) !== ref || await revParse(checkout) !== old)
        return fail("local_sync_skipped", "default checkout changed during inspection");
      // Do not reuse isDirty: implementation status intentionally filters
      // operational paths. Checkout safety requires full porcelain -z.
      const status = await git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (status) return fail("local_sync_skipped", "default checkout has staged, unstaged or untracked changes; preserve and inventory them before reconciliation");
      // Ignored files can also obstruct or be overwritten by a merge. The
      // ordinary operational state directory is the sole safe exclusion.
      const ignored = await git(checkout, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"]);
      if (ignored.split("\0").some(entry => entry.startsWith("!! ") && !/^!! \.architect\/state(?:\/|$)/.test(entry)))
        return fail("local_sync_skipped", "default checkout contains ignored files that may obstruct a merge; inventory them first");
      if (await git(checkout, ["symbolic-ref", "HEAD"]) !== ref || await revParse(cwd, ref) !== old || await revParse(checkout) !== old)
        return fail("local_sync_skipped", "default checkout or branch changed before fast-forward");
      // A merge is not scoped to `ref`: it updates whatever HEAD is when the
      // command starts. A concurrent branch switch (or a newly dirty file with
      // merge.autoStash enabled) can mutate a *different* branch or a stash.
      // Git offers no atomic compare-and-swap of HEAD identity, index and
      // worktree for this operation. Preserve the checkout for manual FF.
      if (old !== tip) return fail("local_sync_skipped", "clean default checkout is behind; automatic checked-out fast-forward cannot atomically guard branch, index and worktree against concurrent changes; preserve edits and reconcile manually");
      disposition.localHead = await revParse(checkout);
      if (await git(checkout, ["symbolic-ref", "HEAD"]) !== ref || await revParse(cwd, ref) !== tip || disposition.localHead !== tip ||
          await git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
        return fail("local_sync_conflicted", "post-sync checkout/ref/status verification failed");
    } else {
      // update-ref's old-OID CAS does not check worktree ownership. A checkout
      // of this ref immediately before the CAS leaves its index at the old
      // tree while its HEAD moves to the new one. Do not run that CAS until
      // there is an atomic Git primitive guarding checkout ownership too.
      if (old !== tip) return fail("local_sync_skipped", "unchecked-out default branch is behind; ref CAS cannot atomically guard against a concurrent checkout; reconcile manually");
      disposition.localHead = await revParse(cwd, ref);
      if (disposition.localHead !== tip || await worktreeCheckingOut(cwd, base))
        return fail("local_sync_conflicted", "post-sync ref or worktree verification failed");
    }
    const after = (await git(cwd, ["ls-remote", "--exit-code", "--", remote, `refs/heads/${base}`])).split(/\s+/)[0];
    if (after !== tip) {
      disposition.observedRemoteSha = after;
      delete disposition.behind;
      return fail("local_sync_conflicted", "remote default advanced after local synchronization; compare the new remote tip before retrying");
    }
    return { ...disposition, localCheckout: "synced", status: "local_sync_verified", behind: 0 };
  } catch (error) {
    return fail("local_sync_conflicted", `local synchronization failed: ${syncDiagnostic(error)}`);
  }
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
  const localSync = await synchronizeDefaultCheckout(cwd, { remote, base, mergeSha: actual.mergeCommit.oid });
  // Checkpoints are supplementary telemetry, never the disposition transport.
  await checkpoint("merged", { ...actual, localSync }).catch(() => {});
  return { pr: actual.url, merged: true, headSha: sha, mergeSha: actual.mergeCommit.oid, localSync };
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

// Copy the session ticket into the worktree as .architect/ticket.md. The
// worktree copy is a cache of the session file (children never edit it), so
// every dispatch refreshes it. Fatal on IO error: no success is returned
// without the spec in place.
async function copyTicketToWorktree(srcTicket, dest) {
  const destTicket = join(dest, ".architect", "ticket.md");
  try {
    await mkdir(dirname(destTicket), { recursive: true });
    const content = await readFile(srcTicket, "utf8");
    await writeFile(destTicket, content, "utf8");
  } catch (error) {
    throw new Error(`failed to copy ticket from '${srcTicket}' to '${destTicket}': ${error?.message ?? error}`, { cause: error });
  }
  return destTicket;
}

export async function createWorktree(cwd, { kind = "bounded", sessionId, branch: customBranch, base = null } = {}) {
  const root = await mainRepoRoot(cwd);
  // Fail fast on a missing ticket before any worktree or branch exists.
  const srcTicket = await resolveTicketSource(root, sessionId);
  const branch = customBranch || implementerBranchName(kind, sessionId);
  const dest = worktreePathFor(root, branch);
  const explicitBaseSha = base == null ? null : await revParse(root, base);

  await mkdir(dirname(dest), { recursive: true });

  let branchExists = false;
  let baseSelection = null;
  try {
    await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    if (existsSync(dest)) {
      // Never refresh a ticket into a foreign directory or a worktree whose
      // branch was replaced. Reuse preserves all tracked and untracked work.
      const actualRoot = await mainRepoRoot(dest);
      const actualBranch = await currentBranch(dest);
      if (actualRoot !== root || actualBranch !== branch) throw new Error("preserved worktree identity mismatch");
      if (explicitBaseSha) await git(dest, ["merge-base", "--is-ancestor", explicitBaseSha, "HEAD"]);
      registerStateExclude(dest, stateDirFor(dest));
      await copyTicketToWorktree(srcTicket, dest);
      return { cwd: dest, worktree: dest, branch, reused: true, sessionId, ticketSource: srcTicket };
    }
    if (explicitBaseSha) await git(root, ["merge-base", "--is-ancestor", explicitBaseSha, branch]);
    await git(root, ["worktree", "add", dest, branch]);
  } else {
    const selected = base == null
      ? await freshDefaultBase(root)
      : { ref: base, sha: explicitBaseSha, source: "explicit" };
    // Pin the verified commit: concurrent fetches cannot change the branch
    // between selection and creation. No root checkout or stash is modified.
    await git(root, ["worktree", "add", "-b", branch, dest, selected.sha]);
    baseSelection = selected;
  }

  registerStateExclude(dest, stateDirFor(dest));

  await copyTicketToWorktree(srcTicket, dest);

  return { cwd: dest, worktree: dest, branch, reused: false, sessionId, ticketSource: srcTicket, ...(baseSelection ? { baseSelection } : {}) };
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

export async function landWorktree(cwd, { worktree, branch, message, title, body, deleteBranch = true, home, sessionId: explicitSessionId, clearTicket = true, curation = null } = {}) {
  const targetWorktree = worktree || cwd;
  const mainRoot = await mainRepoRoot(targetWorktree);

  const targetBranch = branch || await currentBranch(targetWorktree);
  if (targetBranch === "HEAD" || targetBranch === "main" || targetBranch === "master") {
    throw new Error(`cannot land branch '${targetBranch}'; requires a dedicated worktree branch`);
  }

  const resolveSessionTag = () => {
    if (explicitSessionId) return explicitSessionId;
    const match = /^architect\/(?:bounded|open|research)\/([a-zA-Z0-9]+)$/.exec(targetBranch);
    return match ? match[1] : null;
  };

  // ADR source evidence capture / curation obligation seam (managed,
  // record-backed landings only). Nonblocking BY CONTRACT: capture runs
  // BEFORE the destructive ticket reset/worktree retirement, activation runs
  // only after a verified real landing outcome (the actual merge/ff receipt),
  // and every curation failure becomes a bounded truthful warning on the
  // result — a completed landing is never rolled back or failed by curation.
  // A failed capture or receipt handoff PRESERVES the sole unretained required
  // evidence (worktree, branch, session ticket) for recovery instead of
  // cleaning it up. Legacy/manual landings without the seam keep ordinary
  // behavior and state their unsupported/deferred curation truthfully.
  const bounded = (error) => String(error?.message ?? error).slice(0, 300);
  const curationState = curation
    ? { supported: true, status: "capturing", warnings: [] }
    : {
      supported: false,
      status: "unsupported",
      warnings: [],
      reason: "no authoritative managed change record is attached to this landing; ADR source evidence capture and post-landing curation are unsupported/deferred for legacy or manual landing",
    };
  let preserveSoleEvidence = false;
  let captureResult = null;
  const sessionTag = resolveSessionTag();
  let ticketPath = null;
  if (curation?.capture && sessionTag) {
    ticketPath = await resolveTicketSource(mainRoot, sessionTag).catch(() => null);
  }
  if (curation?.capture) {
    try {
      captureResult = await curation.capture({
        mainRoot,
        worktree: targetWorktree,
        branch: targetBranch,
        sessionTag,
        ticketPath,
        baseSelection: null,
      });
      if (captureResult?.suppressed) {
        curationState.status = "suppressed";
        curationState.suppression = captureResult.suppression ?? null;
      } else {
        curationState.status = "prepared";
        curationState.manifestId = captureResult?.manifestId ?? null;
        curationState.operationId = captureResult?.operationId ?? null;
      }
    } catch (error) {
      preserveSoleEvidence = true;
      curationState.status = "capture-failed";
      curationState.warnings.push(`ADR source capture failed; landing continues and the ticket/worktree are preserved for recovery: ${bounded(error)}`);
      curationState.preservedForRecovery = ["worktree", "branch", "ticket"];
    }
  }
  const activateCuration = async (landing) => {
    if (!curation?.activate) return;
    // With a failed capture and a REAL landing no pending obligation can
    // exist (it requires the retained manifest): do not manufacture a second
    // failure over the truthful capture-failed state. A no-change disposition
    // is still recorded — it requires no manifest and invents nothing.
    if (curationState.status === "capture-failed" && landing?.method !== "none") return;
    try {
      const activated = await curation.activate({ landing, manifestId: captureResult?.manifestId ?? null });
      curationState.status = activated?.status ?? curationState.status;
      curationState.operationId = activated?.operationId ?? curationState.operationId ?? null;
      curationState.manifestId = captureResult?.manifestId ?? curationState.manifestId ?? null;
      curationState.obligationRecorded = Boolean(activated?.ok);
    } catch (error) {
      // The receipt evidence itself is the sole unretained artifact here: the
      // worktree/branch stay intact for recovery and the landing stands.
      preserveSoleEvidence = true;
      curationState.status = "activation-failed";
      curationState.warnings.push(`ADR curation obligation activation failed; landing continues and the worktree/branch are preserved for recovery: ${bounded(error)}`);
      curationState.preservedForRecovery = [...new Set([...(curationState.preservedForRecovery ?? []), "worktree", "branch"])];
    }
  };
  const completeCuration = async (archivePath) => {
    if (!curation?.complete) return;
    try {
      await curation.complete({
        manifestId: captureResult?.manifestId ?? null,
        refs: {
          archivePath: archivePath
            ? { status: "retained", path: archivePath }
            : { status: "missing", reason: "the ticket was not archived (or archival failed) during this landing" },
        },
      });
    } catch (error) {
      // Idempotent post-landing completion stays available (e.g. recovery).
      curationState.warnings.push(`ADR source reference completion failed; the explicit pending/missing reference remains retryable: ${bounded(error)}`);
    }
  };

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
    // A no-op landing produces an EXPLICIT no-source-change disposition: no
    // commit is invented and architectural curation is never scheduled.
    await activateCuration({ method: "none", receipt: null, headSha: null, pr: null });
    if (deleteBranch && !preserveSoleEvidence) {
      await retireWorktree(mainRoot, { worktree: targetWorktree, branch: targetBranch, force: true, home });
    }
    let ticketArchived = false;
    let archivePath = null;
    if (clearTicket && !preserveSoleEvidence) {
      if (sessionTag) {
        try {
          const archResult = await archiveAndClearTicket(mainRoot, sessionTag);
          ticketArchived = Boolean(archResult?.archived);
          archivePath = archResult?.archivePath ?? null;
        } catch {}
      }
    }
    await completeCuration(archivePath);
    return {
      landed: true,
      retired: !preserveSoleEvidence,
      branch: targetBranch,
      method: "none",
      pr: null,
      mergeSha: null,
      ticketArchived,
      ...(archivePath ? { archivePath } : {}),
      curation: curationState,
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

  // The ACTUAL merge/ff receipt (result.mergeSha / result.sha) is the
  // authoritative landing identity — commitIfDirty.sha is not necessarily the
  // merge sha. Activation happens BEFORE retirement so the receipt evidence
  // survives an interrupted obligation handoff.
  const mergeSha = result.mergeSha ?? result.sha ?? null;
  await activateCuration({
    method: remote ? "pr" : "ff",
    receipt: mergeSha,
    headSha: result.headSha ?? commitResult.sha ?? null,
    pr: result.pr ?? null,
  });

  if (deleteBranch && !preserveSoleEvidence) {
    await retireWorktree(mainRoot, { worktree: targetWorktree, branch: targetBranch, force: true, home });
  }

  let ticketArchived = false;
  let archivePath = null;
  if (clearTicket && !preserveSoleEvidence) {
    if (sessionTag) {
      try {
        let prNum;
        if (result?.pr) {
          const prMatch = /\/pull\/(\d+)/.exec(result.pr);
          if (prMatch) prNum = prMatch[1];
        }
        const archResult = await archiveAndClearTicket(mainRoot, sessionTag, { prNumber: prNum });
        ticketArchived = Boolean(archResult?.archived);
        archivePath = archResult?.archivePath ?? null;
      } catch {}
    }
  }
  // archivePath is reported only when archival actually produced it.
  await completeCuration(archivePath);

  return {
    landed: true,
    retired: Boolean(deleteBranch && !preserveSoleEvidence),
    branch: targetBranch,
    method: remote ? "pr" : "ff",
    pr: result.pr ?? null,
    mergeSha,
    ...(remote ? { localSync: result.localSync } : {}),
    ticketArchived,
    ...(archivePath ? { archivePath } : {}),
    curation: curationState,
  };
}

export const land = landWorktree;
