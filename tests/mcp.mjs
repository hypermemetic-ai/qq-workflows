#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import {
  PROVIDERS,
  SEAT_PROVIDERS,
  TOOLS,
  buildImplementerStep,
  buildResearcherStep,
  buildReviewerStep,
  callTool,
  handleRpc,
  land,
  prepareWorktree,
  resolveProvider,
  resolveSeatProvider,
  resolveSessionId,
  startMcpServer,
} from "../bin/mcp-server.mjs";
import { git } from "../workflow/git.mjs";

const exec = promisify(execFile);

async function retireTestWorktree(repo, result) {
  try {
    await git(repo, ["worktree", "remove", "--force", result.worktree]);
  } catch {}
  try {
    await git(repo, ["branch", "-D", result.branch]);
  } catch {}
}

// 1. Tool schema checks
assert.equal(TOOLS.length, 2);
const toolNames = TOOLS.map((t) => t.name).sort();
assert.deepEqual(toolNames, ["land", "prepare_worktree"]);

const prepareTool = TOOLS.find((t) => t.name === "prepare_worktree");
assert.ok(prepareTool);
assert.deepEqual(prepareTool.inputSchema.required, ["kind"]);
assert.deepEqual(prepareTool.inputSchema.properties.kind.enum, ["bounded", "open", "research"]);
assert.deepEqual(prepareTool.inputSchema.properties.provider.enum, ["muse", "gemini", "deepseek"]);
assert.deepEqual(prepareTool.inputSchema.properties.implementerProvider.enum, ["muse", "gemini", "deepseek"]);
assert.deepEqual(prepareTool.inputSchema.properties.reviewerProvider.enum, ["muse", "gemini", "deepseek"]);
assert.deepEqual(prepareTool.inputSchema.properties.researcherProvider.enum, ["muse", "gemini", "deepseek"]);
assert.equal(prepareTool.inputSchema.properties.engine, undefined);

// 1b. Provider support table checks
assert.deepEqual(PROVIDERS, ["muse", "gemini", "deepseek"]);
assert.deepEqual(SEAT_PROVIDERS.implementer, ["muse", "gemini", "deepseek"]);
assert.deepEqual(SEAT_PROVIDERS.reviewer, ["muse", "gemini"]);
assert.deepEqual(SEAT_PROVIDERS.researcher, ["muse", "gemini"]);
assert.deepEqual(SEAT_PROVIDERS.architect, ["muse", "gemini"]);

// 1c. Per-seat command template checks (every supported seat x provider).
// Ownership lines ride inside the child prompt so every child sees them.
const IMPLEMENTER_OWNERSHIP = "Leave changes uncommitted. Do not commit, push, review, or land.";
const REVIEWER_OWNERSHIP = "Do not commit, push, or land.";
const RESEARCHER_OWNERSHIP = "Leave files uncommitted. Do not commit, push, or land.";
assert.equal(
  buildImplementerStep("/wt", "P", "muse", "uuid-1"),
  `Delegate via run_command (with Cwd: /wt): 'muse exec --preset implementer --yolo "P ${IMPLEMENTER_OWNERSHIP}"'`,
);
assert.equal(
  buildImplementerStep("/wt", "P", "gemini", "uuid-1"),
  `Delegate via run_command (with Cwd: /wt) using a fresh conversation: 'agy --agent implementer --conversation uuid-1 --print-timeout 60m --print "P ${IMPLEMENTER_OWNERSHIP}"'\nDo NOT pass '--new-project'.`,
);
assert.equal(
  buildImplementerStep("/wt", "P", "deepseek", "uuid-1"),
  `Delegate via run_command (with Cwd: /wt): 'dsh --profile implementer "P ${IMPLEMENTER_OWNERSHIP}"'`,
);
assert.equal(
  buildReviewerStep("/wt", "P", "muse", "uuid-2"),
  `invoke reviewer via run_command (with Cwd: /wt): 'muse exec --preset reviewer --yolo "P ${REVIEWER_OWNERSHIP}"'`,
);
assert.equal(
  buildReviewerStep("/wt", "P", "gemini", "uuid-2"),
  `invoke reviewer via run_command (with Cwd: /wt) using a fresh conversation: 'agy --agent reviewer --conversation uuid-2 --print-timeout 60m --print "P ${REVIEWER_OWNERSHIP}"'\nDo NOT pass '--new-project'.`,
);
assert.equal(
  buildResearcherStep("/wt", "P", "muse"),
  `Delegate via run_command (with Cwd: /wt): 'muse exec --preset researcher --yolo "P ${RESEARCHER_OWNERSHIP}"'`,
);
assert.equal(
  buildResearcherStep("/wt", "P", "gemini"),
  `Invoke research subagent with ticket path /wt/.architect/ticket.md and worktree cwd via run_command (with Cwd: /wt) using Prompt: "P ${RESEARCHER_OWNERSHIP}"`,
);
// Every template carries its seat's ownership line.
for (const provider of ["muse", "gemini", "deepseek"]) {
  assert.ok(buildImplementerStep("/wt", "Do it", provider, "uuid-1").includes(IMPLEMENTER_OWNERSHIP));
}
for (const provider of ["muse", "gemini"]) {
  assert.ok(buildReviewerStep("/wt", "Check it", provider, "uuid-2").includes(REVIEWER_OWNERSHIP));
  assert.ok(buildResearcherStep("/wt", "Study it", provider).includes(RESEARCHER_OWNERSHIP));
}

// 1d. Provider precedence checks (seat arg > seat env > global arg > global env > 'muse')
assert.equal(resolveSeatProvider("implementer", {}, {}), "muse");
assert.equal(resolveSeatProvider("reviewer", {}, {}), "muse");
assert.equal(resolveSeatProvider("researcher", {}, {}), "muse");
assert.equal(resolveSeatProvider("implementer", {}, { QQ_WORKFLOW_PROVIDER: "gemini" }), "gemini");
assert.equal(
  resolveSeatProvider("implementer", { provider: "deepseek" }, { QQ_WORKFLOW_PROVIDER: "gemini" }),
  "deepseek",
);
assert.equal(
  resolveSeatProvider("implementer", {}, { QQ_WORKFLOW_PROVIDER: "gemini", QQ_IMPLEMENTER_PROVIDER: "deepseek" }),
  "deepseek",
);
assert.equal(
  resolveSeatProvider(
    "implementer",
    { provider: "gemini", implementerProvider: "muse" },
    { QQ_WORKFLOW_PROVIDER: "deepseek", QQ_IMPLEMENTER_PROVIDER: "deepseek" },
  ),
  "muse",
);
assert.equal(
  resolveSeatProvider("reviewer", { provider: "deepseek", reviewerProvider: "muse" }, {}),
  "muse",
);
assert.equal(resolveProvider("architect", {}), "muse");
assert.equal(resolveProvider("architect", { seatEnv: "gemini" }), "gemini");

// 1e. Provider error checks
assert.throws(
  () => resolveSeatProvider("implementer", { provider: "foo" }, {}),
  /^Error: unknown provider 'foo': expected 'muse' \| 'gemini' \| 'deepseek'$/,
);
assert.throws(
  () => resolveSeatProvider("implementer", { implementerProvider: "agy" }, {}),
  /^Error: unknown provider 'agy': expected 'muse' \| 'gemini' \| 'deepseek'$/,
);
assert.throws(
  () => resolveSeatProvider("implementer", {}, { QQ_WORKFLOW_PROVIDER: "dsh" }),
  /^Error: unknown provider 'dsh': expected 'muse' \| 'gemini' \| 'deepseek'$/,
);
assert.throws(
  () => resolveSeatProvider("reviewer", { provider: "deepseek" }, {}),
  /^Error: provider 'deepseek' does not support seat 'reviewer'$/,
);
assert.throws(
  () => resolveSeatProvider("researcher", { researcherProvider: "deepseek" }, {}),
  /^Error: provider 'deepseek' does not support seat 'researcher'$/,
);
assert.throws(
  () => resolveProvider("architect", { arg: "deepseek" }),
  /^Error: provider 'deepseek' does not support seat 'architect'$/,
);

const landTool = TOOLS.find((t) => t.name === "land");
assert.ok(landTool);

// 2. Validation failures
await assert.rejects(
  () => prepareWorktree({}),
  /kind is required: 'bounded' \| 'open' \| 'research'/,
  "Must fail without kind",
);
await assert.rejects(
  () => prepareWorktree({ kind: "invalid" }),
  /kind is required: 'bounded' \| 'open' \| 'research'/,
  "Must fail with invalid kind",
);

// 3. Functional test in a temporary repository
const repoDir = mkdtempSync(join(tmpdir(), "architect-mcp-repo-"));
// Provider env vars must not leak into default-resolution assertions.
const savedProviderEnv = {};
for (const key of ["QQ_WORKFLOW_PROVIDER", "QQ_IMPLEMENTER_PROVIDER", "QQ_REVIEWER_PROVIDER", "QQ_RESEARCHER_PROVIDER"]) {
  savedProviderEnv[key] = process.env[key];
  delete process.env[key];
}
try {
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "MCP Test"]);
  await git(repoDir, ["config", "user.email", "mcp@example.invalid"]);

  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "init repo"]);

  // Create a session ticket in .architect/tickets/<sessionId>.md
  const sessionId = "12345678-abcd-ef01-2345-6789abcdef01";
  const ticketsDir = join(repoDir, ".architect", "tickets");
  mkdirSync(ticketsDir, { recursive: true });
  writeFileSync(join(ticketsDir, `${sessionId}.md`), "# Test Session Ticket\n\n## Kind\nbounded\n");

  // Verify resolveSessionId picks up the active ticket
  const resolved = await resolveSessionId(repoDir);
  assert.equal(resolved, sessionId);

  // 4. prepare_worktree with kind = bounded
  const boundedResult = await prepareWorktree({
    kind: "bounded",
    sessionId,
    cwd: repoDir,
  });

  assert.equal(boundedResult.ok, true);
  assert.equal(boundedResult.kind, "bounded");
  assert.equal(boundedResult.branch, "architect/bounded/12345678");
  assert.equal(boundedResult.reviewRequired, false);
  assert.equal(boundedResult.implementerProvider, "muse");
  assert.ok(boundedResult.instructions.includes("muse exec --preset implementer --yolo"));
  assert.ok(boundedResult.instructions.includes(IMPLEMENTER_OWNERSHIP));
  assert.ok(boundedResult.instructions.includes("call 'land'"));
  assert.ok(boundedResult.instructions.includes(`Cwd: ${boundedResult.worktree}`));
  assert.ok(boundedResult.instructions.includes("run_command"));
  assert.equal(boundedResult.implementerPrompt, "Implement .architect/ticket.md in the checkout. When finished, report your answer.");
  assert.equal(boundedResult.reviewerPrompt, undefined);

  // Verify ticket was copied into the worktree as .architect/ticket.md
  const wtTicket = join(boundedResult.worktree, ".architect", "ticket.md");
  assert.equal(readFileSync(wtTicket, "utf8"), "# Test Session Ticket\n\n## Kind\nbounded\n");

  // 4b. Verify runtime guards reject execution from within a delegated worktree
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "bounded",
        cwd: boundedResult.worktree,
      }),
    /prepare_worktree cannot be called from within a delegated worktree/,
    "prepareWorktree must reject execution when called from within a delegated worktree",
  );

  await assert.rejects(
    () =>
      land({
        cwd: boundedResult.worktree,
      }),
    /land must be called from the parent architect session/,
    "land must reject execution when called from within a delegated worktree without explicit worktree target",
  );

  // Verify runtime guards reject execution on architect/ branch outside .qq-worktrees
  const branchRepo = mkdtempSync(join(tmpdir(), "architect-guard-test-"));
  try {
    await git(branchRepo, ["init", "-b", "architect/subagent-branch"]);
    await git(branchRepo, ["config", "user.name", "MCP Test"]);
    await git(branchRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(branchRepo, "README.md"), "# Branch Test Repo\n");
    await git(branchRepo, ["add", "README.md"]);
    await git(branchRepo, ["commit", "-m", "init"]);

    await assert.rejects(
      () =>
        prepareWorktree({
          kind: "bounded",
          cwd: branchRepo,
        }),
      /prepare_worktree cannot be called from within a delegated worktree/,
      "prepareWorktree must reject execution on an architect/ branch",
    );

    await assert.rejects(
      () =>
        land({
          cwd: branchRepo,
        }),
      /land must be called from the parent architect session/,
      "land must reject execution on an architect/ branch without explicit worktree target",
    );
  } finally {
    rmSync(branchRepo, { recursive: true, force: true });
  }

  // 5. prepare_worktree with kind = open
  const openSessionId = "87654321-fedc-ba98-7654-3210fedcba98";
  writeFileSync(join(ticketsDir, `${openSessionId}.md`), "# Open Session Ticket\n\n## Kind\nopen\n");

  const openResult = await prepareWorktree({
    kind: "open",
    sessionId: openSessionId,
    cwd: repoDir,
  });

  assert.equal(openResult.ok, true);
  assert.equal(openResult.kind, "open");
  assert.equal(openResult.branch, "architect/open/87654321");
  assert.equal(openResult.reviewRequired, true);
  assert.equal(openResult.implementerProvider, "muse");
  assert.equal(openResult.reviewerProvider, "muse");
  assert.ok(openResult.instructions.includes("muse exec --preset implementer --yolo"));
  assert.ok(openResult.instructions.includes(openResult.implementerPrompt));
  assert.ok(openResult.instructions.includes(IMPLEMENTER_OWNERSHIP));
  assert.ok(openResult.instructions.includes("muse exec --preset reviewer --yolo"));
  assert.ok(openResult.instructions.includes(openResult.reviewerPrompt));
  assert.ok(openResult.instructions.includes(REVIEWER_OWNERSHIP));
  assert.ok(openResult.instructions.includes(`Cwd: ${openResult.worktree}`));
  assert.ok(openResult.instructions.includes("run_command"));
  assert.equal(openResult.implementerPrompt, "Implement .architect/ticket.md in the checkout. When finished, report your answer.");
  assert.equal(
    openResult.reviewerPrompt,
    "Follow .architect/ticket.md in the checkout. Follow its testing plan. Do not change project code. Report findings. Empty findings means it passed.",
  );

  // 5b. Verify prepare_worktree with provider: "gemini" outputs agy commands
  const geminiSessionId = "11223344-5566-7788-99aa-bbccddeeff00";
  writeFileSync(join(ticketsDir, `${geminiSessionId}.md`), "# Gemini Session Ticket\n\n## Kind\nopen\n");
  const geminiResult = await prepareWorktree({
    kind: "open",
    sessionId: geminiSessionId,
    cwd: repoDir,
    provider: "gemini",
  });
  assert.equal(geminiResult.ok, true);
  assert.equal(geminiResult.implementerProvider, "gemini");
  assert.equal(geminiResult.reviewerProvider, "gemini");
  assert.ok(geminiResult.instructions.includes("agy --agent implementer"));
  assert.match(geminiResult.instructions, /--conversation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.ok(geminiResult.instructions.includes("Do NOT pass '--new-project'"));
  assert.ok(geminiResult.instructions.includes("agy --agent reviewer"));
  await retireTestWorktree(repoDir, geminiResult);

  // 5c. Mixed seats: gemini implementer with default muse reviewer
  const mixedSessionId = "22334455-6677-8899-aabb-ccddeeff0011";
  writeFileSync(join(ticketsDir, `${mixedSessionId}.md`), "# Mixed Session Ticket\n\n## Kind\nopen\n");
  const mixedResult = await prepareWorktree({
    kind: "open",
    sessionId: mixedSessionId,
    cwd: repoDir,
    implementerProvider: "gemini",
  });
  assert.equal(mixedResult.ok, true);
  assert.equal(mixedResult.implementerProvider, "gemini");
  assert.equal(mixedResult.reviewerProvider, "muse");
  assert.ok(mixedResult.instructions.includes("agy --agent implementer"));
  assert.ok(mixedResult.instructions.includes("muse exec --preset reviewer --yolo"));
  await retireTestWorktree(repoDir, mixedResult);

  // 5d. Global deepseek works for bounded (implementer-only delegation)
  const dsSessionId = "33445566-7788-99aa-bbcc-ddeeff001122";
  writeFileSync(join(ticketsDir, `${dsSessionId}.md`), "# DeepSeek Session Ticket\n\n## Kind\nbounded\n");
  const dsResult = await prepareWorktree({
    kind: "bounded",
    sessionId: dsSessionId,
    cwd: repoDir,
    provider: "deepseek",
  });
  assert.equal(dsResult.ok, true);
  assert.equal(dsResult.implementerProvider, "deepseek");
  assert.ok(dsResult.instructions.includes('dsh --profile implementer "'));
  await retireTestWorktree(repoDir, dsResult);

  // 5e. Per-seat deepseek implementer on an open ticket with muse reviewer
  const dsOpenSessionId = "44556677-8899-aabb-ccdd-eeff00112233";
  writeFileSync(join(ticketsDir, `${dsOpenSessionId}.md`), "# DeepSeek Open Ticket\n\n## Kind\nopen\n");
  const dsOpenResult = await prepareWorktree({
    kind: "open",
    sessionId: dsOpenSessionId,
    cwd: repoDir,
    implementerProvider: "deepseek",
  });
  assert.equal(dsOpenResult.ok, true);
  assert.equal(dsOpenResult.implementerProvider, "deepseek");
  assert.equal(dsOpenResult.reviewerProvider, "muse");
  assert.ok(dsOpenResult.instructions.includes('dsh --profile implementer "'));
  assert.ok(dsOpenResult.instructions.includes("muse exec --preset reviewer --yolo"));
  await retireTestWorktree(repoDir, dsOpenResult);

  // 5f. Global deepseek on an open ticket throws for the reviewer seat
  // (no silent fallback) and leaves no worktree or branch behind.
  const dsFailSessionId = "55667788-99aa-bbcc-ddee-ff0011223344";
  writeFileSync(join(ticketsDir, `${dsFailSessionId}.md`), "# DeepSeek Fail Ticket\n\n## Kind\nopen\n");
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "open",
        sessionId: dsFailSessionId,
        cwd: repoDir,
        provider: "deepseek",
      }),
    /^Error: provider 'deepseek' does not support seat 'reviewer'$/,
  );
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/open/55667788"]));

  // 5g. Explicit deepseek reviewer throws even with a valid global provider.
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "open",
        sessionId: "66778899-aabb-ccdd-eeff-001122334455",
        cwd: repoDir,
        provider: "muse",
        reviewerProvider: "deepseek",
      }),
    /^Error: provider 'deepseek' does not support seat 'reviewer'$/,
  );
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/open/66778899"]));

  // 5h. Unknown provider strings throw.
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "bounded",
        sessionId: "778899aa-bbcc-ddee-ff00-112233445566",
        cwd: repoDir,
        provider: "foo",
      }),
    /^Error: unknown provider 'foo': expected 'muse' \| 'gemini' \| 'deepseek'$/,
  );
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "bounded",
        sessionId: "889900aa-bbcc-ddee-ff00-112233445566",
        cwd: repoDir,
        implementerProvider: "agy",
      }),
    /^Error: unknown provider 'agy': expected 'muse' \| 'gemini' \| 'deepseek'$/,
  );

  // 5i. Env precedence end to end: seat env beats global env, seat arg beats all.
  const envSessionId = "9900aabb-ccdd-eeff-0011-223344556677";
  writeFileSync(join(ticketsDir, `${envSessionId}.md`), "# Env Session Ticket\n\n## Kind\nbounded\n");
  process.env.QQ_WORKFLOW_PROVIDER = "gemini";
  process.env.QQ_IMPLEMENTER_PROVIDER = "deepseek";
  try {
    const envResult = await prepareWorktree({
      kind: "bounded",
      sessionId: envSessionId,
      cwd: repoDir,
    });
    assert.equal(envResult.implementerProvider, "deepseek");
    assert.ok(envResult.instructions.includes('dsh --profile implementer "'));
    await retireTestWorktree(repoDir, envResult);

    const argWinsSessionId = "aa00bbcc-ddee-ff00-1122-334455667788";
    writeFileSync(join(ticketsDir, `${argWinsSessionId}.md`), "# Arg Wins Ticket\n\n## Kind\nbounded\n");
    const argWinsResult = await prepareWorktree({
      kind: "bounded",
      sessionId: argWinsSessionId,
      cwd: repoDir,
      implementerProvider: "muse",
    });
    assert.equal(argWinsResult.implementerProvider, "muse");
    assert.ok(argWinsResult.instructions.includes("muse exec --preset implementer --yolo"));
    await retireTestWorktree(repoDir, argWinsResult);
  } finally {
    delete process.env.QQ_WORKFLOW_PROVIDER;
    delete process.env.QQ_IMPLEMENTER_PROVIDER;
  }

  // 6. Test landing worktree
  // Make changes in bounded worktree
  writeFileSync(join(boundedResult.worktree, "code.txt"), "console.log('hello');\n");

  const landResult = await land({
    worktree: boundedResult.worktree,
    cwd: repoDir,
    message: "feat: implemented feature",
  });

  assert.equal(landResult.ok, true);
  assert.equal(landResult.landed, true);
  assert.equal(landResult.branch, "architect/bounded/12345678");
  assert.equal(landResult.method, "ff");

  // Verify file landed in main
  assert.equal(readFileSync(join(repoDir, "code.txt"), "utf8"), "console.log('hello');\n");

  // 6b. prepare_worktree with kind = research and test landing with changes
  const researchSessionId = "abcdef99-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${researchSessionId}.md`), "# Research Session Ticket\n\n## Kind\nresearch\n");

  const researchResult = await prepareWorktree({
    kind: "research",
    sessionId: researchSessionId,
    cwd: repoDir,
  });

  assert.equal(researchResult.ok, true);
  assert.equal(researchResult.kind, "research");
  assert.equal(researchResult.branch, "architect/research/abcdef99");
  assert.equal(researchResult.reviewRequired, false);
  assert.equal(researchResult.researcherProvider, "muse");
  assert.equal(researchResult.researcherPrompt, "Investigate .architect/ticket.md in the checkout. Report findings.");
  assert.equal(researchResult.implementerPrompt, undefined);
  assert.equal(researchResult.reviewerPrompt, undefined);
  assert.ok(researchResult.instructions.includes(`Cwd: ${researchResult.worktree}`));
  assert.ok(researchResult.instructions.includes("run_command"));
  assert.ok(researchResult.instructions.includes("muse exec --preset researcher --yolo"));
  assert.ok(researchResult.instructions.includes(RESEARCHER_OWNERSHIP));
  assert.equal(
    researchResult.instructions,
    `Worktree ready at ${researchResult.worktree}.\nBranch: ${researchResult.branch}\nReview required: false\n\nNext steps:\n1. Delegate via run_command (with Cwd: ${researchResult.worktree}): 'muse exec --preset researcher --yolo "Investigate .architect/ticket.md in the checkout. Report findings. ${RESEARCHER_OWNERSHIP}"'\n2. When finished, call 'land'.`,
  );
  assert.equal(
    readFileSync(join(researchResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Research Session Ticket\n\n## Kind\nresearch\n",
  );

  // 6b-ii. Gemini researcher uses the built-in research subagent text.
  const gemResSessionId = "bb11cc22-ddee-ff00-1122-334455667788";
  writeFileSync(join(ticketsDir, `${gemResSessionId}.md`), "# Gemini Research Ticket\n\n## Kind\nresearch\n");
  const gemResResult = await prepareWorktree({
    kind: "research",
    sessionId: gemResSessionId,
    cwd: repoDir,
    researcherProvider: "gemini",
  });
  assert.equal(gemResResult.ok, true);
  assert.equal(gemResResult.researcherProvider, "gemini");
  assert.ok(gemResResult.instructions.includes("Invoke research subagent with ticket path"));
  assert.ok(gemResResult.instructions.includes(`using Prompt: "${gemResResult.researcherPrompt} ${RESEARCHER_OWNERSHIP}"`));
  await retireTestWorktree(repoDir, gemResResult);

  // 6b-iii. DeepSeek does not serve the researcher seat.
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "research",
        sessionId: "cc22dd33-eeff-0011-2233-445566778899",
        cwd: repoDir,
        provider: "deepseek",
      }),
    /^Error: provider 'deepseek' does not support seat 'researcher'$/,
  );

  writeFileSync(join(researchResult.worktree, "findings.md"), "# Research Findings\n");
  const landResearchResult = await land({
    worktree: researchResult.worktree,
    cwd: repoDir,
    message: "docs: research findings",
  });
  assert.equal(landResearchResult.ok, true);
  assert.equal(landResearchResult.landed, true);
  assert.equal(landResearchResult.branch, "architect/research/abcdef99");
  assert.equal(landResearchResult.method, "ff");
  assert.equal(readFileSync(join(repoDir, "findings.md"), "utf8"), "# Research Findings\n");

  // 6c. Test landing read-only research worktree with no diff/commits against base
  const roSessionId = "ro998877-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${roSessionId}.md`), "# Read-Only Research Ticket\n\n## Kind\nresearch\n");
  const roResult = await prepareWorktree({
    kind: "research",
    sessionId: roSessionId,
    cwd: repoDir,
  });
  assert.equal(roResult.ok, true);
  assert.equal(roResult.branch, "architect/research/ro998877");
  const landRoResult = await land({
    worktree: roResult.worktree,
    cwd: repoDir,
  });
  assert.equal(landRoResult.ok, true);
  assert.equal(landRoResult.landed, true);
  assert.equal(landRoResult.retired, true);
  assert.equal(landRoResult.branch, "architect/research/ro998877");
  assert.equal(landRoResult.method, "none");
  assert.equal(landRoResult.pr, null);
  const wtListAfterRo = await git(repoDir, ["worktree", "list"]);
  assert.ok(!wtListAfterRo.includes("architect/research/ro998877"));
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/research/ro998877"]));

  // 7. Test ticket resolution in prepare_worktree: exact, prefix, then fail
  // fast with no stray worktree or branch. There are no brain or root
  // fallbacks anymore.
  // A. Unknown session id throws even when a root .architect/ticket.md exists.
  const rootArchitectDir = join(repoDir, ".architect");
  writeFileSync(join(rootArchitectDir, "ticket.md"), "# Root Ticket (not a fallback)\n\n## Kind\nbounded\n");
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "bounded",
        sessionId: "missing-session-0001",
        cwd: repoDir,
      }),
    /^Error: no ticket resolved for session 'missing-session-0001'$/,
  );
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/bounded/missings"]));
  const wtListAfterMissing = await git(repoDir, ["worktree", "list"]);
  assert.ok(!wtListAfterMissing.includes("architect/bounded/missings"));

  // B. Prefix ids still resolve: a short id finds the full session file.
  const prefixSessionId = "prefixaa11-2233-4455-6677-889900aabbcc";
  writeFileSync(join(ticketsDir, `${prefixSessionId}.md`), "# Prefix Ticket\n\n## Kind\nbounded\n");
  const prefixResult = await prepareWorktree({
    kind: "bounded",
    sessionId: "prefixaa11",
    cwd: repoDir,
  });
  assert.equal(prefixResult.ok, true);
  assert.equal(prefixResult.branch, "architect/bounded/prefixaa");
  assert.equal(
    readFileSync(join(prefixResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Prefix Ticket\n\n## Kind\nbounded\n",
  );
  await retireTestWorktree(repoDir, prefixResult);

  // C. No explicit id and no tickets on disk throws the no-active-ticket
  // error before anything is created.
  const emptyRepo = mkdtempSync(join(tmpdir(), "architect-mcp-empty-"));
  try {
    await git(emptyRepo, ["init", "-b", "main"]);
    await git(emptyRepo, ["config", "user.name", "MCP Test"]);
    await git(emptyRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(emptyRepo, "README.md"), "# Empty\n");
    await git(emptyRepo, ["add", "README.md"]);
    await git(emptyRepo, ["commit", "-m", "init"]);
    await assert.rejects(
      () => resolveSessionId(emptyRepo),
      /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
    );
    await assert.rejects(
      () =>
        prepareWorktree({
          kind: "bounded",
          cwd: emptyRepo,
        }),
      /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
    );
    const emptyBranches = await git(emptyRepo, ["branch", "--list", "architect/*"]);
    assert.equal(emptyBranches.trim(), "");
    const emptyWtList = await git(emptyRepo, ["worktree", "list"]);
    assert.ok(!emptyWtList.includes("architect/"));
  } finally {
    rmSync(emptyRepo, { recursive: true, force: true });
  }

  // 8. Test RPC tools/call rejects removed ticket tools
  const rpcRead = await handleRpc("tools/call", {
    name: "ticket_read",
    arguments: { cwd: repoDir, sessionId },
  });
  assert.equal(rpcRead.isError, true);
  assert.match(rpcRead.content[0].text, /Unknown tool: ticket_read/);

  const rpcWrite = await handleRpc("tools/call", {
    name: "ticket_write",
    arguments: { cwd: repoDir, sessionId },
  });
  assert.equal(rpcWrite.isError, true);
  assert.match(rpcWrite.content[0].text, /Unknown tool: ticket_write/);

  await assert.rejects(
    () => callTool("ticket_read"),
    /Unknown tool: ticket_read/,
  );
  await assert.rejects(
    () => callTool("ticket_write"),
    /Unknown tool: ticket_write/,
  );

  // Clean up open worktree
  try {
    await git(repoDir, ["worktree", "remove", "--force", openResult.worktree]);
  } catch {}
  try {
    await git(repoDir, ["branch", "-D", openResult.branch]);
  } catch {}
} finally {
  for (const [key, value] of Object.entries(savedProviderEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    rmSync(join(dirname(repoDir), ".qq-worktrees", basename(repoDir)), { recursive: true, force: true });
  } catch {}
  rmSync(repoDir, { recursive: true, force: true });
}

// 9. RPC & JSON-RPC stdio protocol tests
const initResp = await handleRpc("initialize", {});
assert.equal(initResp.serverInfo.name, "qq-workflows");
assert.equal(initResp.serverInfo.version, "0.2.0");

const pingResp = await handleRpc("ping", {});
assert.deepEqual(pingResp, {});

const listResp = await handleRpc("tools/list", {});
assert.equal(listResp.tools.length, 2);

// tools/call with missing kind should return isError: true
const errCallResp = await handleRpc("tools/call", {
  name: "prepare_worktree",
  arguments: {},
});
assert.equal(errCallResp.isError, true);
assert.match(errCallResp.content[0].text, /kind is required: 'bounded' \| 'open' \| 'research'/);

// Test startMcpServer via stream piping
const stdinStream = new PassThrough();
const stdoutStream = new PassThrough();

const responses = [];
stdoutStream.on("data", (chunk) => {
  const lines = chunk.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    responses.push(JSON.parse(line));
  }
});

const rl = startMcpServer({ stdin: stdinStream, stdout: stdoutStream });

// Send initialize request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
// Send tools/list request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
// Send ping request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }) + "\n");
// Send unknown method request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nonexistent", params: {} }) + "\n");

await new Promise((resolve) => setTimeout(resolve, 100));

assert.equal(responses.length, 4);
assert.equal(responses[0].id, 1);
assert.equal(responses[0].result.serverInfo.name, "qq-workflows");

assert.equal(responses[1].id, 2);
assert.equal(responses[1].result.tools.length, 2);

assert.equal(responses[2].id, 3);
assert.deepEqual(responses[2].result, {});

assert.equal(responses[3].id, 4);
assert.equal(responses[3].error.code, -32601);

rl.close();
console.log("MCP server tests passed cleanly.");
