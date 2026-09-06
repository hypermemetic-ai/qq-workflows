#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildReviewPacket,
  defaultBaseRef,
  defaultLocalBranch,
  fastForwardMain,
  hasRemote,
  mergeBase,
} from "../../paseo-plugin/host/git.mjs";

const exec = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

const gitSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../paseo-plugin/host/git.mjs"),
  "utf8",
);
assert.doesNotMatch(gitSrc, /base = "HEAD~1"/);
assert.doesNotMatch(gitSrc, /HEAD~1\.\.\.HEAD/);

const dir = mkdtempSync(join(tmpdir(), "architect-git-"));
try {
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Architect Test"]);
  await git(dir, ["config", "user.email", "architect@example.invalid"]);
  writeFileSync(join(dir, "root.txt"), "root\n");
  await git(dir, ["add", "root.txt"]);
  await git(dir, ["commit", "-m", "root"]);
  writeFileSync(join(dir, "main.txt"), "on main\n");
  await git(dir, ["add", "main.txt"]);
  await git(dir, ["commit", "-m", "main second"]);
  await git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "feature.txt"), "one\n");
  await git(dir, ["add", "feature.txt"]);
  await git(dir, ["commit", "-m", "feature first"]);
  writeFileSync(join(dir, "feature.txt"), "one\ntwo\n");
  await git(dir, ["add", "feature.txt"]);
  await git(dir, ["commit", "-m", "feature second"]);

  assert.equal(await defaultBaseRef(dir), "main");
  const baseSha = await mergeBase(dir, "main", "HEAD");
  const headMinusOne = await git(dir, ["rev-parse", "HEAD~1"]);
  assert.notEqual(baseSha, headMinusOne);

  const packet = await buildReviewPacket(dir);
  assert.equal(packet.baseSha, baseSha);
  assert.equal(packet.files[0].path, "feature.txt");
  assert.ok(packet.files[0].hunks.length >= 1);
  const headers = packet.files[0].hunks.map((hunk) => hunk.header).join("\n");
  assert.match(headers, /\+1,/);

  const onlyLast = await git(dir, ["diff", "--unified=0", "HEAD~1", "HEAD"]);
  const fromBase = await git(dir, ["diff", "--unified=0", baseSha, "HEAD"]);
  assert.notEqual(fromBase, onlyLast);

  assert.equal(await hasRemote(dir), false);
  assert.equal(await defaultLocalBranch(dir), "main");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const local = mkdtempSync(join(tmpdir(), "architect-ff-"));
const wt = `${local}-wt`;
try {
  await git(local, ["init", "-b", "main"]);
  await git(local, ["config", "user.name", "Architect Test"]);
  await git(local, ["config", "user.email", "architect@example.invalid"]);
  writeFileSync(join(local, "root.txt"), "root\n");
  await git(local, ["add", "root.txt"]);
  await git(local, ["commit", "-m", "root"]);
  assert.equal(await hasRemote(local), false);
  await git(local, ["remote", "add", "origin", "https://example.com/repo.git"]);
  assert.equal(await hasRemote(local), true);
  await git(local, ["remote", "remove", "origin"]);
  assert.equal(await hasRemote(local), false);
  await git(local, ["worktree", "add", "-b", "architect/bounded/ff", wt]);
  await git(wt, ["config", "user.name", "Architect Test"]);
  await git(wt, ["config", "user.email", "architect@example.invalid"]);
  writeFileSync(join(wt, "landed.txt"), "from worktree\n");
  await git(wt, ["add", "landed.txt"]);
  await git(wt, ["commit", "-m", "worktree change"]);
  const head = await git(wt, ["rev-parse", "HEAD"]);

  const landed = await fastForwardMain(wt);
  assert.equal(landed.method, "ff");
  assert.equal(landed.branch, "main");
  assert.equal(await git(local, ["rev-parse", "main"]), head);
  assert.equal(readFileSync(join(local, "landed.txt"), "utf8"), "from worktree\n");
  assert.equal(await git(local, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");

  const already = await fastForwardMain(local);
  assert.equal(already.method, "already-on-main");

  writeFileSync(join(local, "main-only.txt"), "main moved\n");
  await git(local, ["add", "main-only.txt"]);
  await git(local, ["commit", "-m", "main moved"]);
  await git(wt, ["commit", "--allow-empty", "-m", "feature moved"]);
  await assert.rejects(() => fastForwardMain(wt), /cannot fast-forward/);
} finally {
  try { await git(local, ["worktree", "remove", "--force", wt]); } catch { /* already gone */ }
  rmSync(wt, { recursive: true, force: true });
  rmSync(local, { recursive: true, force: true });
}
