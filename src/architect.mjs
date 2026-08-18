// Architect workflow: one live card, notebook, clerk, fold, lookup, invoke.
//
// Noun and verb. One per project. The wrapper attaches this workflow when
// the session's selection is architect. On attach, hang workflows:architect
// via qq-relay if loaded; clear on detach. Architect works without relay
// except invoke-result delivery.

import { randomUUID } from "node:crypto";
import { pluginUserMessage } from "./tools.mjs";

export const ARCHITECT_LABEL = "workflows:architect";
export const CHILD_ORIGIN = "subagent";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A chair that may be selected as architect. Children never are. */
export function isArchitectCandidate(agent) {
  const origin = agent?.session?.header?.origin;
  if (origin === CHILD_ORIGIN) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
}

/** @deprecated Use isArchitectCandidate plus session membership. */
export function isArchitectSession(agent) {
  return isArchitectCandidate(agent);
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
    relay.hang(sessionId, ARCHITECT_LABEL);
    logLine(ctx, "info", `qq-workflows: hung ${ARCHITECT_LABEL} on ${sessionId}`);
    return true;
  } catch (error) {
    logLine(
      ctx,
      "warn",
      `qq-workflows: failed to hang ${ARCHITECT_LABEL} on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
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

/** Chop fat tool dumps at a legal append boundary. Do not call from session/event. */
function pruneToolResults(ctx, session) {
  const pruner = ctx.get?.("toolResultPruner", false);
  if (!pruner || typeof pruner.pruneSession !== "function") return null;
  return pruner.pruneSession(session);
}

function lastAssistantText(events) {
  if (!Array.isArray(events)) return "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Child completion → relay.send default to the parent. One shot. */
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
      await relay.send({
        fromId: childId,
        to: parentId,
        message: text,
        delivery: "default",
      });
    } catch (error) {
      sent = false;
      logLine(
        ctx,
        "warn",
        `qq-workflows: invoke result was not delivered to ${parentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const dispose = child.ctx?.on?.("session/event", async (_session, event) => {
    if (event?.type === "turn/end") await sendBack();
  });
  return typeof dispose === "function" ? dispose : () => {};
}

function failVisibly(session, text) {
  if (!session || typeof session.append !== "function") return;
  session.append("user/message", pluginUserMessage(text, "notice"), { surfaceOp: "append" });
}

export function createArchitect({
  ctx,
  store,
  clerk,
  folder,
  agents,
} = {}) {
  const attached = new Map();

  function attach(agent) {
    if (!isArchitectCandidate(agent)) return null;
    const session = agent.session;
    const sessionId = session.id;
    if (attached.has(sessionId)) return attached.get(sessionId);
    store.ensure(sessionId);
    hangLabel(ctx, sessionId);

    let lastTurn;
    let clerkPending = false;
    let disposeEvent;
    let disposeTurn;
    let disposeAssemble;
    try {
      disposeEvent = agent.ctx?.on?.("session/event", (_session, event) => {
        if (event?.type === "turn/end") lastTurn = event.data?.turn;
      });
      disposeTurn = agent.ctx?.on?.("session/event", async (_session, event) => {
        if (event?.type !== "turn/end") return;
        const turn = event.data?.turn;
        clerkPending = true;
        try {
          await clerk.fire({ sessionId, events: session.events, turn });
          folder.decide(sessionId, {
            events: session.events,
            session,
            route: agent.options,
            pendingClerk: false,
          });
        } catch {
          // Clerk/fold must not block the talking loop.
        } finally {
          clerkPending = false;
        }
      });
      disposeAssemble = agent.ctx?.on?.("agent/request", async (_payload, next) => {
        try {
          pruneToolResults(ctx, session);
        } catch (error) {
          failVisibly(
            session,
            `qq-workflows: tool-result prune refused (${error instanceof Error ? error.message : String(error)}).`,
          );
        }
        const pending = folder.pending(sessionId);
        if (clerkPending) {
          folder.decide(sessionId, {
            events: session.events,
            session,
            route: agent.options,
            pendingClerk: true,
          });
        } else if (pending?.action === "fail") {
          failVisibly(session, "qq-workflows: open tail cannot fit after chop; fold refused.");
          folder.clear(sessionId);
        } else if (pending?.action === "drop") {
          try {
            folder.apply(sessionId, { events: session.events, session });
          } catch (error) {
            failVisibly(
              session,
              `qq-workflows: open tail cannot fit after chop; fold refused (${error instanceof Error ? error.message : String(error)}).`,
            );
            folder.clear(sessionId);
          }
        }
        return next();
      });
    } catch {
      // Listeners are best-effort. Notebook + label must survive a host that
      // rejects agent.ctx.on from the plugin fiber.
    }

    const handle = {
      sessionId,
      lastTurn: () => lastTurn,
      detach() {
        disposeEvent?.();
        disposeTurn?.();
        disposeAssemble?.();
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

  async function invoke({ agent } = {}) {
    const relay = relayOf(ctx);
    if (!relay) return { status: "refused", reason: "invoke requires qq-relay" };
    const parent = agent?.session;
    if (!parent?.id || !isArchitectCandidate(agent) || !attached.has(parent.id)) {
      return { status: "refused", reason: "invoke requires a live architect session" };
    }
    if (!agents || typeof agents.create !== "function") {
      return { status: "refused", reason: "invoke requires ctx.agents.create" };
    }
    const foldPoint = folder.pending(parent.id)?.startSeq;
    const parentAlias = typeof relay.alias === "function" ? relay.alias(parent.id) : undefined;
    const packet = await clerk.compilePacket({
      sessionId: parent.id,
      events: parent.events,
      foldPoint: Number.isSafeInteger(foldPoint) ? foldPoint - 1 : undefined,
      parentSession: parent.id,
      parentAlias,
    });
    if (!packet) return { status: "refused", reason: "invoke packet was empty" };
    const childId = `session-${randomUUID()}`;
    const handle = await agents.create({
      sessionId: childId,
      meta: {
        cwd: parent.header?.cwd,
        parentSession: parent.id,
        origin: CHILD_ORIGIN,
      },
    });
    const child = handle?.agent ?? handle;
    watchChildReturn({ ctx, relay, child, parentId: parent.id });
    child.followup({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: packet }],
      source: { kind: "plugin", plugin: "qq-workflows", form: "notice" },
    });
    const alias = typeof relay.alias === "function" ? relay.alias(child.session?.id ?? childId) : undefined;
    return {
      status: "ok",
      child: child.session?.id ?? childId,
      alias: alias ?? "",
      delivery: "default",
    };
  }

  return Object.freeze({
    attach,
    detach,
    invoke,
    attached: (sessionId) => attached.get(sessionId),
    label: ARCHITECT_LABEL,
  });
}
