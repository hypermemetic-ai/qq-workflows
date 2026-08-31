import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";

import { AGENT_HANDLE, adoptAgentHandle } from "./agent-handle.mjs";
import { forceStopAgent } from "./force-stop.mjs";
import { pinNonInteractiveApproval } from "./approval-policy.mjs";
import { withChildSettlement } from "./child-settlement.mjs";
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
import { createResearchWorkspace, checkAnswerCitations, sha256, workspacePaths } from "./research-evidence.mjs";
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


export const RESEARCH_INLINE_ANSWER_MAX_CHARS = 8_000;
export const RESEARCH_ANSWER_PREVIEW_CHARS = 4_000;
export const RESEARCH_REPORT_MAX_CHARS = 12_000;

function boundedLine(value, limit = 400) {
  const text = String(value ?? "").replace(/[\r\n\t]/g, " ");
  if (text.length <= limit) return text;
  const suffix = `… [${text.length - limit} chars omitted]`;
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`.slice(0, limit);
}

function boundedText(value, limit, label) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  const suffix = `\n[${label}: ${text.length - limit} additional chars omitted]`;
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`.slice(0, limit);
}

export function reportText(state, answer) {
  const findings = state.reviewFindings ?? [];
  const complete = answer.length <= RESEARCH_INLINE_ANSWER_MAX_CHARS;
  const answerBody = complete
    ? ["Complete answer (inlined):", answer.trim()].join("\n")
    : [
        "LARGE ANSWER — BOUNDED PREVIEW ONLY (not the complete answer):",
        boundedText(answer.trim(), RESEARCH_ANSWER_PREVIEW_CHARS, "answer preview"),
        "Read the immutable answer artifact above for complete content.",
      ].join("\n");
  const findingPreview = findings.slice(0, 20).map((finding) =>
    `- answer.md:${finding.line}: ${boundedLine(finding.body)}`);
  const omittedFindings = Math.max(0, findings.length - findingPreview.length);
  const body = [
    `Research delegation ${state.id} completed.`,
    `Immutable answer path: ${state.root}/answer.md`,
    `Answer bytes: ${state.answerBytes || Buffer.byteLength(answer, "utf8")}`,
    `Answer SHA-256: ${state.answerSha256 || sha256(answer)}`,
    `Citation check: ${state.citationCheck?.ok === true ? "passed" : "failed"}`,
    `Review findings: ${findings.length}`,
    ...(findingPreview.length ? findingPreview : ["- none"]),
    ...(omittedFindings ? [`[${omittedFindings} review findings omitted]`] : []),
    "",
    answerBody,
  ].join("\n");
  return boundedText(body, RESEARCH_REPORT_MAX_CHARS, "research report");
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
  const owners = new Map();
  const settlementPromises = new Map();
  const reportPromises = new Map();
  let closing = false;

  function clearBinding(sessionId) {
    const dispose = bindings.get(sessionId);
    bindings.delete(sessionId);
    try { dispose?.(); } catch { /* best effort */ }
  }

  function clearOwnerLifecycle(owner, { notifyFailure = true } = {}) {
    for (const pending of owner?.settlements?.values?.() ?? []) {
      if (notifyFailure) {
        try { pending.onFailure?.(); } catch { /* best effort */ }
      }
      pending.resolve(false);
    }
    owner?.settlements?.clear?.();
    for (const off of owner?.lifecycleOffs ?? []) {
      try { off?.(); } catch { /* best effort */ }
    }
    if (owner) owner.lifecycleOffs = [];
  }

  function resultCallId(message) {
    const sourceCallId = message?.source?.kind === "tool" ? message.source.callId : undefined;
    if (typeof sourceCallId === "string" && sourceCallId) return sourceCallId;
    return (Array.isArray(message?.content) ? message.content : []).find((block) =>
      block?.type === "tool-result" && typeof block.toolCallId === "string" && block.toolCallId)?.toolCallId;
  }

  function resultBlocksFor(message, callId) {
    return (Array.isArray(message?.content) ? message.content : []).filter((block) =>
      block?.type === "tool-result" && block.toolCallId === callId);
  }

  async function disposeOwned(agentOrId, reason = "settled", options = {}) {
    const id = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const owner = owners.get(id);
    const child = owner?.child ?? agents?.get?.(id);
    const handle = owner?.handle ?? child?.[AGENT_HANDLE];
    if (!owner && (!options.force || !child)) return false;

    if (options.force) {
      clearBinding(id);
      if (owner) {
        clearOwnerLifecycle(owner, { notifyFailure: false });
        // detachEntered emits agent/disposed synchronously. Mark disposal before
        // detaching so releaseChild treats this as an owned stop.
        owner.disposePromise ??= Promise.resolve();
      }
      const stopped = forceStopAgent({ agents, agent: child, handle });
      const disposal = stopped.disposal.catch((error) => {
        log(ctx, "warn", `qq-workflows: failed to drain research child ${id} after force stop (${reason}): ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }).finally(() => {
        if (!owner) return;
        try { if (owner.child?.[AGENT_HANDLE] === owner.handle) delete owner.child[AGENT_HANDLE]; } catch { /* non-extensible Agent */ }
        if (owners.get(id) === owner) owners.delete(id);
      });
      if (owner) owner.disposePromise = disposal;
      else void disposal;
      if (options.wait !== false) return disposal;
      return true;
    }

    if (!owner.disposePromise) {
      clearBinding(id);
      clearOwnerLifecycle(owner, { notifyFailure: false });
      owner.disposePromise = (async () => {
        let disposed = false;
        try {
          if (!owner.handle || typeof owner.handle.dispose !== "function") {
            throw new Error("owned child has no recoverable AgentHandle");
          }
          await owner.handle.dispose();
          disposed = true;
        } catch (error) {
          log(ctx, "warn", `qq-workflows: failed to dispose research child ${id} (${reason}): ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (disposed) {
            try { if (owner.child?.[AGENT_HANDLE] === owner.handle) delete owner.child[AGENT_HANDLE]; } catch { /* non-extensible Agent */ }
            if (owners.get(id) === owner) owners.delete(id);
          } else {
            // Keep the handle capability recoverable for a later stop or HMR
            // retry instead of turning one disposal failure into a live leak.
            owner.disposePromise = null;
          }
        }
        return disposed;
      })();
    }
    return owner.disposePromise;
  }

  function runSettlement(owner, pending) {
    if (pending.started || !pending.resultCommitted || !pending.idle) return;
    pending.started = true;
    owner.settlements.delete(pending.callId);
    const promise = Promise.resolve().then(async () => {
      const disposed = await disposeOwned(owner.sessionId, pending.reason);
      pending.resolve(disposed);
      return disposed;
    }).catch((error) => {
      log(ctx, "warn", `qq-workflows: post-result research child settlement failed for ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      pending.resolve(false);
      return false;
    });
    settlementPromises.set(owner.sessionId, promise);
  }

  function errorEnvelopeCommitsPass(owner) {
    const state = store.bySession(owner.sessionId);
    return state?.status === "completed"
      && state.reviewSession === owner.sessionId
      && state.reviewFindings.length === 0;
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
      if (blocks.some((block) => block.isError === true) && !errorEnvelopeCommitsPass(owner)) {
        owner.settlements.delete(callId);
        try { pending.onFailure?.(); } catch { /* best effort */ }
        pending.resolve(false);
        return;
      }
      pending.resultCommitted = true;
      runSettlement(owner, pending);
    });
    if (typeof eventOff === "function") offs.push(eventOff);
    const statusOff = owner.child.ctx?.on?.("agent/status", ({ status } = {}) => {
      if (status !== "idle") return;
      for (const pending of owner.settlements.values()) {
        pending.idle = true;
        runSettlement(owner, pending);
      }
    });
    if (typeof statusOff === "function") offs.push(statusOff);
    owner.lifecycleOffs = offs;
  }

  function retain(created, child) {
    const id = sessionIdOf(child);
    if (!id) throw new Error("research AgentHandle has no child session");
    const handle = created && typeof created.dispose === "function" ? created : child?.[AGENT_HANDLE];
    const existing = owners.get(id);
    if (existing) {
      if (handle && existing.handle !== handle) throw new Error(`research already owns child ${id}`);
      return child;
    }
    if (!handle) return child;
    const owner = {
      sessionId: id,
      child,
      handle,
      settlements: new Map(),
      lifecycleOffs: [],
      disposePromise: null,
    };
    owners.set(id, owner);
    installOwnerLifecycle(owner);
    return child;
  }

  function postToolSettlement(sessionId, result, reason) {
    const owner = owners.get(sessionId);
    if (!owner) return result;
    const waiting = Promise.withResolvers();
    const settlement = {
      settled: waiting.promise,
      arm({ callId, onFailure } = {}) {
        if (typeof callId !== "string" || !callId) throw new Error("research child settlement requires a tool call id");
        if (owner.settlements.has(callId)) throw new Error(`research child settlement already armed for ${callId}`);
        owner.settlements.set(callId, {
          callId,
          reason,
          onFailure,
          resolve: waiting.resolve,
          resultCommitted: false,
          idle: owner.child.status === "idle",
          started: false,
        });
      },
    };
    settlementPromises.set(sessionId, waiting.promise);
    return withChildSettlement(result, settlement);
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
    if (state.status === "completed") {
      try { answer = await readFile(`${state.root}/answer.md`, "utf8"); } catch { /* integrity/report metadata will expose a missing answer */ }
    }
    const relay = relayOf(ctx);
    if (!relay || typeof relay.send !== "function") throw new Error("research completion requires qq-relay");
    const fromId = state.reviewSession || state.researchSession;
    await relay.send({
      fromId,
      to: state.parentSessionUuid,
      message: state.status === "completed"
        ? reportText(state, answer)
        : boundedText([
            `Research delegation ${state.id} blocked.`,
            `Reason: ${boundedLine(state.blockedReason || "child closed before completion", 2_000)}`,
            `Answer artifact (may be incomplete): ${boundedLine(`${state.root}/answer.md`, 1_000)}`,
          ].join("\n"), RESEARCH_REPORT_MAX_CHARS, "blocked research report"),
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
    if (state.reviewSession !== id) {
      return { status: "refused", reason: "submit_review requires the owned research review session" };
    }
    if (state.status === "completed") {
      if (!state.reported) {
        try { await deliver(state); }
        catch (error) {
          log(ctx, "warn", `qq-workflows: research report still pending for ${delegationId}: ${error instanceof Error ? error.message : String(error)}`);
          return { status: "refused", reason: "research answer is durable but its parent report is still pending; retry submit_review" };
        }
      }
      const savedFindings = state.reviewFindings ?? [];
      return postToolSettlement(id, {
        status: "ok",
        verdict: savedFindings.length ? "fail" : "pass",
        alreadySubmitted: true,
        outcome: savedFindings.length ? `${savedFindings.length} research answer defect(s) found` : "research answer review passed",
      }, "research review result committed after report delivery");
    }
    if (state.status !== "reviewing") {
      return { status: "refused", reason: "submit_review requires the owned research review session" };
    }
    const normalized = Array.isArray(findings) ? findings : [];
    try {
      const [answer, manifestText] = await Promise.all([
        readFile(`${state.root}/answer.md`, "utf8"),
        readFile(`${state.root}/evidence/manifest.jsonl`, "utf8"),
      ]);
      if (state.answerSha256 && (sha256(answer) !== state.answerSha256 || Buffer.byteLength(answer, "utf8") !== state.answerBytes)) {
        return { status: "refused", reason: "answer.md changed during fresh-context review" };
      }
      if (state.manifestSha256 && sha256(manifestText) !== state.manifestSha256) {
        return { status: "refused", reason: "evidence/manifest.jsonl changed during fresh-context review" };
      }
    } catch (error) {
      return { status: "refused", reason: `research review artifact integrity check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    state = store.save({ ...state, status: "completed", reviewFindings: normalized });
    try { await deliver(state); }
    catch (error) {
      log(ctx, "warn", `qq-workflows: research report pending for ${delegationId}: ${error instanceof Error ? error.message : String(error)}`);
      return { status: "refused", reason: "research answer is durable but its parent report is pending; retry submit_review" };
    }
    return postToolSettlement(id, {
      status: "ok",
      verdict: normalized.length ? "fail" : "pass",
      outcome: normalized.length ? `${normalized.length} research answer defect(s) found` : "research answer review passed",
    }, "research review result committed");
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
      const child = created?.agent ?? created;
      pinNonInteractiveApproval(child, { delegated: true });
      retain(created, child);
      bindReview(child, planned);
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderMiniResearchReviewTask() }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
      });
      return child;
    } catch (error) {
      const current = store.load(state.id);
      if (current?.status === "reviewing" && current.reviewSession === reviewId) {
        store.save({ ...current, status: "researching", reviewSession: "" });
      }
      if (owners.has(reviewId)) await disposeOwned(reviewId, "research review startup rollback");
      else try { await created?.dispose?.(); } catch { /* rollback */ }
      throw error;
    }
  }

  async function submitResearch(delegationId, { agent } = {}) {
    const state = store.load(delegationId);
    const id = sessionIdOf(agent);
    if (!state) return { status: "refused", reason: "research submission has no run" };
    if (state.researchSession !== id) return { status: "refused", reason: "research submission requires the owned mini-research session" };
    if (state.status === "reviewing" || state.status === "completed") {
      return postToolSettlement(id, { status: "ok", alreadySubmitted: true }, "research result committed");
    }
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
    const [answer, manifestText] = await Promise.all([
      readFile(`${state.root}/answer.md`, "utf8"),
      readFile(`${state.root}/evidence/manifest.jsonl`, "utf8"),
    ]);
    const checked = store.save({
      ...state,
      citationCheck,
      answerSha256: sha256(answer),
      answerBytes: Buffer.byteLength(answer, "utf8"),
      manifestSha256: sha256(manifestText),
    });
    try { await spawnReview(checked); }
    catch (error) { return { status: "refused", reason: `cannot start research review: ${error instanceof Error ? error.message : String(error)}` }; }
    return postToolSettlement(id, {
      status: "ok",
      answerPath: `${state.root}/answer.md`,
      citationCheck,
    }, "research result committed");
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
      const child = created?.agent ?? created;
      pinNonInteractiveApproval(child, { delegated: true });
      retain(created, child);
      bindResearch(child, state);
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderMiniResearchTask() }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
      });
      return { status: "ok", delegationId: state.id, child: sessionIdOf(child), role: "mini-research", phaseEpoch: 1, workspace: state.root };
    } catch (error) {
      state = store.save({ ...state, status: "blocked", blockedReason: error instanceof Error ? error.message : String(error) });
      if (owners.has(childId)) await disposeOwned(childId, "research child startup rollback");
      else try { await created?.dispose?.(); } catch { /* rollback */ }
      return { status: "refused", reason: `research child: ${state.blockedReason}`, delegationId: state.id };
    }
  }

  function resumeChild(agent) {
    const id = sessionIdOf(agent);
    const state = store.bySession(id);
    if (!state) return false;
    pinNonInteractiveApproval(agent, { delegated: true });
    retain(agent?.[AGENT_HANDLE], agent);
    if (isMiniResearchAgent(agent) && state.researchSession === id && state.status === "researching") {
      bindResearch(agent, state);
      return true;
    }
    if (isMiniQaAgent(agent) && state.reviewSession === id
      && (state.status === "reviewing" || (state.status === "completed" && !state.reported))) {
      bindReview(agent, state);
      return true;
    }
    // A durable phase transition can outlive its old live Agent during HMR.
    // Reclaim its retained handle and retire it instead of leaving a completed
    // research/review child visible forever.
    clearBinding(id);
    void disposeOwned(id, `stale ${state.status} research phase`, { force: true, wait: false });
    return true;
  }

  async function releaseChild(agent) {
    const id = sessionIdOf(agent);
    clearBinding(id);
    const owner = owners.get(id);
    const disposing = Boolean(owner?.disposePromise);
    if (owner) {
      clearOwnerLifecycle(owner, { notifyFailure: !disposing });
      owners.delete(id);
      if (!disposing) {
        try { if (agent?.[AGENT_HANDLE] === owner.handle) delete agent[AGENT_HANDLE]; } catch { /* non-extensible Agent */ }
      }
    }
    const state = store.bySession(id);
    if (disposing || !state || ["completed", "blocked"].includes(state.status)) return Boolean(owner);
    const isCurrent = (state.status === "researching" && state.researchSession === id)
      || (state.status === "reviewing" && state.reviewSession === id);
    if (!isCurrent) return Boolean(owner);
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
    if (!phase.sessionUuid) {
      if (found.state.status !== "blocked") {
        return { status: "refused", reason: `delegation is terminal (${found.state.status})` };
      }
      for (const childId of new Set([found.state.researchSession, found.state.reviewSession].filter(Boolean))) {
        await disposeOwned(childId, "blocked research stop retried", { force: true, wait: false });
      }
      return { status: "ok", delegationId: found.state.id, delegationStatus: "blocked", terminal: true };
    }
    const blocked = store.save({ ...found.state, status: "blocked", blockedReason: String(reason || "stopped by parent") });
    clearBinding(phase.sessionUuid);
    await disposeOwned(phase.sessionUuid, "research stopped", { force: true, wait: false });
    try { await deliver(blocked); } catch (error) {
      log(ctx, "warn", `qq-workflows: stopped research report pending for ${blocked.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: "ok", delegationId: blocked.id, delegationStatus: "blocked", terminal: true };
  }

  function dispose() {
    closing = true;
    for (const id of [...bindings.keys()]) clearBinding(id);
    // HMR detaches ownership only. Live DSH handles remain on their Agents and
    // the next controller reclaims them from the shared AGENT_HANDLE capability.
    for (const owner of owners.values()) clearOwnerLifecycle(owner);
    owners.clear();
  }

  return Object.freeze({
    invoke,
    resumeChild,
    releaseChild,
    recoverReports,
    workflowStatus,
    workflowSend,
    workflowStop,
    whenSettled: (sessionId) => settlementPromises.get(sessionId) ?? Promise.resolve(false),
    dispose,
    delegation: (id) => store.load(id),
    byDelegation: (id) => store.byDelegation(id),
    bySession: (id) => store.bySession(id),
  });
}
