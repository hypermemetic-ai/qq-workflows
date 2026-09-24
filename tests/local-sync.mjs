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
  writeFileSync(join(root, "tracked"), "original\n"); git(root, "add", "."); git(root, "commit", "-m", "first"); git(root, "push", "-u", "origin", "main");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(temp, "clone", bare, producer);
  git(producer, "config", "user.name", "Test"); git(producer, "config", "user.email", "test@example.invalid");
  const old = git(root, "rev-parse", "HEAD");
  writeFileSync(join(producer, "collision"), "upstream\n"); git(producer, "add", "."); git(producer, "commit", "-m", "merge"); git(producer, "push", "origin", "main");
  const tip = git(producer, "rev-parse", "HEAD");
  const sync = () => synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: tip });
  const unchanged = async (expected = old) => { assert.equal(git(root, "rev-parse", "HEAD"), expected); assert.equal(git(root, "stash", "list"), ""); };
  writeFileSync(join(root, "tracked"), "dirty\n");
  let result = await sync(); assert.equal(result.status, "local_sync_skipped"); assert.equal(result.behind, 1); await unchanged();
  git(root, "add", "tracked"); result = await sync(); assert.equal(result.localCheckout, "not_synced"); await unchanged();
  git(root, "reset", "--hard", old);
  writeFileSync(join(root, "collision"), "local\n"); result = await sync(); assert.equal(result.localCheckout, "not_synced"); await unchanged();
  rmSync(join(root, "collision"));
  // There is no atomic checkout/index/HEAD predicate for a Git merge. Even
  // when clean, report the behind branch rather than expose it to a branch
  // switch or autoStash race immediately before merge.
  const shimDir = join(temp, "shim"), log = join(temp, "mutators");
  mkdirSync(shimDir);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  git(root, "branch", "other");
  // These interventions reproduce the reviewer's pre-operation shim. They
  // would switch HEAD, introduce a tracked edit under merge.autoStash=true,
  // or check out main immediately before a ref CAS if either unsafe Git
  // operation were ever attempted.
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\ncase " $* " in\n  *" merge "*)\n    printf '%s\\n' "$*" >> "${log}"\n    if [ "$SYNC_RACE" = switch ]; then "${realGit}" -C "${root}" checkout -q other; fi\n    if [ "$SYNC_RACE" = dirty ]; then printf 'race\\n' > "${join(root, "tracked")}"; fi\n    ;;\n  *" update-ref "*)\n    printf '%s\\n' "$*" >> "${log}"\n    if [ "$SYNC_RACE" = cas ]; then "${realGit}" -C "${root}" checkout -q main; fi\n    ;;\n  *" rev-list --count "*)\n    if [ "$SYNC_RACE" = count ] && [ ! -e "${join(temp, "count-race")}" ]; then\n      : > "${join(temp, "count-race")}"\n      "${realGit}" -C "${root}" branch -f main "$SYNC_RACE_TIP"\n    fi\n    ;;\nesac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const noUnsafeGitMutation = async (action, race = "switch") => {
    const path = process.env.PATH, priorRace = process.env.SYNC_RACE;
    process.env.PATH = `${shimDir}:${path}`;
    process.env.SYNC_RACE = race;
    try {
      const outcome = await action();
      assert.equal(readFileSync(log, { encoding: "utf8", flag: "a+" }), "", "a merge/update-ref would be exposed to a checkout race");
      return outcome;
    } finally {
      process.env.PATH = path;
      if (priorRace === undefined) delete process.env.SYNC_RACE;
      else process.env.SYNC_RACE = priorRace;
    }
  };
  await noUnsafeGitMutation(async () => {
    git(root, "config", "merge.autoStash", "true");
    result = await sync(); assert.equal(result.localCheckout, "not_synced");
    assert.equal(result.status, "local_sync_skipped");
    assert.equal(result.behind, 1); await unchanged();
    assert.equal(git(root, "status", "--porcelain=v1", "-z"), "");
    assert.equal(git(root, "stash", "list"), "");
  });
  await noUnsafeGitMutation(async () => {
    result = await sync(); assert.equal(result.localCheckout, "not_synced");
    assert.equal(result.behind, 1); await unchanged();
    assert.equal(git(root, "status", "--porcelain=v1", "-z"), "");
    assert.equal(git(root, "stash", "list"), "");
  }, "dirty");
  // Manually reconcile this disposable test repo so linked-worktree scenarios
  // can start from the same tip; the production synchronizer never does this.
  git(root, "merge", "--ff-only", tip);
  assert.equal(git(root, "rev-parse", "HEAD"), tip);
  // Linked checkout and CAS: only the checkout actually holding main is inspected.
  git(root, "checkout", "other"); git(root, "worktree", "add", linked, "main");
  writeFileSync(join(producer, "next"), "next\n"); git(producer, "add", "."); git(producer, "commit", "-m", "next"); git(producer, "push", "origin", "main");
  const next = git(producer, "rev-parse", "HEAD");
  writeFileSync(join(linked, "local"), "not safe\n");
  result = await synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: next });
  assert.equal(result.localCheckout, "not_synced"); assert.equal(result.checkout, linked); assert.equal(git(linked, "rev-parse", "HEAD"), tip);
  rmSync(join(linked, "local"));
  result = await noUnsafeGitMutation(() => synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: next }));
  assert.equal(result.localCheckout, "not_synced"); assert.equal(result.behind, 1);
  assert.equal(git(linked, "rev-parse", "HEAD"), tip); assert.equal(git(linked, "stash", "list"), "");
  git(linked, "merge", "--ff-only", next);
  git(root, "worktree", "remove", linked);
  writeFileSync(join(producer, "last"), "last\n"); git(producer, "add", "."); git(producer, "commit", "-m", "last"); git(producer, "push", "origin", "main");
  const last = git(producer, "rev-parse", "HEAD");
  result = await noUnsafeGitMutation(() => synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: last }), "cas");
  assert.equal(result.localCheckout, "not_synced"); assert.equal(result.checkout, null);
  assert.equal(result.behind, 1); assert.equal(git(root, "rev-parse", "main"), next);
  assert.equal(git(root, "rev-parse", "HEAD"), old); assert.equal(git(root, "stash", "list"), "");
  // A concurrent actor advancing the ref while behind is computed must not
  // leave the stale count (1) paired with the newly observed local HEAD (tip).
  process.env.SYNC_RACE_TIP = last;
  try {
    result = await noUnsafeGitMutation(() => synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: last }), "count");
  } finally { delete process.env.SYNC_RACE_TIP; }
  assert.equal(result.localCheckout, "not_synced");
  assert.equal(result.localHead, last); assert.equal(result.behind, 0);
  result = await synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: last });
  assert.equal(result.localCheckout, "synced"); assert.equal(result.behind, 0);
  result = await synchronizeDefaultCheckout(root, { remote: "unavailable", base: "main", mergeSha: last });
  assert.equal(result.localCheckout, "not_synced"); assert.equal(result.observedRemoteSha, null);
  // A divergent local default never gets replaced by an unconditional ref write.
  git(root, "checkout", "main");
  writeFileSync(join(root, "local-only"), "private\n"); git(root, "add", "."); git(root, "commit", "-m", "local-only");
  const divergent = git(root, "rev-parse", "HEAD");
  result = await synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: last });
  assert.equal(result.status, "local_sync_conflicted"); assert.equal(result.behind, undefined);
  assert.equal(git(root, "rev-parse", "HEAD"), divergent);
  git(root, "checkout", "other");
  git(root, "branch", "-D", "main");
  result = await synchronizeDefaultCheckout(root, { remote: "origin", base: "main", mergeSha: last });
  assert.equal(result.status, "local_sync_skipped"); assert.equal(result.localHead, null);
  assert.equal(git(root, "rev-parse", "HEAD"), old);
  console.log("local sync safety tests passed");
} finally { rmSync(temp, { recursive: true, force: true }); }
