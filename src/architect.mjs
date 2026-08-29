// Architect workflow: visible working memory, two-pair fold, and delegate.
// The document is both standing context and the child's complete work packet.

import { randomUUID } from "node:crypto";
import { pluginUserMessage } from "./tools.mjs";
import { createDelegatedWorktree, repoRootFor, runCommand } from "./git.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { MINI_KIND, miniSetup, renderMiniSweTask } from "./official-mini.mjs";
import { CASE_CONTEXT_NAME, CASE_VARIABLE_NAME, isWorkingMemoryEmpty, renderCaseContext } from "./casefile.mjs";
import { guardContext, OVERFLOW_MESSAGE } from "./fold.mjs";
import { markAssemble } from "./assemble-mark.mjs";
import { truncateObservationContent } from "./observation.mjs";
import { adoptAgentHandle } from "./agent-handle.mjs";
import { pinNonInteractiveApproval } from "./approval-policy.mjs";
import { pinChildSandbox } from "./child-isolation.mjs";
import { loadRepositoryIndexContext } from "./repository-index.mjs";

export const ARCHITECT_LABEL = "workflows:architect";
export const CHILD_ORIGIN = "subagent";
export const ARCHITECT_PROMPT_NAME = "qq-workflows:architect";
export const ARCHITECT_PROMPT = [
  "You are the architect. Working memory is your only durable plan document and plan knowledge: fold can erase earlier conversation, and an empty document means you remember nothing.",
  "There is one document and one name: working memory. `case_write` edits working memory; delegation sends those same bytes as the complete packet.",
  "After every operator message that materially changes the plan, call `case_write` before replying. Do not wait for a final plan and do not claim unwritten conversation is authoritative.",
  "Keep working memory concise and operator-visible, edit it freely, and obtain operator approval of the plan before delegation; plan approval is not a tool permission prompt.",
  "Work autonomously on routine in-domain actions; do not ask for routine permission approvals. Your current sandbox is the complete execution boundary for this session.",
  "Never request sandbox escalation or retry with `sandbox_permissions`. If a required action genuinely cannot be performed, stop and explain the limitation instead of auto-escalating. Surface manual approval only for useful exceptional work clearly outside the normal domain.",
  "Use `delegate({ kind: \"implementation\" })` for implementation or `delegate({ kind: \"research\" })` for evidence-backed questions. Delegation requires approved, settled, non-empty working memory.",
  "Communicate with other architects through relay. Never communicate directly with another architect's children; communicate with your own children only through workflow-owned tools.",
  "Use `workflow_status` and `workflow_send` for live delegations. If an incomplete owned delegation's exact current child is inactive, use `workflow_resume` with role/epoch guards; do not stop it or resume a physical session UUID directly.",
].join("\n");

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_AGENT_HANDLE = Symbol.for("@hypermemetic-ai/qq-workflows/child-agent-handle");

export function isArchitectCandidate(agent) {
  if (agent?.session?.header?.origin === CHILD_ORIGIN) return false;
  if (typeof agent?.session?.header?.parentSession === "string" && agent.session.header.parentSession.length > 0) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
}

function relayOf(ctx) {
  return ctx.get?.("qq-relay", false) ?? null;
}

function systemPromptOf(holder) {
  return holder?.systemPrompt
    ?? holder?.get?.("systemPrompt", false)
    ?? holder?.ctx?.systemPrompt
    ?? holder?.ctx?.get?.("systemPrompt", false)
    ?? null;
}

function logLine(ctx, level, message) {
  if (typeof ctx?.logger?.[level] === "function") ctx.logger[level](message);
  else if (level === "warn") console.warn(message);
}

function hangLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.hang !== "function") return false;
  try {
    relay.hang(sessionId, ARCHITECT_LABEL);
    logLine(ctx, "info", `qq-workflows: hung ${ARCHITECT_LABEL} on ${sessionId}`);
    return true;
  } catch (error) {
    logLine(ctx, "warn", `qq-workflows: failed to hang ${ARCHITECT_LABEL} on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function clearLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.clear !== "function") return false;
  try {
    relay.clear(sessionId, ARCHITECT_LABEL);
    return true;
  } catch {
    return false;
  }
}

function failVisibly(session, text) {
  if (typeof session?.append !== "function") return;
  session.append("user/message", pluginUserMessage(text, "notice"), { surfaceOp: "append" });
}

function lastAssistantText(events) {
  if (!Array.isArray(events)) return "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const text = (event.data?.message?.content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

function watchChildReturn({ ctx, relay, child, parentId, onDelivered }) {
  const childId = child?.session?.id;
  if (!relay || typeof relay.send !== "function" || !childId || !parentId) return () => {};
  let sent = false;
  const sendBack = async () => {
    if (sent) return;
    const text = lastAssistantText(child.session?.events ?? []);
    if (!text) return;
    sent = true;
    try {
      await relay.send({ fromId: childId, to: parentId, message: text, delivery: "default" });
      await onDelivered?.();
    } catch (error) {
      sent = false;
      logLine(ctx, "warn", `qq-workflows: delegate result was not delivered to ${parentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const off = child.ctx?.on?.("session/event", async (_session, event) => {
    if (event?.type === "turn/end") await sendBack();
  });
  return typeof off === "function" ? off : () => {};
}

export async function capArchitectToolObservation(_exec, result, next) {
  const decision = await next();
  if (decision?.kind === "block") {
    const feedback = truncateObservationContent(decision.feedback);
    return feedback === decision.feedback ? decision : { ...decision, feedback };
  }
  if (decision?.kind !== "accept" || Object.hasOwn(decision, "value")) return decision;
  const content = decision.content ?? result?.content;
  const capped = truncateObservationContent(content);
  return capped === content ? decision : { ...decision, content: capped };
}

export function createArchitect({ ctx, cases, folder, agents, tasks, architecture, implementation, onInvokeImplementation, onInvokeChild, onResearch, onDelegateKind, loadIndex, run = runCommand, env = process.env } = {}) {
  const attached = new Map();
  const delegatedHandles = new Map();
  const tasksOf = () => (typeof tasks === "function" ? tasks() : tasks ?? null);
  const liveArchitectureRoute = (agent) => childRoute({
    binding: typeof architecture === "function" ? architecture() : architecture,
    options: agent?.options,
    env,
  });

  function retainDelegated(handle, child) {
    const sessionId = child?.session?.id ?? child?.id;
    if (!sessionId) throw new Error("delegate AgentHandle has no child session");
    const record = { handle, child, disposePromise: null };
    delegatedHandles.set(sessionId, record);
    try {
      Object.defineProperty(child, CHILD_AGENT_HANDLE, {
        value: handle,
        configurable: true,
      });
    } catch {
      // The in-memory owner remains authoritative for this plugin lifetime.
    }
    return record;
  }

  async function disposeDelegated(agentOrId) {
    const sessionId = typeof agentOrId === "string"
      ? agentOrId
      : agentOrId?.session?.id ?? agentOrId?.id;
    const record = delegatedHandles.get(sessionId);
    if (!record) return false;
    if (!record.disposePromise) {
      record.disposePromise = (async () => {
        try {
          await record.handle?.dispose?.();
        } catch (error) {
          logLine(ctx, "warn", `qq-workflows: failed to dispose delegated child ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          try {
            if (record.child?.[CHILD_AGENT_HANDLE] === record.handle) delete record.child[CHILD_AGENT_HANDLE];
          } catch { /* non-extensible Agent */ }
          if (delegatedHandles.get(sessionId) === record) delegatedHandles.delete(sessionId);
        }
      })();
    }
    await record.disposePromise;
    return true;
  }

  function attach(agent) {
    if (!isArchitectCandidate(agent)) return null;
    const session = agent.session;
    const sessionId = session.id;
    pinNonInteractiveApproval(session);
    if (attached.has(sessionId)) return attached.get(sessionId);
    cases?.open?.(sessionId, tasksOf());
    cases?.ensure?.(sessionId);
    hangLabel(ctx, sessionId);

    let lastTurn;
    let disposeEvent;
    let disposeTurn;
    let disposeAssemble;
    let disposeObservation;
    const contextOffs = [];
    const reportedRepositoryIndexErrors = new Set();

    function bindArchitectContext(holder) {
      const prompt = systemPromptOf(holder) ?? systemPromptOf(agent);
      if (typeof prompt?.context !== "function") return;
      while (contextOffs.length) {
        try { contextOffs.pop()?.(); } catch { /* lift */ }
      }
      const promptOff = prompt.context({ name: ARCHITECT_PROMPT_NAME, order: 10, text: () => ARCHITECT_PROMPT });
      if (typeof promptOff === "function") contextOffs.push(promptOff);

      const repositoryIndex = loadRepositoryIndexContext({ ctx, cwd: session.header?.cwd, loadIndex });
      if (repositoryIndex.error) {
        const detail = repositoryIndex.error instanceof Error ? repositoryIndex.error.message : String(repositoryIndex.error);
        if (!reportedRepositoryIndexErrors.has(detail)) {
          reportedRepositoryIndexErrors.add(detail);
          const message = `qq-workflows: repository index was not injected (${detail}).`;
          logLine(ctx, "warn", message);
          failVisibly(session, message);
        }
      } else if (repositoryIndex.context) {
        const repositoryIndexOff = prompt.context(repositoryIndex.context);
        if (typeof repositoryIndexOff === "function") contextOffs.push(repositoryIndexOff);
      }

      if (!cases) return;
      // Case prose is operator/model-authored and may contain DSH prompt groups.
      // Inline body in context text is interpolated and aborts the turn; a
      // registered variable is substituted without a second scan.
      if (typeof prompt.variable !== "function") return;
      const varOff = prompt.variable(
        CASE_VARIABLE_NAME,
        () => String(cases.load(sessionId)?.text ?? "").trim(),
      );
      if (typeof varOff === "function") contextOffs.push(varOff);
      const caseOff = prompt.context({
        name: CASE_CONTEXT_NAME,
        order: 20,
        text: () => {
          const body = String(cases.load(sessionId)?.text ?? "").trim();
          const id = cases.taskId?.(sessionId);
          return renderCaseContext({ body, taskId: id });
        },
      });
      if (typeof caseOff === "function") contextOffs.push(caseOff);
    }
    if (typeof agent?.ctx?.inject === "function") agent.ctx.inject(["systemPrompt"], bindArchitectContext);
    else bindArchitectContext(agent?.ctx ?? agent);

    try {
      disposeObservation = agent.ctx?.on?.("tools/post-execute", capArchitectToolObservation, { prepend: true });
      disposeEvent = agent.ctx?.on?.("session/event", (_session, event) => {
        if (event?.type === "turn/end") lastTurn = event.data?.turn;
      });
      disposeTurn = agent.ctx?.on?.("session/event", (_session, event) => {
        if (event?.type !== "turn/end") return;
        try {
          folder?.decide?.(sessionId, { events: session.events, session, route: liveArchitectureRoute(agent) });
        } catch {
          // Fold decisions never block the architecture loop.
        }
      });
      disposeAssemble = agent.ctx?.on?.("agent/request", async (payload, next) => {
        const started = Date.now();
        let talkingTokens;
        let q;
        try {
          const guard = guardContext({ ctx, session, route: liveArchitectureRoute(agent) });
          if (guard.pruneError) {
            failVisibly(session, `qq-workflows: tool-result prune refused (${guard.pruneError instanceof Error ? guard.pruneError.message : String(guard.pruneError)}).`);
          }
          const pending = folder?.pending?.(sessionId);
          if (pending?.action === "fail") folder.clear(sessionId);
          else if (pending?.action === "drop") {
            const applied = folder.apply(sessionId, {
              events: session.events,
              session,
              workingMemory: cases?.load?.(sessionId)?.text ?? "",
            });
            if (applied?.action === "fail" && applied.reason === "working-memory-empty") {
              failVisibly(session, applied.message);
            }
          }
          const after = guardContext({ ctx, session, route: liveArchitectureRoute(agent) });
          talkingTokens = after.talking;
          q = after.q;
          if ((after.talking ?? 0) > (after.q ?? 0)) {
            failVisibly(session, OVERFLOW_MESSAGE);
            throw new Error(OVERFLOW_MESSAGE);
          }
          return await next();
        } finally {
          markAssemble(session, {
            turn: payload?.turn,
            step: payload?.step,
            ms: Date.now() - started,
            talking: talkingTokens,
            q,
          });
        }
      });
    } catch {
      // Working memory and the label survive hosts that reject fiber listeners.
    }

    if (agent.status !== "running") {
      try { guardContext({ ctx, session, route: liveArchitectureRoute(agent) }); } catch { /* attach must not fail */ }
      try {
        const decision = folder?.decide?.(sessionId, { events: session.events ?? [], session, route: liveArchitectureRoute(agent) });
        if (decision?.action === "drop") {
          const applied = folder.apply(sessionId, {
            events: session.events ?? [],
            session,
            workingMemory: cases?.load?.(sessionId)?.text ?? "",
          });
          if (applied?.action === "fail" && applied.reason === "working-memory-empty") {
            failVisibly(session, applied.message);
          }
        }
      } catch {
        try { folder?.clear?.(sessionId); } catch { /* attach must not fail */ }
      }
    }

    const handle = {
      sessionId,
      agent,
      lastTurn: () => lastTurn,
      detach() {
        disposeEvent?.();
        disposeTurn?.();
        disposeAssemble?.();
        disposeObservation?.();
        while (contextOffs.length) {
          try { contextOffs.pop()?.(); } catch { /* lift */ }
        }
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
    return Boolean(handle);
  }

  async function delegateImplementation({ agent } = {}) {
    const relay = relayOf(ctx);
    if (!relay) return { status: "refused", reason: "delegate requires qq-relay" };
    const parent = agent?.session;
    if (!parent?.id || !isArchitectCandidate(agent) || !attached.has(parent.id)) {
      return { status: "refused", reason: "delegate requires a live architect session" };
    }
    if (!agents || typeof agents.create !== "function") {
      return { status: "refused", reason: "delegate requires ctx.agents.create" };
    }
    const brief = String(cases?.load?.(parent.id)?.text ?? "");
    if (isWorkingMemoryEmpty(brief)) {
      return { status: "refused", reason: "delegate requires settled working memory" };
    }
    const delegationId = randomUUID();
    // Topology belongs in child headers and durable workflow state. The first
    // implementation prompt receives the semantic working-memory bytes once;
    // routing IDs and auto-return notices are not part of the task.
    const task = brief;
    const taskId = cases?.taskId?.(parent.id) ?? null;
    const childId = `session-${randomUUID()}`;
    const parentCwd = parent.header?.cwd;
    let targetCwd = repoRootFor(parentCwd);
    let preparedGit = null;
    let gitRootResolved = false;
    const qq = ctx?.get?.("qq-core", false) ?? ctx?.get?.("qq", false) ?? null;
    if (typeof qq?.gitRootForDelegate === "function") {
      const gitRoot = qq.gitRootForDelegate(parentCwd);
      if (typeof gitRoot === "string" && gitRoot.length > 0) {
        targetCwd = gitRoot;
        gitRootResolved = true;
      }
    } else if (parentCwd === qq?.projectsRoot && typeof qq?.listProjects === "function") {
      const gitRoot = qq.listProjects().find((project) => project?.name === qq.defaultProject)?.cwd;
      if (typeof gitRoot === "string" && gitRoot.length > 0) {
        targetCwd = gitRoot;
        gitRootResolved = true;
      }
    }
    try {
      const prepared = await createDelegatedWorktree(run, {
        cwd: targetCwd,
        brief: task,
        id: childId,
        env,
      });
      preparedGit = prepared;
      targetCwd = prepared.workspace || prepared.worktree;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (gitRootResolved || !/not a git worktree/i.test(message)) {
        return { status: "refused", reason: `delegate worktree: ${message}` };
      }
    }
    const implementationBinding = typeof implementation === "function" ? implementation() : implementation;
    const architectureBinding = typeof architecture === "function" ? architecture() : architecture;
    const route = childRoute({
      binding: implementationBinding ?? architectureBinding,
      options: agent?.options,
      env,
    });
    const created = adoptAgentHandle(await agents.create({
      sessionId: childId,
      meta: {
        cwd: targetCwd,
        parentSession: parent.id,
        origin: CHILD_ORIGIN,
        kind: MINI_KIND,
        agentPreset: MINI_KIND,
      },
      ...childCreateOptions(route, { setup: miniSetup }),
    }));
    const child = created?.agent ?? created;
    pinNonInteractiveApproval(child, { delegated: true });
    pinChildSandbox(child, "implementation");
    const childSessionId = child.session?.id ?? childId;
    retainDelegated(created, child);
    const refuseAdoption = async (reason, { dispose = true } = {}) => {
      let cleanupError = "";
      if (dispose) {
        try {
          await disposeDelegated(childSessionId);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        status: "refused",
        reason: cleanupError
          ? `land adoption failed: ${reason}; child cleanup failed: ${cleanupError}`
          : `land adoption failed: ${reason}`,
      };
    };
    let adoption;
    const invokeImplementation = onInvokeImplementation ?? onInvokeChild;
    if (typeof invokeImplementation === "function") {
      try {
        adoption = await invokeImplementation(child, {
          handle: created,
          brief: task,
          delegationId,
          taskId,
          parent,
          parentSession: parent.id,
          cwd: targetCwd,
          git: preparedGit,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return refuseAdoption(detail);
      }
      if (adoption?.owned === true) delegatedHandles.delete(childSessionId);
      if (adoption?.status === "refused") {
        return refuseAdoption(adoption.reason || "refused", { dispose: adoption.owned !== true });
      }
    }
    // Land owns completion delivery and child disposal after adoption. Keeping
    // the generic last-assistant-text watcher as well can duplicate or race the
    // structured land report. Unowned delegates retain the generic fallback.
    if (adoption?.owned !== true) {
      watchChildReturn({
        ctx,
        relay,
        child,
        parentId: parent.id,
        onDelivered: () => disposeDelegated(childSessionId),
      });
    }
    try {
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderMiniSweTask(task) }],
        source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (adoption?.owned === true && typeof adoption.rollback === "function") {
        await adoption.rollback(detail);
        return refuseAdoption(detail, { dispose: false });
      }
      return refuseAdoption(detail);
    }
    cases?.consume?.(parent.id);
    const alias = typeof relay.alias === "function" ? relay.alias(child.session?.id ?? childId) : undefined;
    return {
      status: "ok",
      delegationId: adoption?.delegationId || delegationId,
            child: child.session?.id ?? childId,
      alias: alias ?? "",
      role: adoption?.role || "implementation",
      phaseEpoch: adoption?.phaseEpoch || 1,
      delivery: "default",
    };
  }

  async function delegate({ agent, kind = "implementation" } = {}) {
    if (kind === "implementation") return delegateImplementation({ agent });
    if (kind !== "research" && typeof onDelegateKind !== "function") {
      return { status: "refused", reason: `unknown delegation kind: ${String(kind ?? "")}` };
    }
    const parent = agent?.session;
    if (!parent?.id || !isArchitectCandidate(agent) || !attached.has(parent.id)) {
      return { status: "refused", reason: "delegate requires a live architect session" };
    }
    const memory = String(cases?.load?.(parent.id)?.text ?? "");
    if (isWorkingMemoryEmpty(memory)) {
      return { status: "refused", reason: "delegate requires settled working memory" };
    }
    const delegationId = randomUUID();
    // Non-implementation delegation kinds receive semantic task data only.
    // The authoritative UUID/parent live in invoke arguments and child headers.
    const packet = memory.trimEnd();
    const invoke = kind === "research" ? onResearch : onDelegateKind;
    if (typeof invoke !== "function") return { status: "refused", reason: `${kind} is unavailable` };
    const result = await invoke({
      kind,
      agent,
      parent,
      parentSessionUuid: parent.id,
      delegationId,
      packet,
      question: memory.trimEnd(),
      taskId: cases?.taskId?.(parent.id) ?? null,
    });
    if (result?.status === "ok") cases?.consume?.(parent.id);
    return result;
  }

  async function dispose() {
    for (const handle of [...attached.values()]) handle.detach();
    for (const sessionId of [...delegatedHandles.keys()]) await disposeDelegated(sessionId);
  }

  return Object.freeze({
    attach,
    detach,
    dispose,
    delegate,
    attached: (sessionId) => attached.get(sessionId),
    label: ARCHITECT_LABEL,
  });
}
