// Architect workflow: one live card, notebook, clerk, fold, lookup, invoke.
//
// Noun and verb. One per project, always on. On attach, hang
// workflows:architect via qq-relay if loaded; clear on detach. Architect
// works without relay except invoke-result delivery.

import { randomUUID } from "node:crypto";
import { pluginUserMessage } from "./tools.mjs";

export const ARCHITECT_LABEL = "workflows:architect";
export const CHILD_ORIGIN = "subagent";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isArchitectSession(agent) {
  const origin = agent?.session?.header?.origin;
  if (origin === CHILD_ORIGIN) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
}

function relayOf(ctx) {
  return ctx.get?.("qq-relay", false) ?? null;
}

function hangLabel(ctx, sessionId) {
  const relay = relayOf(ctx);
  if (!relay || typeof relay.hang !== "function") return false;
  try {
    relay.hang(sessionId, ARCHITECT_LABEL);
    return true;
  } catch {
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

function pruneToolResults(ctx, session) {
  const pruner = ctx.get?.("toolResultPruner", false);
  if (!pruner || typeof pruner.pruneSession !== "function") return null;
  try {
    return pruner.pruneSession(session);
  } catch {
    return null;
  }
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
    if (!isArchitectSession(agent)) return null;
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
        if (event?.type === "tool/result") pruneToolResults(ctx, session);
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
    if (!parent?.id || !isArchitectSession(agent)) {
      return { status: "refused", reason: "invoke requires a live architect session" };
    }
    if (!agents || typeof agents.create !== "function") {
      return { status: "refused", reason: "invoke requires ctx.agents.create" };
    }
    const foldPoint = folder.pending(parent.id)?.startSeq;
    const packet = await clerk.compilePacket({
      sessionId: parent.id,
      events: parent.events,
      foldPoint: Number.isSafeInteger(foldPoint) ? foldPoint - 1 : undefined,
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
