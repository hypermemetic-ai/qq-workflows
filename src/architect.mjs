// Architect workflow: visible working memory, two-pair fold, and delegate.
// The document is both standing context and the child's complete work packet.

import { randomUUID } from "node:crypto";
import { pluginUserMessage } from "./tools.mjs";
import { createDelegatedWorktree, repoRootFor, runCommand } from "./git.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { hideHarnessToolsOn } from "./hide-harness.mjs";
import { MINI_KIND, miniSetup, renderMiniSweTask } from "./official-mini.mjs";
import { CASE_CONTEXT_NAME, CASE_VARIABLE_NAME, EMPTY_CASE, renderCaseContext } from "./casefile.mjs";
import { guardContext, OVERFLOW_MESSAGE } from "./fold.mjs";
import { markAssemble } from "./assemble-mark.mjs";
import { truncateObservationContent } from "./observation.mjs";
import { adoptAgentHandle } from "./agent-handle.mjs";
import { loadWikiIndexContext } from "./wiki-index.mjs";

export const ARCHITECT_LABEL = "workflows:architect";
export const CHILD_ORIGIN = "subagent";
export const ARCHITECT_PROMPT_NAME = "qq-workflows:architect";
export const ARCHITECT_PROMPT = "You are the architect. Use the current turn, last turn, and standing plan document to maintain a concise operator-visible work order. Edit it freely, get operator approval, then delegate; delegation sends that approved plan document without automatically attaching files or research dumps.";

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

export function createArchitect({ ctx, cases, folder, agents, tasks, talking, hands, onInvokeChild, loadIndex, run = runCommand, env = process.env } = {}) {
  const attached = new Map();
  const delegatedHandles = new Map();
  const tasksOf = () => (typeof tasks === "function" ? tasks() : tasks ?? null);

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
    const reportedWikiErrors = new Set();

    function bindArchitectContext(holder) {
      const prompt = systemPromptOf(holder) ?? systemPromptOf(agent);
      if (typeof prompt?.context !== "function") return;
      while (contextOffs.length) {
        try { contextOffs.pop()?.(); } catch { /* lift */ }
      }
      const promptOff = prompt.context({ name: ARCHITECT_PROMPT_NAME, order: 10, text: () => ARCHITECT_PROMPT });
      if (typeof promptOff === "function") contextOffs.push(promptOff);

      const wiki = loadWikiIndexContext({ ctx, cwd: session.header?.cwd, loadIndex });
      if (wiki.error) {
        const detail = wiki.error instanceof Error ? wiki.error.message : String(wiki.error);
        if (!reportedWikiErrors.has(detail)) {
          reportedWikiErrors.add(detail);
          const message = `qq-workflows: wiki index was not injected (${detail}).`;
          logLine(ctx, "warn", message);
          failVisibly(session, message);
        }
      } else if (wiki.context) {
        const wikiOff = prompt.context(wiki.context);
        if (typeof wikiOff === "function") contextOffs.push(wikiOff);
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
          folder?.decide?.(sessionId, { events: session.events, session, route: agent.options });
        } catch {
          // Fold decisions never block the talking loop.
        }
      });
      disposeAssemble = agent.ctx?.on?.("agent/request", async (payload, next) => {
        const started = Date.now();
        let talkingTokens;
        let q;
        try {
          const guard = guardContext({ ctx, session, route: agent.options });
          if (guard.pruneError) {
            failVisibly(session, `qq-workflows: tool-result prune refused (${guard.pruneError instanceof Error ? guard.pruneError.message : String(guard.pruneError)}).`);
          }
          const pending = folder?.pending?.(sessionId);
          if (pending?.action === "fail") folder.clear(sessionId);
          else if (pending?.action === "drop") folder.apply(sessionId, { events: session.events, session });
          const after = guardContext({ ctx, session, route: agent.options });
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
      try { guardContext({ ctx, session, route: agent.options }); } catch { /* attach must not fail */ }
      try {
        const decision = folder?.decide?.(sessionId, { events: session.events ?? [], session, route: agent.options });
        if (decision?.action === "drop") folder.apply(sessionId, { events: session.events ?? [], session });
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

  async function delegate({ agent } = {}) {
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
    if (!brief.trim() || brief.trim() === EMPTY_CASE.trim()) {
      return { status: "refused", reason: "delegate requires settled working memory" };
    }
    const delegationId = randomUUID();
    const parentAlias = typeof relay.alias === "function" ? relay.alias(parent.id) : undefined;
    const aliasNotice = parentAlias
      ? ` Alias ${parentAlias} is informational and ephemeral; never use it as relay identity.`
      : "";
    const returnAddress = `Authoritative parent session UUID: ${parent.id}.${aliasNotice}`;
    const packet = `Delegation ID (authoritative): ${delegationId}.\n${returnAddress} Workflow completion is returned automatically; do not manually relay a duplicate report.\n\n${brief.trimEnd()}`;
    const taskId = cases?.taskId?.(parent.id) ?? null;
    const childId = `session-${randomUUID()}`;
    let targetCwd = repoRootFor(parent.header?.cwd);
    try {
      const prepared = await createDelegatedWorktree(run, {
        cwd: targetCwd,
        brief: packet,
        id: childId,
        env,
      });
      targetCwd = prepared.worktree;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not a git worktree/i.test(message)) {
        return { status: "refused", reason: `delegate worktree: ${message}` };
      }
    }
    const handsBinding = typeof hands === "function" ? hands() : hands;
    const talkingBinding = typeof talking === "function" ? talking() : talking;
    const route = childRoute({
      binding: handsBinding ?? talkingBinding,
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
    hideHarnessToolsOn(child);
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
    if (typeof onInvokeChild === "function") {
      try {
        adoption = await onInvokeChild(child, {
          handle: created,
          packet,
          delegationId,
          taskId,
          parent,
          parentSession: parent.id,
          cwd: targetCwd,
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
    const workflowPacket = adoption?.run
      ? `${packet}\n\nDelegation ID (authoritative): ${adoption.delegationId || delegationId}. Land run: ${adoption.run}. Workflow phase: role ${adoption.role || "implementer"}; epoch ${adoption.phaseEpoch || 1}; child session ${childSessionId}.`
      : packet;
    try {
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderMiniSweTask(workflowPacket) }],
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
      runId: adoption?.run || "",
      child: child.session?.id ?? childId,
      alias: alias ?? "",
      role: adoption?.role || "implementer",
      phaseEpoch: adoption?.phaseEpoch || 1,
      delivery: "default",
    };
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
