// Workflow-owned child -> parent messaging. The model-facing surface deliberately
// accepts no routing identifiers: a controller binds the exact owned child and
// resolves its durable parent/delegation/role/epoch at execution time.

export const CHILD_WORKFLOW_SEND_TOOL_NAME = "workflow_send";

const SHARED_STATE = Symbol.for("@hypermemetic-ai/qq-workflows/child-workflow-send-state/v1");

function sharedState() {
  const existing = globalThis[SHARED_STATE];
  if (existing?.bindings instanceof WeakMap) return existing;
  const state = Object.freeze({ bindings: new WeakMap() });
  Object.defineProperty(globalThis, SHARED_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return state;
}

// Query-import/HMR generations share this registry. WeakMap keys also work for
// non-extensible DSH Agent/Session/Context proxies; no symbol write is required.
const { bindings } = sharedState();

function keysOf(agent) {
  return [agent, agent?.session, agent?.ctx]
    .filter((value, index, values) => value && typeof value === "object" && values.indexOf(value) === index);
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? "";
}

function refusal(reason) {
  return { status: "refused", reason: String(reason || "workflow_send is unavailable") };
}

function bindingFor(agent) {
  if (!agent || typeof agent !== "object") return null;
  for (const key of keysOf(agent)) {
    const binding = bindings.get(key);
    if (binding?.agent === agent
      && binding.sessionId === sessionIdOf(agent)
      && typeof binding.send === "function") return binding;
  }
  return null;
}

/**
 * Bind an exact live child to its owning controller.
 *
 * `send` must revalidate durable ownership and both live endpoints on every
 * call. This module owns only capability attachment and model-surface hygiene.
 */
export function bindChildWorkflowSend(agent, { send } = {}) {
  const sessionId = sessionIdOf(agent);
  if (!agent || typeof agent !== "object" || !sessionId || typeof send !== "function") {
    throw new Error("child workflow_send binding requires an exact agent session and send function");
  }
  const binding = Object.freeze({ agent, sessionId, send });
  const keys = keysOf(agent);
  for (const key of keys) bindings.set(key, binding);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Compare-and-delete is essential during HMR: an old generation's delayed
    // disposer must not erase the replacement controller's binding.
    for (const key of keys) {
      if (bindings.get(key) === binding) bindings.delete(key);
    }
  };
}

function textBlock(text) {
  return { type: "text", text: String(text ?? "") };
}

export function buildChildWorkflowSendTool() {
  return {
    name: CHILD_WORKFLOW_SEND_TOOL_NAME,
    description: "Send a message to the live parent that owns this exact current workflow phase. Routing is resolved internally; no delegation, session, role, epoch, alias, recipient, or delivery identifier is accepted.",
    parameters: {
      message: {
        type: "string",
        required: true,
        description: "Non-empty message for this workflow child's owning parent.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          message_id: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [textBlock(value?.status === "sent"
        ? `Message sent${value.message_id ? ` (${value.message_id})` : ""}.`
        : `Workflow send refused: ${value?.reason || "unavailable"}`)],
    },
    async execute(args, exec) {
      try {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return refusal("workflow_send requires an object with only message");
        }
        const unexpected = Object.keys(args).filter((key) => key !== "message");
        if (unexpected.length > 0) {
          return refusal("workflow_send accepts only message; routing is resolved internally");
        }
        if (typeof args.message !== "string" || !args.message.trim()) {
          return refusal("workflow_send requires a non-empty message");
        }
        const binding = bindingFor(exec?.agent);
        if (!binding) return refusal("workflow_send is unavailable for this unowned or stale child");
        const result = await binding.send({ agent: exec.agent, message: args.message });
        if (result?.status !== "sent") return refusal(result?.reason || "workflow_send was not accepted by the owning controller");
        // Never expose parent/session/delegation/role/epoch/alias routing data to
        // the child. message_id is an opaque delivery receipt, not an address.
        return {
          status: "sent",
          ...(typeof result.message_id === "string" && result.message_id ? { message_id: result.message_id } : {}),
        };
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function installChildWorkflowSend(agentCtx) {
  const tools = agentCtx?.tools ?? agentCtx?.get?.("tools", false);
  if (!tools || typeof tools.register !== "function") {
    throw new Error("child workflow_send requires tools.register");
  }
  const dispose = tools.register(buildChildWorkflowSendTool());
  return typeof dispose === "function" ? dispose : () => {};
}
