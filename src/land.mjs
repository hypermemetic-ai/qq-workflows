// Land workflow: route stamp, isolated QA, two-look cap, then merge.
//
// Architect does not merge. The implementer calls `done`. This chair stamps
// land or review, runs the land worker or an isolated QA child, and always
// packets the architect session through qq-relay default steer.
//
// This is not iterate's pixel reviewer. QA has tools and owns test-only
// commits. Paint-only changes may land; control paths default to review.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";

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
import { childCreateOptions, childRoute } from "./child-model.mjs";
import {
  buildDoneTool,
  buildQaVerdictTool,
  QA_TOOL_ALLOWLIST,
} from "./land-tools.mjs";

export const LAND_LABEL = "workflows:land";
export const CHILD_ORIGIN = "subagent";
export const ROUTE_PACKET_SCHEMA = "qq.route-packet/v1";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** A chair that may be selected as land. Children never are. */
export function isLandCandidate(agent) {
  const origin = agent?.session?.header?.origin;
  if (origin === CHILD_ORIGIN) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      timeout: options.timeout ?? 30_000,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = Number.isInteger(error.code) ? error.code : 1;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? error.message });
        return;
      }
      resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function reason(result, fallback) {
  return result?.stderr?.trim() || result?.stdout?.trim() || fallback;
}

async function checked(run, command, args, options, label) {
  const result = await run(command, args, options);
  if (result?.code !== 0) throw new Error(`${label}: ${reason(result, "command failed")}`);
  return result;
}

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

export async function inspectWorktree(run, cwd) {
  if (!cwd || typeof cwd !== "string") throw new Error("done requires a worktree");
  const top = await checked(run, "git", ["rev-parse", "--show-toplevel"], { cwd }, "not a git worktree");
  const worktree = (await realpath(top.stdout.trim()));
  const common = await checked(
    run, "git", ["rev-parse", "--git-common-dir"], { cwd: worktree }, "cannot resolve git common dir",
  );
  const commonDir = common.stdout.trim();
  const gitDir = await realpath(commonDir.startsWith("/") ? commonDir : `${worktree}/${commonDir}`);
  const mainRoot = await realpath(gitDir.endsWith(".git") ? dirname(gitDir) : gitDir);
  const branch = await checked(
    run, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: worktree }, "worktree HEAD is detached",
  );
  let baseBranch = "main";
  const mainCheck = await run("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: mainRoot });
  if (mainCheck?.code !== 0) {
    const master = await run("git", ["rev-parse", "--verify", "refs/heads/master"], { cwd: mainRoot });
    if (master?.code === 0) baseBranch = "master";
  }
  const base = await checked(
    run, "git", ["rev-parse", "--verify", baseBranch], { cwd: mainRoot }, `cannot resolve ${baseBranch}`,
  );
  return {
    worktree,
    mainRoot,
    branch: branch.stdout.trim(),
    baseBranch,
    baseRef: base.stdout.trim(),
  };
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
  await checked(
    run, "git", ["worktree", "remove", "--force", worktree], { cwd: mainRoot }, "worktree cleanup failed",
  );
  await checked(
    run, "git", ["branch", "-d", state.branch], { cwd: mainRoot }, "merged but branch cleanup failed",
  );
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
  llm,
  run = runCommand,
  complete,
  env = process.env,
} = {}) {
  const attached = new Map();
  const childTools = new Map();
  const settledQa = new Set();

  function binding(role) {
    return settings?.get?.(role) ?? null;
  }

  async function stamp(packet) {
    const hop = complete ?? (binding("router")
      ? async ({ system, user }) => oneShot(llm, binding("router"), { system, user })
      : undefined);
    return routePacket(packet, { complete: hop, prompt: ROUTE_SYSTEM });
  }

  async function sendPacket(state, kind, fromId) {
    const relay = relayOf(ctx);
    if (!relay || typeof relay.send !== "function" || !state.architectSession) return false;
    const message = formatOutcome(state, kind);
    try {
      await relay.send({
        fromId: fromId || state.qaSession || state.implementerSession || attached.keys().next().value || state.id,
        to: state.architectSession,
        message,
        delivery: "default",
      });
      return true;
    } catch (error) {
      logLine(
        ctx,
        "warn",
        `qq-workflows: land packet was not delivered to ${state.architectSession}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
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
    childTools.get(sessionId)?.();
    childTools.delete(sessionId);
    return Boolean(handle) || childTools.has(sessionId);
  }

  function installDone(child, runId) {
    const sessionId = sessionIdOf(child);
    childTools.get(sessionId)?.();
    const dispose = registerTools(child, [
      buildDoneTool({
        submit: (args) => done({ ...args, runId }),
      }),
    ]);
    childTools.set(sessionId, dispose);
    return dispose;
  }

  function installQa(child, runId) {
    const sessionId = sessionIdOf(child);
    childTools.get(sessionId)?.();
    const dispose = registerTools(child, [
      buildQaVerdictTool({
        submit: (args) => submitVerdict({ ...args, runId }),
      }),
    ], { allow: QA_TOOL_ALLOWLIST });
    childTools.set(sessionId, dispose);
    return dispose;
  }

  async function adoptImplementer(child, info = {}) {
    const sessionId = sessionIdOf(child);
    if (!sessionId) return { status: "refused", reason: "adopt requires a child session" };
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
    const record = store.create({
      architectSession,
      implementerSession: sessionId,
      originalImplementerSession: sessionId,
      brief,
      ...git,
    });
    installDone(child, record.id);
    return { status: "ok", run: record.id, child: sessionId };
  }

  async function spawnChild({ role, cwd, parentSession, system, user, install }) {
    if (!agents || typeof agents.create !== "function") {
      throw new Error("land requires ctx.agents.create");
    }
    const route = childRoute({
      binding: binding(role),
      env,
    });
    const childId = `session-${randomUUID()}`;
    const handle = await agents.create({
      sessionId: childId,
      meta: {
        cwd,
        parentSession,
        origin: CHILD_ORIGIN,
        landRole: role,
      },
      ...childCreateOptions(route),
    });
    const child = handle?.agent ?? handle;
    install?.(child);
    const seed = [system, user].filter(Boolean).join("\n\n");
    child.followup?.({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: seed }],
      source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
    });
    return child;
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
        verdict: createQaVerdict({
          verdict: "fail",
          summary: "qa ended without a structured verdict",
          feedback: "qa ended without a structured verdict",
          tests_modified: false,
        }),
      });
    };
    child.ctx?.on?.("session/event", async (_session, event) => {
      if (event?.type === "turn/end") await finish();
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
    const child = await spawnChild({
      role: "qa",
      cwd: state.worktree,
      parentSession,
      system: QA_SYSTEM,
      user,
      install: (next) => installQa(next, state.id),
    });
    const qaSession = sessionIdOf(child);
    const next = store.save({
      ...state,
      status: "reviewing",
      qaSession,
      qaVerdict: null,
    });
    watchQaSettle(child, next.id);
    return next;
  }

  async function startFixer(state, verdict) {
    const parentSession = [...attached.keys()][0] || state.architectSession;
    const user = look1FixPrompt({ ...state, task: { id: state.id } }, verdict);
    const child = await spawnChild({
      role: "implementer",
      cwd: state.worktree,
      parentSession,
      user,
      install: (next) => installDone(next, state.id),
    });
    const implementerSession = sessionIdOf(child);
    return store.save({
      ...state,
      status: "waiting_fix",
      implementerSession,
      qaSession: "",
    });
  }

  async function finishLand(state, fromId) {
    let next = store.save({ ...state, status: "landing" });
    try {
      await landWorktree(run, next);
      next = store.save({
        ...next,
        status: "landed",
        landedAt: new Date().toISOString(),
        packet: next.packet ? { ...next.packet, mark: "land" } : next.packet,
      });
      await sendPacket(next, "landed", fromId);
      return { status: "ok", mark: "land", outcome: formatOutcome(next, "landed"), run: next.id };
    } catch (error) {
      const blocked = store.save({
        ...next,
        status: "blocked",
        blockedReason: error instanceof Error ? error.message : String(error),
        packet: next.packet ? { ...next.packet, mark: "fail" } : next.packet,
      });
      await sendPacket(blocked, "blocked", fromId);
      return { status: "ok", mark: "fail", outcome: formatOutcome(blocked, "blocked"), run: blocked.id };
    }
  }

  async function done({ agent, ref = "HEAD", runId } = {}) {
    const sessionId = sessionIdOf(agent);
    const state = (runId ? store.load(runId) : null) ?? store.bySession(sessionId);
    if (!state) return { status: "refused", reason: "done has no land run for this session" };
    if (state.implementerSession && state.implementerSession !== sessionId) {
      return { status: "refused", reason: "done requires the owned implementer session" };
    }
    if (state.status === "blocked" || state.status === "landed") {
      return { status: "refused", reason: `handoff is ${state.status}, not ready for done` };
    }
    if (state.status === "reviewing" || state.status === "landing") {
      return { status: "refused", reason: `handoff is ${state.status}, not ready for done` };
    }
    if (state.status === "waiting_fix") {
      if (state.look !== 1) return { status: "refused", reason: "qa already used both looks" };
    } else if (state.status !== "running") {
      return { status: "refused", reason: `handoff is ${state.status}, not ready for done` };
    } else if (state.look !== 0) {
      return { status: "refused", reason: "qa already used both looks" };
    }
    try {
      if (!state.worktree) return { status: "refused", reason: "done requires a worktree" };
      const cwd = await realpath(agent?.session?.header?.cwd || state.worktree);
      const expected = await realpath(state.worktree);
      if (cwd !== expected) return { status: "refused", reason: "done must run from its delegated worktree" };
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
      if (mark === "land") return finishLand(next, sessionId);
      next = store.save({ ...next, look: look === 0 ? 1 : look, status: "reviewing" });
      next = await startQa(next);
      return { status: "ok", mark: "review", look: next.look, run: next.id, qa: next.qaSession };
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function submitVerdict({ agent, verdict, runId } = {}) {
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
        return finishLand(next, sessionId);
      }
      if (state.look === 1) {
        next = await startFixer(next, enforced.verdict);
        return {
          status: "ok",
          verdict: "fail",
          look: 1,
          run: next.id,
          implementer: next.implementerSession,
          outcome: `qa look 1 rejected ${state.id}. one fresh implementer.`,
        };
      }
      next = store.save({
        ...next,
        status: "blocked",
        blockedReason: enforced.verdict.feedback || enforced.verdict.summary,
        packet: next.packet ? { ...next.packet, mark: "fail" } : next.packet,
      });
      await sendPacket(next, "blocked", sessionId);
      return { status: "ok", verdict: "fail", look: 2, outcome: formatOutcome(next, "blocked"), run: next.id };
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function dispose() {
    for (const handle of [...attached.values()]) handle.detach();
    for (const disposeTools of [...childTools.values()]) disposeTools();
    childTools.clear();
  }

  return Object.freeze({
    attach,
    detach,
    dispose,
    adoptImplementer,
    done,
    submitVerdict,
    attached: (sessionId) => attached.get(sessionId),
    run: (id) => store.load(id),
    bySession: (sessionId) => store.bySession(sessionId),
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
