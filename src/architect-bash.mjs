// Architect chairs start in workspace-write, but may use the host-sanctioned
// one-shot retry after a real sandbox denial. Keep those controls visible while
// making them optional so routine bash calls do not serialize a non-widening
// sandbox request.

const ARCHITECT_OPTIONAL_ESCALATION_BASH = Symbol.for("qq.workflows.architectOptionalEscalationBash");
const ESCALATION_ARGUMENTS = new Set(["sandbox_permissions", "justification"]);

function withoutEscalationRequiredEntries(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return schema;
  seen.add(schema);
  if (Array.isArray(schema)) {
    for (const value of schema) withoutEscalationRequiredEntries(value, seen);
    return schema;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value)) {
      schema[key] = value.filter((name) => !ESCALATION_ARGUMENTS.has(name));
    }
    withoutEscalationRequiredEntries(schema[key], seen);
  }
  return schema;
}

/**
 * Return a detached host schema with only escalation requirements removed.
 * The properties and every other part of the host contract remain visible.
 */
export function optionalizeArchitectBashParameters(parameters) {
  if (!parameters || typeof parameters !== "object") return parameters;
  return withoutEscalationRequiredEntries(structuredClone(parameters));
}

/**
 * Shadow inherited host bash for architect sessions only.
 *
 * Execution arguments (including object identity) and host behavior are
 * forwarded unchanged. The global symbol makes repeated wrapping idempotent
 * when plugin modules are replaced by HMR.
 */
export function wrapArchitectBash(base) {
  if (!base || typeof base.execute !== "function") {
    throw new Error("architect requires a bash tool to wrap");
  }
  if (base[ARCHITECT_OPTIONAL_ESCALATION_BASH] === true) return base;
  return {
    ...base,
    [ARCHITECT_OPTIONAL_ESCALATION_BASH]: true,
    parameters: optionalizeArchitectBashParameters(base.parameters),
    execute(args, exec) {
      return base.execute(args, exec);
    },
  };
}
