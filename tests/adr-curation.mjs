#!/usr/bin/env node
// Focused deterministic proof of the ADR source-evidence retention and
// recoverable curation-obligation seam. Real local temporary repositories and
// a deterministic fake `gh` seam exercise the ACTUAL landing call path
// (landWorktree + managed hook + the one authoritative change record); the
// record-level helpers are exercised exactly as the landing hook drives them.
// No paid inference, no worker launch, no notification transport anywhere.
//
// Covers: (a) PR and ff landing identities + owner/phase binding + exact
// source text/provenance + full report references; (b) no-op and
// failed/unknown landing produce no phantom curation; (c) deterministic
// duplicate callbacks/recovery idempotency; (d) failure/crash windows before
// capture, merge-before-obligation, archive-after-capture,
// retirement/report-finalization — preserved sole source and nonblocking
// successful landing; (e) unresolved updates stay unresolved attributed
// evidence; (f) wrong owner/phase, malformed refs, corrupted/missing durable
// artifacts fail honestly and caches cannot override authoritative status;
// (g) future trusted ADR-only suppression with no recursion while normal
// changes default capture ON; (h) legacy/manual compatibility and no new
// worker launch.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ADR_ROOTS,
  adrCurationView,
  adrSourcePath,
  completeAdrSourceRefs,
  createAdrCurationHook,
  activateCurationObligation,
  listCurationObligations,
  readAdrSourceManifest,
  recoverAdrCuration,
  resolveAdrSuppression,
  stageAdrSource,
  writeAdrSourceBlob,
  buildAdrSourceManifest,
} from "../workflow/adr-curation.mjs";
import { openChange } from "../workflow/change-record.mjs";
import {
  managedExecutionPipelineHooks,
  managedExecutionView,
  reconcileManagedExecution,
  readLaunchMetadata,
  recordHostStarted,
  recordManagedExecution,
  recordRoleOutcome,
  registerRoleAttempt,
} from "../workflow/execution-authority.mjs";
import { publishExecutionResult } from "../workflow/execution-host.mjs";
import { defaultCompletionText } from "../workflow/notify.mjs";
import { buildExecutionTerminalMessage } from "../bin/mcp-server.mjs";
import { createWorktree, landWorktree, revParse } from "../workflow/git.mjs";
import { createJob, readJob, writeJob } from "../workflow/jobs.mjs";
import { readReport, saveReport } from "../workflow/reports.mjs";

const exec = promisify(execFile);
const git = async (cwd, args) => (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
const pass = (message) => console.log(`PASS ${message}`);
const OWNER = "coordinator-adr-1";
const RUNTIME = { kind: "runtime", id: "test-runtime" };
const WORKER = { kind: "worker", id: "test-worker" };

function adrEvents(stateDir, executionId) {
  return openChange({ stateDir, changeId: executionId })
    .readEvents({ afterSeq: 0, limit: 10_000 })
    .events
    .filter((env) => env.kind.startsWith("adr."));
}

// ---------------------------------------------------------------------------
// Fixtures: real temporary git repositories with session tickets
// ---------------------------------------------------------------------------

async function mkRepo({ remote = false, phaseId, ticketText }) {
  const repo = mkdtempSync(join(tmpdir(), "adr-curation-repo-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "ADR Test"]);
  await git(repo, ["config", "user.email", "adr@example.invalid"]);
  writeFileSync(join(repo, "init.txt"), "init\n");
  await git(repo, ["add", "init.txt"]);
  await git(repo, ["commit", "-m", "init"]);
  mkdirSync(join(repo, ".architect", "tickets"), { recursive: true });
  writeFileSync(join(repo, ".architect", "tickets", `${phaseId}.md`), ticketText, "utf8");
  let bare = null;
  if (remote) {
    bare = mkdtempSync(join(tmpdir(), "adr-curation-remote-"));
    await git(bare, ["init", "--bare"]);
    await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "origin", "main:main"]);
  }
  return { repo, bare, stateDir: join(repo, ".state"), phaseId, ticketText };
}

// The managed change record exactly as recordManagedExecution builds it, plus
// two role seats with full durable reports and two committed updates: one
// acknowledged, one left UNRESOLVED (attributed source, never policy).
function seedManaged({ stateDir, executionId, root, phaseId, owner = OWNER, withUpdates = true }) {
  const requestPath = join(stateDir, "execution-hosts", executionId, "request.json");
  mkdirSync(dirname(requestPath), { recursive: true });
  writeFileSync(requestPath, "{}", "utf8");
  recordManagedExecution({
    stateDir,
    executionId,
    kind: "open",
    phaseId,
    root,
    owner,
    constraints: "Immutable phase constraints: ship the feature. Never touch config/.",
    launchId: `${executionId}-launch`,
    requestPath,
    now: 1,
  });
  const impl = registerRoleAttempt({
    stateDir, executionId, role: "implementer", jobId: `${executionId}-impl`, attemptId: `${executionId}-impl-a1`,
    prompt: "Implement the task.", cwd: root, owner, now: 2,
  });
  const reviewer = registerRoleAttempt({
    stateDir, executionId, role: "reviewer", jobId: `${executionId}-rev`, attemptId: `${executionId}-rev-a1`,
    prompt: "Review the work.", cwd: root, owner, now: 3,
  });
  const implReport = saveReport(stateDir, {
    jobId: impl.jobId,
    role: "implementer",
    text: `FULL-REPORT-MARKER implementer findings\n${"x".repeat(30_000)}\nfull text, never summarized`,
  });
  const revReport = saveReport(stateDir, {
    jobId: reviewer.jobId,
    role: "reviewer",
    text: "FULL-REPORT-MARKER reviewer findings\nVerdict: PASS\nfull text",
  });
  const handle = openChange({ stateDir, changeId: executionId });
  // The seat is observed started before acknowledgements are recordable.
  handle.append("attempt.started", { identity: { seat: "implementer" } },
    { context: { actor: RUNTIME, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `started-${impl.jobId}`, now: 4 });
  handle.append("attempt.started", { identity: { seat: "reviewer" } },
    { context: { actor: RUNTIME, jobId: reviewer.jobId, attemptId: reviewer.attemptId }, commandId: `started-${reviewer.jobId}`, now: 5 });
  const revisions = { unresolved: null, acknowledged: null };
  if (withUpdates) {
    // r4: committed update that is NEVER acknowledged (unresolved).
    revisions.unresolved = 4;
    handle.append("assignment.revised",
      { revision: 4, predecessor: 3, scope: { kind: "job", jobId: impl.jobId }, assignment: { instructions: "Composed with update four." }, note: "Coordinator instruction four (unresolved)." },
      { context: { actor: RUNTIME, jobId: impl.jobId }, commandId: `revise-${impl.jobId}-r4`, now: 6 });
    handle.append("amendment.submitted",
      { amendmentId: `${executionId}-amd4`, revision: 4, note: "Coordinator instruction four (unresolved)." },
      { context: { actor: RUNTIME, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `submit-${executionId}-amd4`, now: 7 });
    // r5: committed update that IS acknowledged by the worker.
    revisions.acknowledged = 5;
    handle.append("assignment.revised",
      { revision: 5, predecessor: 4, scope: { kind: "job", jobId: impl.jobId }, assignment: { instructions: "Composed with update five." }, note: "Coordinator instruction five (acknowledged)." },
      { context: { actor: RUNTIME, jobId: impl.jobId }, commandId: `revise-${impl.jobId}-r5`, now: 8 });
    handle.append("amendment.submitted",
      { amendmentId: `${executionId}-amd5`, revision: 5, note: "Coordinator instruction five (acknowledged)." },
      { context: { actor: RUNTIME, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `submit-${executionId}-amd5`, now: 9 });
    handle.append("worker.acknowledged", { revision: 5 },
      { context: { actor: WORKER, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `ack-${impl.jobId}-r5`, now: 10 });
  }
  recordRoleOutcome({
    stateDir, executionId, role: "implementer", jobId: impl.jobId, attemptId: impl.attemptId,
    status: "completed", summary: "implemented", reportId: implReport.reportId, identity: { seat: "implementer" }, now: 11,
  });
  recordRoleOutcome({
    stateDir, executionId, role: "reviewer", jobId: reviewer.jobId, attemptId: reviewer.attemptId,
    status: "completed", summary: "passed", reportId: revReport.reportId, identity: { seat: "reviewer" }, now: 12,
  });
  return { impl, reviewer, implReport, revReport, revisions };
}

// ---------------------------------------------------------------------------
// Deterministic fake `gh` seam over a real local bare remote
// ---------------------------------------------------------------------------

function installFakeGh(bare) {
  const bin = mkdtempSync(join(tmpdir(), "adr-curation-bin-"));
  const state = mkdtempSync(join(tmpdir(), "adr-curation-gh-"));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -eu
STATE="$FAKE_GH_STATE"; REMOTE="$FAKE_GH_REMOTE"; BASE="\${FAKE_GH_BASE:-main}"
mkdir -p "$STATE"
export GIT_AUTHOR_NAME=Fake GIT_AUTHOR_EMAIL=fake@example.invalid GIT_COMMITTER_NAME=Fake GIT_COMMITTER_EMAIL=fake@example.invalid
cmd="\${1:-} \${2:-}"
shift 2 || true
case "$cmd" in
  "repo view")
    printf '{"nameWithOwner":"fake/adr-repo","defaultBranchRef":{"name":"%s"}}' "$BASE" ;;
  "pr list")
    if [ -f "$STATE/created" ]; then
      head_sha=$(cat "$STATE/head")
      if [ -f "$STATE/merged" ]; then
        merge_sha=$(cat "$STATE/merge")
        printf '[{"url":"https://fake.example/pull/1","state":"MERGED","headRefOid":"%s","mergeCommit":{"oid":"%s"},"baseRefName":"%s"}]' "$head_sha" "$merge_sha" "$BASE"
      else
        printf '[{"url":"https://fake.example/pull/1","state":"OPEN","headRefOid":"%s","mergeCommit":null,"baseRefName":"%s"}]' "$head_sha" "$BASE"
      fi
    else
      printf '[]'
    fi ;;
  "pr create")
    head_branch=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--head" ]; then head_branch="$arg"; fi
      prev="$arg"
    done
    head_sha=$(git -C "$REMOTE" rev-parse "refs/heads/$head_branch")
    printf '%s' "$head_sha" > "$STATE/head"
    printf '%s' "$head_branch" > "$STATE/headbranch"
    touch "$STATE/created" ;;
  "pr merge")
    head_sha=$(cat "$STATE/head")
    head_branch=$(cat "$STATE/headbranch")
    base_sha=$(git -C "$REMOTE" rev-parse "refs/heads/$BASE")
    merge_tree=$(git -C "$REMOTE" rev-parse "$head_sha^{tree}")
    merge_sha=$(git -C "$REMOTE" commit-tree "$merge_tree" -p "$base_sha" -p "$head_sha" -m "Merge pull request #1 from fake/$head_branch")
    git -C "$REMOTE" update-ref "refs/heads/$BASE" "$merge_sha" "$base_sha"
    git -C "$REMOTE" update-ref -d "refs/heads/$head_branch" || true
    printf '%s' "$merge_sha" > "$STATE/merge"
    touch "$STATE/merged" ;;
  "pr view")
    head_sha=$(cat "$STATE/head")
    merge_sha=$(cat "$STATE/merge")
    printf '{"url":"https://fake.example/pull/1","state":"MERGED","headRefOid":"%s","mergeCommit":{"oid":"%s"},"baseRefName":"%s"}' "$head_sha" "$merge_sha" "$BASE" ;;
  *)
    echo "fake gh: unknown command '$cmd'" >&2
    exit 1 ;;
esac
`, "utf8");
  chmodSync(join(bin, "gh"), 0o755);
  const previous = { PATH: process.env.PATH, FAKE_GH_REMOTE: process.env.FAKE_GH_REMOTE, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_BASE: process.env.FAKE_GH_BASE };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.FAKE_GH_REMOTE = bare;
  process.env.FAKE_GH_STATE = state;
  process.env.FAKE_GH_BASE = "main";
  return {
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// (a) Successful ff landing: real repository, real record, exact evidence
// ---------------------------------------------------------------------------

const PHASE_A = "phaseff0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXEC_A = "execff-0001";
const TICKET_A = "# Phase A ticket\n\nExact ticket content — byte for byte.\nIncludes provenance marker TICKET-MARKER-A.\n";
{
  const { repo, stateDir, phaseId, ticketText } = await mkRepo({ phaseId: PHASE_A, ticketText: TICKET_A });
  const seeded = seedManaged({ stateDir, executionId: EXEC_A, root: repo, phaseId });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "feature.txt"), "built feature\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_A, owner: OWNER, phaseId, root: repo });
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, message: "feat: feature", curation: hook });

  // Landing identity: the actual ff receipt is authoritative.
  assert.equal(landResult.landed, true);
  assert.equal(landResult.method, "ff");
  assert.equal(landResult.mergeSha, await revParse(repo, "main"));
  assert.equal(landResult.curation.status, "pending");
  assert.equal(landResult.curation.obligationRecorded, true);
  assert.ok(landResult.curation.manifestId);
  assert.ok(landResult.curation.operationId);
  assert.ok(landResult.ticketArchived);
  assert.ok(landResult.archivePath, "archivePath exists only after archival and is never fabricated");
  assert.equal(landResult.retired, true);

  // Exact source text + provenance + full report references.
  const manifest = readAdrSourceManifest(stateDir, landResult.curation.manifestId);
  assert.equal(manifest.ticket.text, ticketText, "the exact ticket content is retained byte-for-byte");
  assert.equal(manifest.ticket.path, join(repo, ".architect", "tickets", `${phaseId}.md`));
  assert.equal(manifest.provenance.owner, OWNER);
  assert.equal(manifest.provenance.phaseId, PHASE_A);
  assert.equal(manifest.provenance.project, repo);
  assert.equal(manifest.provenance.branch, wt.branch);
  assert.match(manifest.constraints.instructions, /Immutable phase constraints/);
  assert.equal(manifest.constraints.complete, true);
  assert.ok(manifest.recordSnapshot.lastSeq > 0);
  assert.ok(manifest.updates.every((entry) => entry.eventId && entry.commandId && entry.actor));
  const reportIds = manifest.roleReports.map((entry) => entry.reportId);
  assert.ok(reportIds.includes(seeded.implReport.reportId));
  assert.ok(reportIds.includes(seeded.revReport.reportId));
  assert.ok(manifest.roleReports.every((entry) => entry.status === "retained"));
  const fullReport = readReport(stateDir, seeded.implReport.reportId);
  assert.equal(fullReport.ok, true);
  assert.ok(fullReport.text.includes("FULL-REPORT-MARKER"));
  const manifestText = JSON.stringify(manifest);
  assert.ok(!manifestText.includes("FULL-REPORT-MARKER"), "full durable report REFERENCES are retained, never truncated summaries");
  assert.equal(manifest.policy.textualClaimsTreatedAsPolicy, false);

  // Owner/phase/project binding on the obligation; only verified real landing
  // receipts activate a pending obligation.
  const view = adrCurationView({ stateDir, changeId: EXEC_A });
  assert.equal(view.processingStatus, "pending");
  const obligation = view.obligations[0];
  assert.equal(obligation.status, "pending");
  assert.equal(obligation.landing.method, "ff");
  assert.equal(obligation.landing.receipt, landResult.mergeSha);
  assert.equal(obligation.owner, OWNER);
  assert.equal(obligation.phaseId, PHASE_A);
  assert.equal(obligation.project, repo);
  assert.equal(obligation.operationId, landResult.curation.operationId);
  assert.equal(listCurationObligations({ stateDir, changeId: EXEC_A }).obligations.length, 1);

  // Post-landing completion: the archive path is a retained reference.
  const merged = adrCurationView({ stateDir, changeId: EXEC_A }).manifests[0];
  assert.equal(merged.refs.archivePath.status, "retained");
  assert.equal(merged.refs.archivePath.path, landResult.archivePath);
  assert.equal(merged.refs.landingReceipt.status, "retained");
  assert.equal(merged.evidenceComplete, true, "all required references retained after activation");

  // The managed projection surfaces the same authoritative state.
  const managedView = managedExecutionView({ stateDir, executionId: EXEC_A });
  assert.equal(managedView.curation.processingStatus, "pending");
  const hooks = managedExecutionPipelineHooks({ stateDir, executionId: EXEC_A, owner: OWNER });
  assert.equal(typeof hooks.adrCuration.capture, "function");
  assert.deepEqual(Object.keys(hooks.adrCuration).sort(), ["activate", "capture", "complete", "stateDir", "executionId", "view"].sort());
  pass("(a) ff landing identity, owner/phase binding, exact source text/provenance and full report refs");
}

// ---------------------------------------------------------------------------
// (a) Successful PR landing through the deterministic fake `gh` seam
// ---------------------------------------------------------------------------

const PHASE_B = "phasepr00001-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXEC_B = "execpr-0001";
const TICKET_B = "# Phase B ticket\n\nTICKET-MARKER-B exact content.\n";
{
  const { repo, bare, stateDir, phaseId, ticketText } = await mkRepo({ remote: true, phaseId: PHASE_B, ticketText: TICKET_B });
  const seeded = seedManaged({ stateDir, executionId: EXEC_B, root: repo, phaseId });
  const wt = await createWorktree(repo, { kind: "open", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "pr-feature.txt"), "pr feature\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_B, owner: OWNER, phaseId, root: repo });
  const fake = installFakeGh(bare);
  let landResult;
  try {
    landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, message: "feat: pr feature", curation: hook });
  } finally {
    fake.restore();
  }
  assert.equal(landResult.landed, true);
  assert.equal(landResult.method, "pr");
  assert.match(landResult.pr, /\/pull\/1$/);
  // The actual merge receipt from the merged PR is authoritative.
  assert.equal(landResult.mergeSha, await git(bare, ["rev-parse", "refs/heads/main"]));
  assert.equal(landResult.localSync.localCheckout, "not_synced", "untracked ticket/root files must not be hidden from checkout safety");
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), landResult.localSync.localHead);
  createJob({ stateDir, id: EXEC_B, role: "execution", kind: "open", workflow: { sessionKey: OWNER, root: repo }, cwd: repo, now: 1 });
  const meta = readLaunchMetadata({ stateDir, executionId: EXEC_B });
  recordHostStarted({ stateDir, executionId: EXEC_B, attemptId: meta.attemptId, identity: { host: true, pid: process.pid }, now: 20 });
  const settled = publishExecutionResult({ stateDir, jobId: EXEC_B,
    result: { ok: true, status: "completed", phase: "completed", result: { landingOutcome: landResult }, childAttempts: [] } });
  assert.equal(settled.terminal.status, "completed", "remote success stands despite local skip");
  const authoritative = managedExecutionView({ stateDir, executionId: EXEC_B });
  assert.equal(authoritative.landingOutcome.localSync.status, "local_sync_skipped");
  assert.equal(authoritative.execution.outcome.status, "completed");
  assert.match(readReport(stateDir, settled.terminal.reportId).text, /local_sync_skipped/);
  assert.match(defaultCompletionText(settled), /NOT synchronized/);
  writeJob(stateDir, { ...readJob(stateDir, EXEC_B), status: "running", terminal: null });
  const recovered = reconcileManagedExecution({ stateDir, executionId: EXEC_B });
  assert.equal(recovered.projection.terminal.status, "completed");
  assert.match(defaultCompletionText(recovered.projection), /NOT synchronized/);
  assert.equal(recovered.view.landingOutcome.localSync.status, "local_sync_skipped");
  assert.match(buildExecutionTerminalMessage({ id: EXEC_B, kind: "open", status: "completed", result: { landingOutcome: landResult } }), /NOT synchronized/);

  const view = adrCurationView({ stateDir, changeId: EXEC_B });
  assert.equal(view.processingStatus, "pending");
  const obligation = view.obligations[0];
  assert.equal(obligation.status, "pending");
  assert.equal(obligation.landing.method, "pr");
  assert.equal(obligation.landing.receipt, landResult.mergeSha);
  assert.equal(obligation.landing.pr, landResult.pr);
  assert.equal(obligation.owner, OWNER);
  assert.equal(obligation.phaseId, PHASE_B);
  const manifest = readAdrSourceManifest(stateDir, landResult.curation.manifestId);
  assert.equal(manifest.ticket.text, ticketText);
  assert.ok(manifest.roleReports.some((entry) => entry.reportId === seeded.revReport.reportId));
  pass("(a) PR landing identity via fake gh seam, merge receipt bound to the obligation");
}

// ---------------------------------------------------------------------------
// (b) No-op landing = explicit no-source-change; failed landing = uncurated
// ---------------------------------------------------------------------------

const PHASE_C = "phasenoop001-cccc-4ccc-8ccc-cccccccccccc";
const EXEC_C = "execno-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_C, ticketText: "# No-change ticket\n\nTICKET-MARKER-C.\n" });
  seedManaged({ stateDir, executionId: EXEC_C, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "research", sessionId: phaseId });
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_C, owner: OWNER, phaseId, root: repo });
  const headBefore = await revParse(repo, "main");
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: hook });
  assert.equal(landResult.method, "none");
  assert.equal(landResult.mergeSha, null);
  assert.equal(await revParse(repo, "main"), headBefore, "a no-op landing invents no commit");
  assert.equal(landResult.curation.status, "no-change");
  const view = adrCurationView({ stateDir, changeId: EXEC_C });
  assert.equal(view.processingStatus, "no-change");
  const obligation = view.obligations[0];
  assert.equal(obligation.status, "no-change");
  assert.equal(obligation.landing.method, "none");
  assert.equal(obligation.landing.receipt, null);
  assert.equal(view.pendingCuration.length, 0, "a no-source-change disposition never schedules architectural curation");
  pass("(b) method:none produces an explicit no-source-change disposition, no invented commit, no curation");
}

const PHASE_C2 = "phasefail01-cccc-4ccc-8ccc-cccccccccccc";
const EXEC_C2 = "execfail-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_C2, ticketText: "# Failing ticket\n\nTICKET-MARKER-C2.\n" });
  seedManaged({ stateDir, executionId: EXEC_C2, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "doomed.txt"), "will not land\n");
  // Move main ahead so the ff landing genuinely fails (unknown/failed landing).
  writeFileSync(join(repo, "moved.txt"), "main moved\n");
  await git(repo, ["add", "moved.txt"]);
  await git(repo, ["commit", "-m", "main moved"]);
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_C2, owner: OWNER, phaseId, root: repo });
  await assert.rejects(
    () => landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: hook }),
    /cannot fast-forward/,
  );
  const view = adrCurationView({ stateDir, changeId: EXEC_C2 });
  assert.equal(view.obligations.length, 0, "a failed/unknown landing never activates an obligation (no phantom curation)");
  assert.equal(view.processingStatus, "prepared");
  assert.equal(view.pendingCuration.length, 0);
  pass("(b) failed landing stays uncurated: staged evidence only, no phantom obligation");
}

// ---------------------------------------------------------------------------
// (c) Deterministic duplicate callbacks are idempotent
// ---------------------------------------------------------------------------

const PHASE_D = "phasedup001-dddd-4ddd-8ddd-dddddddddddd";
const EXEC_D = "execdup-0001";
{
  const { repo, stateDir, phaseId, ticketText } = await mkRepo({ phaseId: PHASE_D, ticketText: "# Duplicate ticket\n\nTICKET-MARKER-D.\n" });
  seedManaged({ stateDir, executionId: EXEC_D, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "dup.txt"), "dup\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_D, owner: OWNER, phaseId, root: repo });
  const ticketPath = join(repo, ".architect", "tickets", `${phaseId}.md`);
  const first = await hook.capture({ mainRoot: repo, worktree: wt.cwd, branch: wt.branch, sessionTag: null, ticketPath });
  const second = await hook.capture({ mainRoot: repo, worktree: wt.cwd, branch: wt.branch, sessionTag: null, ticketPath });
  assert.equal(first.manifestId, second.manifestId);
  assert.equal(adrEvents(stateDir, EXEC_D).filter((env) => env.kind === "adr.source_manifest").length, 1);

  const receipt = "a".repeat(40);
  const landing = { method: "ff", receipt, headSha: "b".repeat(40), pr: null };
  const act1 = await hook.activate({ landing, manifestId: first.manifestId });
  const act2 = await hook.activate({ landing, manifestId: first.manifestId });
  assert.equal(act1.operationId, act2.operationId);
  assert.equal(act2.dedupe, true);
  assert.equal(adrEvents(stateDir, EXEC_D).filter((env) => env.kind === "adr.curation_obligation").length, 1);
  assert.equal(adrCurationView({ stateDir, changeId: EXEC_D }).obligations.length, 1);

  const refs = { executionReport: { status: "retained", reportId: "rep-dup-1" } };
  await hook.complete({ manifestId: first.manifestId, refs });
  const again = await hook.complete({ manifestId: first.manifestId, refs });
  assert.equal(again.dedupe, true);
  // Two completions exist: the activation receipt handoff and this late ref.
  assert.equal(adrEvents(stateDir, EXEC_D).filter((env) => env.kind === "adr.source_completion").length, 2);
  assert.equal(ticketText.includes("TICKET-MARKER-D"), true);

  // Recovery replays are idempotent too.
  const rec1 = recoverAdrCuration({ stateDir, changeId: EXEC_D, repair: true });
  const rec2 = recoverAdrCuration({ stateDir, changeId: EXEC_D, repair: true });
  assert.equal(rec1.ok, true);
  assert.equal(rec2.ok, true);
  assert.equal(rec2.reconstructed.length, 0, "a settled handoff reconstructs nothing");
  assert.equal(adrEvents(stateDir, EXEC_D).length, 4, "duplicate callbacks and recovery never duplicate events");
  assert.ok(wt.cwd);
  pass("(c) deterministic duplicate callbacks and recovery replays never duplicate manifests or obligations");
}

// ---------------------------------------------------------------------------
// (d) Failure/crash windows: nonblocking landing, preserved sole source
// ---------------------------------------------------------------------------

// (d1) capture crash before retention: landing stands, sole source preserved.
const PHASE_E1 = "phasecapf1-eeee-4eee-8eee-eeeeeeeeeeee";
const EXEC_E1 = "execcap-0001";
{
  const { repo, stateDir, phaseId, ticketText } = await mkRepo({ phaseId: PHASE_E1, ticketText: "# Capture crash ticket\n\nTICKET-MARKER-E1 sole source.\n" });
  seedManaged({ stateDir, executionId: EXEC_E1, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "e1.txt"), "e1\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_E1, owner: OWNER, phaseId, root: repo });
  const failing = { ...hook, capture: async () => { throw new Error("synthetic capture crash"); } };
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: failing });
  // Nonblocking successful landing with a bounded truthful warning.
  assert.equal(landResult.landed, true);
  assert.equal(landResult.mergeSha, await revParse(repo, "main"));
  assert.equal(landResult.curation.status, "capture-failed");
  assert.match(landResult.curation.warnings[0], /synthetic capture crash/);
  // The SOLE unretained evidence is preserved for recovery, not discarded.
  assert.equal(readFileSync(join(repo, ".architect", "tickets", `${phaseId}.md`), "utf8"), ticketText);
  assert.equal(landResult.ticketArchived, false);
  assert.equal(landResult.retired, false);
  assert.equal(existsSync(wt.cwd), true, "the worktree evidence survives a failed capture");
  assert.equal(adrEvents(stateDir, EXEC_E1).length, 0);
  pass("(d) capture failure never fails the landing and preserves the sole source for recovery");
}

// (d2) merge-before-obligation: activation crash after merge; retry activates
// exactly one obligation from the real receipt.
const PHASE_E2 = "phaseactf1-eeee-4eee-8eee-eeeeeeeeeeee";
const EXEC_E2 = "execact-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_E2, ticketText: "# Activation crash ticket\n\nTICKET-MARKER-E2.\n" });
  seedManaged({ stateDir, executionId: EXEC_E2, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "e2.txt"), "e2\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_E2, owner: OWNER, phaseId, root: repo });
  const failing = { ...hook, activate: async () => { throw new Error("synthetic obligation handoff crash"); } };
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: failing });
  assert.equal(landResult.landed, true, "a completed landing is never rolled back or failed by the obligation seam");
  assert.equal(landResult.mergeSha, await revParse(repo, "main"));
  assert.equal(landResult.curation.status, "activation-failed");
  let view = adrCurationView({ stateDir, changeId: EXEC_E2 });
  assert.equal(view.processingStatus, "prepared", "merge-before-obligation stays truthful and pending");
  assert.equal(view.obligations.length, 0);
  // Recovery retry with the verified receipt: exactly one obligation.
  const ids = readAdrSourceManifest(stateDir, landResult.curation.manifestId);
  const activated = activateCurationObligation({
    stateDir,
    executionId: EXEC_E2,
    attemptId: ids.attemptId,
    manifestId: landResult.curation.manifestId,
    landing: { method: "ff", receipt: landResult.mergeSha, headSha: landResult.mergeSha, pr: null },
    expected: { owner: OWNER, phaseId, root: repo },
  });
  assert.equal(activated.status, "pending");
  const duplicate = activateCurationObligation({
    stateDir,
    executionId: EXEC_E2,
    attemptId: ids.attemptId,
    manifestId: landResult.curation.manifestId,
    landing: { method: "ff", receipt: landResult.mergeSha, headSha: landResult.mergeSha, pr: null },
  });
  assert.equal(duplicate.dedupe, true);
  view = adrCurationView({ stateDir, changeId: EXEC_E2 });
  assert.equal(view.obligations.length, 1, "duplicate activation callbacks never create duplicate obligations");
  assert.equal(view.obligations[0].landing.receipt, landResult.mergeSha);
  pass("(d) merge-before-obligation stays pending, then activates exactly once from the verified receipt");
}

// (d3) interrupted receipt handoff (completion committed, obligation lost) is
// reconstructed by recovery from the retained receipt only.
const PHASE_E3 = "phasehand1-eeee-4eee-8eee-eeeeeeeeeeee";
const EXEC_E3 = "exechnd-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_E3, ticketText: "# Handoff ticket\n\nTICKET-MARKER-E3.\n" });
  seedManaged({ stateDir, executionId: EXEC_E3, root: repo, phaseId, withUpdates: false });
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_E3, owner: OWNER, phaseId, root: repo });
  const staged = await hook.capture({ mainRoot: repo, worktree: repo, branch: "architect/bounded/x" });
  completeAdrSourceRefs({
    stateDir,
    executionId: EXEC_E3,
    manifestId: staged.manifestId,
    refs: { landingReceipt: { status: "retained" } },
    landing: { method: "ff", receipt: "c".repeat(40), headSha: "d".repeat(40), pr: null },
    disposition: "pending",
  });
  const recovered1 = recoverAdrCuration({ stateDir, changeId: EXEC_E3, repair: true });
  assert.equal(recovered1.ok, true);
  assert.equal(recovered1.reconstructed.filter((entry) => entry.action === "activated-curation-obligation").length, 1);
  const recovered2 = recoverAdrCuration({ stateDir, changeId: EXEC_E3, repair: true });
  assert.equal(recovered2.reconstructed.length, 0);
  assert.equal(adrEvents(stateDir, EXEC_E3).filter((env) => env.kind === "adr.curation_obligation").length, 1, "recovery reconstructs exactly one obligation");
  assert.equal(adrCurationView({ stateDir, changeId: EXEC_E3 }).obligations[0].landing.receipt, "c".repeat(40));
  pass("(d) interrupted receipt handoff reconstructs exactly one obligation from retained evidence");
}

// (d4) interrupted capture (blob written, event lost): recovery re-stages
// idempotently; without a retained receipt nothing is invented.
const EXEC_E4 = "execcap-0002";
{
  const stateDir = join(mkdtempSync(join(tmpdir(), "adr-curation-orphan-")), "state");
  const root = mkdtempSync(join(tmpdir(), "adr-curation-orphan-root-"));
  mkdirSync(stateDir, { recursive: true });
  const phaseId = "phaseorph1-eeee-4eee-8eee-eeeeeeeeeeee";
  recordManagedExecution({
    stateDir, executionId: EXEC_E4, kind: "bounded", phaseId, root, owner: OWNER,
    constraints: "Orphan capture constraints.", launchId: `${EXEC_E4}-launch`,
    requestPath: join(stateDir, "request-orphan.json"), now: 1,
  });
  const ids = readLaunchMetadata({ stateDir, executionId: EXEC_E4 });
  const handle = openChange({ stateDir, changeId: EXEC_E4 });
  const state = handle.state;
  const manifest = buildAdrSourceManifest({
    state,
    changeId: EXEC_E4,
    jobId: EXEC_E4,
    attemptId: ids.attemptId,
    events: handle.readEvents({ afterSeq: 0, limit: 1000 }).events,
    ticket: { path: null, sessionId: null, reason: "orphan capture fixture" },
    provenance: { project: root, owner: OWNER, phaseId, worktree: root, branch: "architect/bounded/orphan" },
    now: 2,
  });
  writeAdrSourceBlob(stateDir, manifest); // crash here: blob only, no event
  assert.equal(adrEvents(stateDir, EXEC_E4).length, 0);
  const recovered = recoverAdrCuration({ stateDir, changeId: EXEC_E4, repair: true });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.reconstructed.filter((entry) => entry.action === "staged-source-manifest").length, 1);
  const again = recoverAdrCuration({ stateDir, changeId: EXEC_E4, repair: true });
  assert.equal(again.reconstructed.length, 0);
  assert.equal(adrEvents(stateDir, EXEC_E4).filter((env) => env.kind === "adr.source_manifest").length, 1);
  const view = adrCurationView({ stateDir, changeId: EXEC_E4 });
  assert.equal(view.processingStatus, "prepared");
  assert.equal(view.obligations.length, 0, "no retained landing receipt -> the change stays uncurated, never false success");
  assert.equal(view.pendingCuration.length, 0);
  pass("(d) interrupted capture re-stages idempotently and never invents an obligation without a receipt");
}

// (d5) archive-after-capture handoff failure: landing stands, late completion
// is idempotent.
const PHASE_E5 = "phasearch1-eeee-4eee-8eee-eeeeeeeeeeee";
const EXEC_E5 = "execarc-0001";
{
  const { repo, stateDir, phaseId, ticketText } = await mkRepo({ phaseId: PHASE_E5, ticketText: "# Archive handoff ticket\n\nTICKET-MARKER-E5.\n" });
  seedManaged({ stateDir, executionId: EXEC_E5, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "e5.txt"), "e5\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_E5, owner: OWNER, phaseId, root: repo });
  const failing = { ...hook, complete: async () => { throw new Error("synthetic archive handoff crash"); } };
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: failing });
  assert.equal(landResult.landed, true);
  assert.match(landResult.curation.warnings[0], /archive handoff/);
  assert.ok(landResult.archivePath);
  let merged = adrCurationView({ stateDir, changeId: EXEC_E5 }).manifests[0];
  assert.equal(merged.refs.archivePath.status, "pending", "the archive ref stays explicitly pending, never fabricated");
  assert.equal(merged.evidenceComplete, true, "archivePath is optional; required evidence is complete");
  completeAdrSourceRefs({
    stateDir, executionId: EXEC_E5, manifestId: merged.manifestId,
    refs: { archivePath: { status: "retained", path: landResult.archivePath } },
  });
  const twin = completeAdrSourceRefs({
    stateDir, executionId: EXEC_E5, manifestId: merged.manifestId,
    refs: { archivePath: { status: "retained", path: landResult.archivePath } },
  });
  assert.equal(twin.dedupe, true);
  merged = adrCurationView({ stateDir, changeId: EXEC_E5 }).manifests[0];
  assert.equal(merged.refs.archivePath.status, "retained");
  assert.equal(merged.refs.archivePath.path, landResult.archivePath);
  const blob = readAdrSourceManifest(stateDir, merged.manifestId);
  assert.equal(blob.ticket.text, ticketText, "the exact ticket text survives in the immutable manifest blob");
  pass("(d) archive-after-capture failure keeps explicit pending refs and completes idempotently later");
}

// (d6) retirement/report-finalization window + publishExecutionResult closes
// the landing-return -> final-report gap without blocking anything.
const PHASE_E6 = "phasefin11-eeee-4eee-8eee-eeeeeeeeeeee";
const EXEC_E6 = "execfin-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_E6, ticketText: "# Finalization ticket\n\nTICKET-MARKER-E6.\n" });
  seedManaged({ stateDir, executionId: EXEC_E6, root: repo, phaseId, withUpdates: false });
  createJob({ stateDir, id: EXEC_E6, role: "execution", kind: "open", workflow: { sessionKey: OWNER, root: repo }, cwd: repo, now: 1 });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "e6.txt"), "e6\n");
  const hook = createAdrCurationHook({ stateDir, executionId: EXEC_E6, owner: OWNER, phaseId, root: repo });
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: hook });
  // Window: landing returned, final reports not yet published.
  let view = adrCurationView({ stateDir, changeId: EXEC_E6 });
  assert.equal(view.processingStatus, "pending");
  assert.equal(view.manifests[0].refs.executionReport.status, "pending", "the final report ref is explicitly pending across the gap");
  // The real finalization call path completes it idempotently.
  const meta = readLaunchMetadata({ stateDir, executionId: EXEC_E6 });
  recordHostStarted({ stateDir, executionId: EXEC_E6, attemptId: meta.attemptId, identity: { host: true, pid: process.pid }, now: 20 });
  const settled = publishExecutionResult({
    stateDir,
    jobId: EXEC_E6,
    result: { ok: true, status: "completed", phase: "completed", result: { landingOutcome: landResult }, childAttempts: [] },
  });
  assert.equal(settled.terminal.status, "completed");
  assert.equal(settled.curationCompletion.ok, true);
  view = adrCurationView({ stateDir, changeId: EXEC_E6 });
  const ref = view.manifests[0].refs.executionReport;
  assert.equal(ref.status, "retained");
  assert.ok(ref.reportId);
  assert.equal(readReport(stateDir, ref.reportId).ok, true);
  assert.equal(view.processingStatus, "pending", "the curation obligation itself remains honestly pending for the future consumer");
  pass("(d) report finalization closes the landing-return gap with idempotent post-landing completion");
}

// ---------------------------------------------------------------------------
// (e) Unresolved updates remain unresolved attributed evidence
// ---------------------------------------------------------------------------

const PHASE_F = "phaseunres-ffff-4fff-8fff-ffffffffffff";
const EXEC_F = "execunr-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_F, ticketText: "# Unresolved ticket\n\nTICKET-MARKER-F.\n" });
  const seeded = seedManaged({ stateDir, executionId: EXEC_F, root: repo, phaseId, withUpdates: true });
  const staged = await stageAdrSource({
    stateDir,
    executionId: EXEC_F,
    ticketPath: join(repo, ".architect", "tickets", `${phaseId}.md`),
    sessionTag: phaseId,
    worktree: repo,
    branch: "architect/bounded/x",
    expected: { owner: OWNER, phaseId, root: repo },
    now: 30,
  });
  const manifest = readAdrSourceManifest(stateDir, staged.manifestId);
  const unresolved = manifest.updates.find((entry) => entry.revision === seeded.revisions.unresolved);
  const acknowledged = manifest.updates.find((entry) => entry.revision === seeded.revisions.acknowledged);
  assert.equal(unresolved.resolution, "unresolved");
  assert.equal(unresolved.acceptedPolicy, false, "rejected/unresolved material is attributed source, never accepted policy");
  assert.equal(unresolved.acknowledgement, null);
  assert.equal(unresolved.amendmentId, `${EXEC_F}-amd4`);
  assert.equal(unresolved.targetJobId, `${EXEC_F}-impl`);
  assert.equal(unresolved.targetedAttemptId, `${EXEC_F}-impl-a1`);
  assert.equal(unresolved.instruction, "Coordinator instruction four (unresolved).");
  assert.ok(unresolved.actor, "unresolved material keeps its attribution");
  assert.equal(acknowledged.resolution, "acknowledged");
  assert.equal(acknowledged.acceptedPolicy, true);
  assert.equal(acknowledged.acknowledgement.revision, seeded.revisions.acknowledged);
  assert.ok(acknowledged.acknowledgement.seq > 0);
  assert.equal(acknowledged.instruction, "Coordinator instruction five (acknowledged).");
  assert.equal(manifest.updates[0].resolution, "launch-revision");
  assert.ok(manifest.updates.every((entry) => entry.resolution !== undefined));
  // Outcome references come from record events, not text.
  assert.ok(acknowledged.outcome && ["completed", "failed", "cancelled"].includes(acknowledged.outcome.status));
  pass("(e) unresolved updates stay unresolved attributed evidence; ack/outcome refs derive only from record events");
}

// ---------------------------------------------------------------------------
// (f) Wrong owner/phase, malformed refs, corrupt/missing artifacts, caches
// ---------------------------------------------------------------------------

const PHASE_G = "phasebind1-gggg-4ggg-8ggg-gggggggggggg";
const EXEC_G = "execbnd-0001";
{
  const { repo, stateDir, phaseId, ticketText } = await mkRepo({ phaseId: PHASE_G, ticketText: "# Binding ticket\n\nTICKET-MARKER-G.\n" });
  seedManaged({ stateDir, executionId: EXEC_G, root: repo, phaseId, withUpdates: false });
  const ticketPath = join(repo, ".architect", "tickets", `${phaseId}.md`);
  // Wrong owner / wrong phase / wrong root fail honestly.
  await assert.rejects(
    () => stageAdrSource({ stateDir, executionId: EXEC_G, ticketPath, expected: { owner: "intruder-session" } }),
    /owner-mismatch|does not match/,
  );
  await assert.rejects(
    () => stageAdrSource({ stateDir, executionId: EXEC_G, ticketPath, expected: { owner: OWNER, phaseId: "some-other-phase" } }),
    /phase-mismatch|does not match/,
  );
  await assert.rejects(
    () => stageAdrSource({ stateDir, executionId: EXEC_G, ticketPath, expected: { owner: OWNER, root: "/somewhere/else" } }),
    /root-mismatch|does not match/,
  );
  const staged = await stageAdrSource({ stateDir, executionId: EXEC_G, ticketPath, expected: { owner: OWNER, phaseId, root: repo }, now: 40 });

  // Malformed refs and phantom obligations are refused by the reducer.
  const handle = openChange({ stateDir, changeId: EXEC_G });
  assert.throws(
    () => handle.append("adr.source_manifest",
      { manifestId: "bad-manifest-1", schemaVersion: 1, evidence: { path: "/tmp/x", sha256: "f".repeat(64), bytes: 1 }, refs: { ticket: { status: "bogus" } } },
      { context: { actor: RUNTIME, jobId: EXEC_G, attemptId: readLaunchMetadata({ stateDir, executionId: EXEC_G }).attemptId }, commandId: "bad-manifest-cmd-1" }),
    (err) => err?.code === "invalid-event",
  );
  assert.throws(
    () => handle.append("adr.source_manifest",
      { manifestId: "bad-manifest-2", schemaVersion: 1, evidence: { path: "/tmp/x", sha256: "f".repeat(64), bytes: 1 }, refs: { ticket: { status: "retained" } } },
      { context: { actor: RUNTIME, jobId: EXEC_G, attemptId: readLaunchMetadata({ stateDir, executionId: EXEC_G }).attemptId }, commandId: "bad-manifest-cmd-2" }),
    (err) => err?.code === "invalid-event", "a manifest never silently omits a required reference",
  );
  assert.throws(
    () => handle.append("adr.curation_obligation",
      { operationId: "phantom-op-1", manifestId: staged.manifestId, status: "pending", landing: { method: "ff", receipt: null }, project: repo, owner: OWNER, phaseId },
      { context: { actor: RUNTIME, jobId: EXEC_G, attemptId: readLaunchMetadata({ stateDir, executionId: EXEC_G }).attemptId }, commandId: "phantom-op-cmd-1" }),
    (err) => err?.code === "invalid-event", "a pending obligation without a verified receipt is refused",
  );
  assert.throws(
    () => handle.append("adr.curation_obligation",
      { operationId: "phantom-op-2", manifestId: staged.manifestId, status: "pending", landing: { method: "none" }, project: repo, owner: OWNER, phaseId },
      { context: { actor: RUNTIME, jobId: EXEC_G, attemptId: readLaunchMetadata({ stateDir, executionId: EXEC_G }).attemptId }, commandId: "phantom-op-cmd-2" }),
    (err) => err?.code === "invalid-transition" || err?.code === "invalid-event", "method:none never schedules curation",
  );

  // Cache writes can never override the authoritative curation status.
  const before = adrCurationView({ stateDir, changeId: EXEC_G });
  const job = readJob(stateDir, EXEC_G) ?? createJob({ stateDir, id: EXEC_G, role: "execution", kind: "open", workflow: { sessionKey: OWNER, root: repo }, cwd: repo, now: 1 });
  writeJob(stateDir, { ...job, curation: { processingStatus: "completed-curation", obligations: [] }, status: "completed" });
  const after = adrCurationView({ stateDir, changeId: EXEC_G });
  assert.deepEqual(after, before, "the jobs cache is never a second source of truth");

  // Corrupted durable artifact fails honestly and is never declared complete.
  writeFileSync(adrSourcePath(stateDir, staged.manifestId), "{ corrupt", "utf8");
  assert.throws(() => readAdrSourceManifest(stateDir, staged.manifestId), /corrupt/);
  let view = adrCurationView({ stateDir, changeId: EXEC_G });
  assert.equal(view.manifests[0].blob.valid, false);
  assert.equal(view.manifests[0].evidenceComplete, false, "complete evidence is never declared over a corrupted artifact");
  const corruptRecovery = recoverAdrCuration({ stateDir, changeId: EXEC_G, repair: true });
  assert.equal(corruptRecovery.ok, false, "recovery fails honestly on corruption and never guesses");

  // Missing durable artifact: explicit missing state, honest incompleteness.
  rmSync(adrSourcePath(stateDir, staged.manifestId));
  assert.throws(() => readAdrSourceManifest(stateDir, staged.manifestId), /missing/);
  view = adrCurationView({ stateDir, changeId: EXEC_G });
  assert.equal(view.manifests[0].blob.exists, false);
  assert.equal(view.manifests[0].evidenceComplete, false);
  void ticketText;
  pass("(f) wrong binding, malformed refs and corrupted/missing artifacts fail honestly; caches cannot override status");
}

// ---------------------------------------------------------------------------
// (g) Suppression: verified ADR-root confinement or trusted publisher opt-out
// ---------------------------------------------------------------------------

{
  // Ordinary managed source changes default capture ON.
  assert.equal(resolveAdrSuppression({ changedPaths: ["src/a.js"], verified: true }).suppressed, false);
  assert.equal(resolveAdrSuppression({ changedPaths: ["docs/adr/x.md"], verified: true }).suppressed, false,
    "with no established ADR root, only the trusted opt-out suppresses");
  // Future ADR-root confinement (once storage is established).
  assert.equal(ADR_ROOTS.length, 0);
  const confined = resolveAdrSuppression({ changedPaths: ["docs/adr/x.md", "docs/adr/y.md"], verified: true, adrRoots: ["docs/adr"] });
  assert.equal(confined.suppressed, true);
  assert.equal(confined.basis, "adr-roots");
  assert.equal(confined.changedPaths.allWithinAdrRoots, true);
  assert.equal(resolveAdrSuppression({ changedPaths: ["docs/adr/x.md", "src/a.js"], verified: true, adrRoots: ["docs/adr"] }).suppressed, false);
  assert.equal(resolveAdrSuppression({ changedPaths: ["docs/adr/x.md"], verified: false, adrRoots: ["docs/adr"] }).suppressed, false,
    "an unverified changed-path claim never suppresses");
  // Trusted internal publisher opt-out, narrowly validated.
  const opt = resolveAdrSuppression({ trustedPublicationOptOut: { reason: "ADR-only publication", provenance: "adr-publisher v1", publisher: true } });
  assert.equal(opt.suppressed, true);
  assert.equal(opt.basis, "trusted-opt-out");
  assert.throws(() => resolveAdrSuppression({ trustedPublicationOptOut: { reason: "no", provenance: "" , publisher: true } }), /provenance/);
  assert.throws(() => resolveAdrSuppression({ trustedPublicationOptOut: { reason: "", provenance: "x", publisher: true } }), /reason/);
  assert.throws(() => resolveAdrSuppression({ trustedPublicationOptOut: { reason: "r", provenance: "p" } }), /publisher/);
  assert.throws(() => resolveAdrSuppression({ trustedPublicationOptOut: "the model says it is an ADR-only change" }), /must be an object/);
  pass("(g) suppression only from verified ADR-root confinement or validated publisher opt-out; claims never suppress");
}

const PHASE_H = "phasesupp1-hhhh-4hhh-8hhh-hhhhhhhhhhhh";
const EXEC_H = "execsup-0001";
{
  const { repo, stateDir, phaseId } = await mkRepo({ phaseId: PHASE_H, ticketText: "# ADR publication ticket\n\nTICKET-MARKER-H.\n" });
  seedManaged({ stateDir, executionId: EXEC_H, root: repo, phaseId, withUpdates: false });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "adr-entry.md"), "# ADR\n");
  const hook = createAdrCurationHook({
    stateDir, executionId: EXEC_H, owner: OWNER, phaseId, root: repo,
    trustedPublicationOptOut: { reason: "ADR-only publication of the curated ADR", provenance: "adr-publisher narrow deterministic publisher", publisher: true },
  });
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, curation: hook });
  assert.equal(landResult.landed, true);
  assert.equal(landResult.curation.status, "suppressed");
  // No manifest: verified suppression suppresses CAPTURE itself.
  assert.equal(adrEvents(stateDir, EXEC_H).filter((env) => env.kind === "adr.source_manifest").length, 0);
  const view = adrCurationView({ stateDir, changeId: EXEC_H });
  assert.equal(view.processingStatus, "suppressed");
  const obligation = view.obligations[0];
  assert.equal(obligation.status, "suppressed");
  assert.equal(obligation.suppression.publisher, true);
  assert.equal(view.pendingCuration.length, 0, "a suppressed ADR-only publication never schedules curation (no recursive loop)");
  assert.equal(listCurationObligations({ stateDir, changeId: EXEC_H }).obligations.length, 0);
  pass("(g) trusted ADR-only suppression records an explicit suppressed disposition and prevents recursive curation");
}

// ---------------------------------------------------------------------------
// (h) Legacy/manual landing compatibility; no new worker launch
// ---------------------------------------------------------------------------

const PHASE_I = "phaseleg11-iiii-4iii-8iii-iiiiiiiiiiii";
{
  const { repo, phaseId, ticketText } = await mkRepo({ phaseId: PHASE_I, ticketText: "# Legacy ticket\n\nTICKET-MARKER-I.\n" });
  const wt = await createWorktree(repo, { kind: "bounded", sessionId: phaseId });
  writeFileSync(join(wt.cwd, "legacy.txt"), "legacy\n");
  const before = await revParse(repo, "main");
  const landResult = await landWorktree(repo, { worktree: wt.cwd, branch: wt.branch, message: "feat: legacy" });
  // Ordinary landing/archive behavior is preserved exactly.
  assert.equal(landResult.landed, true);
  assert.equal(landResult.method, "ff");
  assert.equal(landResult.mergeSha, await revParse(repo, "main"));
  assert.notEqual(landResult.mergeSha, before);
  assert.equal(landResult.retired, true);
  assert.equal(landResult.ticketArchived, true);
  assert.ok(landResult.archivePath);
  // Truthful unsupported/deferred curation; never impersonating a managed
  // authoritative change (no record events can exist without a record).
  assert.equal(landResult.curation.supported, false);
  assert.equal(landResult.curation.status, "unsupported");
  assert.match(landResult.curation.reason, /unsupported\/deferred/);
  assert.equal(ticketText.length > 0, true);
  pass("(h) legacy/manual landing keeps ordinary behavior and states deferred curation truthfully");
}

{
  // The seam launches no process, no worker, no notification: static contract.
  const moduleDir = dirname(fileURLToPath(new URL("../workflow/adr-curation.mjs", import.meta.url)));
  const adrSrc = readFileSync(join(moduleDir, "adr-curation.mjs"), "utf8");
  assert.doesNotMatch(adrSrc, /child_process/);
  assert.doesNotMatch(adrSrc, /from "\.\/(notify|worker-launch|execution-host-launcher|runner-lifecycle|execution-supervisor)\.mjs"/);
  assert.doesNotMatch(adrSrc, /spawn|execFile|setInterval/);
  assert.doesNotMatch(adrSrc, /import[^\n]*zvec/i, "the source manifest is never registered for search or indexing");
  assert.doesNotMatch(adrSrc, /createIndex|addDocuments|embed\(|upsert/i);
  const gitSrc = readFileSync(join(moduleDir, "git.mjs"), "utf8");
  assert.match(gitSrc, /preserveSoleEvidence/, "landWorktree preserves sole evidence on capture/receipt failure");
  pass("(h) the curation seam spawns nothing, schedules nothing, and indexes nothing");
}

console.log("All ADR curation seam tests passed.");
