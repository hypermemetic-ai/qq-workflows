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
import { adoptAgentHandle } from "../../core/src/session.mjs";
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
export const CHILD_ORIGIN = "subagent";
export const ROUTE_PACKET_SCHEMA = "qq.route-packet/v1";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_AGENT_HANDLE = Symbol.for("@hypermemetic-ai/qq-workflows/child-agent-handle");

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
  const origin = agent?.session?.header?.origin;
  if (origin === CHILD_ORIGIN) return false;
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
  if (kind === "landed") {
    return [`Landed on ${state.baseBranch}.`, body].filter(Boolean).join("\n\n");
  }
  if (kind === "blocked") {
    const why = state.blockedReason || "blocked";
    return [`Blocked: ${why}`, body].filter(Boolean).join("\n\n");
  }
  return body;
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

  function tasksOf() {
    return typeof tasks === "function" ? tasks() : tasks ?? null;
  }

  function binding(role) {
    return settings?.get?.(role) ?? null;
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
    const parent = agents?.get?.(state.architectSession);
    if (!parent || typeof parent.steer !== "function") return false;
    const message = formatOutcome(state, kind);
    try {
      parent.steer({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: `From workflow child ${fromId || state.id}:\n\n${message}` }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "relay" },
      });
      try { await sessionsOf()?.flush?.(parent.session); } catch { /* inbox splice is already durable */ }
      return true;
    } catch (error) {
      logLine(ctx, "warn", `qq-workflows: direct land packet delivery failed for ${state.architectSession}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function sendPacket(state, kind, fromId, { directOnly = false } = {}) {
    if (!state.architectSession) return true;
    const relay = relayOf(ctx);
    const sender = fromId || state.qaSession || state.implementerSession || attached.keys().next().value || state.id;
    if (!directOnly && relay && typeof relay.send === "function") {
      try {
        await relay.send({
          fromId: sender,
          to: state.architectSession,
          message: formatOutcome(state, kind),
          delivery: "default",
        });
        return true;
      } catch (error) {
        logLine(ctx, "warn", `qq-workflows: relay packet delivery from ${sender} failed, trying live parent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return directPacket(state, kind, sender);
  }

  async function deliverRequiredPacket(state, kind, fromId, options) {
    let next = store.save({
      ...state,
      reportPending: Boolean(state.architectSession),
      reportKind: state.architectSession ? kind : "",
      reportFromSession: state.architectSession ? String(fromId || "") : "",
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
    const blocked = store.save({
      ...state,
      status: "blocked",
      blockedReason: String(blockedReason || `${owner.role} child closed`),
      packet: state.packet ? { ...state.packet, mark: "fail" } : state.packet,
    });
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

  function clearOwnerLifecycle(owner) {
    for (const pending of owner?.settlements?.values?.() ?? []) {
      if (!pending.failureNotified) {
        try { pending.onFailure?.(); } catch { /* retry policy is best effort */ }
      }
      pending.resolve(false);
    }
    owner?.settlements?.clear?.();
    for (const off of owner?.lifecycleOffs ?? []) {
      try { off?.(); } catch { /* best effort */ }
    }
    if (owner) owner.lifecycleOffs = [];
  }

  function runArmedSettlement(owner, pending) {
    if (pending.started || (!pending.resultCommitted && !pending.resultFailed) || !pending.idle) return;
    pending.started = true;
    owner.settlements.delete(pending.callId);
    const promise = (async () => {
      if (pending.resultFailed) {
        let delivered = false;
        try {
          delivered = await pending.failureAction?.() === true;
        } catch (error) {
          logLine(ctx, "warn", `qq-workflows: failed tool-result recovery for ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (delivered) await disposeChild(owner.sessionId, "failed tool result reported");
        pending.resolve(false);
        return false;
      }
      try {
        await pending.action();
        pending.resolve(true);
        return true;
      } catch (error) {
        logLine(ctx, "warn", `qq-workflows: post-result child settlement failed for ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        pending.resolve(false);
        return false;
      }
    })();
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

  function postToolSettlement(sessionId, result, reason, action) {
    const owner = childOwners.get(sessionId);
    if (!owner) return null;
    const waiting = Promise.withResolvers();
    const settlement = {
      settled: waiting.promise,
      arm({ callId, onFailure } = {}) {
        if (typeof callId !== "string" || !callId) throw new Error("child settlement requires a tool call id");
        if (owner.settlements.has(callId)) throw new Error(`child settlement already armed for ${callId}`);
        owner.settlements.set(callId, {
          callId,
          reason,
          action,
          onFailure,
          failureAction: async () => {
            const currentOwner = childOwners.get(sessionId);
            if (!currentOwner) return true;
            const blocked = blockOwnedWork(currentOwner, `${reason} failed before settlement`);
            const state = blocked.state ?? store.load(currentOwner.runId);
            if (!state) return true;
            if (!blocked.changed && !state.reportPending) return true;
            const report = await deliverRequiredPacket(
              state,
              state.reportKind || "blocked",
              state.reportFromSession || sessionId,
            );
            return report.delivered;
          },
          resolve: waiting.resolve,
          resultCommitted: false,
          resultFailed: false,
          failureNotified: false,
          idle: owner.child.status === "idle",
          started: false,
        });
      },
    };
    settlementPromises.set(sessionId, waiting.promise);
    withChildSettlement(result, settlement);
    return settlement;
  }

  function retainChild(handle, { child = handle?.agent ?? handle, role, runId } = {}) {
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
      return existing;
    }
    const owner = {
      sessionId,
      child,
      handle,
      role: role || child?.session?.header?.landRole || "implementer",
      runId: runId || "",
      disposePromise: null,
      externalDisposed: false,
      settlements: new Map(),
      lifecycleOffs: [],
    };
    childOwners.set(sessionId, owner);
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
    clearRetainedHandle(owner);
    if (childOwners.get(owner.sessionId) === owner) childOwners.delete(owner.sessionId);
    settledQa.delete(owner.sessionId);
  }

  async function disposeChild(agentOrId, reason = "settled") {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const owner = childOwners.get(sessionId);
    if (!owner) return false;
    if (!owner.disposePromise) {
      clearChildTools(sessionId);
      clearOwnerLifecycle(owner);
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
    const submit = (args) => done({ ...args, runId, postTool: true });
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
        submit: (args) => submitVerdict({ ...args, runId, postTool: true }),
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
    let git = { worktree: cwd || "", inspectError: "" };
    try {
      git = { ...await inspectWorktree(run, cwd), inspectError: "" };
    } catch (error) {
      git = {
        worktree: cwd || "",
        inspectError: error instanceof Error ? error.message : String(error),
      };
    }
    const runId = `land-${randomUUID().slice(0, 8)}`;
    let owner;
    let disposeBinding;
    try {
      if (info.handle) owner = retainChild(info.handle, { child, role: "implementer", runId });
      disposeBinding = installDone(child, runId);
      const record = store.create({
        id: runId,
        architectSession,
        taskId: info.taskId,
        implementerSession: sessionId,
        originalImplementerSession: sessionId,
        brief,
        ...git,
      });
      return {
        status: "ok",
        run: record.id,
        child: sessionId,
        owned: Boolean(owner),
        rollback: async (rollbackReason = "delegate startup failed") => {
          const current = store.load(record.id);
          if (current && current.status === "running") {
            store.save({
              ...current,
              status: "blocked",
              blockedReason: String(rollbackReason),
            });
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

  function resumeChild(child) {
    const sessionId = sessionIdOf(child);
    if (!sessionId) return false;
    const state = store.bySession(sessionId);
    if (!state) return false;
    const retained = child?.[CHILD_AGENT_HANDLE];
    if (!retained) return false;
    const role = state.qaSession === sessionId ? "qa" : "implementer";
    const owner = retainChild(retained, { child, role, runId: state.id });
    if (state.reportPending) {
      void retryPendingReport(owner, state);
      return true;
    }
    if (role === "implementer" && isMiniAgent(child) && (state.status === "running" || state.status === "waiting_fix")) {
      installDone(child, state.id);
      return true;
    }
    if (role === "qa" && state.status === "reviewing") {
      installQa(child, state.id);
      watchQaSettle(child, state.id);
      return true;
    }
    return true;
  }

  function resumeImplementer(child) {
    return isMiniAgent(child) && resumeChild(child);
  }

  async function spawnChild({ role, runId, cwd, parentSession, system, user, install }) {
    if (!agents || typeof agents.create !== "function") {
      throw new Error("land requires ctx.agents.create");
    }
    const route = childRoute({
      binding: binding(role),
      env,
    });
    const childId = `session-${randomUUID()}`;
    const mini = role === "implementer";
    const handle = adoptAgentHandle(await agents.create({
      sessionId: childId,
      meta: {
        cwd,
        parentSession,
        origin: CHILD_ORIGIN,
        landRole: role,
        ...(mini ? { kind: MINI_KIND, agentPreset: MINI_KIND } : {}),
      },
      ...childCreateOptions(route, mini ? { setup: miniSetup } : {}),
    });
    const child = handle?.agent ?? handle;
    let retained = false;
    try {
      retainChild(handle, { child, role, runId });
      retained = true;
      install?.(child);
      const seed = [system, user].filter(Boolean).join("\n\n");
      const content = mini ? renderMiniSweTask(seed) : seed;
      let started = false;
      return {
        child,
        async start() {
          if (started) return;
          started = true;
          try {
            if (typeof child.followup !== "function") throw new Error(`${role} child cannot accept its work packet`);
            child.followup({
              id: randomUUID(),
              role: "user",
              content: [{ type: "text", text: content }],
              source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
            });
          } catch (error) {
            await disposeChild(childId, `${role} startup rollback`);
            throw error;
          }
        },
      };
    } catch (error) {
      if (retained) await disposeChild(childId, `${role} startup rollback`);
      else {
        try { await handle?.dispose?.(); } catch { /* best effort create rollback */ }
      }
      throw error;
    }
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
    if (!childId) return;
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
    child.ctx?.on?.("session/event", async (_session, event) => {
      if (event?.type !== "turn/end") return;
      if (isHookInterruption(event.data?.reason)) return;
      await finish();
    });
  }

  async function startQa(state) {
    const parentSession = [...attached.keys()][0] || state.architectSession;
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
    const spawned = await spawnChild({
      role: "qa",
      runId: state.id,
      cwd: state.worktree,
      parentSession,
      system: QA_SYSTEM,
      user,
      install: (next) => installQa(next, state.id),
    });
    const qaSession = sessionIdOf(spawned.child);
    const next = store.save({
      ...state,
      status: "reviewing",
      qaSession,
      qaVerdict: null,
    });
    watchQaSettle(spawned.child, next.id);
    await spawned.start();
    return next;
  }

  async function startFixer(state, verdict) {
    const parentSession = [...attached.keys()][0] || state.architectSession;
    const user = look1FixPrompt({ ...state, task: { id: state.id } }, verdict);
    const spawned = await spawnChild({
      role: "implementer",
      runId: state.id,
      cwd: state.worktree,
      parentSession,
      user,
      install: (next) => installDone(next, state.id),
    });
    const implementerSession = sessionIdOf(spawned.child);
    const next = store.save({
      ...state,
      status: "waiting_fix",
      implementerSession,
      qaSession: "",
    });
    await spawned.start();
    return next;
  }

  async function settleAccepted({ sessionId, result, reason, postTool, action }) {
    if (postTool && postToolSettlement(sessionId, result, reason, action)) return result;
    await action();
    return result;
  }

  async function finishLand(state, fromId, { postTool = false } = {}) {
    let next = store.save({ ...state, status: "landing" });
    let kind = "landed";
    try {
      await landWorktree(run, next);
    } catch (error) {
      kind = "blocked";
      next = store.save({
        ...next,
        status: "blocked",
        blockedReason: error instanceof Error ? error.message : String(error),
        packet: next.packet ? { ...next.packet, mark: "fail" } : next.packet,
      });
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
      next = store.save({
        ...next,
        status: "landed",
        landedAt: new Date().toISOString(),
        archivedTaskId,
        archiveError,
        packet: next.packet ? { ...next.packet, mark: "land" } : next.packet,
      });
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
      action: () => disposeChild(fromId, `${kind} tool result settled`),
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

  async function submitRef(state, { ref = "HEAD", fromId, postTool = false } = {}) {
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
      let next = store.save({
        ...state,
        ref: sha,
        look,
        packet,
        status: mark === "land" ? "landing" : "reviewing",
      });
      if (mark === "land") return finishLand(next, fromId, { postTool });
      next = store.save({
        ...next,
        look: look === 0 ? 1 : look,
        status: "reviewing",
        qaSession: "",
        qaVerdict: null,
      });
      const result = { status: "ok", mark: "review", look: next.look, run: next.id, qa: "" };
      const transition = async () => {
        await disposeChild(fromId, "implementer done tool result settled");
        try {
          const reviewing = await startQa(store.load(next.id) ?? next);
          result.qa = reviewing.qaSession;
        } catch (error) {
          const current = store.load(next.id) ?? next;
          const blockedState = store.save({
            ...current,
            status: "blocked",
            blockedReason: `qa child startup failed: ${error instanceof Error ? error.message : String(error)}`,
            packet: current.packet ? { ...current.packet, mark: "fail" } : current.packet,
          });
          await deliverRequiredPacket(blockedState, "blocked", fromId, { directOnly: true });
        }
      };
      return settleAccepted({
        sessionId: fromId,
        result,
        reason: "implementer done result committed",
        postTool,
        action: transition,
      });
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function done({ agent, ref = "HEAD", runId, postTool = false } = {}) {
    const sessionId = sessionIdOf(agent);
    const state = (runId ? store.load(runId) : null) ?? store.bySession(sessionId);
    if (!state) return { status: "refused", reason: "done has no land run for this session" };
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
    return submitRef(state, { ref, fromId: sessionId, postTool });
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

  async function submitVerdict({ agent, verdict, runId, postTool = false } = {}) {
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
        return finishLand(next, sessionId, { postTool });
      }
      if (state.look === 1) {
        next = store.save({
          ...next,
          status: "waiting_fix",
          implementerSession: "",
          qaSession: sessionId,
        });
        const result = {
          status: "ok",
          verdict: "fail",
          look: 1,
          run: next.id,
          implementer: "",
          outcome: `qa look 1 rejected ${state.id}. one fresh implementer.`,
        };
        const transition = async () => {
          await disposeChild(sessionId, "qa look 1 tool result settled");
          try {
            const fixing = await startFixer(store.load(next.id) ?? next, enforced.verdict);
            result.implementer = fixing.implementerSession;
          } catch (error) {
            const current = store.load(next.id) ?? next;
            const blockedState = store.save({
              ...current,
              status: "blocked",
              blockedReason: `fixer child startup failed: ${error instanceof Error ? error.message : String(error)}`,
              packet: current.packet ? { ...current.packet, mark: "fail" } : current.packet,
            });
            await deliverRequiredPacket(blockedState, "blocked", sessionId, { directOnly: true });
          }
        };
        return settleAccepted({
          sessionId,
          result,
          reason: "qa look 1 result committed",
          postTool,
          action: transition,
        });
      }
      next = store.save({
        ...next,
        status: "blocked",
        blockedReason: enforced.verdict.feedback || enforced.verdict.summary,
        packet: next.packet ? { ...next.packet, mark: "fail" } : next.packet,
      });
      const report = await deliverRequiredPacket(next, "blocked", sessionId);
      next = report.state;
      const result = { status: "ok", verdict: "fail", look: 2, outcome: formatOutcome(next, "blocked"), run: next.id };
      if (!report.delivered) return result;
      return settleAccepted({
        sessionId,
        result,
        reason: "qa look 2 result committed",
        postTool,
        action: () => disposeChild(sessionId, "qa look 2 tool result settled"),
      });
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function dispose() {
    for (const handle of [...attached.values()]) handle.detach();
    const pending = [];
    for (const sessionId of [...childOwners.keys()]) {
      const owner = childOwners.get(sessionId);
      const blocked = blockOwnedWork(owner, `${owner?.role || "workflow"} child cancelled by plugin teardown`);
      const state = blocked.state ?? store.load(owner?.runId);
      let delivered = true;
      if (state && (blocked.changed || state.reportPending)) {
        const report = await deliverRequiredPacket(
          state,
          state.reportKind || (state.status === "landed" ? "landed" : "blocked"),
          state.reportFromSession || sessionId,
        );
        delivered = report.delivered;
      }
      if (delivered) {
        if (owner?.externalDisposed) forgetChildOwner(owner);
        else await disposeChild(sessionId, "plugin teardown report delivered");
      } else pending.push(sessionId);
    }
    for (const sessionId of [...childTools.keys()]) {
      if (!childOwners.has(sessionId)) clearChildTools(sessionId);
    }
    return { pending };
  }

  return Object.freeze({
    attach,
    detach,
    dispose,
    adoptImplementer,
    resumeImplementer,
    resumeChild,
    releaseChild,
    done,
    invoke,
    submitVerdict,
    attached: (sessionId) => attached.get(sessionId),
    run: (id) => store.load(id),
    bySession: (sessionId) => store.bySession(sessionId),
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
