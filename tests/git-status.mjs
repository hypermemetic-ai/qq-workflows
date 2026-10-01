import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/git-status.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "git-status-"));
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const report = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
try {
  const remote = join(root, "remote.git");
  const author = join(root, "author");
  const checkout = join(root, "checkout");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", author);
  git(author, "config", "user.name", "Git Status Test");
  git(author, "config", "user.email", "test@example.invalid");
  writeFileSync(join(author, "tracked.txt"), "initial\n");
  writeFileSync(join(author, "rename.txt"), "rename me\n");
  git(author, "add", ".");
  git(author, "commit", "-m", "initial");
  git(author, "remote", "add", "origin", remote);
  git(author, "push", "-u", "origin", "main");
  git(root, "clone", remote, checkout);

  // A cached clean result must not masquerade as a fresh remote check.
  writeFileSync(join(author, "remote.txt"), "new remote work\n");
  git(author, "add", ".");
  git(author, "commit", "-m", "remote advanced");
  git(author, "push");
  const cached = report(checkout, "--cached");
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /freshness: UNKNOWN \(cached mode\)/);
  assert.equal(git(checkout, "rev-list", "--count", "HEAD..origin/main"), "0");

  // Refresh discovers remote work while preserving HEAD, index and local files.
  git(checkout, "mv", "rename.txt", "renamed.txt");
  writeFileSync(join(checkout, "tracked.txt"), "local edits\n");
  writeFileSync(join(checkout, "untracked.txt"), "keep me\n");
  const head = git(checkout, "rev-parse", "HEAD");
  const index = join(checkout, git(checkout, "rev-parse", "--git-path", "index"));
  const beforeIndex = readFileSync(index);
  const fresh = report(checkout);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Remote checked: origin at/);
  assert.match(fresh.stdout, /behind .* by 1 commit/);
  assert.match(fresh.stdout, /renamed:\s+rename.txt -> renamed.txt/);
  assert.match(fresh.stdout, /modified:\s+tracked.txt/);
  assert.match(fresh.stdout, /untracked.txt/);
  assert.equal(git(checkout, "rev-parse", "HEAD"), head);
  assert.deepEqual(readFileSync(index), beforeIndex);
  assert.equal(readFileSync(join(checkout, "tracked.txt"), "utf8"), "local edits\n");
  assert.equal(readFileSync(join(checkout, "untracked.txt"), "utf8"), "keep me\n");

  git(checkout, "remote", "set-url", "origin", join(root, "missing.git"));
  const failed = report(checkout);
  assert.equal(failed.status, 2);
  assert.match(failed.stdout, /freshness: UNKNOWN \(fetch failed or timed out\)/);
  assert.match(failed.stdout, /tracked.txt/);

  git(checkout, "checkout", "-b", "unpublished");
  assert.match(report(checkout).stdout, /no upstream; ahead\/behind unavailable/);
  git(checkout, "branch", "--set-upstream-to=main");
  const local = report(checkout);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /Upstream: local branch/);
  git(checkout, "checkout", "--detach");
  const detached = report(checkout);
  assert.equal(detached.status, 0, detached.stderr);
  assert.match(detached.stdout, /no upstream/);
  assert.match(detached.stdout, /HEAD detached/);

  // Native status also exposes a merge that still needs completion.
  git(author, "checkout", "-b", "conflicting");
  writeFileSync(join(author, "tracked.txt"), "feature\n");
  git(author, "commit", "-am", "feature");
  git(author, "checkout", "main");
  writeFileSync(join(author, "tracked.txt"), "main\n");
  git(author, "commit", "-am", "main");
  assert.equal(spawnSync("git", ["merge", "conflicting"], { cwd: author }).status, 1);
  const conflicted = report(author, "--cached");
  assert.equal(conflicted.status, 0, conflicted.stderr);
  assert.match(conflicted.stdout, /unmerged paths/i);
  assert.match(conflicted.stdout, /both modified:\s+tracked.txt/);
  console.log("Git status checks passed: refresh, preservation, offline/failure, upstream and conflicts.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
