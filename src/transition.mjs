// Awaitable leave and A→B transition for the workflow registry.
//
// Internal workflow dismiss is outside this API and does not leave.
// Reasons are generic; this module never branches on a workflow name.

import {
  assertLeaveReason,
  assertSessionContext,
  lifecycleRefused,
  refusalMessage,
} from "./context.mjs";

function requestName(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "";
  const name = request.name ?? request.workflow;
  return typeof name === "string" ? name : "";
}

export function createWorkflowSessionApi({
  getWorkflow,
  selectedName,
  persistSelection,
  liveAgent,
  names = () => [],
}) {
  function describe(name) {
    const workflow = getWorkflow(name);
    if (!workflow) return null;
    return Object.freeze({
      name: workflow.name,
      acceptedContexts: workflow.acceptedContexts,
    });
  }

  function acceptedContexts(name) {
    return getWorkflow(name)?.acceptedContexts ?? null;
  }

  function accepts(name, context) {
    assertSessionContext(context);
    const workflow = getWorkflow(name);
    return Boolean(workflow?.acceptedContexts.includes(context));
  }

  function compatible({ name, context, agent, sessionId } = {}) {
    if (!accepts(name, context)) return false;
    const live = agent ?? (sessionId ? liveAgent(sessionId) : null);
    if (live && getWorkflow(name).candidate(live) !== true) return false;
    return true;
  }

  function accepting(context) {
    assertSessionContext(context);
    return names().filter((name) => getWorkflow(name)?.acceptedContexts.includes(context));
  }

  async function detachNamed(sessionId, name) {
    const workflow = getWorkflow(name);
    if (!workflow) return;
    const agent = liveAgent(sessionId);
    const result = await workflow.ensureDetached(agent ?? sessionId);
    if (lifecycleRefused(result)) {
      throw new Error(refusalMessage(result, `workflow ${name} refused to leave`));
    }
  }

  async function attachNamed(sessionId, name) {
    const workflow = getWorkflow(name);
    if (!workflow) throw new Error(`unknown workflow: ${name}`);
    const agent = liveAgent(sessionId);
    if (!agent) return;
    if (workflow.candidate(agent) !== true) {
      throw new Error(`a child session cannot select ${name}`);
    }
    const result = await workflow.ensureAttached(agent);
    if (lifecycleRefused(result)) {
      throw new Error(refusalMessage(result, `workflow ${name} refused to attach`));
    }
  }

  async function restoreOrClear(sessionId, name) {
    try {
      await attachNamed(sessionId, name);
    } catch {
      try { await detachNamed(sessionId, name); } catch {}
      try { persistSelection(sessionId, null); } catch {}
    }
  }

  async function leave(sessionId, reason) {
    assertLeaveReason(reason);
    const current = selectedName(sessionId);
    if (!current) return null;
    try {
      await detachNamed(sessionId, current);
    } catch (error) {
      await restoreOrClear(sessionId, current);
      throw error;
    }
    try {
      persistSelection(sessionId, null);
    } catch (error) {
      await restoreOrClear(sessionId, current);
      throw error;
    }
    return null;
  }

  async function transition(sessionId, request) {
    const name = requestName(request);
    const context = assertSessionContext(request?.context);
    const reason = assertLeaveReason(request?.reason);
    const workflow = getWorkflow(name);
    if (!workflow) throw new Error(`unknown workflow: ${name}`);
    if (!workflow.acceptedContexts.includes(context)) {
      throw new Error(`workflow ${name} does not accept ${context} context`);
    }
    const agent = liveAgent(sessionId);
    if (agent && workflow.candidate(agent) !== true) {
      throw new Error(`a child session cannot select ${name}`);
    }

    const current = selectedName(sessionId);
    if (current === name) {
      await attachNamed(sessionId, name);
      return name;
    }

    if (current) await leave(sessionId, reason);

    try {
      await attachNamed(sessionId, name);
    } catch (error) {
      try { await detachNamed(sessionId, name); } catch {}
      try { persistSelection(sessionId, null); } catch {}
      throw error;
    }

    try {
      persistSelection(sessionId, name);
    } catch (error) {
      try { await detachNamed(sessionId, name); } catch {}
      try { persistSelection(sessionId, null); } catch {}
      throw error;
    }
    return name;
  }

  return Object.freeze({
    acceptedContexts,
    accepts,
    accepting,
    describe,
    compatible,
    leave,
    transition,
  });
}
