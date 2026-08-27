#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../src/git.mjs";
import { compilePacket } from "../src/routing.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-routing."));
const repo = join(root, "repo");
mkdirSync(repo);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "routing-test",
  GIT_AUTHOR_EMAIL: "routing@test",
  GIT_COMMITTER_NAME: "routing-test",
  GIT_COMMITTER_EMAIL: "routing@test",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (...args) => execFileSync("git", args, {
  cwd: repo,
  env,
  encoding: "utf8",
  maxBuffer: 8_000_000,
}).trim();

try {
  git("init", "-b", "main");
  writeFileSync(join(repo, "large.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "base");
  const baseRef = git("rev-parse", "HEAD");

  // One very long changed line reproduces the finish failure: the unified diff
  // exceeds runCommand's 2 MB buffer even though the packet needs only its hunk.
  writeFileSync(join(repo, "large.txt"), `${"x".repeat(2_100_000)}\n`);
  git("add", ".");
  git("commit", "-m", "large textual proposal");
  const ref = git("rev-parse", "HEAD");
  const rawDiff = execFileSync("git", ["diff", "-U0", `${baseRef}...${ref}`], {
    cwd: repo,
    env,
    maxBuffer: 8_000_000,
  });
  assert.ok(rawDiff.byteLength > 2_000_000, "fixture must exceed runCommand maxBuffer");

  const packet = await compilePacket(
    (command, args, options = {}) => runCommand(command, args, { ...options, env }),
    { baseRef, ref, worktree: repo },
    { brief: "large packet regression" },
  );
  assert.deepEqual(packet.files, [{ path: "large.txt", added: 1, deleted: 1 }]);
  assert.deepEqual(packet.pointers, ["large.txt:1"]);

  const tenHunks = Array.from({ length: 10 }, (_, index) => [
    `diff --git a/file-${index}.txt b/file-${index}.txt`,
    `+++ b/file-${index}.txt`,
    `@@ -0,0 +${index + 1} @@ context ${index}`,
    "+changed",
  ].join("\n")).join("\n");
  let stoppedAtLimit = false;
  const streamedPacket = await compilePacket(async (_command, _args, options) => {
    assert.equal(typeof options.onStdout, "function");
    for (let offset = 0; offset < tenHunks.length; offset += 7) {
      if (options.onStdout(tenHunks.slice(offset, offset + 7)) === false) {
        stoppedAtLimit = true;
        break;
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  }, { baseRef, ref, worktree: repo }, { files: [], brief: "pointer limit" });
  assert.equal(stoppedAtLimit, true);
  assert.deepEqual(streamedPacket.pointers, Array.from({ length: 8 }, (_, index) =>
    `file-${index}.txt:${index + 1} context ${index}`));

  console.log("routing tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
