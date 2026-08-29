import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";

import { adoptAgentHandle } from "./agent-handle.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { CHILD_ORIGIN, isArchitectCandidate } from "./architect.mjs";
import {
  bindMiniResearch,
  ensureMiniResearchMounted,
  isMiniResearchAgent,
  MINI_RESEARCH_KIND,
  miniResearchSetup,
} from "./mini-research.mjs";
import {
  renderMiniResearchReviewTask,
  renderMiniResearchTask,
} from "./mini-research-v2.mjs";
import {
  bindMiniQaSubmit,
  isMiniQaAgent,
  MINI_QA_KIND,
  miniQaSetup,
} from "./mini-qa.mjs";
import { createResearchWorkspace, checkAnswerCitations, readManifest, workspacePaths } from "./research-evidence.mjs";
import { createResearchOracle } from "./research-oracle.mjs";
import { createResearchSessions } from "./research-sessions.mjs";
import { createResearchWeb } from "./research-web.mjs";

function sessionIdOf(agent) { return agent?.session?.id ?? agent?.id ?? ""; }
function valueOf(value) { return typeof value === "function" ? value() : value; }
function relayOf(ctx) { return ctx?.get?.("qq-relay", false) ?? null; }
function log(ctx, level, message) {
  if (typeof ctx?.logger?.[level] === "function") ctx.logger[level](message);
  else if (level === "warn") console.warn(message);
}

async function projectRoot(ctx, parent) {
  const cwd = parent?.header?.cwd;
  let root = cwd;
  const qq = ctx?.get?.("qq-core", false) ?? ctx?.get?.("qq", false) ?? null;
  if (typeof qq?.gitRootForDelegate === "function") {
    const selected = qq.gitRootForDelegate(cwd);
    if (typeof selected === "string" && selected) root = selected;
  } else if (cwd === qq?.projectsRoot && typeof qq?.listProjects === "function") {
    const selected = qq.listProjects().find((project) => project?.name === qq.defaultProject)?.cwd;
    if (typeof selected === "string" && selected) root = selected;
  }
  if (typeof root !== "string" || !root) throw new Error("research cannot determine the project root");
  return root;
}


function reportText(state, answer) {
  const findings = state.reviewFindings ?? [];
  return [
    `Research delegation ${state.id} completed.`,
    `Answer path: ${state.root}/answer.md`,
    `Citation check: ${state.citationCheck?.ok === true ? "passed" : "failed"}`,
    `Review findings: ${findings.length}`,
    ...(findings.length ? findings.map((finding) => `- answer.md:${finding.line}: ${finding.body}`) : ["- none"]),
    "",
    "Answer:",
    answer.trim(),
  ].join("\n");
}

export function createResearch({
  ctx,
  store,
  agents,
  sessionQuery,
  parentDir,
  implementation,
  architecture,
  qa,
  env = process.env,
  webProvider,
  fetch: fetchImpl,
} = {}) {
  if (!store || typeof store.create !== "function") throw new Error("research requires a durable store");
  const bindings = new Map();
  const handles = new Map();
  const reportPromises = new Map();
  let closing = false;

  function clearBinding(sessionId) {
    const dispose = bindings.get(sessionId);
    bindings.delete(sessionId);
    try { dispose?.(); } catch { /* best effort */ }
  }

  function retain(created, child) {
    const id = sessionIdOf(child);
    if (id) handles.set(id, created);
    return child;
  }

  function liveSessionQuery() {
    return valueOf(sessionQuery) ?? ctx?.get?.("sessionQuery", false) ?? null;
  }

  function persistCandidates(delegationId, field, candidates) {
    const current = store.load(delegationId);
    if (!current || current.status !== "researching") return;
    store.save({ ...current, [field]: candidates });
  }

  function runtimeFor(state) {
    const paths = workspacePaths(state.root);
    let web = null;
    try {
      web = createResearchWeb({
        workspace: paths,
        provider: valueOf(webProvider),
        env,
        fetch: fetchImpl,
        candidates: state.webCandidates,
        onCandidates: (candidates) => persistCandidates(state.id, "webCandidates", candidates),
      });
    } catch {
      // Missing keys/provider fail closed when web-search is invoked; sessions and repo remain usable.
    }
    let sessions = null;
    try {
      sessions = createResearchSessions({
        workspace: paths,
        sessionQuery: liveSessionQuery(),
        candidates: state.sessionCandidates,
        onCandidates: (candidates) => persistCandidates(state.id, "sessionCandidates", candidates),
      });
    } catch {
      // Missing public sessionQuery fails closed when session-search is invoked.
    }
    return { paths, web, sessions };
  }

  async function deliverNow(state) {
    if (state.reported) return true;
    const messageId = state.reportMessageId || randomUUID();
    if (!state.reportMessageId) state = store.save({ ...state, reportMessageId: messageId });
    let answer = "";
    try { answer = await readFile(`${state.root}/answer.md`, "utf8"); } catch { /* blocked runs may have no answer */ }
    const relay = relayOf(ctx);
    if (!relay || typeof relay.send !== "function") throw new Error("research completion requires qq-relay");
    const fromId = state.reviewSession || state.researchSession;
    await relay.send({
      fromId,
      to: state.parentSessionUuid,
      message: state.status === "completed"
        ? reportText(state, answer)
        : `Research delegation ${state.id} blocked: ${state.blockedReason || "child closed before completion"}\nAnswer path: ${state.root}/answer.md`,
      delivery: "default",
      messageId,
    });
    const latest = store.load(state.id);
    if (latest && !latest.reported) store.save({ ...latest, reported: true });
    return true;
  }

  function deliver(state) {
    if (state.reported) return Promise.resolve(true);
    const active = reportPromises.get(state.id);
    if (active) return active;
    const promise = deliverNow(state).finally(() => {
      if (reportPromises.get(state.id) === promise) reportPromises.delete(state.id);
    });
    reportPromises.set(state.id, promise);
    return promise;
  }

  async function completeReview(delegationId, { agent, findings } = {}) {
    let state = store.load(delegationId);
    const id = sessionIdOf(agent);
    if (!state) return { status: "refused", reason: "submit_review has no research delegation" };
    if (state.status === "completed") return { status: "ok", verdict: findings?.length ? "fail" : "pass", alreadySubmitted: true };
    if (state.status !== "reviewing" || state.reviewSession !== id) {
      return { status: "refused", reason: "submit_review requires the owned research review session" };
    }
    const normalized = Array.isArray(findings) ? findings : [];
    state = store.save({ ...state, status: "completed", reviewFindings: normalized });
    try { await deliver(state); }
    catch (error) {
      log(ctx, "warn", `qq-workflows: research report pending for ${delegationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: "ok",
      verdict: normalized.length ? "fail" : "pass",
      outcome: normalized.length ? `${normalized.length} research answer defect(s) found` : "research answer review passed",
    };
  }

  function bindReview(child, state) {
    miniQaSetup(child?.ctx ?? child);
    const oracle = createResearchOracle(state.root);
    clearBinding(sessionIdOf(child));
    const dispose = bindMiniQaSubmit(child, {
      oracle,
      submit: (args) => completeReview(state.id, args),
      isCompleted: () => store.load(state.id)?.status === "completed",
    });
    bindings.set(sessionIdOf(child), dispose);
  }

  async function spawnReview(state) {
    if (!agents || typeof agents.create !== "function") throw new Error("research review requires ctx.agents.create");
    const reviewId = state.reviewSession || `session-${randomUUID()}`;
    const planned = store.save({ ...state, status: "reviewing", reviewSession: reviewId });
    const route = childRoute({
      binding: valueOf(qa) ?? valueOf(architecture),
      env,
    });
    let created;
    try {
      created = adoptAgentHandle(await agents.create({
        sessionId: reviewId,
        meta: {
          cwd: planned.root,
          parentSession: planned.parentSessionUuid,
          origin: CHILD_ORIGIN,
          kind: MINI_QA_KIND,
          agentPreset: MINI_QA_KIND,
          delegationId: planned.id,
        },
        ...childCreateOptions(route, { setup: miniQaSetup }),
      }));
      const child = retain(created, created?.agent ?? created);
      bindReview(child, planned);
      const [answer, manifest] = await Promise.all([
        readFile(`${planned.root}/answer.md`, "utf8"),
        readManifest(workspacePaths(planned.root)),
      ]);
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderMiniResearchReviewTask({ question: planned.question, answer, manifest }) }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
      });
      return child;
    } catch (error) {
      const current = store.load(state.id);
      if (current?.status === "reviewing" && current.reviewSession === reviewId) {
        store.save({ ...current, status: "researching", reviewSession: "" });
      }
      try { await created?.dispose?.(); } catch { /* rollback */ }
      throw error;
    }
  }

  async function submitResearch(delegationId, { agent } = {}) {
    const state = store.load(delegationId);
    const id = sessionIdOf(agent);
    if (!state) return { status: "refused", reason: "research submission has no run" };
    if (state.researchSession !== id) return { status: "refused", reason: "research submission requires the owned mini-research session" };
    if (state.status === "reviewing" || state.status === "completed") return { status: "ok", alreadySubmitted: true };
    if (state.status !== "researching") return { status: "refused", reason: `research delegation is ${state.status}` };
    try {
      const [persistedQuestion, actualRepo] = await Promise.all([
        readFile(`${state.root}/question.md`, "utf8"),
        realpath(`${state.root}/repo`),
      ]);
      if (persistedQuestion !== `${state.question.trimEnd()}\n`) {
        return { status: "refused", reason: "question.md was modified after the research delegation started" };
      }
      if (actualRepo !== state.repoRoot) {
        return { status: "refused", reason: "repo symlink no longer targets the approved project root" };
      }
    } catch (error) {
      return { status: "refused", reason: `research capsule integrity check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const citationCheck = await checkAnswerCitations(workspacePaths(state.root));
    if (!citationCheck.ok) return { status: "refused", reason: citationCheck.reason };
    const checked = store.save({ ...state, citationCheck });
    try { await spawnReview(checked); }
    catch (error) { return { status: "refused", reason: `cannot start research review: ${error instanceof Error ? error.message : String(error)}` }; }
    return { status: "ok", answerPath: `${state.root}/answer.md`, citationCheck };
  }

  function bindResearch(child, state) {
    ensureMiniResearchMounted(child);
    const runtime = runtimeFor(state);
    clearBinding(sessionIdOf(child));
    const dispose = bindMiniResearch(child, {
      ...runtime,
      submit: (args) => submitResearch(state.id, args),
    });
    bindings.set(sessionIdOf(child), dispose);
  }

  async function invoke({ agent, question, delegationId } = {}) {
    if (closing) return { status: "refused", reason: "research is shutting down" };
    if (!isArchitectCandidate(agent)) return { status: "refused", reason: "research requires a root architect session" };
    if (!agents || typeof agents.create !== "function") return { status: "refused", reason: "research requires ctx.agents.create" };
    const parent = agent.session;
    const durableId = String(delegationId ?? "").toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(durableId)) {
      return { status: "refused", reason: "research requires an authoritative delegation UUID" };
    }
    const text = String(question ?? "").trim();
    if (!text) return { status: "refused", reason: "research requires settled working memory" };
    let workspace;
    try {
      const repoRoot = await projectRoot(ctx, parent);
      workspace = await createResearchWorkspace({ parentDir, repoRoot, question: text });
    } catch (error) {
      return { status: "refused", reason: `research capsule: ${error instanceof Error ? error.message : String(error)}` };
    }
    const childId = `session-${randomUUID()}`;
    let state = store.create({
      id: durableId,
      parentSessionUuid: parent.id,
      root: workspace.root,
      repoRoot: workspace.repoRoot,
      question: text,
      researchSession: childId,
    });
    const route = childRoute({ binding: valueOf(implementation) ?? valueOf(architecture), options: agent?.options, env });
    let created;
    try {
      created = adoptAgentHandle(await agents.create({
        sessionId: childId,
        meta: {
          cwd: workspace.root,
          parentSession: parent.id,
          origin: CHILD_ORIGIN,
          kind: MINI_RESEARCH_KIND,
          agentPreset: MINI_RESEARCH_KIND,
          delegationId: state.id,
        },
        ...childCreateOptions(route, { setup: miniResearchSetup }),
      }));
      const child = retain(created, created?.agent ?? created);
      bindResearch(child, state);
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderMiniResearchTask({ task: text }) }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
      });
      return { status: "ok", delegationId: state.id, child: sessionIdOf(child), role: "mini-research", phaseEpoch: 1, workspace: state.root };
    } catch (error) {
      state = store.save({ ...state, status: "blocked", blockedReason: error instanceof Error ? error.message : String(error) });
      try { await created?.dispose?.(); } catch { /* rollback */ }
      return { status: "refused", reason: `research child: ${state.blockedReason}`, delegationId: state.id };
    }
  }

  function resumeChild(agent) {
    const state = store.bySession(sessionIdOf(agent));
    if (!state) return false;
    if (isMiniResearchAgent(agent) && state.researchSession === sessionIdOf(agent) && state.status === "researching") {
      bindResearch(agent, state);
      return true;
    }
    if (isMiniQaAgent(agent) && state.reviewSession === sessionIdOf(agent) && state.status === "reviewing") {
      bindReview(agent, state);
      return true;
    }
    return false;
  }

  async function releaseChild(agent) {
    const id = sessionIdOf(agent);
    clearBinding(id);
    handles.delete(id);
    const state = store.bySession(id);
    if (!state || ["completed", "blocked"].includes(state.status)) return false;
    const isCurrent = (state.status === "researching" && state.researchSession === id)
      || (state.status === "reviewing" && state.reviewSession === id);
    if (!isCurrent) return false;
    const blocked = store.save({ ...state, status: "blocked", blockedReason: `${state.status === "reviewing" ? "mini-qa" : "mini-research"} child closed before completion` });
    try { await deliver(blocked); } catch (error) {
      log(ctx, "warn", `qq-workflows: blocked research report pending for ${state.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  async function recoverReports() {
    for (const state of store.list().filter((run) => ["completed", "blocked"].includes(run.status) && !run.reported)) {
      try { await deliver(state); } catch { /* relay may mount later */ }
    }
  }

  function currentPhase(state) {
    if (state?.status === "researching") return { sessionUuid: state.researchSession, role: "mini-research", phaseEpoch: 1 };
    if (state?.status === "reviewing") return { sessionUuid: state.reviewSession, role: "qa", phaseEpoch: 2 };
    return { sessionUuid: "", role: "", phaseEpoch: state?.reviewSession ? 2 : 1 };
  }

  function ownedDelegation(delegationId, parentSessionUuid) {
    const state = store.byDelegation(delegationId);
    if (!state) return { refusal: { status: "refused", reason: "delegation was not found" } };
    if (state.parentSessionUuid !== parentSessionUuid) {
      return { refusal: { status: "refused", reason: "delegation belongs to a different parent session" } };
    }
    return { state };
  }

  function workflowStatus({ delegationId, parentSessionUuid } = {}) {
    const found = ownedDelegation(delegationId, parentSessionUuid);
    if (found.refusal) return found.refusal;
    const phase = currentPhase(found.state);
    const relay = relayOf(ctx);
    return {
      status: "ok",
      kind: "research",
      delegationId: found.state.id,
      delegationStatus: found.state.status,
      ...phase,
      alias: phase.sessionUuid && typeof relay?.alias === "function" ? (relay.alias(phase.sessionUuid) ?? "") : "",
      transitioning: false,
      terminal: found.state.status === "completed" || found.state.status === "blocked",
      workspace: found.state.root,
      parentSessionUuid: found.state.parentSessionUuid,
    };
  }

  async function workflowSend({ delegationId, message, expectedRole, expectedEpoch, parentSessionUuid } = {}) {
    const found = ownedDelegation(delegationId, parentSessionUuid);
    if (found.refusal) return found.refusal;
    const phase = currentPhase(found.state);
    if (!phase.sessionUuid) return { status: "refused", reason: `delegation is terminal (${found.state.status})` };
    if (expectedRole !== undefined && expectedRole !== phase.role) return { status: "refused", reason: `stale workflow role: expected ${expectedRole}, current is ${phase.role}` };
    if (expectedEpoch !== undefined && expectedEpoch !== phase.phaseEpoch) return { status: "refused", reason: `stale phase epoch: expected ${expectedEpoch}, current is ${phase.phaseEpoch}` };
    if (typeof message !== "string" || !message.trim()) return { status: "refused", reason: "workflow_send requires a non-empty message" };
    const child = agents?.get?.(phase.sessionUuid);
    if (!child) return { status: "refused", reason: "current workflow child is not live" };
    const relay = relayOf(ctx);
    if (!relay || typeof relay.send !== "function") return { status: "refused", reason: "workflow_send requires qq-relay" };
    const sent = await relay.send({ fromId: parentSessionUuid, to: phase.sessionUuid, message, delivery: "default" });
    return { ...sent, delegationId: found.state.id, ...phase, alias: sent?.to_alias ?? "" };
  }

  async function workflowStop({ delegationId, reason, parentSessionUuid } = {}) {
    const found = ownedDelegation(delegationId, parentSessionUuid);
    if (found.refusal) return found.refusal;
    const phase = currentPhase(found.state);
    if (!phase.sessionUuid) return { status: "refused", reason: `delegation is terminal (${found.state.status})` };
    const blocked = store.save({ ...found.state, status: "blocked", blockedReason: String(reason || "stopped by parent") });
    clearBinding(phase.sessionUuid);
    const handle = handles.get(phase.sessionUuid);
    handles.delete(phase.sessionUuid);
    try { await handle?.dispose?.(); } catch { /* state is already terminal */ }
    try { await deliver(blocked); } catch (error) {
      log(ctx, "warn", `qq-workflows: stopped research report pending for ${blocked.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: "ok", delegationId: blocked.id, delegationStatus: "blocked", terminal: true };
  }

  function dispose() {
    closing = true;
    for (const id of [...bindings.keys()]) clearBinding(id);
    // HMR detaches ownership only. Live DSH handles remain on their Agents and
    // the next controller rebinds them from durable run JSON.
    handles.clear();
  }

  return Object.freeze({
    invoke,
    resumeChild,
    releaseChild,
    recoverReports,
    workflowStatus,
    workflowSend,
    workflowStop,
    dispose,
    delegation: (id) => store.load(id),
    byDelegation: (id) => store.byDelegation(id),
    bySession: (id) => store.bySession(id),
  });
}
