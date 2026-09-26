import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synchronizeDefaultCheckout } from "../workflow/git.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const temp = mkdtempSync(join(tmpdir(), "architect-local-sync-"));
const bare = join(temp, "remote.git"), root = join(temp, "root"), producer = join(temp, "producer"), linked = join(temp, "linked");
try {
  git(temp, "init", "--bare", bare);
  git(temp, "clone", bare, root);
  git(root, "checkout", "-b", "main");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, ".gitignore"), "ignored*\ncache/\n");
  writeFileSync(join(root, "tracked"), "original\n"); git(root, "add", "."); git(root, "commit", "-m", "first"); git(root, "push", "-u", "origin", "main");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(temp, "clone", bare, producer);
  git(producer, "config", "user.name", "Test"); git(producer, "config", "user.email", "test@example.invalid");
  const old = git(root, "rev-parse", "HEAD");
  writeFileSync(join(producer, "ignored-collision"), "upstream\n");
  writeFileSync(join(producer, "normal"), "upstream\n");
  git(producer, "add", "-f", "ignored-collision", "normal"); git(producer, "commit", "-m", "merge"); git(producer, "push", "origin", "main");
  const tip = git(producer, "rev-parse", "HEAD");
  const sync = (sha = tip) => synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: sha });
  const unchanged = (sha = old) => { assert.equal(git(root, "rev-parse", "main"), sha); assert.equal(git(root, "stash", "list"), ""); };
  writeFileSync(join(root, "tracked"), "dirty\n");
  let result = await sync(); assert.equal(result.status, "local_sync_skipped"); assert.equal(result.behind, 1); unchanged();
  git(root, "add", "tracked"); result = await sync(); assert.equal(result.localCheckout, "not_synced"); unchanged();
  git(root, "restore", "--staged", "--worktree", "tracked");
  writeFileSync(join(root, "normal"), "local\n"); result = await sync(); assert.equal(result.localCheckout, "not_synced"); unchanged();
  rmSync(join(root, "normal"));
  writeFileSync(join(root, "ignored-collision"), "private\n");
  result = await sync(); assert.equal(result.localCheckout, "not_synced"); assert.match(result.reason, /ignored-collision/); unchanged();
  assert.equal(readFileSync(join(root, "ignored-collision"), "utf8"), "private\n");
  rmSync(join(root, "ignored-collision"));
  // A branch switch during inspection must not synchronize a different HEAD.
  git(root, "branch", "other");
  const switchDir = join(temp, "switch-shim"), realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(switchDir);
  writeFileSync(join(switchDir, "git"), `#!/bin/sh\ncase " $* " in\n *" status --porcelain=v1 "*) if [ ! -e "${join(temp, "switched")}" ]; then : > "${join(temp, "switched")}"; "${realGit}" -C "${root}" checkout -q other; fi;;\nesac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(switchDir, "git"), 0o755);
  let originalPath = process.env.PATH;
  process.env.PATH = `${switchDir}:${originalPath}`;
  try { result = await sync(); } finally { process.env.PATH = originalPath; }
  assert.equal(result.localCheckout, "not_synced"); unchanged();
  assert.equal(git(root, "branch", "--show-current"), "other");
  git(root, "checkout", "main");
  mkdirSync(join(root, "cache")); writeFileSync(join(root, "cache", "private"), "keep\n");
  writeFileSync(join(root, "ignored-harmless"), "keep too\n");
  result = await sync(); assert.equal(result.localCheckout, "synced"); assert.equal(git(root, "rev-parse", "HEAD"), tip);
  assert.equal(readFileSync(join(root, "cache", "private"), "utf8"), "keep\n");
  assert.equal(readFileSync(join(root, "ignored-harmless"), "utf8"), "keep too\n");
  // An ignored file under an incoming tracked directory also blocks; Git may
  // otherwise overwrite ignored contents in file/directory transitions.
  mkdirSync(join(producer, "cache")); writeFileSync(join(producer, "cache", "private"), "incoming\n");
  git(producer, "add", "-f", "cache/private"); git(producer, "commit", "-m", "colliding directory"); git(producer, "push", "origin", "main");
  const collisionTip = git(producer, "rev-parse", "HEAD");
  result = await sync(collisionTip); assert.equal(result.localCheckout, "not_synced"); assert.match(result.reason, /cache\/private/); unchanged(tip);
  assert.equal(readFileSync(join(root, "cache", "private"), "utf8"), "keep\n");
  rmSync(join(root, "cache"), { recursive: true });
  result = await sync(collisionTip); assert.equal(result.localCheckout, "synced");
  // An ignored file replaced by a tracked directory must also be preserved.
  mkdirSync(join(producer, "ignored-parent")); writeFileSync(join(producer, "ignored-parent", "child"), "tracked\n");
  git(producer, "add", "-f", "ignored-parent/child"); git(producer, "commit", "-m", "directory replaces file"); git(producer, "push", "origin", "main");
  const parentTip = git(producer, "rev-parse", "HEAD");
  writeFileSync(join(root, "ignored-parent"), "private file\n");
  result = await sync(parentTip); assert.equal(result.localCheckout, "not_synced"); assert.match(result.reason, /ignored-parent/); unchanged(collisionTip);
  assert.equal(readFileSync(join(root, "ignored-parent"), "utf8"), "private file\n");
  rmSync(join(root, "ignored-parent")); result = await sync(parentTip); assert.equal(result.localCheckout, "synced");
  // A directory replaced by a tracked file must not destroy an ignored child.
  mkdirSync(join(producer, "ignored-dir")); writeFileSync(join(producer, "ignored-dir", "child"), "tracked\n");
  git(producer, "add", "-f", "ignored-dir/child"); git(producer, "commit", "-m", "directory"); git(producer, "push", "origin", "main");
  const directoryTip = git(producer, "rev-parse", "HEAD");
  mkdirSync(join(root, "ignored-dir")); writeFileSync(join(root, "ignored-dir", "private"), "private\n");
  // only ignored-dir/private is not an exact/ancestor intersection with
  // ignored-dir/child; the directory itself remains, so this is safe.
  result = await sync(directoryTip); assert.equal(result.localCheckout, "synced");
  assert.equal(readFileSync(join(root, "ignored-dir", "private"), "utf8"), "private\n");
  git(producer, "rm", "-r", "ignored-dir"); writeFileSync(join(producer, "ignored-dir"), "file\n");
  git(producer, "add", "-f", "ignored-dir"); git(producer, "commit", "-m", "file replaces directory"); git(producer, "push", "origin", "main");
  const fileTip = git(producer, "rev-parse", "HEAD");
  result = await sync(fileTip); assert.equal(result.localCheckout, "not_synced"); assert.match(result.reason, /ignored-dir\/private/);
  assert.equal(readFileSync(join(root, "ignored-dir", "private"), "utf8"), "private\n");
  rmSync(join(root, "ignored-dir", "private")); result = await sync(fileTip); assert.equal(result.localCheckout, "synced");
  git(root, "checkout", "other"); git(root, "worktree", "add", linked, "main");
  writeFileSync(join(producer, "next"), "next\n"); git(producer, "add", "next"); git(producer, "commit", "-m", "next"); git(producer, "push", "origin", "main");
  const next = git(producer, "rev-parse", "HEAD");
  writeFileSync(join(linked, "local"), "not safe\n");
  result = await sync(next); assert.equal(result.localCheckout, "not_synced"); assert.equal(result.checkout, linked); unchanged(fileTip);
  rmSync(join(linked, "local"));
  result = await sync(next); assert.equal(result.localCheckout, "synced"); assert.equal(git(linked, "rev-parse", "HEAD"), next);
  git(root, "worktree", "remove", linked);
  writeFileSync(join(producer, "last"), "last\n"); git(producer, "add", "last"); git(producer, "commit", "-m", "last"); git(producer, "push", "origin", "main");
  const last = git(producer, "rev-parse", "HEAD");
  result = await sync(last); assert.equal(result.localCheckout, "not_synced"); assert.equal(result.checkout, null); unchanged(next);
  // Concurrent movement while behind is computed never pairs an old count
  // with a new HEAD. The behind unchecked-out branch remains untouched.
  const shimDir = join(temp, "shim");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\ncase " $* " in\n *" rev-list --count "*) if [ ! -e "${join(temp, "raced")}" ]; then : > "${join(temp, "raced")}"; "${realGit}" -C "${root}" branch -f main "$SYNC_RACE_TIP"; fi;;\nesac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${previousPath}`; process.env.SYNC_RACE_TIP = last;
  try { result = await sync(last); } finally { process.env.PATH = previousPath; delete process.env.SYNC_RACE_TIP; }
  assert.equal(result.localHead, last); assert.equal(result.behind, 0); assert.equal(result.localCheckout, "not_synced");
  result = await sync(last); assert.equal(result.localCheckout, "synced");
  result = await synchronizeDefaultCheckout(root, { remote: "unavailable", base: "main", mergeSha: last });
  assert.equal(result.localCheckout, "not_synced"); assert.equal(result.observedRemoteSha, null);
  git(root, "checkout", "main"); writeFileSync(join(root, "local-only"), "private\n"); git(root, "add", "local-only"); git(root, "commit", "-m", "local-only");
  const divergent = git(root, "rev-parse", "HEAD");
  result = await sync(last); assert.equal(result.status, "local_sync_conflicted"); assert.equal(result.behind, undefined); unchanged(divergent);
  git(root, "checkout", "other"); git(root, "branch", "-D", "main");
  result = await sync(last); assert.equal(result.status, "local_sync_skipped"); assert.equal(result.localHead, null);
  assert.equal(git(root, "rev-parse", "HEAD"), old);
  console.log("local sync safety tests passed");
} finally { rmSync(temp, { recursive: true, force: true }); }
