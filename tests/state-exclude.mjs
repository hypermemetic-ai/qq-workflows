import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createWorkflow } from "../workflow/operations.mjs";
import { callTool } from "../bin/mcp-server.mjs";
import { createWorktree, worktreePathFor } from "../workflow/git.mjs";
import { registerStateExclude, STATE_EXCLUDE_RULE } from "../workflow/state-exclude.mjs";
import { stateDirFor } from "../workflow/session.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const base = mkdtempSync(join(tmpdir(), "qq-state-exclude-"));
const oldOverride = process.env.QQ_WORKFLOW_STATE_DIR;
const oldWorktrees = process.env.ARCHITECT_WORKTREES_DIR;
delete process.env.QQ_WORKFLOW_STATE_DIR;
process.env.ARCHITECT_WORKTREES_DIR = join(base, "worktrees");
const repo = join(base, "repo");
mkdirSync(repo);
try {
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  const state = join(repo, ".architect", "state");
  for (const name of ["changes/example.jsonl", "reports/old.md", "jobs/old.json"]) {
    mkdirSync(join(state, name, ".."), { recursive: true });
    writeFileSync(join(state, name), `retained ${name}\n`);
  }
  const contents = ["changes/example.jsonl", "reports/old.md", "jobs/old.json"].map(name => readFileSync(join(state, name)));
  mkdirSync(join(repo, ".architect", "config"));
  writeFileSync(join(repo, ".architect", "config", "settings.json"), "before");
  writeFileSync(join(state, "tracked.json"), "tracked");
  git(repo, "add", ".architect/config/settings.json", ".architect/state/tracked.json");
  git(repo, "commit", "-qm", "initial");
  writeFileSync(join(repo, ".architect", "config", "settings.json"), "after");
  writeFileSync(join(repo, "source.txt"), "source");
  const visible = () => git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  assert.match(visible(), /changes\/example.jsonl/);
  const exclude = resolve(repo, git(repo, "rev-parse", "--git-path", "info/exclude"));
  const custom = "# custom comment\n*.local"; // no final newline
  writeFileSync(exclude, custom);
  createWorkflow({ root: repo, sessionKey: "fixture", env: {} });
  createWorkflow({ root: repo, sessionKey: "fixture", env: {} });
  assert.equal(readFileSync(exclude, "utf8"), `${custom}\n${STATE_EXCLUDE_RULE}\n`);
  assert.ok(!visible().includes("changes/example.jsonl"));
  assert.ok(!git(repo, "ls-files", "--others", "--exclude-standard").includes("reports/old.md"));
  assert.match(visible(), /source.txt/);
  assert.match(visible(), /config\/settings.json/);
  writeFileSync(join(state, "tracked.json"), "modified tracked");
  assert.match(visible(), /state\/tracked.json/);
  contents.forEach((bytes, i) => assert.deepEqual(readFileSync(join(state, ["changes/example.jsonl", "reports/old.md", "jobs/old.json"][i])), bytes));

  // Direct MCP tool entry (not native factory) registers in the supplied root.
  writeFileSync(exclude, "# mcp\n");
  await assert.rejects(callTool("check_runner", { cwd: repo, id: "missing" }));
  assert.equal(readFileSync(exclude, "utf8"), `# mcp\n${STATE_EXCLUDE_RULE}\n`);
  // MCP accepts a cwd inside a repository; registration must use its worktree
  // top level just as the ticket tool resolves the repository root.
  const nested = join(repo, "nested");
  mkdirSync(nested);
  writeFileSync(exclude, "# nested mcp\n");
  assert.match(git(repo, "ls-files", "--others", "--exclude-standard"), /changes\/example.jsonl/);
  const updated = await callTool("update_ticket", { cwd: nested, sessionId: "fixture", content: "# Ticket\n" });
  assert.equal(readFileSync(updated.path, "utf8"), "# Ticket\n");
  assert.equal(readFileSync(exclude, "utf8"), `# nested mcp\n${STATE_EXCLUDE_RULE}\n`);
  assert.ok(!git(repo, "ls-files", "--others", "--exclude-standard").includes("changes/example.jsonl"));
  await callTool("update_ticket", { cwd: nested, sessionId: "fixture", content: "# Ticket\n" });
  assert.equal(readFileSync(exclude, "utf8"), `# nested mcp\n${STATE_EXCLUDE_RULE}\n`);
  assert.deepEqual(readFileSync(join(state, "changes/example.jsonl")), contents[0]);
  const ticketDir = join(repo, ".architect", "tickets");
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(join(ticketDir, "phase.md"), "# ticket\n");
  const wt = await createWorktree(repo, { kind: "open", sessionId: "phase", base: "HEAD" });
  const wtExclude = resolve(wt.cwd, git(wt.cwd, "rev-parse", "--git-path", "info/exclude"));
  assert.ok(readFileSync(wtExclude, "utf8").includes(STATE_EXCLUDE_RULE));
  assert.equal(wtExclude, exclude, "Git uses the effective common exclude for this linked worktree");
  const linkedState = join(wt.cwd, ".architect", "state", "jobs", "linked.json");
  mkdirSync(join(linkedState, ".."), { recursive: true });
  writeFileSync(linkedState, "linked preserved");
  assert.equal(git(wt.cwd, "check-ignore", ".architect/state/jobs/linked.json"), ".architect/state/jobs/linked.json");
  assert.ok(!git(wt.cwd, "ls-files", "--others", "--exclude-standard").includes("linked.json"));
  writeFileSync(wtExclude, "# reused\n");
  const reused = await createWorktree(repo, { kind: "open", sessionId: "phase", base: "HEAD" });
  assert.equal(reused.reused, true);
  assert.equal(readFileSync(wtExclude, "utf8"), `# reused\n${STATE_EXCLUDE_RULE}\n`);
  const linkedNested = join(wt.cwd, "nested");
  mkdirSync(linkedNested);
  writeFileSync(wtExclude, "# linked mcp\n");
  assert.match(git(wt.cwd, "ls-files", "--others", "--exclude-standard"), /linked.json/);
  // Even though update_ticket targets the main repo, exclusion is installed
  // for the cwd's linked worktree using Git's effective metadata path.
  await callTool("update_ticket", { cwd: linkedNested, sessionId: "fixture", content: "# Ticket\n" });
  assert.equal(readFileSync(wtExclude, "utf8"), `# linked mcp\n${STATE_EXCLUDE_RULE}\n`);
  assert.ok(!git(wt.cwd, "ls-files", "--others", "--exclude-standard").includes("linked.json"));
  assert.equal(readFileSync(linkedState, "utf8"), "linked preserved");
  assert.equal(registerStateExclude(repo, state).status, "present");
  writeFileSync(exclude, "# default before\n/.architect/state/\n# after\n");
  assert.equal(registerStateExclude(repo, state).status, "present");
  assert.equal(readFileSync(exclude, "utf8"), "# default before\n/.architect/state/\n# after\n");
  writeFileSync(exclude, "# custom state\n");
  createWorkflow({ root: repo, sessionKey: "external", env: { QQ_WORKFLOW_STATE_DIR: join(base, "external") } });
  assert.equal(readFileSync(exclude, "utf8"), "# custom state\n");
  process.env.QQ_WORKFLOW_STATE_DIR = join(base, "external");
  try {
    await callTool("update_ticket", { cwd: nested, sessionId: "fixture", content: "# Ticket\n" });
    assert.equal(readFileSync(exclude, "utf8"), "# custom state\n", "nested MCP custom state must not register");
  } finally { delete process.env.QQ_WORKFLOW_STATE_DIR; }
  writeFileSync(exclude, "# concurrent\n");
  const moduleUrl = new URL("../workflow/state-exclude.mjs", import.meta.url).href;
  const run = () => new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {registerStateExclude} from ${JSON.stringify(moduleUrl)}; const result=registerStateExclude(${JSON.stringify(repo)},${JSON.stringify(state)}); if(result.status === 'warning') process.exit(1);`], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? done() : reject(new Error(`registration exited ${code}`)));
  });
  await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(readFileSync(exclude, "utf8"), `# concurrent\n${STATE_EXCLUDE_RULE}\n`);
  assert.equal(registerStateExclude(repo, join(base, "external")).status, "skipped");
  assert.equal(registerStateExclude(base, join(base, ".architect", "state")).status, "skipped");
  assert.equal(registerStateExclude(join(repo, ".architect"), join(repo, ".architect", ".architect", "state")).status, "skipped");
  const lock = `${exclude}.qq-workflows.lock`;
  writeFileSync(exclude, "# lock\n");
  mkdirSync(lock);
  const warnings = [];
  assert.equal(registerStateExclude(repo, state, { warn: text => warnings.push(text) }).status, "warning");
  assert.equal(warnings.length, 1);
  assert.equal(readFileSync(exclude, "utf8"), "# lock\n");
  rmSync(lock, { recursive: true });
  rmSync(exclude);
  if (process.getuid?.() !== 0) {
    const metadata = join(exclude, "..");
    chmodSync(metadata, 0o555);
    try {
      assert.equal(registerStateExclude(repo, state, { warn: text => warnings.push(text) }).status, "warning", "read-only metadata is nonfatal");
    } finally { chmodSync(metadata, 0o755); }
  }
  mkdirSync(exclude);
  assert.equal(registerStateExclude(repo, state, { warn: text => warnings.push(text) }).status, "warning", "unwritable metadata shape does not fail workflow");
  rmSync(exclude, { recursive: true });
  assert.equal(registerStateExclude(repo, state).status, "registered");
  assert.equal(readFileSync(exclude, "utf8"), `${STATE_EXCLUDE_RULE}\n`);
  // The old landing helper stages the unignored ticket despite ignored state.
  writeFileSync(join(repo, ".architect", "ticket.md"), "# worktree ticket\n");
  const stage = spawnSync("git", ["add", "-A", "--", ":(literal).architect/ticket.md"], { cwd: repo, encoding: "utf8" });
  assert.equal(stage.status, 0, stage.stderr);
  assert.equal(git(repo, "ls-files", "--cached", ".architect/ticket.md"), ".architect/ticket.md");
  assert.equal(git(repo, "check-ignore", ".architect/state/changes/example.jsonl"), ".architect/state/changes/example.jsonl");
  const external = join(base, "elsewhere");
  mkdirSync(external);
  const symlinkRepo = join(base, "symlink-repo");
  mkdirSync(symlinkRepo);
  git(symlinkRepo, "init", "-q");
  symlinkSync(external, join(symlinkRepo, ".architect"));
  assert.equal(registerStateExclude(symlinkRepo, join(symlinkRepo, ".architect", "state")).status, "skipped");
  // Each direct createWorktree route starts with its own untouched effective
  // exclude: a previous default registration must not mask a custom-state bug.
  for (const config of ["default", "external", "in-repo", "relative"]) {
    for (const route of ["new", "reused"]) {
      const fixture = join(base, `direct-${config}-${route}`);
      mkdirSync(fixture);
      git(fixture, "init", "-q", "-b", "main");
      git(fixture, "config", "user.email", "test@example.test");
      git(fixture, "config", "user.name", "Test");
      writeFileSync(join(fixture, "committed.txt"), "base\n");
      git(fixture, "add", "committed.txt");
      git(fixture, "commit", "-qm", "base");
      const ticketDir = join(fixture, ".architect", "tickets");
      mkdirSync(ticketDir, { recursive: true });
      writeFileSync(join(ticketDir, "direct.md"), "# direct ticket\n");
      writeFileSync(join(fixture, "source.txt"), "source\n");
      const ledger = join(fixture, ".architect", "state", "changes", "example.jsonl");
      mkdirSync(join(ledger, ".."), { recursive: true });
      writeFileSync(ledger, '{"retained":true}\n');
      const ledgerBytes = readFileSync(ledger);
      const branch = `architect/open/direct-${config}-${route}`;
      const dest = worktreePathFor(fixture, branch);
      if (route === "reused") {
        // Create the linked checkout before exclude registration so this route
        // still tests an untouched effective exclude. Record its creation base:
        // production reuse must not infer provenance from the current HEAD.
        const creationBase = git(fixture, "rev-parse", "HEAD");
        git(fixture, "worktree", "add", "-q", "-b", branch, dest, creationBase);
        git(fixture, "update-ref", `refs/qq-workflow/bases/${branch}`, creationBase);
      }
      const gitCwd = route === "new" ? fixture : dest;
      const exclude = resolve(gitCwd, git(gitCwd, "rev-parse", "--git-path", "info/exclude"));
      // Also cover an absent exclude file (Git init normally creates one).
      if (config === "external") rmSync(exclude, { force: true });
      const before = config === "external" ? null : readFileSync(exclude);
      assert.ok(!before?.toString().includes(STATE_EXCLUDE_RULE));
      const chosen = config === "default" ? undefined
        : config === "external" ? join(base, `external-state-${route}`)
        : config === "in-repo" ? join(fixture, "custom-state")
        : relative(process.cwd(), join(fixture, "relative-state"));
      const prior = process.env.QQ_WORKFLOW_STATE_DIR;
      try {
        if (chosen === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
        else process.env.QQ_WORKFLOW_STATE_DIR = chosen;
        if (config === "relative") assert.equal(stateDirFor(dest), chosen, "relative override is returned verbatim");
        const result = await createWorktree(fixture, { kind: "open", sessionId: "direct", branch, base: "HEAD" });
        assert.equal(result.reused, route === "reused");
        assert.equal(result.cwd, dest);
        const linkedExclude = resolve(result.cwd, git(result.cwd, "rev-parse", "--git-path", "info/exclude"));
        assert.equal(linkedExclude, exclude, "Git resolves linked effective metadata in the common repository");
        const linkedLedger = join(result.cwd, ".architect", "state", "changes", "example.jsonl");
        mkdirSync(join(linkedLedger, ".."), { recursive: true });
        writeFileSync(linkedLedger, ledgerBytes);
        writeFileSync(join(result.cwd, "source.txt"), "source\n");
        const inMain = git(fixture, "ls-files", "--others", "--exclude-standard");
        const inLinked = git(result.cwd, "ls-files", "--others", "--exclude-standard");
        if (config === "default") {
          const expected = Buffer.concat([before, Buffer.from(`${before.length && before[before.length - 1] !== 10 ? "\n" : ""}${STATE_EXCLUDE_RULE}\n`)]);
          assert.deepEqual(readFileSync(exclude), expected, `${route} appends only the narrow rule`);
          assert.ok(!inMain.includes("changes/example.jsonl"));
          assert.ok(!inLinked.includes("changes/example.jsonl"));
        } else {
          if (before === null) assert.equal(existsSync(exclude), false, "absent exclude stays absent");
          else assert.deepEqual(readFileSync(exclude), before, `${config} ${route} must not alter exclude`);
          assert.match(inMain, /\.architect\/state\/changes\/example\.jsonl/);
          assert.match(inLinked, /\.architect\/state\/changes\/example\.jsonl/);
        }
        assert.match(inMain, /source\.txt/);
        assert.match(inMain, /\.architect\/tickets\/direct\.md/);
        assert.match(inLinked, /source\.txt/);
        assert.match(inLinked, /\.architect\/ticket\.md/);
        assert.deepEqual(readFileSync(ledger), ledgerBytes);
        assert.deepEqual(readFileSync(linkedLedger), ledgerBytes);
      } finally {
        if (prior === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
        else process.env.QQ_WORKFLOW_STATE_DIR = prior;
      }
    }
  }
  console.log("state exclusion integration ok");
} finally {
  if (oldOverride === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
  else process.env.QQ_WORKFLOW_STATE_DIR = oldOverride;
  if (oldWorktrees === undefined) delete process.env.ARCHITECT_WORKTREES_DIR;
  else process.env.ARCHITECT_WORKTREES_DIR = oldWorktrees;
  rmSync(base, { recursive: true, force: true });
}
