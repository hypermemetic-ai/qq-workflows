// Land is not a selectable workflow. Official Mini submits through its
// completion command; the architect/base `land` tool may submit an existing
// worktree. Both paths stamp land or review, run the land worker or an isolated
// QA child, and packet the architect session through qq-relay default steer.
//
// Paint-only changes may land; control paths default to review. An optional
// external task record archives only after the merge/cleanup succeeds.

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checked,
  inspectWorktree,
  reason,
  runCommand,
} from "./git.mjs";

import {
  DELEGATION_PACKET_SCHEMA,
  boundFormattedText,
  boundedPacketLine,
  compilePacket,
  formatPacket,
  isTestPath,
} from "./proposal-packet.mjs";
import { materializeTaskArtifact } from "./task-artifact.mjs";
import { createQaVerdict } from "./qa-verdict.mjs";
import { RepoOracle } from "./repo-oracle.mjs";
import { AGENT_HANDLE, adoptAgentHandle } from "./agent-handle.mjs";
import { pinNonInteractiveApproval } from "./approval-policy.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { withChildSettlement } from "./child-settlement.mjs";
import {
  bindMiniSubmit,
  isMiniAgent,
  MINI_KIND,
  miniSetup,
  renderMiniSweTask,
} from "./official-mini.mjs";
import { buildDoneTool } from "./land-tools.mjs";
import {
  bindMiniQaSubmit,
  ensureMiniQaMounted,
  MINI_QA_KIND,
  miniQaSetup,
  renderMiniQaTask,
} from "./mini-qa.mjs";

export const DELEGATION_LABEL_PREFIX = "workflows:delegation/";
export const DELEGATION_PHASE_LABEL_PREFIX = "workflows:delegation-phase/";
const DELEGATION_PHASE_ROLES = new Set(["implementation", "qa"]);
export const CHILD_ORIGIN = "subagent";
export { DELEGATION_PACKET_SCHEMA };

const DELEGATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_AGENT_HANDLE = Symbol.for("@hypermemetic-ai/qq-workflows/child-agent-handle");
const SETTLEMENT_TRANSITIONS = new Set(["dispose", "finish_land", "start_qa", "start_implementation"]);
export const DELEGATION_PHASE_INPUT_SCHEMA = "qq.delegation-phase-input/v1";
export const PHASE_DELTA_MAX_CHARS = 4_000;
export const DELEGATION_OUTCOME_MAX_CHARS = 16_000;

/** A chair that may invoke land. Children never are. */
export function isLandCandidate(agent) {
  const header = agent?.session?.header;
  if (header?.origin === CHILD_ORIGIN) return false;
  if (typeof header?.parentSession === "string" && header.parentSession.length > 0) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
}

export { inspectWorktree, runCommand };

function relayOf(ctx) {
  return ctx.get?.("qq-relay", false) ?? null;
}

function logLine(ctx, level, message) {
  const logger = ctx?.logger;
  if (logger && typeof logger[level] === "function") {
    logger[level](message);
    return;
  }
  if (level === "warn") console.warn(message);
}

function childWorkflowLabels(delegationId, workflowRole) {
  const id = String(delegationId ?? "").toLowerCase();
  if (!DELEGATION_ID.test(id)) {
    throw new Error("land child label requires a bounded delegation id");
  }
  if (!DELEGATION_PHASE_ROLES.has(workflowRole)) {
    throw new Error(`land child label has unknown role ${workflowRole}`);
  }
  return [`${DELEGATION_LABEL_PREFIX}${id}`, `${DELEGATION_PHASE_LABEL_PREFIX}${workflowRole}`];
}

function hangChildLabels(ctx, owner) {
  const relay = relayOf(ctx);
  if (!owner || !relay || typeof relay.hang !== "function") return false;
  const labels = childWorkflowLabels(owner.delegationId, owner.workflowRole);
  owner.workflowLabels ??= new Set();
  let complete = true;
  for (const label of labels) {
    try {
      relay.hang(owner.sessionId, label);
      owner.workflowLabels.add(label);
    } catch (error) {
      complete = false;
      logLine(ctx, "warn", `qq-workflows: failed to hang ${label} on ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return complete;
}

function clearChildLabels(ctx, owner) {
  const relay = relayOf(ctx);
  if (!owner || !relay || typeof relay.clear !== "function") return false;
  let cleared = false;
  for (const label of owner.workflowLabels ?? []) {
    try { cleared = relay.clear(owner.sessionId, label) || cleared; } catch { /* best effort */ }
  }
  owner.workflowLabels?.clear?.();
  return cleared;
}

function beginPhaseTransition(state, fields = {}) {
  return { ...state, ...fields, transitioning: true };
}

function advancePhase(state, sessionUuid, role, fields = {}) {
  if (!SESSION_ID.test(sessionUuid) || !DELEGATION_PHASE_ROLES.has(role)) {
    throw new Error("cannot advance delegation to an invalid workflow phase");
  }
  const pending = state.pendingPhase;
  if (pending && (pending.sessionUuid !== sessionUuid || pending.role !== role)) {
    throw new Error("cannot advance delegation to a child other than its pending phase");
  }
  if (state.current?.sessionUuid === sessionUuid && state.current?.role === role) {
    return { ...state, ...fields, current: state.current, transitioning: false, pendingPhase: null };
  }
  const phaseEpoch = pending?.phaseEpoch ?? (state.phaseEpoch + 1);
  return {
    ...state,
    ...fields,
    phaseEpoch,
    current: { sessionUuid, role, phaseEpoch },
    transitioning: false,
    pendingPhase: null,
  };
}

function finishWorkflow(state, fields = {}) {
  const next = { ...state, ...fields, current: null, transitioning: false, pendingPhase: null };
  // Artifact-backed records can drop their duplicate durable task body at the
  // terminal boundary. Legacy records keep old fields for lossless recovery.
  if (next.taskArtifact) {
    next.brief = "";
    if (next.packet?.brief) {
      const { brief: _legacyDuplicate, ...packet } = next.packet;
      next.packet = packet;
    }
  }
  return next;
}

function workflowRoleForState(state, sessionId, fallback = "implementation") {
  if (state?.qaSession === sessionId) return "qa";
  if (state?.implementationSession === sessionId) return "implementation";
  return DELEGATION_PHASE_ROLES.has(fallback) ? fallback : "implementation";
}

function toolsService(holder) {
  return holder?.tools
    ?? holder?.get?.("tools", false)
    ?? holder?.ctx?.tools
    ?? holder?.ctx?.get?.("tools", false)
    ?? null;
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? "";
}

function messageHasId(message, messageId) {
  return message?.id === messageId || message?.data?.id === messageId;
}

function messageInserted(agent, messageId) {
  if (!agent || typeof messageId !== "string" || !messageId) return false;
  const pending = [
    ...(agent.inbox?.nextTurn ?? []),
    ...(agent.inbox?.nextStep ?? []),
  ];
  if (pending.some((message) => messageHasId(message, messageId))) return true;
  // DSH followup splices into the inbox then wakes the driver. The driver
  // claims that splice before it appends user/message, so a synchronous check
  // must treat the durable inbox insertion as retention.
  return (agent.session?.events ?? []).some((event) => {
    if (event?.type === "user/message") {
      return messageHasId(event.data, messageId) || messageHasId(event.data?.message, messageId);
    }
    if (event?.type === "agent/inbox/spliced") {
      return (event.data?.inserted ?? []).some((message) => messageHasId(message, messageId));
    }
    return false;
  });
}

function parseChangedPaths(source) {
  const text = String(source ?? "");
  return text.split(text.includes("\0") ? "\0" : "\n").filter(Boolean);
}

function appendVerdictFailure(verdict, feedback) {
  verdict.verdict = "fail";
  verdict.feedback = `${verdict.feedback ? `${verdict.feedback}\n` : ""}${feedback}`;
}

export function renderDelegationPhaseTask(pending) {
  if (pending?.message) return pending.message;
  const input = pending?.input;
  if (!input) return "";
  const seed = [
    `Exact task artifact: ${input.taskArtifact}`,
    `Expected task SHA-256: ${input.taskSha256}`,
    "Read the artifact before review or revision. Do not edit it; the host verifies and rematerializes it between phases.",
    `Proposal summary:
${input.proposal}`,
    `Phase delta:
${input.delta}`,
  ].join("\n\n");
  return pending.role === "qa"
    ? renderMiniQaTask({ task: seed })
    : pending.role === "implementation" ? renderMiniSweTask(seed) : seed;
}

export function formatOutcome(state, kind) {
  const status = kind === "landed" ? "landed" : kind === "blocked" ? "blocked" : String(kind || state?.status || "completed");
  const packet = state?.packet ? formatPacket(state.packet) : "No proposal summary was recorded.";
  const verdict = state?.qaVerdict;
  const qa = verdict
    ? [
        `QA verdict: ${verdict.verdict}`,
        `QA summary: ${boundFormattedText(verdict.summary || "(none)", 1_000, "QA summary")}`,
        `QA feedback: ${boundFormattedText(verdict.feedback || "(none)", PHASE_DELTA_MAX_CHARS, "QA feedback")}`,
        `Tests modified by QA: ${verdict.tests_modified === true ? "yes" : "no"}`,
      ].join("\n")
    : "QA verdict: unavailable";
  const diagnostics = [
    state?.ref ? `Ref: ${boundedPacketLine(state.ref, 120)}` : "",
    status === "landed" ? `Base branch: ${boundedPacketLine(state?.baseBranch || "main", 120)}` : "",
    status === "blocked" ? `Blocked reason: ${boundFormattedText(state?.blockedReason || "blocked", 2_000, "blocked reason")}` : "",
    status === "blocked" && state?.worktree ? `Retained worktree: ${boundedPacketLine(state.worktree)}` : "",
    state?.archiveError ? `Task archive diagnostic: ${boundFormattedText(state.archiveError, 1_000, "archive diagnostic")}` : "",
  ].filter(Boolean).join("\n");
  return boundFormattedText([
    `Implementation delegation ${state?.delegationId || "unknown"}: ${status}.`,
    diagnostics,
    qa,
    `Change summary:
${packet}`,
  ].filter(Boolean).join("\n\n"), DELEGATION_OUTCOME_MAX_CHARS, "implementation outcome");
}

export async function enforceQaWorktree(run, state, verdict) {
  const dirty = await checked(
    run, "git", ["status", "--porcelain", "--untracked-files=all"], { cwd: state.worktree }, "cannot inspect qa worktree",
  );
  const headRevision = await checked(
    run, "git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: state.worktree }, "cannot inspect qa commit",
  );
  const qaHead = headRevision.stdout.trim();
  let testOnlyCommit = false;

  if (dirty.stdout.trim() && verdict.verdict === "pass") {
    appendVerdictFailure(verdict, "qa left uncommitted worktree changes.");
  }

  if (!dirty.stdout.trim() && qaHead !== state.ref) {
    const descendant = await run("git", ["merge-base", "--is-ancestor", state.ref, qaHead], { cwd: state.worktree });
    if (descendant?.code !== 0) {
      appendVerdictFailure(verdict, "qa replaced or rewrote the reviewed commit instead of adding test-only changes.");
    } else {
      const changed = await checked(
        run, "git", ["diff", "--name-only", "--no-renames", "-z", `${state.ref}..${qaHead}`],
        { cwd: state.worktree }, "cannot inspect qa commits",
      );
      const paths = parseChangedPaths(changed.stdout);
      const productionPaths = paths.filter((path) => !isTestPath(path));
      if (!paths.length) appendVerdictFailure(verdict, "qa created a commit without test changes.");
      else if (productionPaths.length) {
        appendVerdictFailure(verdict, `qa committed production-code changes: ${productionPaths.join(", ")}.`);
      } else testOnlyCommit = true;
    }
  }

  return { verdict, testOnlyCommit, qaHead };
}

/** GitHub PR operations used by Land. Kept behind the injected command runner so
 * tests can exercise the complete land sequence without network access. */
function githubJson(result, label) {
  try { return JSON.parse(String(result?.stdout ?? "")); }
  catch (error) { throw new Error(`${label}: GitHub returned malformed JSON`, { cause: error }); }
}

export function githubRepositoryFromOrigin(value) {
  const source = String(value ?? "").trim();
  let host = "";
  let pathname = "";
  const scp = source.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !source.includes("://")) {
    host = scp[1];
    pathname = scp[2];
  } else {
    try {
      const parsed = new URL(source);
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return "";
    }
  }
  const parts = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (!host || parts.length !== 2) return "";
  const repository = `${parts[0]}/${parts[1]}`;
  return host.toLowerCase() === "github.com" ? repository : `${host}/${repository}`;
}

/** GitHub PR operations bound explicitly to the repository selected by origin. */
export function createGitHubClient(run = runCommand) {
  const repositories = new Map();

  async function repositoryFor(mainRoot) {
    if (repositories.has(mainRoot)) return repositories.get(mainRoot);
    const origin = await checked(
      run, "git", ["remote", "get-url", "origin"], { cwd: mainRoot }, "cannot resolve origin for GitHub",
    );
    const repository = githubRepositoryFromOrigin(origin.stdout);
    if (!repository) throw new Error("cannot bind GitHub operations to origin: origin is not an unambiguous GitHub repository URL");
    const selected = await checked(
      run,
      "gh",
      ["repo", "view", repository, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: mainRoot },
      "cannot bind GitHub operations to origin",
    );
    const selectedName = String(selected.stdout ?? "").trim();
    if (!selectedName || !repository.endsWith(selectedName)) {
      throw new Error("cannot bind GitHub operations to origin: repository identity mismatch");
    }
    repositories.set(mainRoot, repository);
    return repository;
  }

  async function matchingPullRequest({ mainRoot, repository, baseBranch, headBranch, headRef }) {
    const listed = await checked(
      run,
      "gh",
      [
        "pr", "list", "--repo", repository,
        "--state", "open", "--base", baseBranch, "--head", headBranch,
        "--json", "url,headRefOid,headRefName,baseRefName", "--limit", "100",
      ],
      { cwd: mainRoot },
      "cannot inspect existing pull requests",
    );
    const rows = githubJson(listed, "cannot inspect existing pull requests");
    if (!Array.isArray(rows)) throw new Error("cannot inspect existing pull requests: expected an array");
    const matches = rows.filter((row) => row?.headRefOid === headRef
      && row?.headRefName === headBranch && row?.baseRefName === baseBranch && typeof row?.url === "string" && row.url);
    if (matches.length > 1) throw new Error(`multiple open pull requests match published candidate ${headRef}`);
    return matches[0]?.url ?? "";
  }

  return Object.freeze({
    async openPullRequest({ mainRoot, baseBranch, headBranch, headRef, title, body = "" }) {
      const repository = await repositoryFor(mainRoot);
      const existing = await matchingPullRequest({ mainRoot, repository, baseBranch, headBranch, headRef });
      if (existing) return existing;
      const pullRequestTitle = String(title ?? "").trim() || headBranch;
      const args = [
        "pr", "create", "--repo", repository,
        "--base", baseBranch,
        "--head", headBranch,
        "--title", pullRequestTitle,
        "--body", String(body ?? ""),
      ];
      const opened = await run("gh", args, { cwd: mainRoot });
      if (opened?.code !== 0) {
        // A timeout/504 can arrive after GitHub committed the mutation. Query
        // the exact head OID before deciding whether a retry is safe.
        const recovered = await matchingPullRequest({ mainRoot, repository, baseBranch, headBranch, headRef });
        if (recovered) return recovered;
        throw new Error(`pull request creation failed: ${reason(opened, "command failed")}`);
      }
      const pullRequest = String(opened.stdout ?? "").trim().split(/\r?\n/).at(-1)?.trim() ?? "";
      if (!pullRequest) throw new Error("pull request creation failed: GitHub did not return a pull request URL");
      return pullRequest;
    },

    async mergePullRequest({ mainRoot, pullRequest, headRef }) {
      const repository = await repositoryFor(mainRoot);
      await checked(
        run,
        "gh",
        ["pr", "merge", pullRequest, "--repo", repository, "--merge", "--match-head-commit", headRef],
        { cwd: mainRoot },
        "pull request merge failed",
      );
    },
  });
}

const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Publish and independently verify the exact reviewed commit before PR work. */
export async function publishCandidate(run, state, { mainRoot = state.mainRoot, worktree = state.worktree } = {}) {
  const remoteRef = `refs/heads/${state.branch}`;
  await checked(run, "git", ["check-ref-format", remoteRef], { cwd: mainRoot }, "proposal branch name is invalid");
  const resolved = await checked(
    run, "git", ["rev-parse", "--verify", state.ref], { cwd: worktree }, "local candidate does not resolve",
  );
  const candidateOid = resolved.stdout.trim().toLowerCase();
  if (!GIT_OID.test(candidateOid)) throw new Error(`local candidate resolved to an invalid object id: ${resolved.stdout.trim()}`);
  const localType = await checked(
    run, "git", ["cat-file", "-t", candidateOid], { cwd: worktree }, "cannot inspect local candidate object type",
  );
  if (localType.stdout.trim() !== "commit") {
    throw new Error(`local candidate ${candidateOid} has object type ${localType.stdout.trim() || "unknown"}, not commit`);
  }

  // Import by immutable OID, not by a potentially stale or ambiguous branch.
  await checked(
    run, "git", ["fetch", "--no-tags", worktree, candidateOid], { cwd: mainRoot }, "cannot import exact proposal commit",
  );
  const importedType = await checked(
    run, "git", ["cat-file", "-t", candidateOid], { cwd: mainRoot }, "cannot inspect imported proposal object type",
  );
  if (importedType.stdout.trim() !== "commit") {
    throw new Error(`imported candidate ${candidateOid} has object type ${importedType.stdout.trim() || "unknown"}, not commit`);
  }
  await checked(
    run,
    "git",
    ["push", "origin", `${candidateOid}:${remoteRef}`],
    { cwd: mainRoot },
    "proposal push failed",
  );

  const queried = await checked(
    run, "git", ["ls-remote", "--refs", "origin", remoteRef], { cwd: mainRoot }, "cannot query published proposal ref",
  );
  const rows = String(queried.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) {
    throw new Error(`published proposal ref ${remoteRef} is ${rows.length ? "ambiguous" : "missing"}; expected exactly ${candidateOid}`);
  }
  const match = rows[0].match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/i);
  if (!match || match[2] !== remoteRef) {
    throw new Error(`published proposal ref query was ambiguous or malformed: ${rows[0]}`);
  }
  const remoteOid = match[1].toLowerCase();
  if (remoteOid !== candidateOid) {
    throw new Error(`published proposal OID mismatch: local ${candidateOid}, remote ${remoteOid}`);
  }

  const evidenceId = String(state.delegationId || state.id || candidateOid.slice(0, 12)).replace(/[^a-z0-9-]/gi, "-").slice(0, 80);
  const evidenceRef = `refs/qq-workflows/published/${evidenceId}`;
  await checked(
    run,
    "git",
    ["fetch", "--no-tags", "origin", `${remoteRef}:${evidenceRef}`],
    { cwd: mainRoot },
    "cannot fetch exact published proposal ref",
  );
  const fetched = await checked(
    run, "git", ["rev-parse", "--verify", evidenceRef], { cwd: mainRoot }, "cannot resolve fetched publication evidence",
  );
  const fetchedOid = fetched.stdout.trim().toLowerCase();
  const remoteType = await checked(
    run, "git", ["cat-file", "-t", evidenceRef], { cwd: mainRoot }, "cannot inspect published proposal object type",
  );
  if (fetchedOid !== candidateOid) {
    throw new Error(`fetched proposal OID mismatch: local ${candidateOid}, fetched ${fetchedOid}`);
  }
  if (remoteType.stdout.trim() !== "commit") {
    throw new Error(`published proposal ${candidateOid} has object type ${remoteType.stdout.trim() || "unknown"}, not commit`);
  }
  return Object.freeze({ candidateOid, localType: "commit", remoteOid: fetchedOid, remoteType: "commit", remoteRef, evidenceRef });
}

export async function landWorktree(run, state, { github = createGitHubClient(run) } = {}) {
  const mainRoot = await realpath(state.mainRoot);
  const worktree = await realpath(state.worktree);
  if (mainRoot === worktree) throw new Error("land refuses to merge from the main checkout");
  const branch = await checked(
    run, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: mainRoot }, "main checkout is detached",
  );
  if (branch.stdout.trim() !== state.baseBranch) {
    throw new Error(`main checkout is on ${branch.stdout.trim()}, not ${state.baseBranch}`);
  }
  const mainStatus = await checked(
    run, "git", ["status", "--porcelain", "--untracked-files=all"], { cwd: mainRoot }, "cannot inspect main checkout",
  );
  if (String(mainStatus.stdout ?? "").trim()) throw new Error("main checkout is dirty");
  const worktreeStatus = await checked(
    run, "git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree }, "cannot inspect delegated worktree",
  );
  if (worktreeStatus.stdout.trim()) throw new Error("delegated worktree has uncommitted residue");
  const proposalPresence = await run(
    "git", ["diff", "--quiet", `${state.baseRef}...${state.ref}`, "--"], { cwd: worktree },
  );
  if (proposalPresence?.code === 0) throw new Error("delegated proposal has no changes relative to its reviewed base");
  if (proposalPresence?.code !== 1) throw new Error(`cannot inspect whether proposal has changes: ${reason(proposalPresence, "git diff failed")}`);
  const proposalDiff = await checked(
    run, "git", ["diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", `${state.baseRef}...${state.ref}`, "--"],
    { cwd: worktree }, "cannot inspect proposal paths",
  );
  const proposalPaths = parseChangedPaths(proposalDiff.stdout);
  const generatedPaths = proposalPaths.filter((path) => path === "openwiki" || path.startsWith("openwiki/"));
  if (generatedPaths.length) {
    throw new Error(`delegated proposal changes generated OpenWiki paths: ${generatedPaths.join(", ")}`);
  }
  const proposalSubject = await checked(
    run,
    "git",
    ["show", "-s", "--format=%s", state.ref],
    { cwd: worktree },
    "cannot read proposal title",
  );

  // Fail closed on publication. GitHub is not called until the exact immutable
  // candidate is independently visible as a commit at the exact remote ref.
  const publication = await publishCandidate(run, state, { mainRoot, worktree });
  const pullRequest = String(await github.openPullRequest({
    mainRoot,
    baseBranch: state.baseBranch,
    headBranch: state.branch,
    headRef: publication.candidateOid,
    title: proposalSubject.stdout.trim() || state.branch,
    body: `Automated Land proposal for ${publication.candidateOid}.`,
  }) ?? "").trim();
  if (!pullRequest) throw new Error("pull request creation failed: GitHub did not return a pull request identifier");
  await github.mergePullRequest({
    mainRoot,
    pullRequest,
    baseBranch: state.baseBranch,
    headBranch: state.branch,
    headRef: publication.candidateOid,
  });
  await checked(
    run,
    "git",
    ["fetch", "origin", state.baseBranch],
    { cwd: mainRoot },
    "origin fetch after pull request merge failed",
  );
  await checked(
    run,
    "git",
    ["merge-base", "--is-ancestor", publication.candidateOid, `origin/${state.baseBranch}`],
    { cwd: mainRoot },
    "pull request merge is not present on origin",
  );
  await checked(
    run,
    "git",
    ["merge", "--ff-only", `origin/${state.baseBranch}`],
    { cwd: mainRoot },
    "local main fast-forward failed",
  );

  const localHead = await checked(
    run,
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: mainRoot },
    "cannot verify local main after fast-forward",
  );
  const originHead = await checked(
    run,
    "git",
    ["rev-parse", "--verify", `origin/${state.baseBranch}`],
    { cwd: mainRoot },
    "cannot verify origin main after fast-forward",
  );
  if (localHead.stdout.trim() !== originHead.stdout.trim()) {
    throw new Error("local main does not match origin/main after fast-forward");
  }

  // No cleanup is allowed until landing and the local fast-forward have
  // both succeeded. A failed land remains inspectable and retryable.
  const isWorktree = existsSync(join(worktree, ".git")) && !existsSync(join(worktree, ".git", "HEAD"));
  if (isWorktree) {
    await checked(
      run, "git", ["worktree", "remove", "--force", worktree], { cwd: mainRoot }, "worktree cleanup failed",
    );
  } else {
    try {
      rmSync(worktree, { recursive: true, force: true });
    } catch {
      await run("rm", ["-rf", worktree]);
    }
  }
  await run("git", ["branch", "-D", state.branch], { cwd: mainRoot });
  // Publication failures retain this evidence ref. A fully landed proposal no
  // longer needs the duplicate object pointer.
  await run("git", ["update-ref", "-d", publication.evidenceRef], { cwd: mainRoot });
  return state;
}

function registerTools(child, definitions) {
  const tools = toolsService(child);
  if (!tools || typeof tools.register !== "function") return () => {};
  const disposers = definitions.map((tool) => tools.register(tool));
  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch {}
    }
  };
}

export function createLand({
  ctx,
  store,
  settings,
  agents,
  tasks,
  run = runCommand,
  github = createGitHubClient(run),
  env = process.env,
} = {}) {
  const childTools = new Map();
  const childOwners = new Map();
  const settlementPromises = new Map();
  const settledQa = new Set();
  // These controller-level sets, unlike owner diagnostics, survive the gap in
  // which a committed phase transition has disposed its old child but has not
  // retained the intended successor yet.
  const activeSubmissions = new Set();
  const activeTransitions = new Set();
  const pendingRecoveries = new Map();
  let closing = false;
  let disposePromise = null;

  function tasksOf() {
    return typeof tasks === "function" ? tasks() : tasks ?? null;
  }

  function binding(role) {
    return settings?.get?.(role) ?? null;
  }

  function pendingPhaseMessage(_state, pending) {
    return renderDelegationPhaseTask(pending);
  }

  async function ensureTaskArtifact(state) {
    if (!state?.brief) throw new Error(`delegation ${state?.id || "unknown"} has no durable task for a fresh phase`);
    const artifact = await materializeTaskArtifact(run, {
      worktree: state.worktree,
      task: state.brief,
      expectedDigest: state.taskArtifact?.sha256,
    });
    const same = state.taskArtifact
      && state.taskArtifact.path === artifact.path
      && state.taskArtifact.pointer === artifact.pointer
      && state.taskArtifact.sha256 === artifact.sha256
      && state.taskArtifact.bytes === artifact.bytes;
    return same ? state : store.save({ ...state, taskArtifact: artifact });
  }

  function planPhase(state, role, { task, user, delta } = {}) {
    if (!DELEGATION_PHASE_ROLES.has(role)) throw new Error(`cannot plan invalid workflow role ${role}`);
    const latest = store.load(state.id) ?? state;
    if (!latest.transitioning) throw new Error(`delegation ${state.id} is not transitioning`);
    if (latest.pendingPhase) {
      if (latest.pendingPhase.role !== role) {
        throw new Error(`delegation ${state.id} already plans ${latest.pendingPhase.role}`);
      }
      return latest;
    }
    if (!latest.taskArtifact) throw new Error(`delegation ${state.id} has no exact task artifact`);
    const pendingPhase = {
      sessionUuid: `session-${randomUUID()}`,
      role,
      phaseEpoch: latest.phaseEpoch + 1,
      messageId: randomUUID(),
      message: "",
      input: {
        schema: DELEGATION_PHASE_INPUT_SCHEMA,
        taskArtifact: latest.taskArtifact.pointer,
        taskSha256: latest.taskArtifact.sha256,
        proposal: formatPacket(latest.packet),
        delta: boundFormattedText(delta ?? task ?? user ?? "Continue the current workflow phase.", PHASE_DELTA_MAX_CHARS, "phase delta"),
      },
      messageDelivered: false,
    };
    return store.save({ ...latest, pendingPhase });
  }

  function phaseFields(pending) {
    if (pending.role === "implementation") {
      return {
        status: "revising",
        implementationSession: pending.sessionUuid,
        qaSession: "",
      };
    }
    if (pending.role === "qa") {
      return {
        status: "reviewing",
        qaSession: pending.sessionUuid,
        qaVerdict: null,
      };
    }
    throw new Error(`cannot promote unsupported pending workflow role ${pending.role}`);
  }

  function promotePendingPhase(state, expected = state.pendingPhase) {
    if (!expected) throw new Error(`delegation ${state.id} has no pending phase`);
    const latest = store.load(state.id) ?? state;
    if (latest.current?.sessionUuid === expected.sessionUuid
      && latest.current.role === expected.role
      && latest.current.phaseEpoch === expected.phaseEpoch) {
      return latest;
    }
    const pending = latest.pendingPhase;
    if (!pending || pending.sessionUuid !== expected.sessionUuid
      || pending.role !== expected.role || pending.phaseEpoch !== expected.phaseEpoch) {
      throw new Error(`delegation ${state.id} pending phase changed before promotion`);
    }
    return store.save(advancePhase(latest, pending.sessionUuid, pending.role, {
      ...phaseFields(pending),
      settlementSession: "",
      settlementCallId: "",
      settlementTransition: "",
    }));
  }

  function pendingPhaseMatches(left, right) {
    return Boolean(left && right
      && left.sessionUuid === right.sessionUuid
      && left.role === right.role
      && left.phaseEpoch === right.phaseEpoch
      && left.messageId === right.messageId
      && left.message === right.message
      && JSON.stringify(left.input) === JSON.stringify(right.input));
  }

  function markPendingMessageDelivered(state, expected) {
    const latest = store.load(state.id) ?? state;
    const pending = latest.pendingPhase;
    if (!pendingPhaseMatches(pending, expected)) {
      throw new Error(`delegation ${state.id} pending packet changed before delivery acknowledgement`);
    }
    if (pending.messageDelivered) return latest;
    return store.save({
      ...latest,
      pendingPhase: { ...pending, messageDelivered: true },
    });
  }

  function activatePendingChild(owner, state, expected = state.pendingPhase) {
    if (!owner || !expected || !expected.messageId || (!expected.message && !expected.input)) {
      throw new Error(`delegation ${state.id} pending phase has no durable work packet`);
    }
    let latest = store.load(state.id) ?? state;
    let pending = latest.pendingPhase;
    if (!pendingPhaseMatches(pending, expected)) {
      throw new Error(`delegation ${state.id} pending phase changed before packet delivery`);
    }
    if (!pending.messageDelivered) {
      if (childOwners.get(owner.sessionId) !== owner) return latest;
      if (!messageInserted(owner.child, pending.messageId)) {
        if (typeof owner.child?.followup !== "function") {
          throw new Error(`${owner.role} child cannot accept its work packet`);
        }
        owner.child.followup({
          id: pending.messageId,
          role: "user",
          content: [{ type: "text", text: pendingPhaseMessage(latest, pending) }],
          source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
        });
      }
      if (childOwners.get(owner.sessionId) !== owner) return store.load(state.id) ?? latest;
      if (!messageInserted(owner.child, pending.messageId)) {
        throw new Error(`${owner.role} child did not retain its work packet`);
      }
      latest = markPendingMessageDelivered(latest, pending);
      pending = latest.pendingPhase;
    }
    if (childOwners.get(owner.sessionId) !== owner) return latest;
    latest = promotePendingPhase(latest, pending);
    if (pending.role === "qa") {
      if (!childTools.has(owner.sessionId)) installQa(owner.child, latest.id);
      watchQaSettle(owner.child, latest.id);
    } else {
      if (!childTools.has(owner.sessionId)) installDone(owner.child, latest.id);
    }
    return latest;
  }

  function matchesPendingHeaders(child, state, pending) {
    const header = child?.session?.header;
    return header?.delegationId === state.delegationId
      && header?.delegationPhaseRole === pending.role
      && header?.delegationPhaseEpoch === pending.phaseEpoch;
  }



  function sessionsOf() {
    return ctx.get?.("sessions", false) ?? null;
  }

  async function directPacket(state, kind, fromId) {
    const parentSessionUuid = state.parentSessionUuid || state.architectSession;
    const parent = agents?.get?.(parentSessionUuid);
    if (!parent || typeof parent.steer !== "function") return false;
    const messageId = state.reportEnvelopeId;
    if (!messageId) return false;
    if (messageInserted(parent, messageId)) return true;
    const message = formatOutcome(state, kind);
    try {
      parent.steer({
        id: messageId,
        role: "user",
        content: [{ type: "text", text: `${message}\n\nReported by physical workflow child ${fromId || state.id}.` }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "relay" },
      });
      try { await sessionsOf()?.flush?.(parent.session); } catch { /* inbox splice is already durable */ }
      return true;
    } catch (error) {
      logLine(ctx, "warn", `qq-workflows: direct land packet delivery failed for ${parentSessionUuid}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function sendPacket(state, kind, fromId, { directOnly = false } = {}) {
    const parentSessionUuid = state.parentSessionUuid || state.architectSession;
    if (!parentSessionUuid) return true;
    const relay = relayOf(ctx);
    const sender = fromId || state.qaSession || state.implementationSession || state.id;
    if (!directOnly && relay && typeof relay.send === "function") {
      try {
        await relay.send({
          fromId: sender,
          to: parentSessionUuid,
          message: formatOutcome(state, kind),
          delivery: "default",
          messageId: state.reportEnvelopeId,
        });
        return true;
      } catch (error) {
        logLine(ctx, "warn", `qq-workflows: relay packet delivery from ${sender} failed, trying live parent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return directPacket(state, kind, sender);
  }

  async function deliverRequiredPacket(state, kind, fromId, options) {
    const parentSessionUuid = state.parentSessionUuid || state.architectSession;
    const reportEnvelopeId = parentSessionUuid ? (state.reportEnvelopeId || randomUUID()) : state.reportEnvelopeId;
    let next = store.save({
      ...state,
      reportPending: Boolean(parentSessionUuid),
      reportEnvelopeId,
      reportKind: parentSessionUuid ? kind : "",
      reportFromSession: parentSessionUuid ? String(fromId || "") : "",
    });
    const delivered = await sendPacket(next, kind, fromId, options);
    if (delivered) {
      next = store.save({
        ...next,
        reportPending: false,
        reportKind: "",
        reportFromSession: "",
      });
    }
    return { state: next, delivered };
  }

  function blockOwnedWork(owner, blockedReason) {
    if (!owner?.delegationId) return { state: null, changed: false };
    const state = store.load(owner.delegationId);
    if (!state || state.status === "blocked" || state.status === "landed") {
      return { state, changed: false };
    }
    const ownsCurrent = owner.role === "qa"
      ? state.qaSession === owner.sessionId
      : state.implementationSession === owner.sessionId;
    if (!ownsCurrent) return { state, changed: false };
    const blocked = store.save(finishWorkflow(state, {
      status: "blocked",
      blockedReason: String(blockedReason || `${owner.role} child closed`),
      packet: state.packet ? { ...state.packet, mark: "fail" } : state.packet,
    }));
    return { state: blocked, changed: true };
  }

  function isHookInterruption(reason) {
    return reason?.kind === "aborted" && reason.reason?.kind === "hook";
  }

  function watchImplementationCancel(child, delegationId) {
    const sessionId = sessionIdOf(child);
    const off = child.ctx?.on?.("session/event", async (_session, event) => {
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      if (reason?.kind !== "aborted" || isHookInterruption(reason)) return;
      const owner = childOwners.get(sessionId);
      if (!owner || owner.delegationId !== delegationId || owner.disposePromise) return;
      const blocked = blockOwnedWork(owner, "implementation child was cancelled before done");
      if (!blocked.changed) return;
      const report = await deliverRequiredPacket(blocked.state, "blocked", sessionId);
      if (report.delivered) await disposeChild(sessionId, "implementation cancellation reported");
    });
    return typeof off === "function" ? off : () => {};
  }

  function clearChildTools(sessionId) {
    const disposeTools = childTools.get(sessionId);
    childTools.delete(sessionId);
    try { disposeTools?.(); } catch { /* child teardown is best effort */ }
  }

  function clearOwnerLifecycle(owner, { notifyFailure = true } = {}) {
    for (const pending of owner?.settlements?.values?.() ?? []) {
      if (notifyFailure && !pending.failureNotified) {
        try { pending.onFailure?.(); } catch { /* retry policy is best effort */ }
      }
      pending.resolve(false);
    }
    owner?.settlements?.clear?.();
    for (const off of owner?.lifecycleOffs ?? []) {
      try { off?.(); } catch { /* best effort */ }
    }
    if (owner) {
      owner.lifecycleOffs = [];
      owner.qaSettleOff = null;
    }
  }

  function rememberSettlement(owner, transition, callId = "") {
    if (!SETTLEMENT_TRANSITIONS.has(transition)) {
      throw new Error(`unknown child settlement transition ${transition}`);
    }
    const state = store.load(owner.delegationId);
    if (!state) throw new Error(`child settlement has no delegation ${owner.delegationId}`);
    return store.save({
      ...state,
      settlementSession: owner.sessionId,
      settlementCallId: callId,
      settlementTransition: transition,
    });
  }

  function clearRememberedSettlement(owner, callId = "") {
    const state = store.load(owner.delegationId);
    if (!state || state.settlementSession !== owner.sessionId) return state;
    if (callId && state.settlementCallId && state.settlementCallId !== callId) return state;
    return store.save({
      ...state,
      settlementSession: "",
      settlementCallId: "",
      settlementTransition: "",
    });
  }

  function trackControllerTransition(promise, owner) {
    activeTransitions.add(promise);
    owner?.activeTransitions.add(promise);
    void promise.finally(() => {
      activeTransitions.delete(promise);
      owner?.activeTransitions.delete(promise);
    }).catch(() => {});
    return promise;
  }

  function runArmedSettlement(owner, pending) {
    if (pending.started || (!pending.resultCommitted && !pending.resultFailed) || !pending.idle) return;
    pending.started = true;
    owner.settlements.delete(pending.callId);
    // Defer execution one microtask so the controller owns the transition
    // promise before any action can dispose the old owner or trigger teardown.
    const promise = Promise.resolve().then(async () => {
      if (pending.resultFailed) {
        let delivered = false;
        try {
          delivered = await pending.failureAction?.() === true;
        } catch (error) {
          logLine(ctx, "warn", `qq-workflows: failed tool-result recovery for ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (delivered) await disposeChild(owner.sessionId, "failed tool result reported");
        clearRememberedSettlement(owner, pending.callId);
        pending.resolve(false);
        return false;
      }
      try {
        await pending.action();
        clearRememberedSettlement(owner, pending.callId);
        pending.resolve(true);
        return true;
      } catch (error) {
        logLine(ctx, "warn", `qq-workflows: post-result child settlement failed for ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        pending.resolve(false);
        return false;
      }
    });
    trackControllerTransition(promise, owner);
    settlementPromises.set(owner.sessionId, promise);
  }

  function resultBlocksFor(message, callId) {
    return (Array.isArray(message?.content) ? message.content : []).filter((block) =>
      block?.type === "tool-result" && block.toolCallId === callId);
  }

  function resultCallId(message) {
    const sourceCallId = message?.source?.kind === "tool" ? message.source.callId : undefined;
    if (typeof sourceCallId === "string" && sourceCallId) return sourceCallId;
    const block = (Array.isArray(message?.content) ? message.content : []).find((item) =>
      item?.type === "tool-result" && typeof item.toolCallId === "string" && item.toolCallId);
    return block?.toolCallId;
  }

  function errorEnvelopeCommitsPass(owner, pending) {
    if (pending.transition !== "finish_land") return false;
    return store.load(owner.delegationId)?.qaVerdict?.verdict === "pass";
  }

  function failArmedSettlement(owner, pending) {
    if (pending.started || pending.resultFailed) return;
    pending.resultFailed = true;
    if (!pending.failureNotified) {
      pending.failureNotified = true;
      try { pending.onFailure?.(); } catch { /* retry policy is best effort */ }
    }
    runArmedSettlement(owner, pending);
  }

  function installOwnerLifecycle(owner) {
    const offs = [];
    const eventOff = owner.child.ctx?.on?.("session/event", (_session, event) => {
      if (event?.type !== "tool/result") return;
      const message = event.data?.message;
      const callId = resultCallId(message);
      const pending = owner.settlements.get(callId);
      if (!pending || pending.started) return;
      const blocks = resultBlocksFor(message, callId);
      if (blocks.length === 0) return;
      if (blocks.some((block) => block.isError === true) && !errorEnvelopeCommitsPass(owner, pending)) {
        failArmedSettlement(owner, pending);
        return;
      }
      pending.resultCommitted = true;
      runArmedSettlement(owner, pending);
    });
    if (typeof eventOff === "function") offs.push(eventOff);
    const statusOff = owner.child.ctx?.on?.("agent/status", ({ status } = {}) => {
      if (status !== "idle") return;
      for (const pending of owner.settlements.values()) {
        pending.idle = true;
        runArmedSettlement(owner, pending);
      }
    });
    if (typeof statusOff === "function") offs.push(statusOff);
    owner.lifecycleOffs = offs;
  }

  function failureActionFor(owner, reason) {
    return async () => {
      const currentOwner = childOwners.get(owner.sessionId);
      if (!currentOwner) return true;
      const blocked = blockOwnedWork(currentOwner, `${reason} failed before settlement`);
      const state = blocked.state ?? store.load(currentOwner.delegationId);
      if (!state) return true;
      if (!blocked.changed && !state.reportPending) return true;
      const report = await deliverRequiredPacket(
        state,
        state.reportKind || "blocked",
        state.reportFromSession || owner.sessionId,
      );
      return report.delivered;
    };
  }

  function addPendingSettlement(owner, { callId, reason, transition, action, onFailure, resolve }) {
    if (owner.settlements.has(callId)) return owner.settlements.get(callId);
    const pending = {
      callId,
      reason,
      transition,
      action,
      onFailure,
      failureAction: failureActionFor(owner, reason),
      resolve,
      resultCommitted: false,
      resultFailed: false,
      failureNotified: false,
      idle: owner.child.status === "idle",
      started: false,
    };
    owner.settlements.set(callId, pending);
    return pending;
  }

  function postToolSettlement(sessionId, result, reason, transition, action, submission) {
    const owner = submission?.owner ?? childOwners.get(sessionId);
    if (!owner || childOwners.get(sessionId) !== owner) return null;
    rememberSettlement(owner, transition);
    const waiting = Promise.withResolvers();
    const settlement = {
      settled: waiting.promise,
      arm({ callId, onFailure } = {}) {
        try {
          if (typeof callId !== "string" || !callId) throw new Error("child settlement requires a tool call id");
          if (owner.settlements.has(callId)) throw new Error(`child settlement already armed for ${callId}`);
          rememberSettlement(owner, transition, callId);
          addPendingSettlement(owner, {
            callId,
            reason,
            transition,
            action,
            onFailure,
            resolve: waiting.resolve,
          });
        } finally {
          submission?.release();
        }
      },
    };
    settlementPromises.set(sessionId, waiting.promise);
    withChildSettlement(result, settlement);
    submission?.hold();
    return settlement;
  }

  async function trackChildSubmission(sessionId, action) {
    if (closing) return { status: "refused", reason: "workflow child is no longer owned because its controller is closing" };
    const owner = childOwners.get(sessionId);
    if (!owner) return { status: "refused", reason: "workflow child is no longer owned" };
    const waiting = Promise.withResolvers();
    const submission = {
      owner,
      held: false,
      released: false,
      hold() { this.held = true; },
      release() {
        if (this.released) return;
        this.released = true;
        owner.activeSubmissions.delete(waiting.promise);
        activeSubmissions.delete(waiting.promise);
        waiting.resolve();
      },
    };
    owner.activeSubmissions.add(waiting.promise);
    activeSubmissions.add(waiting.promise);
    try {
      return await action(submission);
    } finally {
      if (!submission.held) submission.release();
    }
  }

  function retainChild(handle, { child = handle?.agent ?? handle, role, workflowRole, delegationId } = {}) {
    // Accepted controller transitions may finish while closing, but no caller
    // can establish ownership after the controller has drained those promises.
    if (closing && activeTransitions.size === 0) {
      throw new Error("land workflow controller is closing");
    }
    const sessionId = sessionIdOf(child);
    if (!sessionId) throw new Error("child AgentHandle has no session");
    if (handle?.agent && handle.agent !== child) {
      throw new Error(`child AgentHandle does not own ${sessionId}`);
    }
    if (isLandCandidate(child) || child?.session?.header?.origin !== CHILD_ORIGIN) {
      throw new Error("land refuses to own a parent or root AgentHandle");
    }
    const existing = childOwners.get(sessionId);
    if (existing) {
      if (existing.handle !== handle) throw new Error(`land already owns child ${sessionId}`);
      if (workflowRole) existing.workflowRole = workflowRole;
      if (delegationId) existing.delegationId = delegationId;
      hangChildLabels(ctx, existing);
      return existing;
    }
    const owner = {
      sessionId,
      child,
      handle,
      role: role || child?.session?.header?.delegationRole || "implementation",
      workflowRole: workflowRole || child?.session?.header?.delegationPhaseRole || (role === "qa" ? "qa" : "implementation"),
      delegationId: delegationId || child?.session?.header?.delegationId || "",
      workflowLabels: new Set(),
      disposePromise: null,
      externalDisposed: false,
      settlements: new Map(),
      lifecycleOffs: [],
      qaSettleOff: null,
      activeSubmissions: new Set(),
      activeTransitions: new Set(),
    };
    childOwners.set(sessionId, owner);
    hangChildLabels(ctx, owner);
    installOwnerLifecycle(owner);
    try {
      Object.defineProperty(child, CHILD_AGENT_HANDLE, {
        value: handle,
        configurable: true,
      });
    } catch {
      // The in-memory owner remains authoritative for this plugin lifetime.
    }
    return owner;
  }

  function clearRetainedHandle(owner) {
    try {
      if (owner?.child?.[CHILD_AGENT_HANDLE] === owner.handle) delete owner.child[CHILD_AGENT_HANDLE];
    } catch { /* non-extensible Agent */ }
  }

  function forgetChildOwner(owner) {
    if (!owner) return;
    clearChildTools(owner.sessionId);
    clearOwnerLifecycle(owner);
    clearChildLabels(ctx, owner);
    clearRetainedHandle(owner);
    if (childOwners.get(owner.sessionId) === owner) childOwners.delete(owner.sessionId);
    settledQa.delete(owner.sessionId);
  }

  function detachChildOwner(owner) {
    if (!owner) return false;
    clearChildTools(owner.sessionId);
    clearOwnerLifecycle(owner, { notifyFailure: false });
    clearChildLabels(ctx, owner);
    if (childOwners.get(owner.sessionId) === owner) childOwners.delete(owner.sessionId);
    settledQa.delete(owner.sessionId);
    // The AgentHandle capability deliberately remains on the live child. A
    // replacement controller discovers that child through agents.list() and
    // re-retains this exact handle from the durable delegation.
    return true;
  }

  async function disposeChild(agentOrId, reason = "settled") {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const owner = childOwners.get(sessionId);
    if (!owner) return false;
    if (!owner.disposePromise) {
      clearChildTools(sessionId);
      clearOwnerLifecycle(owner);
      clearChildLabels(ctx, owner);
      owner.disposePromise = (async () => {
        try {
          await owner.handle?.dispose?.();
        } catch (error) {
          logLine(
            ctx,
            "warn",
            `qq-workflows: failed to dispose ${owner.role} child ${sessionId} (${reason}): ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearRetainedHandle(owner);
          if (childOwners.get(sessionId) === owner) childOwners.delete(sessionId);
        }
      })();
    }
    await owner.disposePromise;
    return true;
  }

  async function releaseChild(agentOrId) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const owner = childOwners.get(sessionId);
    if (!owner) return false;
    if (!owner.disposePromise) {
      owner.externalDisposed = true;
      const blocked = blockOwnedWork(owner, `${owner.role} child closed before completion`);
      const state = blocked.state ?? store.load(owner.delegationId);
      if (state && (blocked.changed || state.reportPending)) {
        const report = await deliverRequiredPacket(
          state,
          state.reportKind || (state.status === "landed" ? "landed" : "blocked"),
          state.reportFromSession || sessionId,
          { directOnly: true },
        );
        if (!report.delivered) return false;
      }
    }
    forgetChildOwner(owner);
    return true;
  }

  function refreshLabels() {
    let refreshed = 0;
    for (const owner of childOwners.values()) {
      if (hangChildLabels(ctx, owner)) refreshed++;
    }
    return refreshed;
  }

  function installDone(child, delegationId) {
    const sessionId = sessionIdOf(child);
    childTools.get(sessionId)?.();
    const submit = (args) => trackChildSubmission(sessionId, (submission) =>
      done({ ...args, delegationId, postTool: true, submission }));
    const disposeSubmit = isMiniAgent(child)
      ? bindMiniSubmit(child, submit)
      : registerTools(child, [buildDoneTool({ submit })]);
    const disposeCancel = watchImplementationCancel(child, delegationId);
    const dispose = () => {
      try { disposeCancel(); } finally { disposeSubmit(); }
    };
    childTools.set(sessionId, dispose);
    return dispose;
  }

  function installQa(child, delegationId) {
    const sessionId = sessionIdOf(child);
    childTools.get(sessionId)?.();
    const state = store.load(delegationId);
    if (!state) throw new Error(`cannot install mini-qa for missing delegation ${delegationId}`);
    ensureMiniQaMounted(child);
    const capsuleGitDir = join(state.worktree, ".git");
    const oracle = new RepoOracle(state.baseRef, state.ref, {
      // Delegated shared clones keep proposal objects in their internal .git.
      // Linked-worktree callers use the common main object database instead.
      gitDir: existsSync(join(capsuleGitDir, "HEAD"))
        ? capsuleGitDir
        : join(state.mainRoot, ".git"),
    });
    const dispose = bindMiniQaSubmit(child, {
      oracle,
      submit: (args) => trackChildSubmission(sessionId, (submission) =>
        submitVerdict({ ...args, delegationId, postTool: true, submission })),
      isCompleted: () => {
        const current = store.load(delegationId);
        return current?.qaSession === sessionId && Boolean(current.qaVerdict);
      },
    });
    childTools.set(sessionId, dispose);
    return dispose;
  }

  async function adoptImplementation(child, info = {}) {
    const sessionId = sessionIdOf(child);
    if (!sessionId) return { status: "refused", reason: "adopt requires a child session", owned: false };
    const cwd = info.cwd ?? child?.session?.header?.cwd;
    const brief = String(info.brief ?? info.packet ?? "");
    const architectSession = info.parent?.id ?? info.parentSession ?? "";
    let git;
    try {
      git = await inspectWorktree(run, cwd);
    } catch (error) {
      return {
        status: "refused",
        reason: `adopt requires a git worktree: ${error instanceof Error ? error.message : String(error)}`,
        owned: false,
      };
    }
    const delegationId = info.delegationId || randomUUID();
    let taskArtifact;
    try {
      taskArtifact = await materializeTaskArtifact(run, { worktree: git.worktree, task: brief });
    } catch (error) {
      return {
        status: "refused",
        reason: `cannot materialize exact task artifact: ${error instanceof Error ? error.message : String(error)}`,
        owned: false,
      };
    }
    let owner;
    let disposeBinding;
    try {
      if (info.handle) owner = retainChild(info.handle, { child, role: "implementation", workflowRole: "implementation", delegationId });
      disposeBinding = installDone(child, delegationId);
      try {
        child.session.header.delegationPhaseRole = "implementation";
      } catch { /* durable store and labels remain authoritative */ }
      const record = store.create({
        id: delegationId,
        delegationId,
        parentSessionUuid: architectSession,
        architectSession,
        taskId: info.taskId,
        implementationSession: sessionId,
        originalImplementationSession: sessionId,
        brief,
        taskArtifact,
        ...git,
      });
      try {
        child.session.header.delegationId = record.delegationId;
        child.session.header.delegationPhaseEpoch = record.phaseEpoch;
      } catch { /* durable store remains authoritative */ }
      return {
        status: "ok",
        delegationId: record.delegationId,
        child: sessionId,
        role: record.current.role,
        phaseEpoch: record.phaseEpoch,
        owned: Boolean(owner),
        rollback: async (rollbackReason = "delegate startup failed") => {
          const current = store.load(record.id);
          if (current && current.status === "running") {
            store.save(finishWorkflow(current, {
              status: "blocked",
              blockedReason: String(rollbackReason),
            }));
          }
          await disposeChild(sessionId, "adoption rollback");
        },
      };
    } catch (error) {
      if (owner) await disposeChild(sessionId, "adoption rollback");
      else {
        try { disposeBinding?.(); } catch { /* best effort rollback */ }
        childTools.delete(sessionId);
      }
      return {
        status: "refused",
        reason: error instanceof Error ? error.message : String(error),
        owned: Boolean(owner),
      };
    }
  }

  async function retryPendingReport(owner, state) {
    const kind = state.reportKind || (state.status === "landed" ? "landed" : "blocked");
    const report = await deliverRequiredPacket(state, kind, state.reportFromSession || owner.sessionId, { directOnly: true });
    if (report.delivered) {
      if (owner.externalDisposed) forgetChildOwner(owner);
      else await disposeChild(owner.sessionId, "pending report delivered");
    }
    return report.delivered;
  }

  function rememberedResult(child, callId) {
    const events = Array.isArray(child?.session?.events) ? child.session.events : [];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event?.type !== "tool/result") continue;
      const message = event.data?.message;
      if (resultCallId(message) !== callId) continue;
      const blocks = resultBlocksFor(message, callId);
      if (blocks.length === 0) continue;
      return { failed: blocks.some((block) => block.isError === true) };
    }
    return null;
  }

  function resumeRememberedSettlement(owner, state) {
    if (state.settlementSession !== owner.sessionId) return false;
    if (!SETTLEMENT_TRANSITIONS.has(state.settlementTransition)) return false;
    const callId = state.settlementCallId;
    if (!callId) return true;
    if (owner.settlements.has(callId) || owner.activeTransitions.size > 0) return true;
    const waiting = Promise.withResolvers();
    const reason = state.settlementTransition === "start_qa"
      ? "implementation done result committed"
      : state.settlementTransition === "start_implementation"
        ? "qa look 1 result committed"
        : state.settlementTransition === "finish_land"
          ? "qa pass result committed"
          : "terminal child result committed";
    const pending = addPendingSettlement(owner, {
      callId,
      reason,
      transition: state.settlementTransition,
      action: () => applyPostResultTransition({
        sessionId: owner.sessionId,
        delegationId: owner.delegationId,
        transition: state.settlementTransition,
      }),
      resolve: waiting.resolve,
    });
    const remembered = rememberedResult(owner.child, callId);
    if (remembered?.failed && !errorEnvelopeCommitsPass(owner, pending)) failArmedSettlement(owner, pending);
    else if (remembered) {
      pending.resultCommitted = true;
      runArmedSettlement(owner, pending);
    }
    settlementPromises.set(owner.sessionId, waiting.promise);
    return true;
  }

  function resumeChild(child, { allowClosing = false } = {}) {
    if (closing && !allowClosing) return false;
    const sessionId = sessionIdOf(child);
    if (!sessionId) return false;
    let state = store.bySession(sessionId);
    if (!state) return false;
    pinNonInteractiveApproval(child, { delegated: true });
    const pending = state.pendingPhase?.sessionUuid === sessionId ? state.pendingPhase : null;
    const recoverable = state.current?.sessionUuid === sessionId
      || state.settlementSession === sessionId
      || pending
      || (state.reportPending && state.reportFromSession === sessionId);
    if (!recoverable) return false;
    const retained = child?.[CHILD_AGENT_HANDLE] ?? child?.[AGENT_HANDLE];
    if (!retained) return false;
    let owner;
    if (pending) {
      if (!matchesPendingHeaders(child, state, pending)) return false;
      if (!pending.messageId || (!pending.message && !pending.input)) return false;
      const pendingRole = pending.role;
      owner = retainChild(retained, {
        child,
        role: pendingRole,
        workflowRole: pending.role,
        delegationId: state.id,
      });
      if (pending.input && !pending.messageDelivered) {
        void recoverPendingDelegation(state.id);
        return true;
      }
      try {
        state = activatePendingChild(owner, state, pending);
      } catch (error) {
        detachChildOwner(owner);
        throw error;
      }
      if (state.pendingPhase) return true;
    }
    const role = state.qaSession === sessionId ? "qa" : "implementation";
    const workflowRole = workflowRoleForState(state, sessionId, child?.session?.header?.delegationPhaseRole || role);
    owner ??= retainChild(retained, { child, role, workflowRole, delegationId: state.id });
    if (state.reportPending) {
      void retryPendingReport(owner, state);
      return true;
    }
    if (resumeRememberedSettlement(owner, state)) return true;
    if (role === "implementation" && (state.status === "running" || state.status === "revising")) {
      if (!childTools.has(sessionId)) installDone(child, state.id);
      return true;
    }
    if (role === "qa" && state.status === "reviewing") {
      if (!childTools.has(sessionId)) installQa(child, state.id);
      watchQaSettle(child, state.id);
      return true;
    }
    return true;
  }

  function resumeImplementation(child) {
    return isMiniAgent(child) && resumeChild(child);
  }

  async function spawnChild({ sessionUuid, role, workflowRole, delegationId, phaseEpoch, cwd, parentSession }) {
    if (!agents || typeof agents.create !== "function") {
      throw new Error("land requires ctx.agents.create");
    }
    const route = childRoute({
      binding: binding(role),
      env,
    });
    if (!SESSION_ID.test(sessionUuid)) throw new Error("land child requires its preplanned session UUID");
    const childId = sessionUuid;
    const mini = role === "implementation";
    const miniQa = role === "qa";
    const handle = adoptAgentHandle(await agents.create({
      sessionId: childId,
      meta: {
        cwd,
        parentSession,
        origin: CHILD_ORIGIN,
        delegationRole: role,
        delegationPhaseRole: workflowRole,
        delegationId: delegationId,
        delegationPhaseEpoch: phaseEpoch,
        ...(mini ? { kind: MINI_KIND, agentPreset: MINI_KIND } : {}),
        ...(miniQa ? { kind: MINI_QA_KIND, agentPreset: MINI_QA_KIND } : {}),
      },
      ...childCreateOptions(route, mini
        ? { setup: miniSetup }
        : miniQa ? { setup: miniQaSetup } : {}),
    }));
    const child = handle?.agent ?? handle;
    let retained = false;
    try {
      pinNonInteractiveApproval(child, { delegated: true });
      const owner = retainChild(handle, { child, role, workflowRole, delegationId });
      retained = true;
      return { child, owner };
    } catch (error) {
      if (retained) await disposeChild(childId, `${role} startup rollback`);
      else {
        try { await handle?.dispose?.(); } catch { /* preserve startup error */ }
      }
      throw error;
    }
  }

  function liveAgent(sessionId) {
    const direct = agents?.get?.(sessionId);
    if (direct) return direct;
    if (typeof agents?.list !== "function") return null;
    return agents.list().find((agent) => sessionIdOf(agent) === sessionId) ?? null;
  }

  async function recoverPendingPhase(delegationId) {
    let state = store.load(delegationId);
    const pending = state?.pendingPhase;
    if (!state || !pending || !state.transitioning) return false;
    if (!pending.messageId || (!pending.message && !pending.input)) {
      throw new Error(`delegation ${delegationId} pending phase has no durable work packet`);
    }
    // Structured records depend on the host-controlled artifact. Restore exact
    // durable bytes before recovered delivery. Legacy pre-rendered messages are
    // replayed byte-for-byte even when no artifact can be reconstructed.
    if (pending.input) state = await ensureTaskArtifact(state);

    const owned = childOwners.get(pending.sessionUuid);
    if (owned) {
      if (owned.delegationId !== state.id || owned.workflowRole !== pending.role) {
        throw new Error(`delegation ${delegationId} intended child is owned by another phase`);
      }
      activatePendingChild(owned, state, pending);
      return true;
    }

    // Same-process HMR leaves the AgentHandle capability on a live child. Use
    // it instead of touching agents.create, including pending packet recovery.
    let child = liveAgent(pending.sessionUuid);
    if (child) {
      return resumeChild(child, { allowClosing: true });
    }

    const role = pending.role;
    let spawned;
    try {
      spawned = await spawnChild({
        sessionUuid: pending.sessionUuid,
        role,
        workflowRole: pending.role,
        delegationId: state.delegationId,
        phaseEpoch: pending.phaseEpoch,
        cwd: state.worktree,
        parentSession: state.parentSessionUuid || state.architectSession,
      });
    } catch (error) {
      // A concurrent recovery can win the fixed-UUID create. Re-adopt that
      // exact endpoint when its retained capability is visible; never choose a
      // fresh UUID or issue a second create for this recovery attempt.
      child = liveAgent(pending.sessionUuid);
      if (child && resumeChild(child, { allowClosing: true })) return true;
      throw error;
    }

    state = store.load(delegationId) ?? state;
    if (state.current?.sessionUuid === pending.sessionUuid
      && state.current.role === pending.role
      && state.current.phaseEpoch === pending.phaseEpoch
      && !state.pendingPhase) {
      return true;
    }
    activatePendingChild(spawned.owner, state, pending);
    return true;
  }

  function recoverPendingDelegation(delegationId) {
    const existing = pendingRecoveries.get(delegationId);
    if (existing) return existing;
    if (closing) return Promise.resolve(false);
    // Register before executing recovery so plugin teardown sees the promise
    // even if apply and dispose occur in the same turn.
    const promise = Promise.resolve().then(() => recoverPendingPhase(delegationId));
    pendingRecoveries.set(delegationId, promise);
    trackControllerTransition(promise);
    void promise.finally(() => {
      if (pendingRecoveries.get(delegationId) === promise) pendingRecoveries.delete(delegationId);
    }).catch(() => {});
    return promise;
  }

  async function recoverPendingPhases() {
    if (closing) return [];
    const pending = store.list()
      .filter((state) => state.transitioning && state.pendingPhase)
      .map((state) => recoverPendingDelegation(state.id));
    return Promise.allSettled(pending);
  }

  function watchQaSettle(child, delegationId) {
    const childId = sessionIdOf(child);
    const owner = childOwners.get(childId);
    if (!childId || owner?.qaSettleOff) return owner?.qaSettleOff ?? null;
    const finish = async () => {
      if (settledQa.has(childId)) return;
      const state = store.load(delegationId);
      if (!state || state.qaSession !== childId || state.status !== "reviewing") return;
      if (state.qaVerdict) {
        settledQa.add(childId);
        return;
      }
      settledQa.add(childId);
      await submitVerdict({
        agent: child,
        delegationId,
        postTool: false,
        verdict: createQaVerdict({
          verdict: "fail",
          summary: "qa ended without a structured verdict",
          feedback: "qa ended without a structured verdict",
          tests_modified: false,
        }),
      });
    };
    const eventOff = child.ctx?.on?.("session/event", async (_session, event) => {
      if (event?.type !== "turn/end") return;
      if (isHookInterruption(event.data?.reason)) return;
      await finish();
    });
    const off = typeof eventOff === "function" ? eventOff : () => {};
    if (owner) {
      owner.qaSettleOff = off;
      owner.lifecycleOffs.push(off);
    }
    return off;
  }

  async function startQa(state) {
    state = await ensureTaskArtifact(state);
    const parentSession = state.parentSessionUuid || state.architectSession;
    const prior = state.look === 2 ? state.blockedReason : "";
    const task = [
      state.look === 1 ? "Look 1." : "Look 2, the final look. There is no third look.",
      `Review ref ${state.ref} against base ${state.baseRef}.`,
      prior ? `Prior look-1 rejection:\n${prior}` : "",
    ].filter(Boolean).join("\n\n");
    const workflowRole = "qa";
    const planned = planPhase(state, workflowRole, { delta: task });
    const pending = planned.pendingPhase;
    const spawned = await spawnChild({
      sessionUuid: pending.sessionUuid,
      role: "qa",
      workflowRole,
      delegationId: planned.delegationId,
      phaseEpoch: pending.phaseEpoch,
      cwd: planned.worktree,
      parentSession,
    });
    try {
      return activatePendingChild(spawned.owner, planned, pending);
    } catch (error) {
      await disposeChild(pending.sessionUuid, "qa phase promotion rollback");
      throw error;
    }
  }

  async function startImplementation(state, verdict) {
    state = await ensureTaskArtifact(state);
    const parentSession = state.parentSessionUuid || state.architectSession;
    const user = `QA rejected the proposal. ${verdict.feedback || verdict.summary} Address the findings, commit the result, then call done again with ref HEAD.`;
    const planned = planPhase(state, "implementation", { delta: user });
    const pending = planned.pendingPhase;
    const spawned = await spawnChild({
      sessionUuid: pending.sessionUuid,
      role: "implementation",
      workflowRole: pending.role,
      delegationId: planned.delegationId,
      phaseEpoch: pending.phaseEpoch,
      cwd: planned.worktree,
      parentSession,
    });
    try {
      return activatePendingChild(spawned.owner, planned, pending);
    } catch (error) {
      await disposeChild(pending.sessionUuid, "implementation phase promotion rollback");
      throw error;
    }
  }

  async function applyPostResultTransition({ sessionId, delegationId, transition, result }) {
    if (transition === "dispose") {
      await disposeChild(sessionId, "tool result settled");
      return;
    }
    if (transition === "finish_land") {
      const current = store.load(delegationId);
      if (!current) return;
      if (current.status === "landed"
        || (current.status === "blocked" && current.qaVerdict?.verdict !== "pass")) {
        await disposeChild(sessionId, "qa pass already settled");
        return;
      }
      if (current.qaSession !== sessionId || current.qaVerdict?.verdict !== "pass") {
        throw new Error("qa pass settlement has no owning pass verdict");
      }
      await land(current, sessionId);
      return;
    }
    if (transition === "start_qa") {
      await disposeChild(sessionId, "implementation done tool result settled");
      const current = store.load(delegationId);
      if (!current || current.status !== "reviewing") return;
      if (current.qaSession) {
        if (result) result.qa = current.qaSession;
        return;
      }
      try {
        const reviewing = await startQa(current);
        if (result) result.qa = reviewing.qaSession;
      } catch (error) {
        const latest = store.load(delegationId) ?? current;
        const blockedState = store.save(finishWorkflow(latest, {
          status: "blocked",
          blockedReason: `qa child startup failed: ${error instanceof Error ? error.message : String(error)}`,
          packet: latest.packet ? { ...latest.packet, mark: "fail" } : latest.packet,
        }));
        await deliverRequiredPacket(blockedState, "blocked", sessionId, { directOnly: true });
      }
      return;
    }
    if (transition === "start_implementation") {
      await disposeChild(sessionId, "qa look 1 tool result settled");
      const current = store.load(delegationId);
      if (!current || current.status !== "revising") return;
      if (current.implementationSession) {
        if (result) result.implementation = current.implementationSession;
        return;
      }
      try {
        const fixing = await startImplementation(current, current.qaVerdict);
        if (result) result.implementation = fixing.implementationSession;
      } catch (error) {
        const latest = store.load(delegationId) ?? current;
        const blockedState = store.save(finishWorkflow(latest, {
          status: "blocked",
          blockedReason: `implementation child startup failed: ${error instanceof Error ? error.message : String(error)}`,
          packet: latest.packet ? { ...latest.packet, mark: "fail" } : latest.packet,
        }));
        await deliverRequiredPacket(blockedState, "blocked", sessionId, { directOnly: true });
      }
      return;
    }
    throw new Error(`unknown child settlement transition ${transition}`);
  }

  async function settleAccepted({ sessionId, result, reason, postTool, transition, action, submission }) {
    if (postTool) {
      postToolSettlement(sessionId, result, reason, transition, action, submission);
      return result;
    }
    await action();
    return result;
  }

  async function land(state, fromId, { postTool = false, submission } = {}) {
    let next = store.save(beginPhaseTransition(state, { status: "landing" }));
    let kind = "landed";
    try {
      await landWorktree(run, next, { github });
    } catch (error) {
      kind = "blocked";
      next = store.save(finishWorkflow(next, {
        status: "blocked",
        blockedReason: error instanceof Error ? error.message : String(error),
        packet: next.packet ? { ...next.packet, mark: "fail" } : next.packet,
      }));
    }

    if (kind === "landed") {
      let archivedTaskId = "";
      let archiveError = "";
      if (next.taskId) {
        try {
          const service = tasksOf();
          if (!service || typeof service.archive !== "function") throw new Error("task archive is unavailable");
          archivedTaskId = String(await service.archive(next.taskId));
        } catch (error) {
          archiveError = error instanceof Error ? error.message : String(error);
          logLine(ctx, "warn", `qq-workflows: landed ${next.id} but could not archive task ${next.taskId}: ${archiveError}`);
        }
      }
      next = store.save(finishWorkflow(next, {
        status: "landed",
        landedAt: new Date().toISOString(),
        archivedTaskId,
        archiveError,
        packet: next.packet ? { ...next.packet, mark: "land" } : next.packet,
      }));
    }

    const report = await deliverRequiredPacket(next, kind, fromId);
    next = report.state;
    const result = kind === "landed"
      ? { status: "ok", mark: "land", outcome: formatOutcome(next, kind), delegationId: next.delegationId }
      : { status: "ok", mark: "fail", outcome: formatOutcome(next, kind), delegationId: next.delegationId };
    if (!report.delivered) return result;
    return settleAccepted({
      sessionId: fromId,
      result,
      reason: `${kind} result committed`,
      postTool,
      transition: "dispose",
      action: () => applyPostResultTransition({ sessionId: fromId, delegationId: next.id, transition: "dispose", result }),
      submission,
    });
  }

  function notReady(state) {
    if (state.status === "blocked" || state.status === "landed") {
      return `delegation is ${state.status}, not ready for done`;
    }
    if (state.status === "reviewing" || state.status === "landing") {
      return `delegation is ${state.status}, not ready for done`;
    }
    if (state.status === "revising") {
      if (state.look !== 1) return "qa already used both looks";
      return "";
    }
    if (state.status !== "running") return `delegation is ${state.status}, not ready for done`;
    if (state.look !== 0) return "qa already used both looks";
    return "";
  }

  function delegationForWorktree(path) {
    if (!path) return null;
    const records = store.list().filter((record) => record.worktree === path);
    const active = records.find((record) => record.status !== "landed" && record.status !== "blocked");
    if (active) return active;
    return records.find((record) =>
      record.status === "blocked" && record.qaVerdict?.verdict === "pass") ?? null;
  }

  async function submitRef(state, { ref = "HEAD", fromId, postTool = false, submission } = {}) {
    if (!state.worktree) return { status: "refused", reason: "done requires a worktree" };
    const blocked = notReady(state);
    if (blocked) return { status: "refused", reason: blocked };
    try {
      const revision = await checked(
        run, "git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: state.worktree }, "ref is not a commit",
      );
      const sha = revision.stdout.trim();
      await checked(
        run, "git", ["merge-base", "--is-ancestor", state.baseRef, sha], { cwd: state.worktree },
        "ref does not descend from the delegated base",
      );
      const status = await checked(
        run, "git", ["status", "--porcelain", "--untracked-files=all"], { cwd: state.worktree },
        "cannot inspect worktree",
      );
      if (status.stdout.trim()) {
        return { status: "refused", reason: "worktree is not clean; commit or remove every change before done" };
      }
      const look = state.status === "revising" ? 2 : state.look;
      const packet = await compilePacket(run, { ...state, ref: sha }, { mark: null });
      const priorLook1Rejection = state.status === "revising" && state.qaVerdict
        ? state.qaVerdict.feedback || state.qaVerdict.summary
        : "";
      packet.mark = "review";
      let next = store.save(beginPhaseTransition(state, {
        ref: sha,
        look,
        packet,
        status: "reviewing",
      }));
      next = store.save(beginPhaseTransition(next, {
        look: look === 0 ? 1 : look,
        status: "reviewing",
        qaSession: "",
        qaVerdict: null,
        ...(priorLook1Rejection ? { blockedReason: priorLook1Rejection } : {}),
      }));
      const result = { status: "ok", mark: "review", look: next.look, delegationId: next.delegationId, qa: "" };
      return settleAccepted({
        sessionId: fromId,
        result,
        reason: "implementation done result committed",
        postTool,
        transition: "start_qa",
        action: () => applyPostResultTransition({
          sessionId: fromId,
          delegationId: next.id,
          transition: "start_qa",
          result,
        }),
        submission,
      });
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function done({ agent, ref = "HEAD", delegationId, postTool = false, submission } = {}) {
    const sessionId = sessionIdOf(agent);
    const state = (delegationId ? store.load(delegationId) : null) ?? store.bySession(sessionId);
    if (!state) return { status: "refused", reason: "done has no delegation for this session" };
    const parentSessionUuid = state.parentSessionUuid || state.architectSession;
    const chair = parentSessionUuid ? agents?.get?.(parentSessionUuid) : null;
    if (chair && !isLandCandidate(chair)) {
      return { status: "refused", reason: "done requires a root chair parent" };
    }
    if (state.implementationSession && state.implementationSession !== sessionId) {
      return { status: "refused", reason: "done requires the owned implementation session" };
    }
    if (!state.worktree) return { status: "refused", reason: "done requires a worktree" };
    try {
      const cwd = await realpath(agent?.session?.header?.cwd || state.worktree);
      const expected = await realpath(state.worktree);
      if (cwd !== expected) return { status: "refused", reason: "done must run from its delegated worktree" };
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
    return submitRef(state, { ref, fromId: sessionId, postTool, submission });
  }

  async function invoke({ agent, worktree, ref = "HEAD", brief } = {}) {
    if (!isLandCandidate(agent)) {
      return { status: "refused", reason: "land requires a root session" };
    }
    const sessionId = sessionIdOf(agent);
    const cwd = worktree || agent?.session?.header?.cwd;
    let git;
    try {
      git = await inspectWorktree(run, cwd);
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
    if (git.worktree === git.mainRoot) {
      return { status: "refused", reason: "land refuses the primary checkout; use a branch worktree" };
    }
    const existing = delegationForWorktree(git.worktree);
    let state = existing ?? store.create({
      parentSessionUuid: sessionId,
      architectSession: sessionId,
      implementationSession: sessionId,
      brief: String(brief ?? ""),
      ...git,
    });
    if (brief && existing) state = store.save({ ...state, brief: String(brief) });
    if (!state.taskArtifact && state.brief) state = await ensureTaskArtifact(state);
    if (state.status === "blocked" && state.qaVerdict?.verdict === "pass") {
      return land(state, sessionId);
    }
    return submitRef(state, { ref, fromId: sessionId });
  }

  async function submitVerdict({ agent, verdict, delegationId, postTool = false, submission } = {}) {
    const sessionId = sessionIdOf(agent);
    const state = (delegationId ? store.load(delegationId) : null) ?? store.bySession(sessionId);
    if (!state) return { status: "refused", reason: "submit_review has no delegation for this session" };
    if (!sessionId || state.qaSession !== sessionId) {
      return { status: "refused", reason: "submit_review requires the owned QA session" };
    }
    if (state.qaVerdict) {
      return {
        status: "ok",
        verdict: state.qaVerdict.verdict,
        look: state.look,
        delegationId: state.delegationId,
        alreadySubmitted: true,
        outcome: `qa look ${state.look} verdict was already submitted.`,
      };
    }
    if (state.status !== "reviewing") {
      return { status: "refused", reason: `delegation is ${state.status}, not ready for qa` };
    }
    if (state.look !== 1 && state.look !== 2) {
      return { status: "refused", reason: "delegation is not ready for qa" };
    }
    const working = { ...verdict };
    let next;
    try {
      const enforced = await enforceQaWorktree(run, state, working);
      next = store.save({
        ...state,
        ref: enforced.verdict.verdict === "pass" && enforced.testOnlyCommit ? enforced.qaHead : state.ref,
        qaVerdict: enforced.verdict,
      });
      settledQa.add(sessionId);
      if (enforced.verdict.verdict === "pass") {
        const result = {
          status: "ok",
          verdict: "pass",
          look: state.look,
          delegationId: next.delegationId,
          outcome: `qa look ${state.look} accepted ${state.id}. landing after the review result settles.`,
        };
        return settleAccepted({
          sessionId,
          result,
          reason: "qa pass result committed",
          postTool,
          transition: "finish_land",
          action: () => applyPostResultTransition({
            sessionId,
            delegationId: next.id,
            transition: "finish_land",
            result,
          }),
          submission,
        });
      }
      if (state.look === 1) {
        next = store.save(beginPhaseTransition(next, {
          status: "revising",
          implementationSession: "",
          qaSession: sessionId,
        }));
        const result = {
          status: "ok",
          verdict: "fail",
          look: 1,
          delegationId: next.delegationId,
          implementation: "",
          outcome: `qa look 1 rejected ${state.id}. one fresh implementation.`,
        };
        return settleAccepted({
          sessionId,
          result,
          reason: "qa look 1 result committed",
          postTool,
          transition: "start_implementation",
          action: () => applyPostResultTransition({
            sessionId,
            delegationId: next.id,
            transition: "start_implementation",
            result,
          }),
          submission,
        });
      }
      next = store.save(finishWorkflow(next, {
        status: "blocked",
        blockedReason: enforced.verdict.feedback || enforced.verdict.summary,
        packet: next.packet ? { ...next.packet, mark: "fail" } : next.packet,
      }));
      const report = await deliverRequiredPacket(next, "blocked", sessionId);
      next = report.state;
      const result = { status: "ok", verdict: "fail", look: 2, outcome: "qa look 2 rejected the proposal; the delegation is blocked and its compact report was delivered.", delegationId: next.delegationId };
      if (!report.delivered) return result;
      return settleAccepted({
        sessionId,
        result,
        reason: "qa look 2 result committed",
        postTool,
        transition: "dispose",
        action: () => applyPostResultTransition({ sessionId, delegationId: next.id, transition: "dispose", result }),
        submission,
      });
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function delegationRefusal(reason) {
    return { status: "refused", reason };
  }

  function ownedDelegation(delegationId, parentSessionUuid) {
    const state = store.byDelegation(delegationId);
    if (!state) return { refusal: delegationRefusal("delegation was not found") };
    if (state.parentSessionUuid && state.parentSessionUuid !== parentSessionUuid) {
      return { refusal: delegationRefusal("delegation belongs to a different parent session") };
    }
    return { state };
  }

  function workflowStatus({ delegationId, parentSessionUuid } = {}) {
    const found = ownedDelegation(delegationId, parentSessionUuid);
    if (found.refusal) return found.refusal;
    const state = found.state;
    const sessionUuid = state.current?.sessionUuid || "";
    const relay = relayOf(ctx);
    return {
      status: "ok",
      delegationId: state.delegationId,
      kind: "implementation",
      delegationStatus: state.status,
      role: state.current?.role || "",
      phaseEpoch: state.phaseEpoch,
      sessionUuid,
      alias: sessionUuid && typeof relay?.alias === "function" ? (relay.alias(sessionUuid) ?? "") : "",
      transitioning: state.transitioning,
      terminal: state.status === "landed" || state.status === "blocked",
      ref: state.ref,
      worktree: state.worktree,
      parentSessionUuid: state.parentSessionUuid,
    };
  }

  async function workflowSend({ delegationId, message, expectedRole, expectedEpoch, parentSessionUuid } = {}) {
    const found = ownedDelegation(delegationId, parentSessionUuid);
    if (found.refusal) return found.refusal;
    const state = found.state;
    if (state.status === "landed" || state.status === "blocked") {
      return delegationRefusal(`delegation is terminal (${state.status})`);
    }
    if (state.transitioning) return delegationRefusal("delegation is transitioning between workflow phases");
    const current = state.current;
    if (!current) return delegationRefusal("delegation has no current workflow child");
    if (expectedRole !== undefined && expectedRole !== current.role) {
      return delegationRefusal(`stale workflow role: expected ${expectedRole}, current is ${current.role}`);
    }
    if (expectedEpoch !== undefined && expectedEpoch !== current.phaseEpoch) {
      return delegationRefusal(`stale phase epoch: expected ${expectedEpoch}, current is ${current.phaseEpoch}`);
    }
    const owner = childOwners.get(current.sessionUuid);
    const live = agents?.get?.(current.sessionUuid);
    if (!owner || owner.delegationId !== state.id || owner.workflowRole !== current.role
      || !live || sessionIdOf(live) !== current.sessionUuid) {
      return delegationRefusal("current workflow child is not owned and live");
    }
    if (typeof message !== "string" || !message.trim()) {
      return delegationRefusal("workflow_send requires a non-empty message");
    }
    const relay = relayOf(ctx);
    if (!relay || typeof relay.send !== "function") return delegationRefusal("workflow_send requires qq-relay");
    try {
      const sent = await relay.send({
        fromId: parentSessionUuid,
        to: current.sessionUuid,
        message,
        delivery: "default",
      });
      return {
        ...sent,
        delegationId: state.delegationId,
        sessionUuid: current.sessionUuid,
        alias: sent?.to_alias ?? (typeof relay.alias === "function" ? (relay.alias(current.sessionUuid) ?? "") : ""),
        role: current.role,
        phaseEpoch: current.phaseEpoch,
      };
    } catch (error) {
      return delegationRefusal(error instanceof Error ? error.message : String(error));
    }
  }

  async function workflowStop({ delegationId, reason, parentSessionUuid } = {}) {
    const found = ownedDelegation(delegationId, parentSessionUuid);
    if (found.refusal) return found.refusal;
    const state = found.state;
    if (state.status === "landed" || state.status === "blocked") {
      return delegationRefusal(`delegation is terminal (${state.status})`);
    }
    const childIds = new Set([
      state.current?.sessionUuid,
      state.pendingPhase?.sessionUuid,
      state.implementationSession,
      state.qaSession,
    ].filter(Boolean));
    let blocked = store.save(finishWorkflow(state, {
      status: "blocked",
      blockedReason: String(reason || "stopped by parent"),
      packet: state.packet ? { ...state.packet, mark: "fail" } : state.packet,
    }));
    const report = await deliverRequiredPacket(blocked, "blocked", state.current?.sessionUuid || "");
    blocked = report.state;
    for (const childId of childIds) await disposeChild(childId, "delegation stopped");
    return { status: "ok", delegationId: blocked.delegationId, delegationStatus: blocked.status, terminal: true };
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    closing = true;
    disposePromise = (async () => {
      let detached = 0;

      // Controller work is the teardown authority. In particular it remains
      // visible after disposeChild has removed the old owner and before the
      // accepted transition has retained its successor. Submissions are kept
      // here as well so the pre-arm drain survives owner replacement.
      while (activeSubmissions.size > 0 || activeTransitions.size > 0) {
        await Promise.allSettled([...activeSubmissions, ...activeTransitions]);
      }

      // Once controller work is quiescent, drain and detach every owner to a
      // fixed point. Owner sets remain useful diagnostics and cover work that
      // was already local to an owner when closing began.
      while (childOwners.size > 0) {
        const owners = [...childOwners.values()];
        const active = owners.flatMap((owner) => [
          ...owner.activeSubmissions,
          ...owner.activeTransitions,
        ]);
        if (active.length > 0) {
          await Promise.allSettled(active);
          continue;
        }
        for (const owner of owners) {
          if (childOwners.get(owner.sessionId) === owner && detachChildOwner(owner)) detached++;
        }
      }
      for (const sessionId of [...childTools.keys()]) clearChildTools(sessionId);
      return { detached };
    })();
    return disposePromise;
  }

  return Object.freeze({
    dispose,
    adoptImplementation,
    adoptImplementer: adoptImplementation,
    resumeImplementation,
    resumeChild,
    recoverPendingPhases,
    releaseChild,
    refreshLabels,
    workflowStatus,
    workflowSend,
    workflowStop,
    done,
    invoke,
    submitVerdict,
    delegation: (id) => store.load(id),
    byDelegation: (id) => store.byDelegation(id),
    bySession: (sessionId) => store.bySession(sessionId),
    ownedChildren: () => [...childOwners.keys()],
    whenSettled: (sessionId) => settlementPromises.get(sessionId) ?? Promise.resolve(false),
  });
}

export const internals = Object.freeze({
  inspectWorktree,
  enforceQaWorktree,
  landWorktree,
  formatOutcome,
  runCommand,
});
