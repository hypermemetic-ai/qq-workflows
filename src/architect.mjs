// Architect workflow: one live card, notebook, clerk, fold, lookup, invoke.
//
// Noun and verb. One per project. The wrapper attaches this workflow when
// the session's selection is architect. On attach, hang workflows:architect
// via qq-relay if loaded; clear on detach. Architect works without relay
// except invoke-result delivery.

import { randomUUID } from "node:crypto";
import { pluginUserMessage } from "./tools.mjs";
import { buildSpine } from "./clerk.mjs";
import { repoRootFor } from "./iterate.mjs";
import { childCreateOptions, childRoute } from "./child-model.mjs";
import { hideHarnessToolsOn } from "./hide-harness.mjs";
import {
  classifyJunction,
  createOfferBook,
  incomingLeftoverNotes,
  leftoverDigest,
  leftoverProse,
  leftoverTitle,
  priorLeftoverNotes,
  switchBrief,
} from "./offer.mjs";
import { bankLeftover, bankNotice } from "./bank.mjs";
import { oneShot } from "../../core/src/ask.mjs";

export const ARCHITECT_LABEL = "workflows:architect";
export const CHILD_ORIGIN = "subagent";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A chair that may be selected as architect. Children never are. */
export function isArchitectCandidate(agent) {
  const origin = agent?.session?.header?.origin;
  if (origin === CHILD_ORIGIN) return false;
  return SESSION_ID.test(agent?.session?.id ?? agent?.id ?? "");
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

function noticeLeftover(session, text) {
  failVisibly(session, text);
}

function publicOffer(offer) {
  if (!offer || offer.kind !== "switch") return null;
  return {
    id: offer.id,
    kind: "switch",
    title: offer.title,
    brief: offer.operatorBrief || offer.brief,
    runnerBrief: "",
    choices: ["start", "abandon", "later"],
  };
}

export function createArchitect({
  ctx,
  store,
  clerk,
  folder,
  agents,
  tasks,
  talking,
  onInvokeChild,
  env = process.env,
  offerBook,
  llm,
  resolveBinding,
  runScribe = oneShot,
} = {}) {
  const attached = new Map();
  const offers = offerBook ?? createOfferBook();

  function tasksOf() {
    return typeof tasks === "function" ? tasks() : tasks ?? null;
  }

  async function bankProse(title, prose) {
    const service = tasksOf();
    if (!service || typeof service.create !== "function") {
      return { status: "refused", reason: "bank requires qq-tasks" };
    }
    const llmOf = typeof llm === "function" ? llm() : llm;
    const binding = typeof resolveBinding === "function" ? resolveBinding() : resolveBinding;
    return bankLeftover({
      tasks: service,
      title,
      leftover: prose,
      llm: llmOf,
      binding,
      run: runScribe,
    });
  }

  function rememberHandled(sessionId, digest) {
    offers.remember(sessionId, digest);
    store?.rememberLeftover?.(sessionId, digest);
  }

  function wasHandled(sessionId, digest) {
    if (offers.alreadyHandled(sessionId, digest)) return true;
    const persisted = store?.handledLeftovers?.(sessionId);
    return Array.isArray(persisted) && persisted.includes(digest);
  }

  function liveDigest(sessionId) {
    if (!store || typeof store.load !== "function") return "";
    try {
      const notebook = store.load(sessionId);
      const card = store.openCard(notebook) ?? notebook.cards.at(-1);
      return leftoverDigest(card);
    } catch {
      return "";
    }
  }

  /** Pre-f3a61e9 leftover prompts compiled a child packet and used handoff/bank/ignore. */
  function discardStaleOffer(sessionId, current) {
    offers.clear(sessionId);
    rememberHandled(sessionId, current?.digest);
    const digest = liveDigest(sessionId);
    if (digest && digest !== current?.digest) rememberHandled(sessionId, digest);
    return current;
  }

  function liveSwitchOffer(sessionId) {
    const current = offers.get(sessionId);
    if (!current) return { offer: null, dropped: false };
    if (current.kind === "switch") return { offer: current, dropped: false };
    discardStaleOffer(sessionId, current);
    return { offer: null, dropped: true };
  }

  function liveSession(sessionId, agent) {
    return agent?.session ?? attached.get(sessionId)?.agent?.session;
  }

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
          await considerOffer({ sessionId, events: session.events, turn, session });
        } catch {
          // Clerk/fold/offer must not block the talking loop.
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
      agent,
      lastTurn: () => lastTurn,
      offer: () => publicOffer(liveSwitchOffer(sessionId).offer),
      detach() {
        disposeEvent?.();
        disposeTurn?.();
        disposeAssemble?.();
        clearLabel(ctx, sessionId);
        offers.clear(sessionId);
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

  async function considerOffer({ sessionId, events, turn, session } = {}) {
    const notebook = store.load(sessionId);
    const card = store.openCard(notebook) ?? notebook.cards.at(-1);
    const spine = buildSpine(events, turn);
    const digest = leftoverDigest(card);
    const existing = offers.get(sessionId);
    if (existing && existing.kind !== "switch") discardStaleOffer(sessionId, existing);
    else if (existing?.digest === digest) return existing;
    if (wasHandled(sessionId, digest)) return { status: "skip", reason: "already-handled" };
    const kind = classifyJunction(card, { turnStartSeq: spine.startSeq });
    if (kind === "skip") {
      return { status: "skip", reason: "empty" };
    }
    const prior = priorLeftoverNotes(card, spine.startSeq);
    const incoming = incomingLeftoverNotes(card, spine.startSeq);
    if (kind === "bank") {
      const prose = leftoverProse({ notes: prior });
      const title = leftoverTitle({ name: card?.name, notes: prior }, prose);
      const filed = await bankProse(title, prose);
      if (filed.status === "ok") {
        withdrawNotes(sessionId, prior);
        offers.clear(sessionId);
        rememberHandled(sessionId, digest);
        noticeLeftover(session, bankNotice(filed, title));
        return { ...filed, silent: true };
      }
      return { status: "skip", reason: "bank-unavailable" };
    }
    const title = leftoverTitle({ name: "concern", notes: incoming });
    const brief = switchBrief(prior, incoming);
    return offers.put(sessionId, {
      id: randomUUID(),
      kind: "switch",
      digest,
      title,
      prior,
      incoming,
      prose: leftoverProse({ notes: prior }),
      incomingProse: leftoverProse({ notes: incoming }),
      brief,
      operatorBrief: brief,
      runnerBrief: "",
    });
  }

  function offer(sessionId) {
    return publicOffer(liveSwitchOffer(sessionId).offer);
  }

  function withdrawNotes(sessionId, notes) {
    if (!store || typeof store.appendWithdraw !== "function") return;
    for (const note of notes ?? []) {
      store.appendWithdraw(sessionId, {
        text: `X withdrawn / ${note.text}`,
        startSeq: note.startSeq,
        endSeq: note.endSeq,
      });
    }
  }

  async function choose(sessionId, { choice, agent } = {}) {
    const { offer: current, dropped } = liveSwitchOffer(sessionId);
    if (!current) {
      return dropped
        ? { status: "ok", action: "dismiss" }
        : { status: "refused", reason: "no leftover offer" };
    }
    const live = liveSession(sessionId, agent);
    if (choice === "abandon" || choice === "ignore") {
      withdrawNotes(sessionId, current.prior);
      offers.clear(sessionId);
      rememberHandled(sessionId, current.digest);
      noticeLeftover(live, "Previous leftover abandoned.");
      return { status: "ok", action: "abandon" };
    }
    if (choice === "start" || choice === "now" || choice === "handoff") {
      const prose = current.prose || leftoverProse({ notes: current.prior ?? [] });
      const title = leftoverTitle({ name: "concern", notes: current.prior ?? [] }, prose);
      let filed = { status: "ok", action: "start" };
      if (prose && !String(prose).split("\n").every((line) => !line.trim())) {
        filed = await bankProse(title, prose);
        if (filed.status !== "ok") return filed;
        noticeLeftover(live, bankNotice(filed, title).replace(/^Leftover /, "Previous leftover "));
      }
      withdrawNotes(sessionId, current.prior);
      offers.clear(sessionId);
      rememberHandled(sessionId, current.digest);
      return { ...filed, action: "start" };
    }
    if (choice === "later" || choice === "bank") {
      const prose = current.incomingProse || leftoverProse({ notes: current.incoming ?? [] });
      const title = current.title || leftoverTitle({ name: "concern", notes: current.incoming ?? [] }, prose);
      const filed = await bankProse(title, prose);
      if (filed.status !== "ok") return filed;
      withdrawNotes(sessionId, current.incoming);
      offers.clear(sessionId);
      rememberHandled(sessionId, current.digest);
      noticeLeftover(live, bankNotice(filed, title).replace(/^Leftover /, "New idea "));
      return { ...filed, action: "later" };
    }
    return { status: "refused", reason: "unknown leftover choice" };
  }

  async function invoke({ agent, packet: compiled } = {}) {
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
    const packet = compiled || await clerk.compilePacket({
      sessionId: parent.id,
      events: parent.events,
      foldPoint: Number.isSafeInteger(foldPoint) ? foldPoint - 1 : undefined,
      parentSession: parent.id,
      parentAlias,
    });
    if (!packet) return { status: "refused", reason: "invoke packet was empty" };
    const childId = `session-${randomUUID()}`;
    const targetCwd = repoRootFor(parent.header?.cwd);
    const route = childRoute({
      binding: typeof talking === "function" ? talking() : talking,
      options: agent?.options,
      env,
    });
    const handle = await agents.create({
      sessionId: childId,
      meta: {
        cwd: targetCwd,
        parentSession: parent.id,
        origin: CHILD_ORIGIN,
      },
      ...childCreateOptions(route),
    });
    const child = handle?.agent ?? handle;
    hideHarnessToolsOn(child);
    let adopted = false;
    if (typeof onInvokeChild === "function") {
      try {
        const result = await onInvokeChild(child, {
          packet,
          parent,
          parentSession: parent.id,
          cwd: targetCwd,
        });
        adopted = result === true || result?.status === "ok";
      } catch {
        adopted = false;
      }
    }
    if (!adopted) watchChildReturn({ ctx, relay, child, parentId: parent.id });
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

  function dispose() {
    for (const handle of [...attached.values()]) handle.detach();
  }

  return Object.freeze({
    attach,
    detach,
    dispose,
    invoke,
    offer,
    choose,
    considerOffer,
    attached: (sessionId) => attached.get(sessionId),
    label: ARCHITECT_LABEL,
  });
}
