import { installChildCompaction } from "./child-compaction.mjs";
import { installChildSessionHistory } from "./child-session-history.mjs";
import { installChildWorkflowSend } from "./child-workflow-send.mjs";

/** Compose current-child recall, messaging, and compaction under one rollback-safe HMR lift. */
export function installChildConversationServices(agentCtx) {
  const lifts = [];
  try {
    lifts.push(installChildSessionHistory(agentCtx));
    lifts.push(installChildWorkflowSend(agentCtx));
    lifts.push(installChildCompaction(agentCtx));
  } catch (error) {
    for (const lift of lifts.reverse()) {
      try { lift?.(); } catch { /* best effort rollback */ }
    }
    throw error;
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const pending = [];
    for (const lift of lifts.reverse()) {
      try {
        const result = lift?.();
        if (result && typeof result.then === "function") pending.push(result);
      } catch { /* best effort */ }
    }
    if (pending.length > 0) return Promise.allSettled(pending);
  };
  const readiness = lifts.map((lift) => lift?.ready).filter((ready) => ready && typeof ready.then === "function");
  if (readiness.length > 0) {
    dispose.ready = Promise.all(readiness).then(() => undefined).catch(async (error) => {
      await dispose();
      throw error;
    });
  }
  return dispose;
}

/** Agent setup may await nested Cordis fibers; ordinary mocks remain synchronous. */
export function childServicesReady(lift) {
  return lift?.ready && typeof lift.ready.then === "function" ? lift.ready.then(() => undefined) : undefined;
}

/** Observe asynchronous remounts of already-published agents without creating an unhandled rejection. */
export function observeLiveChildSetup(agent, readiness, label) {
  if (!readiness || typeof readiness.then !== "function") return;
  readiness.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    try { agent?.ctx?.logger?.warn?.(`${label} child conversation services failed to remount: ${message}`); } catch { /* strict context */ }
  });
}

export function messageHasChildAction(event, completionTools) {
  if (event?.type !== "assistant/message") return undefined;
  const content = event?.data?.message?.content ?? event?.message?.content;
  if (!Array.isArray(content)) return false;
  const names = new Set([...(completionTools ?? []), "session_history", "workflow_send"]);
  return content.some((block) => block?.type === "tool-call" && names.has(block?.name));
}
