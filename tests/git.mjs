#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildReviewPacket,
  createWorktree,
  defaultBaseRef,
  defaultLocalBranch,
  fastForwardMain,
  hasRemote,
  implementerBranchName,
  landWorktree,
  mergeBase,
  retireWorktree,
  worktreePathFor,
} from "../workflow/git.mjs";
const exec = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

const gitSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../workflow/git.mjs"),
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

// Tests for worktree lifecycle and landing semantics
assert.equal(implementerBranchName("bounded", "9cb8531b-1234"), "architect/bounded/9cb8531b");
assert.equal(implementerBranchName("open", "9cb8531b-1234"), "architect/open/9cb8531b");
assert.equal(implementerBranchName("research", "9cb8531b-1234"), "architect/research/9cb8531b");
assert.match(worktreePathFor("/tmp/repo", "architect/bounded/9cb8531b"), /\.qq-worktrees\/repo\/architect-bounded-9cb8531b/);

const lifecycleRepo = mkdtempSync(join(tmpdir(), "architect-lifecycle-"));
try {
  await git(lifecycleRepo, ["init", "-b", "main"]);
  await git(lifecycleRepo, ["config", "user.name", "Architect Test"]);
  await git(lifecycleRepo, ["config", "user.email", "architect@example.invalid"]);
  writeFileSync(join(lifecycleRepo, "init.txt"), "initial commit\n");
  await git(lifecycleRepo, ["add", "init.txt"]);
  await git(lifecycleRepo, ["commit", "-m", "initial"]);

  // Seed session tickets: createWorktree fails fast without one.
  mkdirSync(join(lifecycleRepo, ".architect", "tickets"), { recursive: true });
  for (const id of [
    "abcdef12-3456-7890-abcd-ef1234567890",
    "11223344-5566-7788-9900-aabbccddeeff",
    "55667788-9900-aabb-ccdd-eeff00112233",
    "66778899-0011-2233-4455-667788990011",
  ]) {
    writeFileSync(join(lifecycleRepo, ".architect", "tickets", `${id}.md`), `# Ticket ${id}\n`);
  }

  // 1. Prepare worktree branch
  const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
  const wt = await createWorktree(lifecycleRepo, { kind: "bounded", sessionId });
  assert.equal(wt.branch, "architect/bounded/abcdef12");
  assert.equal(wt.reused, false);
  assert.ok(wt.cwd.includes("architect-bounded-abcdef12"));
  assert.equal(await git(wt.cwd, ["branch", "--show-current"]), wt.branch);
  assert.equal(
    readFileSync(join(wt.cwd, ".architect", "ticket.md"), "utf8"),
    `# Ticket ${sessionId}\n`,
  );

  // Calling createWorktree again reuses existing worktree
  const reused = await createWorktree(lifecycleRepo, { kind: "bounded", sessionId });
  assert.equal(reused.reused, true);
  assert.equal(reused.cwd, wt.cwd);

  // 2. Work in the checkout (dirty changes)
  writeFileSync(join(wt.cwd, "feature.txt"), "built by implementer\n");

  // 3. Land worktree (fast-forward local main, retire worktree, delete local branch)
  const landResult = await landWorktree(lifecycleRepo, {
    worktree: wt.cwd,
    branch: wt.branch,
    message: "feat: implementer work",
  });
  assert.equal(landResult.landed, true);
  assert.equal(landResult.method, "ff");
  assert.equal(landResult.branch, "architect/bounded/abcdef12");

  // Verify main has the changes
  assert.equal(readFileSync(join(lifecycleRepo, "feature.txt"), "utf8"), "built by implementer\n");
  assert.equal(await git(lifecycleRepo, ["log", "-1", "--pretty=%B"]), "feat: implementer work");

  // Verify worktree is retired (directory removed)
  assert.equal(readFileSync(join(lifecycleRepo, "init.txt"), "utf8"), "initial commit\n");
  const wtList = await git(lifecycleRepo, ["worktree", "list"]);
  assert.ok(!wtList.includes(wt.branch), "worktree must not be listed");

  // Verify branch is deleted
  await assert.rejects(() => git(lifecycleRepo, ["rev-parse", "--verify", `refs/heads/${wt.branch}`]), /fatal:/);

  // 4. Research worktree with changes
  const resSessionId = "11223344-5566-7788-9900-aabbccddeeff";
  const wtRes = await createWorktree(lifecycleRepo, { kind: "research", sessionId: resSessionId });
  assert.equal(wtRes.branch, "architect/research/11223344");
  writeFileSync(join(wtRes.cwd, "benchmark.txt"), "benchmark results\n");
  const landResResult = await landWorktree(lifecycleRepo, {
    worktree: wtRes.cwd,
    branch: wtRes.branch,
    message: "docs: benchmark results",
  });
  assert.equal(landResResult.landed, true);
  assert.equal(landResResult.method, "ff");
  assert.equal(landResResult.branch, "architect/research/11223344");
  assert.equal(readFileSync(join(lifecycleRepo, "benchmark.txt"), "utf8"), "benchmark results\n");
  assert.equal(await git(lifecycleRepo, ["log", "-1", "--pretty=%B"]), "docs: benchmark results");

  // 5. Read-only research worktree with no changes (retires without merging)
  const roSessionId = "55667788-9900-aabb-ccdd-eeff00112233";
  const wtRo = await createWorktree(lifecycleRepo, { kind: "research", sessionId: roSessionId });
  assert.equal(wtRo.branch, "architect/research/55667788");
  const landRoResult = await landWorktree(lifecycleRepo, {
    worktree: wtRo.cwd,
    branch: wtRo.branch,
  });
  assert.equal(landRoResult.landed, true);
  assert.equal(landRoResult.retired, true);
  assert.equal(landRoResult.branch, "architect/research/55667788");
  assert.equal(landRoResult.method, "none");
  assert.equal(landRoResult.pr, null);
  assert.equal(landRoResult.mergeSha, null);
  const wtListRo = await git(lifecycleRepo, ["worktree", "list"]);
  assert.ok(!wtListRo.includes(wtRo.branch), "read-only research worktree must not be listed");
  await assert.rejects(() => git(lifecycleRepo, ["rev-parse", "--verify", `refs/heads/${wtRo.branch}`]), /fatal:/);

  // 6. Read-only research worktree with remote configured (safely retires without failing on empty PR)
  await git(lifecycleRepo, ["remote", "add", "origin", "https://example.com/repo.git"]);
  assert.equal(await hasRemote(lifecycleRepo), true);
  const roRemoteSession = "66778899-0011-2233-4455-667788990011";
  const wtRoRemote = await createWorktree(lifecycleRepo, { kind: "research", sessionId: roRemoteSession });
  const landRoRemoteResult = await landWorktree(lifecycleRepo, {
    worktree: wtRoRemote.cwd,
    branch: wtRoRemote.branch,
  });
  assert.equal(landRoRemoteResult.landed, true);
  assert.equal(landRoRemoteResult.retired, true);
  assert.equal(landRoRemoteResult.branch, "architect/research/66778899");
  assert.equal(landRoRemoteResult.method, "none");
  assert.equal(landRoRemoteResult.pr, null);
  const wtListRoRemote = await git(lifecycleRepo, ["worktree", "list"]);
  assert.ok(!wtListRoRemote.includes(wtRoRemote.branch), "remote read-only research worktree must not be listed");
  await assert.rejects(() => git(lifecycleRepo, ["rev-parse", "--verify", `refs/heads/${wtRoRemote.branch}`]), /fatal:/);
  await git(lifecycleRepo, ["remote", "remove", "origin"]);
} finally {
  try {
    rmSync(join(dirname(lifecycleRepo), ".qq-worktrees", basename(lifecycleRepo)), { recursive: true, force: true });
  } catch {}
  rmSync(lifecycleRepo, { recursive: true, force: true });
}

// 4. Test createWorktree ticket resolution: exact, prefix, then fail fast
const ticketRepo = mkdtempSync(join(tmpdir(), "architect-ticket-resolution-"));
try {
  await git(ticketRepo, ["init", "-b", "main"]);
  await git(ticketRepo, ["config", "user.name", "Architect Test"]);
  await git(ticketRepo, ["config", "user.email", "architect@example.invalid"]);
  writeFileSync(join(ticketRepo, "init.txt"), "init\n");
  await git(ticketRepo, ["add", "init.txt"]);
  await git(ticketRepo, ["commit", "-m", "init"]);

  // 1. Session ticket in .architect/tickets/<sessionId>.md
  const s1 = "sess-ticket-1111";
  mkdirSync(join(ticketRepo, ".architect", "tickets"), { recursive: true });
  writeFileSync(join(ticketRepo, ".architect", "tickets", `${s1}.md`), "# Session 1 Ticket\n");
  const wt1 = await createWorktree(ticketRepo, { kind: "bounded", sessionId: s1 });
  assert.equal(
    readFileSync(join(wt1.cwd, ".architect", "ticket.md"), "utf8"),
    "# Session 1 Ticket\n",
  );
  await retireWorktree(ticketRepo, { worktree: wt1.cwd, branch: wt1.branch });

  // 2. Prefix match: a short id resolves the full session file
  const wtPrefix = await createWorktree(ticketRepo, { kind: "bounded", sessionId: "sess-ticket" });
  assert.equal(
    readFileSync(join(wtPrefix.cwd, ".architect", "ticket.md"), "utf8"),
    "# Session 1 Ticket\n",
  );
  await retireWorktree(ticketRepo, { worktree: wtPrefix.cwd, branch: wtPrefix.branch });

  // 3. Unknown session throws before any worktree or branch exists, even
  // when a root .architect/ticket.md exists (the root fallback is gone).
  writeFileSync(join(ticketRepo, ".architect", "ticket.md"), "# Repo Root Ticket\n");
  await assert.rejects(
    () => createWorktree(ticketRepo, { kind: "bounded", sessionId: "sess-unknown-9999" }),
    /^Error: no ticket resolved for session 'sess-unknown-9999'$/,
  );
  await assert.rejects(() => git(ticketRepo, ["rev-parse", "--verify", "refs/heads/architect/bounded/sessunkn"]));
  const wtListAfterThrow = await git(ticketRepo, ["worktree", "list"]);
  assert.ok(!wtListAfterThrow.includes("architect/bounded/sessunkn"), "failed resolution must not leave a worktree");

  // 4. Missing session id throws the no-active-ticket error with no strays.
  await assert.rejects(
    () => createWorktree(ticketRepo, { kind: "bounded" }),
    /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
  );
  await assert.rejects(() => git(ticketRepo, ["rev-parse", "--verify", "refs/heads/architect/bounded"]));
} finally {
  try {
    rmSync(join(dirname(ticketRepo), ".qq-worktrees", basename(ticketRepo)), { recursive: true, force: true });
  } catch {}
  rmSync(ticketRepo, { recursive: true, force: true });
}

console.log("Git tests passed cleanly.");
