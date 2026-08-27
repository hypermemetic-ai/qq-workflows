// Land is not a selectable workflow. Official Mini submits through its
// completion command; the architect/base `land` tool may submit an existing
// worktree. Both paths stamp land or review, run the land worker or an isolated
// QA child, and packet the architect session through qq-relay default steer.
//
// This is not iterate's pixel reviewer. QA has tools and owns test-only
// commits. Paint-only changes may land; control paths default to review. The
// bound qq-task archives only after the merge/cleanup succeeds.

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checked, inspectWorktree, reason, runCommand } from "./git.mjs";

import {
  compilePacket,
  formatPacket,
  isTestPath,
  look1FixPrompt,
  qaLookPrompt,
  routePacket,
  stampFromEvidence,
} from "../../bin/lib/review.mjs";
import { createQaVerdict } from "../../bin/lib/qa-verdict.mjs";
import { oneShot } from "../../core/src/ask.mjs";
import { AGENT_HANDLE, adoptAgentHandle } from "../../core/src/session.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { withChildSettlement } from "./child-settlement.mjs";
import {
  bindMiniSubmit,
  isMiniAgent,
  MINI_KIND,
  miniSetup,
  renderMiniSweTask,
} from "./official-mini.mjs";
import {
  buildDoneTool,
  buildQaVerdictTool,
  QA_TOOL_ALLOWLIST,
} from "./land-tools.mjs";

export const LAND_LABEL = "workflows:land";
export const LAND_RUN_LABEL_PREFIX = "workflows:land-run/";
export const LAND_ROLE_LABEL_PREFIX = "workflows:land-role/";
const LAND_WORKFLOW_ROLES = new Set(["implementer", "fixer", "qa-look-1", "qa-look-2"]);
export const CHILD_ORIGIN = "subagent";
export const ROUTE_PACKET_SCHEMA = "qq.route-packet/v1";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_AGENT_HANDLE = Symbol.for("@hypermemetic-ai/qq-workflows/child-agent-handle");
const SETTLEMENT_TRANSITIONS = new Set(["dispose", "start_qa", "start_fixer"]);

export const ROUTE_SYSTEM = [
  "You stamp a completion packet land or review.",
  "Return exactly land or review. Nothing else.",
  "Default to review when uncertain.",
  "Control paths or words involving session, store, identity, review, land, run, handoff, or relay route to review even when the diff is small.",
  "The land fast path is paint — copy, comments, color, or stylesheet-only changes — not a line-count threshold.",
].join("\n");

export const QA_SYSTEM = [
  "You are the isolated QA chair.",
  "Inspect the worktree and run the narrow checks that prove the brief.",
  "On both looks, you own the tests and may commit test-only changes.",
  "Never edit or commit production code.",
  "Reject bad or excess tests, bloat, and over-engineering.",
  "End by calling qa_verdict exactly once.",
  "A pass requires a clean worktree; any test changes must already be committed.",
].join(" ");

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

function hangLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.hang !== "function") return false;
  try {
    relay.hang(sessionId, LAND_LABEL);
    logLine(ctx, "info", `qq-workflows: hung ${LAND_LABEL} on ${sessionId}`);
    return true;
  } catch (error) {
    logLine(
      ctx,
      "warn",
      `qq-workflows: failed to hang ${LAND_LABEL} on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function clearLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.clear !== "function") return false;
  try {
    relay.clear(sessionId, LAND_LABEL);
    return true;
  } catch {
    return false;
  }
}

function childWorkflowLabels(runId, workflowRole) {
  const run = String(runId ?? "").toLowerCase();
  if (!/^land-[a-z0-9-]{1,48}$/.test(run)) {
    throw new Error("land child label requires a bounded land run id");
  }
  if (!LAND_WORKFLOW_ROLES.has(workflowRole)) {
    throw new Error(`land child label has unknown role ${workflowRole}`);
  }
  return [`${LAND_RUN_LABEL_PREFIX}${run}`, `${LAND_ROLE_LABEL_PREFIX}${workflowRole}`];
}

function hangChildLabels(ctx, owner) {
  const relay = relayOf(ctx);
  if (!owner || !relay || typeof relay.hang !== "function") return false;
  const labels = childWorkflowLabels(owner.runId, owner.workflowRole);
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
  if (!SESSION_ID.test(sessionUuid) || !LAND_WORKFLOW_ROLES.has(role)) {
    throw new Error("cannot advance land run to an invalid workflow phase");
  }
  const pending = state.pendingPhase;
  if (pending && (pending.sessionUuid !== sessionUuid || pending.role !== role)) {
    throw new Error("cannot advance land run to a child other than its pending phase");
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
  return { ...state, ...fields, current: null, transitioning: false, pendingPhase: null };
}

function workflowRoleForState(state, sessionId, fallback = "implementer") {
  if (state?.qaSession === sessionId) return `qa-look-${state.look === 2 ? 2 : 1}`;
  if (state?.implementerSession === sessionId) {
    return state.originalImplementerSession === sessionId ? "implementer" : "fixer";
  }
  if (LAND_WORKFLOW_ROLES.has(fallback)) return fallback;
  return fallback === "qa" ? `qa-look-${state?.look === 2 ? 2 : 1}` : "implementer";
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

function messageInserted(agent, messageId) {
  if (!agent || typeof messageId !== "string" || !messageId) return false;
  const pending = [
    ...(agent.inbox?.nextTurn ?? []),
    ...(agent.inbox?.nextStep ?? []),
  ];
  if (pending.some((message) => message?.id === messageId)) return true;
  return (agent.session?.events ?? []).some((event) =>
    event?.type === "user/message"
    && (event.data?.id === messageId || event.data?.message?.id === messageId));
}

function parseChangedPaths(source) {
  const text = String(source ?? "");
  return text.split(text.includes("\0") ? "\0" : "\n").filter(Boolean);
}

function appendVerdictFailure(verdict, feedback) {
  verdict.verdict = "fail";
  verdict.feedback = `${verdict.feedback ? `${verdict.feedback}\n` : ""}${feedback}`;
}

export function formatOutcome(state, kind) {
  const packet = state?.packet;
  const body = packet ? formatPacket(packet) : state?.brief ?? "";
  // Terminal runs clear the routable pointer, but retain the last immutable
  // phase UUID as diagnostics in lifecycle reports.
  const activeChild = state?.current?.sessionUuid || state?.qaSession || state?.implementerSession || "";
  const role = state?.current?.role || (activeChild ? workflowRoleForState(state, activeChild) : "none");
  const topology = [
    `Delegation ID (authoritative): ${state?.delegationId || "unknown"}`,
    `Land run: ${state?.id || "unknown"}`,
    state?.parentSessionUuid ? `Parent session (authoritative UUID): ${state.parentSessionUuid}` : "",
    activeChild ? `Workflow child session (stable UUID): ${activeChild}` : "",
    `Workflow role: ${role}`,
    Number.isSafeInteger(state?.phaseEpoch) ? `Phase epoch: ${state.phaseEpoch}` : "",
    Number.isSafeInteger(state?.look) ? `QA look: ${state.look}` : "",
    state?.ref ? `Ref: ${state.ref}` : "",
    state?.worktree ? `Worktree: ${state.worktree}` : "",
  ].filter(Boolean).join("\n");
  const verdict = state?.qaVerdict;
  const verdictEvidence = verdict ? [
    `Saved structured QA verdict (${verdict.verdict}):`,
    `Summary: ${verdict.summary}`,
    `Feedback: ${verdict.feedback || "(none)"}`,
    `Tests modified: ${verdict.tests_modified === true ? "yes" : "no"}`,
  ].join("\n") : "";
  if (kind === "landed") {
    return [topology, `Landed on ${state.baseBranch}.`, verdictEvidence, body].filter(Boolean).join("\n\n");
  }
  if (kind === "blocked") {
    const why = state.blockedReason || "blocked";
    return [topology, `Blocked: ${why}`, verdictEvidence, body].filter(Boolean).join("\n\n");
  }
  return [topology, verdictEvidence, body].filter(Boolean).join("\n\n");
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

export async function landWorktree(run, state) {
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
  const proposalDiff = await checked(
    run, "git", ["diff", "--name-only", "--no-renames", "-z", `${state.baseRef}...${state.ref}`, "--"],
    { cwd: worktree }, "cannot inspect proposal paths",
  );
  const generatedPaths = parseChangedPaths(proposalDiff.stdout).filter((path) => path === "openwiki" || path.startsWith("openwiki/"));
  if (generatedPaths.length) {
    throw new Error(`delegated proposal changes generated OpenWiki paths: ${generatedPaths.join(", ")}`);
  }
  // Import branch/commit from task capsule if not already present on mainRoot
  await run("git", ["fetch", worktree, `${state.branch}:${state.branch}`], { cwd: mainRoot });

  const merged = await run("git", ["merge-base", "--is-ancestor", state.ref, "HEAD"], { cwd: mainRoot });
  if (merged?.code !== 0 && merged?.code !== 1) {
    throw new Error(`cannot inspect whether proposal is already merged: ${reason(merged, "command failed")}`);
  }
  if (merged.code === 1) {
    const tree = await run("git", ["merge-tree", "--write-tree", "HEAD", state.ref], { cwd: mainRoot });
    if (tree?.code !== 0 && !String(tree?.stderr ?? "").includes("unknown option")) {
      throw new Error(`proposal no longer merges cleanly: ${reason(tree, "command failed")}`);
    }
    await checked(run, "git", ["merge", "--no-ff", "--no-edit", state.ref], { cwd: mainRoot }, "merge failed");
  }
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
  return state;
}

function registerTools(child, definitions, { allow } = {}) {
  const tools = toolsService(child);
  if (!tools || typeof tools.register !== "function") return () => {};
  const disposers = definitions.map((tool) => tools.register(tool));
  if (allow && typeof tools.restrict === "function") {
    try {
      const disposeRestrict = tools.restrict({ allow: [...allow] });
      if (typeof disposeRestrict === "function") disposers.push(disposeRestrict);
    } catch {
      // Restrict is best-effort. Verdict still registers.
    }
  }
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
  llm,
  run = runCommand,
  complete,
  env = process.env,
} = {}) {
  const attached = new Map();
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

  function pendingPhaseMessage(state, pending, { system, user } = {}) {
    const parentSession = state.parentSessionUuid || state.architectSession;
    const identity = [
      `Delegation ID (authoritative): ${state.delegationId}. Land run: ${state.id}.`,
      `Workflow phase: role ${pending.role}; epoch ${pending.phaseEpoch}; child session ${pending.sessionUuid}.`,
      `Authoritative parent session UUID: ${parentSession}. Session aliases are informational and ephemeral.`,
      "Workflow completion is returned automatically; do not manually relay a duplicate report.",
    ].join(" ");
    const seed = [identity, system, user].filter(Boolean).join("\n\n");
    return pending.role === "fixer" ? renderMiniSweTask(seed) : seed;
  }

  function planPhase(state, role, packet = {}) {
    if (!LAND_WORKFLOW_ROLES.has(role)) throw new Error(`cannot plan invalid workflow role ${role}`);
    const latest = store.load(state.id) ?? state;
    if (!latest.transitioning) throw new Error(`land run ${state.id} is not transitioning`);
    if (latest.pendingPhase) {
      if (latest.pendingPhase.role !== role) {
        throw new Error(`land run ${state.id} already plans ${latest.pendingPhase.role}`);
      }
      return latest;
    }
    const pendingPhase = {
      sessionUuid: `session-${randomUUID()}`,
      role,
      phaseEpoch: latest.phaseEpoch + 1,
      messageId: randomUUID(),
      message: "",
      messageDelivered: false,
    };
    pendingPhase.message = pendingPhaseMessage(latest, pendingPhase, packet);
    return store.save({ ...latest, pendingPhase });
  }

  function phaseFields(pending) {
    if (pending.role === "fixer") {
      return {
        status: "waiting_fix",
        implementerSession: pending.sessionUuid,
        qaSession: "",
      };
    }
    if (pending.role === "qa-look-1" || pending.role === "qa-look-2") {
      return {
        status: "reviewing",
        qaSession: pending.sessionUuid,
        qaVerdict: null,
      };
    }
    throw new Error(`cannot promote unsupported pending workflow role ${pending.role}`);
  }

  function promotePendingPhase(state, expected = state.pendingPhase) {
    if (!expected) throw new Error(`land run ${state.id} has no pending phase`);
    const latest = store.load(state.id) ?? state;
    if (latest.current?.sessionUuid === expected.sessionUuid
      && latest.current.role === expected.role
      && latest.current.phaseEpoch === expected.phaseEpoch) {
      return latest;
    }
    const pending = latest.pendingPhase;
    if (!pending || pending.sessionUuid !== expected.sessionUuid
      || pending.role !== expected.role || pending.phaseEpoch !== expected.phaseEpoch) {
      throw new Error(`land run ${state.id} pending phase changed before promotion`);
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
      && left.message === right.message);
  }

  function markPendingMessageDelivered(state, expected) {
    const latest = store.load(state.id) ?? state;
    const pending = latest.pendingPhase;
    if (!pendingPhaseMatches(pending, expected)) {
      throw new Error(`land run ${state.id} pending packet changed before delivery acknowledgement`);
    }
    if (pending.messageDelivered) return latest;
    return store.save({
      ...latest,
      pendingPhase: { ...pending, messageDelivered: true },
    });
  }

  function activatePendingChild(owner, state, expected = state.pendingPhase) {
    if (!owner || !expected || !expected.messageId || !expected.message) {
      throw new Error(`land run ${state.id} pending phase has no durable work packet`);
    }
    let latest = store.load(state.id) ?? state;
    let pending = latest.pendingPhase;
    if (!pendingPhaseMatches(pending, expected)) {
      throw new Error(`land run ${state.id} pending phase changed before packet delivery`);
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
          content: [{ type: "text", text: pending.message }],
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
    if (pending.role === "qa-look-1" || pending.role === "qa-look-2") {
      if (!childTools.has(owner.sessionId)) installQa(owner.child, latest.id);
      watchQaSettle(owner.child, latest.id);
    } else {
      if (!childTools.has(owner.sessionId)) installDone(owner.child, latest.id);
    }
    return latest;
  }

  function matchesPendingHeaders(child, state, pending) {
    const header = child?.session?.header;
    return header?.landRun === state.id
      && header?.landDelegation === state.delegationId
      && header?.landWorkflowRole === pending.role
      && header?.landPhaseEpoch === pending.phaseEpoch;
  }

  async function stamp(packet) {
    const hop = complete ?? (binding("router")
      ? async ({ system, user }) => oneShot(llm, binding("router"), { system, user })
      : undefined);
    return routePacket(packet, { complete: hop, prompt: ROUTE_SYSTEM });
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
    const sender = fromId || state.qaSession || state.implementerSession || attached.keys().next().value || state.id;
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
    if (!owner?.runId) return { state: null, changed: false };
    const state = store.load(owner.runId);
    if (!state || state.status === "blocked" || state.status === "landed") {
      return { state, changed: false };
    }
    const ownsCurrent = owner.role === "qa"
      ? state.qaSession === owner.sessionId
      : state.implementerSession === owner.sessionId;
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

  function watchImplementerCancel(child, runId) {
    const sessionId = sessionIdOf(child);
    const off = child.ctx?.on?.("session/event", async (_session, event) => {
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      if (reason?.kind !== "aborted" || isHookInterruption(reason)) return;
      const owner = childOwners.get(sessionId);
      if (!owner || owner.runId !== runId || owner.disposePromise) return;
      const blocked = blockOwnedWork(owner, "implementer child was cancelled before done");
      if (!blocked.changed) return;
      const report = await deliverRequiredPacket(blocked.state, "blocked", sessionId);
      if (report.delivered) await disposeChild(sessionId, "implementer cancellation reported");
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
    const state = store.load(owner.runId);
    if (!state) throw new Error(`child settlement has no land run ${owner.runId}`);
    return store.save({
      ...state,
      settlementSession: owner.sessionId,
      settlementCallId: callId,
      settlementTransition: transition,
    });
  }

  function clearRememberedSettlement(owner, callId = "") {
    const state = store.load(owner.runId);
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
      if (blocks.some((block) => block.isError === true)) {
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
      const state = blocked.state ?? store.load(currentOwner.runId);
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

  function addPendingSettlement(owner, { callId, reason, action, onFailure, resolve }) {
    if (owner.settlements.has(callId)) return owner.settlements.get(callId);
    const pending = {
      callId,
      reason,
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

  function retainChild(handle, { child = handle?.agent ?? handle, role, workflowRole, runId } = {}) {
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
      if (runId) existing.runId = runId;
      hangChildLabels(ctx, existing);
      return existing;
    }
    const owner = {
      sessionId,
      child,
      handle,
      role: role || child?.session?.header?.landRole || "implementer",
      workflowRole: workflowRole || child?.session?.header?.landWorkflowRole || (role === "qa" ? "qa-look-1" : "implementer"),
      runId: runId || child?.session?.header?.landRun || "",
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
    // re-retains this exact handle from the durable land run.
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
      const state = blocked.state ?? store.load(owner.runId);
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

  function attach(agent) {
    if (!isLandCandidate(agent)) return null;
    const session = agent.session;
    const sessionId = session.id;
    if (attached.has(sessionId)) return attached.get(sessionId);
    hangLabel(ctx, sessionId);
    const handle = {
      sessionId,
      detach() {
        clearLabel(ctx, sessionId);
        attached.delete(sessionId);
      },
    };
    attached.set(sessionId, handle);
    return handle;
  }

  function refreshLabels() {
    let refreshed = 0;
    for (const owner of childOwners.values()) {
      if (hangChildLabels(ctx, owner)) refreshed++;
    }
    return refreshed;
  }

  function detach(agentOrId) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : agentOrId?.session?.id ?? agentOrId?.id;
    const handle = attached.get(sessionId);
    handle?.detach();
    const hadTools = childTools.has(sessionId);
    clearChildTools(sessionId);
    return Boolean(handle) || hadTools;
  }

  function installDone(child, runId) {
    const sessionId = sessionIdOf(child);
    childTools.get(sessionId)?.();
    const submit = (args) => trackChildSubmission(sessionId, (submission) =>
      done({ ...args, runId, postTool: true, submission }));
    const disposeSubmit = isMiniAgent(child)
      ? bindMiniSubmit(child, submit)
      : registerTools(child, [buildDoneTool({ submit })]);
    const disposeCancel = watchImplementerCancel(child, runId);
    const dispose = () => {
      try { disposeCancel(); } finally { disposeSubmit(); }
    };
    childTools.set(sessionId, dispose);
    return dispose;
  }

  function installQa(child, runId) {
    const sessionId = sessionIdOf(child);
    childTools.get(sessionId)?.();
    const dispose = registerTools(child, [
      buildQaVerdictTool({
        submit: (args) => trackChildSubmission(sessionId, (submission) =>
          submitVerdict({ ...args, runId, postTool: true, submission })),
      }),
    ], { allow: QA_TOOL_ALLOWLIST });
    childTools.set(sessionId, dispose);
    return dispose;
  }

  async function adoptImplementer(child, info = {}) {
    const sessionId = sessionIdOf(child);
    if (!sessionId) return { status: "refused", reason: "adopt requires a child session", owned: false };
    const cwd = info.cwd ?? child?.session?.header?.cwd;
    const brief = String(info.packet ?? info.brief ?? "");
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
    const runId = `land-${randomUUID().slice(0, 8)}`;
    let owner;
    let disposeBinding;
    try {
      if (info.handle) owner = retainChild(info.handle, { child, role: "implementer", workflowRole: "implementer", runId });
      disposeBinding = installDone(child, runId);
      try {
        child.session.header.landRun = runId;
        child.session.header.landRole = "implementer";
        child.session.header.landWorkflowRole = "implementer";
      } catch { /* durable store and labels remain authoritative */ }
      const record = store.create({
        id: runId,
        delegationId: info.delegationId,
        parentSessionUuid: architectSession,
        architectSession,
        taskId: info.taskId,
        implementerSession: sessionId,
        originalImplementerSession: sessionId,
        brief,
        ...git,
      });
      try {
        child.session.header.landDelegation = record.delegationId;
        child.session.header.landPhaseEpoch = record.phaseEpoch;
      } catch { /* durable store remains authoritative */ }
      return {
        status: "ok",
        delegationId: record.delegationId,
        run: record.id,
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
      ? "implementer done result committed"
      : state.settlementTransition === "start_fixer"
        ? "qa look 1 result committed"
        : "terminal child result committed";
    const pending = addPendingSettlement(owner, {
      callId,
      reason,
      action: () => applyPostResultTransition({
        sessionId: owner.sessionId,
        runId: owner.runId,
        transition: state.settlementTransition,
      }),
      resolve: waiting.resolve,
    });
    const remembered = rememberedResult(owner.child, callId);
    if (remembered?.failed) failArmedSettlement(owner, pending);
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
      if (!pending.messageId || !pending.message) return false;
      const pendingRole = pending.role.startsWith("qa-") ? "qa" : "implementer";
      owner = retainChild(retained, {
        child,
        role: pendingRole,
        workflowRole: pending.role,
        runId: state.id,
      });
      try {
        state = activatePendingChild(owner, state, pending);
      } catch (error) {
        detachChildOwner(owner);
        throw error;
      }
      if (state.pendingPhase) return true;
    }
    const role = state.qaSession === sessionId ? "qa" : "implementer";
    const workflowRole = workflowRoleForState(state, sessionId, child?.session?.header?.landWorkflowRole || role);
    owner ??= retainChild(retained, { child, role, workflowRole, runId: state.id });
    if (state.reportPending) {
      void retryPendingReport(owner, state);
      return true;
    }
    if (resumeRememberedSettlement(owner, state)) return true;
    if (role === "implementer" && (state.status === "running" || state.status === "waiting_fix")) {
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

  function resumeImplementer(child) {
    return isMiniAgent(child) && resumeChild(child);
  }

  async function spawnChild({ sessionUuid, role, workflowRole, runId, delegationId, phaseEpoch, cwd, parentSession }) {
    if (!agents || typeof agents.create !== "function") {
      throw new Error("land requires ctx.agents.create");
    }
    const route = childRoute({
      binding: binding(role),
      env,
    });
    if (!SESSION_ID.test(sessionUuid)) throw new Error("land child requires its preplanned session UUID");
    const childId = sessionUuid;
    const mini = role === "implementer";
    const handle = adoptAgentHandle(await agents.create({
      sessionId: childId,
      meta: {
        cwd,
        parentSession,
        origin: CHILD_ORIGIN,
        landRole: role,
        landWorkflowRole: workflowRole,
        landRun: runId,
        landDelegation: delegationId,
        landPhaseEpoch: phaseEpoch,
        ...(mini ? { kind: MINI_KIND, agentPreset: MINI_KIND } : {}),
      },
      ...childCreateOptions(route, mini ? { setup: miniSetup } : {}),
    }));
    const child = handle?.agent ?? handle;
    let retained = false;
    try {
      const owner = retainChild(handle, { child, role, workflowRole, runId });
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

  async function recoverPendingPhase(runId) {
    let state = store.load(runId);
    const pending = state?.pendingPhase;
    if (!state || !pending || !state.transitioning) return false;
    if (!pending.messageId || !pending.message) {
      throw new Error(`land run ${runId} pending phase has no durable work packet`);
    }

    const owned = childOwners.get(pending.sessionUuid);
    if (owned) {
      if (owned.runId !== state.id || owned.workflowRole !== pending.role) {
        throw new Error(`land run ${runId} intended child is owned by another phase`);
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

    const role = pending.role.startsWith("qa-") ? "qa" : "implementer";
    let spawned;
    try {
      spawned = await spawnChild({
        sessionUuid: pending.sessionUuid,
        role,
        workflowRole: pending.role,
        runId: state.id,
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

    state = store.load(runId) ?? state;
    if (state.current?.sessionUuid === pending.sessionUuid
      && state.current.role === pending.role
      && state.current.phaseEpoch === pending.phaseEpoch
      && !state.pendingPhase) {
      return true;
    }
    activatePendingChild(spawned.owner, state, pending);
    return true;
  }

  function recoverPendingRun(runId) {
    const existing = pendingRecoveries.get(runId);
    if (existing) return existing;
    if (closing) return Promise.resolve(false);
    // Register before executing recovery so plugin teardown sees the promise
    // even if apply and dispose occur in the same turn.
    const promise = Promise.resolve().then(() => recoverPendingPhase(runId));
    pendingRecoveries.set(runId, promise);
    trackControllerTransition(promise);
    void promise.finally(() => {
      if (pendingRecoveries.get(runId) === promise) pendingRecoveries.delete(runId);
    }).catch(() => {});
    return promise;
  }

  async function recoverPendingPhases() {
    if (closing) return [];
    const pending = store.list()
      .filter((state) => state.transitioning && state.pendingPhase)
      .map((state) => recoverPendingRun(state.id));
    return Promise.allSettled(pending);
  }

  async function packetDiff(state) {
    const diff = await run(
      "git",
      ["diff", "-U0", "--no-color", `${state.baseRef}...${state.ref}`],
      { cwd: state.worktree },
    );
    const text = String(diff?.stdout ?? "").trim();
    if (!text) return "(no diff)";
    return text.length > 24_000 ? `${text.slice(0, 24_000)}\n…(truncated)` : text;
  }

  function watchQaSettle(child, runId) {
    const childId = sessionIdOf(child);
    const owner = childOwners.get(childId);
    if (!childId || owner?.qaSettleOff) return owner?.qaSettleOff ?? null;
    const finish = async () => {
      if (settledQa.has(childId)) return;
      const state = store.load(runId);
      if (!state || state.qaSession !== childId || state.status !== "reviewing") return;
      if (state.qaVerdict) {
        settledQa.add(childId);
        return;
      }
      settledQa.add(childId);
      await submitVerdict({
        agent: child,
        runId,
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
    const parentSession = state.parentSessionUuid || state.architectSession;
    const diff = await packetDiff(state);
    const user = [
      qaLookPrompt({
        ...state,
        ticketPath: "(packet brief)",
        task: { id: state.id },
      }),
      "",
      formatPacket(state.packet),
      "",
      "Diff:",
      diff,
    ].join("\n");
    const workflowRole = `qa-look-${state.look}`;
    const planned = planPhase(state, workflowRole, { system: QA_SYSTEM, user });
    const pending = planned.pendingPhase;
    const spawned = await spawnChild({
      sessionUuid: pending.sessionUuid,
      role: "qa",
      workflowRole,
      runId: planned.id,
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

  async function startFixer(state, verdict) {
    const parentSession = state.parentSessionUuid || state.architectSession;
    const user = look1FixPrompt({ ...state, task: { id: state.id } }, verdict);
    const planned = planPhase(state, "fixer", { user });
    const pending = planned.pendingPhase;
    const spawned = await spawnChild({
      sessionUuid: pending.sessionUuid,
      role: "implementer",
      workflowRole: pending.role,
      runId: planned.id,
      delegationId: planned.delegationId,
      phaseEpoch: pending.phaseEpoch,
      cwd: planned.worktree,
      parentSession,
    });
    try {
      return activatePendingChild(spawned.owner, planned, pending);
    } catch (error) {
      await disposeChild(pending.sessionUuid, "fixer phase promotion rollback");
      throw error;
    }
  }

  async function applyPostResultTransition({ sessionId, runId, transition, result }) {
    if (transition === "dispose") {
      await disposeChild(sessionId, "tool result settled");
      return;
    }
    if (transition === "start_qa") {
      await disposeChild(sessionId, "implementer done tool result settled");
      const current = store.load(runId);
      if (!current || current.status !== "reviewing") return;
      if (current.qaSession) {
        if (result) result.qa = current.qaSession;
        return;
      }
      try {
        const reviewing = await startQa(current);
        if (result) result.qa = reviewing.qaSession;
      } catch (error) {
        const latest = store.load(runId) ?? current;
        const blockedState = store.save(finishWorkflow(latest, {
          status: "blocked",
          blockedReason: `qa child startup failed: ${error instanceof Error ? error.message : String(error)}`,
          packet: latest.packet ? { ...latest.packet, mark: "fail" } : latest.packet,
        }));
        await deliverRequiredPacket(blockedState, "blocked", sessionId, { directOnly: true });
      }
      return;
    }
    if (transition === "start_fixer") {
      await disposeChild(sessionId, "qa look 1 tool result settled");
      const current = store.load(runId);
      if (!current || current.status !== "waiting_fix") return;
      if (current.implementerSession) {
        if (result) result.implementer = current.implementerSession;
        return;
      }
      try {
        const fixing = await startFixer(current, current.qaVerdict);
        if (result) result.implementer = fixing.implementerSession;
      } catch (error) {
        const latest = store.load(runId) ?? current;
        const blockedState = store.save(finishWorkflow(latest, {
          status: "blocked",
          blockedReason: `fixer child startup failed: ${error instanceof Error ? error.message : String(error)}`,
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

  async function finishLand(state, fromId, { postTool = false, submission } = {}) {
    let next = store.save(beginPhaseTransition(state, { status: "landing" }));
    let kind = "landed";
    try {
      await landWorktree(run, next);
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
          if (!service || typeof service.archive !== "function") throw new Error("qq-tasks is unavailable");
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
      ? { status: "ok", mark: "land", outcome: formatOutcome(next, kind), run: next.id }
      : { status: "ok", mark: "fail", outcome: formatOutcome(next, kind), run: next.id };
    if (!report.delivered) return result;
    return settleAccepted({
      sessionId: fromId,
      result,
      reason: `${kind} result committed`,
      postTool,
      transition: "dispose",
      action: () => applyPostResultTransition({ sessionId: fromId, runId: next.id, transition: "dispose", result }),
      submission,
    });
  }

  function notReady(state) {
    if (state.status === "blocked" || state.status === "landed") {
      return `handoff is ${state.status}, not ready for done`;
    }
    if (state.status === "reviewing" || state.status === "landing") {
      return `handoff is ${state.status}, not ready for done`;
    }
    if (state.status === "waiting_fix") {
      if (state.look !== 1) return "qa already used both looks";
      return "";
    }
    if (state.status !== "running") return `handoff is ${state.status}, not ready for done`;
    if (state.look !== 0) return "qa already used both looks";
    return "";
  }

  function runForWorktree(path) {
    if (!path) return null;
    for (const record of store.list()) {
      if (record.worktree === path && (record.status === "running" || record.status === "waiting_fix")) {
        return record;
      }
    }
    return null;
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
      const look = state.status === "waiting_fix" ? 2 : state.look;
      const packet = await compilePacket(run, { ...state, ref: sha }, { brief: state.brief, mark: null });
      const mark = await stamp(packet);
      packet.mark = mark;
      let next = store.save(beginPhaseTransition(state, {
        ref: sha,
        look,
        packet,
        status: mark === "land" ? "landing" : "reviewing",
      }));
      if (mark === "land") return finishLand(next, fromId, { postTool, submission });
      next = store.save(beginPhaseTransition(next, {
        look: look === 0 ? 1 : look,
        status: "reviewing",
        qaSession: "",
        qaVerdict: null,
      }));
      const result = { status: "ok", mark: "review", look: next.look, run: next.id, qa: "" };
      return settleAccepted({
        sessionId: fromId,
        result,
        reason: "implementer done result committed",
        postTool,
        transition: "start_qa",
        action: () => applyPostResultTransition({
          sessionId: fromId,
          runId: next.id,
          transition: "start_qa",
          result,
        }),
        submission,
      });
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function done({ agent, ref = "HEAD", runId, postTool = false, submission } = {}) {
    const sessionId = sessionIdOf(agent);
    const state = (runId ? store.load(runId) : null) ?? store.bySession(sessionId);
    if (!state) return { status: "refused", reason: "done has no land run for this session" };
    const parentSessionUuid = state.parentSessionUuid || state.architectSession;
    const chair = parentSessionUuid ? agents?.get?.(parentSessionUuid) : null;
    if (chair && !isLandCandidate(chair)) {
      return { status: "refused", reason: "done requires a root chair parent" };
    }
    if (state.implementerSession && state.implementerSession !== sessionId) {
      return { status: "refused", reason: "done requires the owned implementer session" };
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
    const existing = runForWorktree(git.worktree);
    const state = existing ?? store.create({
      parentSessionUuid: sessionId,
      architectSession: sessionId,
      implementerSession: sessionId,
      brief: String(brief ?? existing?.brief ?? ""),
      ...git,
    });
    if (brief && existing) {
      return submitRef(store.save({ ...state, brief: String(brief) }), { ref, fromId: sessionId });
    }
    return submitRef(state, { ref, fromId: sessionId });
  }

  async function submitVerdict({ agent, verdict, runId, postTool = false, submission } = {}) {
    const sessionId = sessionIdOf(agent);
    const state = (runId ? store.load(runId) : null) ?? store.bySession(sessionId);
    if (!state) return { status: "refused", reason: "qa_verdict has no land run for this session" };
    if (state.status !== "reviewing") {
      return { status: "refused", reason: `handoff is ${state.status}, not ready for qa` };
    }
    if (state.qaSession && state.qaSession !== sessionId) {
      return { status: "refused", reason: "qa_verdict requires the owned QA session" };
    }
    if (state.qaVerdict) return { status: "refused", reason: "qa verdict was already submitted" };
    if (state.look !== 1 && state.look !== 2) {
      return { status: "refused", reason: "handoff is not ready for qa" };
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
        return finishLand(next, sessionId, { postTool, submission });
      }
      if (state.look === 1) {
        next = store.save(beginPhaseTransition(next, {
          status: "waiting_fix",
          implementerSession: "",
          qaSession: sessionId,
        }));
        const result = {
          status: "ok",
          verdict: "fail",
          look: 1,
          run: next.id,
          implementer: "",
          outcome: `qa look 1 rejected ${state.id}. one fresh implementer.`,
        };
        return settleAccepted({
          sessionId,
          result,
          reason: "qa look 1 result committed",
          postTool,
          transition: "start_fixer",
          action: () => applyPostResultTransition({
            sessionId,
            runId: next.id,
            transition: "start_fixer",
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
      const result = { status: "ok", verdict: "fail", look: 2, outcome: formatOutcome(next, "blocked"), run: next.id };
      if (!report.delivered) return result;
      return settleAccepted({
        sessionId,
        result,
        reason: "qa look 2 result committed",
        postTool,
        transition: "dispose",
        action: () => applyPostResultTransition({ sessionId, runId: next.id, transition: "dispose", result }),
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
      runId: state.id,
      runStatus: state.status,
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
    if (!owner || owner.runId !== state.id || owner.workflowRole !== current.role
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
        message: `Delegation ID (authoritative): ${state.delegationId}. Land run: ${state.id}.

${message}`,
        delivery: "default",
      });
      return {
        ...sent,
        delegationId: state.delegationId,
        runId: state.id,
        sessionUuid: current.sessionUuid,
        alias: sent?.to_alias ?? (typeof relay.alias === "function" ? (relay.alias(current.sessionUuid) ?? "") : ""),
        role: current.role,
        phaseEpoch: current.phaseEpoch,
      };
    } catch (error) {
      return delegationRefusal(error instanceof Error ? error.message : String(error));
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    closing = true;
    disposePromise = (async () => {
      for (const handle of [...attached.values()]) handle.detach();
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
    attach,
    detach,
    dispose,
    adoptImplementer,
    resumeImplementer,
    resumeChild,
    recoverPendingPhases,
    releaseChild,
    refreshLabels,
    workflowStatus,
    workflowSend,
    done,
    invoke,
    submitVerdict,
    attached: (sessionId) => attached.get(sessionId),
    run: (id) => store.load(id),
    bySession: (sessionId) => store.bySession(sessionId),
    ownedChildren: () => [...childOwners.keys()],
    whenSettled: (sessionId) => settlementPromises.get(sessionId) ?? Promise.resolve(false),
    label: LAND_LABEL,
  });
}

export const internals = Object.freeze({
  inspectWorktree,
  enforceQaWorktree,
  landWorktree,
  formatOutcome,
  runCommand,
  stampFromEvidence,
  ROUTE_SYSTEM,
  QA_SYSTEM,
});
