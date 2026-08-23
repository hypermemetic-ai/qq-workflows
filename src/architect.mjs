// Architect workflow: visible working memory, fold/chop, and delegate.
// The document is both standing context and the child's complete work packet.

import { randomUUID } from "node:crypto";
import { pluginUserMessage } from "./tools.mjs";
import { repoRootFor } from "./iterate.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { hideHarnessToolsOn } from "./hide-harness.mjs";
import { MINI_KIND, miniSetup, renderMiniSweTask } from "./official-mini.mjs";
import { CASE_CONTEXT_NAME, EMPTY_CASE } from "./casefile.mjs";
import { guardContext, OVERFLOW_MESSAGE } from "./chop.mjs";
import { markAssemble } from "./assemble-mark.mjs";

export const ARCHITECT_LABEL = "workflows:architect";
export const CHILD_ORIGIN = "subagent";
export const ARCHITECT_PROMPT_NAME = "qq-workflows:architect";
export const ARCHITECT_PROMPT = "You are the architect. Settle intent in working memory and delegate the work once the operator approves. They see the same working memory document.";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isArchitectCandidate(agent) {
  if (agent?.session?.header?.origin === CHILD_ORIGIN) return false;
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

function watchChildReturn({ ctx, relay, child, parentId }) {
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

export function createArchitect({ ctx, cases, folder, agents, tasks, talking, hands, onInvokeChild, env = process.env } = {}) {
  const attached = new Map();
  const tasksOf = () => (typeof tasks === "function" ? tasks() : tasks ?? null);

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
    const contextOffs = [];

    function bindCaseContext(holder) {
      const prompt = systemPromptOf(holder) ?? systemPromptOf(agent);
      if (typeof prompt?.context !== "function") return;
      while (contextOffs.length) {
        try { contextOffs.pop()?.(); } catch { /* lift */ }
      }
      const promptOff = prompt.context({ name: ARCHITECT_PROMPT_NAME, order: 10, text: () => ARCHITECT_PROMPT });
      if (typeof promptOff === "function") contextOffs.push(promptOff);
      if (!cases) return;
      const caseOff = prompt.context({
        name: CASE_CONTEXT_NAME,
        order: 20,
        text: () => {
          const body = String(cases.load(sessionId)?.text ?? "").trim();
          if (!body) return "";
          const id = cases.taskId?.(sessionId);
          return id ? `Working memory (${id}):\n\n${body}` : `Working memory:\n\n${body}`;
        },
      });
      if (typeof caseOff === "function") contextOffs.push(caseOff);
    }
    if (typeof agent?.ctx?.inject === "function") agent.ctx.inject(["systemPrompt"], bindCaseContext);
    else bindCaseContext(agent?.ctx ?? agent);

    try {
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
    const parentAlias = typeof relay.alias === "function" ? relay.alias(parent.id) : undefined;
    const returnAddress = parentAlias
      ? `Return address: session ${parent.id} (alias ${parentAlias}).`
      : `Return address: session ${parent.id}.`;
    const packet = `${brief.trimEnd()}\n\n${returnAddress} Results are delivered through qq-relay default steer.`;
    const taskId = cases?.taskId?.(parent.id) ?? null;
    const childId = `session-${randomUUID()}`;
    const targetCwd = repoRootFor(parent.header?.cwd);
    const handsBinding = typeof hands === "function" ? hands() : hands;
    const talkingBinding = typeof talking === "function" ? talking() : talking;
    const route = childRoute({
      binding: handsBinding ?? talkingBinding,
      options: agent?.options,
      env,
    });
    const created = await agents.create({
      sessionId: childId,
      meta: {
        cwd: targetCwd,
        parentSession: parent.id,
        origin: CHILD_ORIGIN,
        kind: MINI_KIND,
        agentPreset: MINI_KIND,
      },
      ...childCreateOptions(route, { setup: miniSetup }),
    });
    const child = created?.agent ?? created;
    hideHarnessToolsOn(child);
    const refuseAdoption = async (reason) => {
      let cleanupError = "";
      try {
        await created?.dispose?.();
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
      return {
        status: "refused",
        reason: cleanupError
          ? `land adoption failed: ${reason}; child cleanup failed: ${cleanupError}`
          : `land adoption failed: ${reason}`,
      };
    };
    if (typeof onInvokeChild === "function") {
      let adoption;
      try {
        adoption = await onInvokeChild(child, {
          packet,
          taskId,
          parent,
          parentSession: parent.id,
          cwd: targetCwd,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return refuseAdoption(detail);
      }
      if (adoption?.status === "refused") {
        return refuseAdoption(adoption.reason || "refused");
      }
    }
    watchChildReturn({ ctx, relay, child, parentId: parent.id });
    child.followup({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: renderMiniSweTask(packet) }],
      source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
    });
    cases?.consume?.(parent.id);
    const alias = typeof relay.alias === "function" ? relay.alias(child.session?.id ?? childId) : undefined;
    return {
      status: "ok",
      child: child.session?.id ?? childId,
      alias: alias ?? "",
      delivery: "default",
    };
  }

  function dispose() {
    for (const handle of [...attached.values()]) handle.detach();
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
