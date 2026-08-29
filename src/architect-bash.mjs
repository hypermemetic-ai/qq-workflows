// Architect chairs inherit the host bash executor, but their standing policy
// forbids sandbox escalation. Keep the host's ordinary bash contract while
// removing escalation-only controls from both the model schema and execution.

const ARCHITECT_WRAPPED_BASH = Symbol.for("qq.workflows.architectWrappedBash");
const FORBIDDEN_BASH_ARGUMENTS = new Set(["sandbox_permissions", "justification"]);

function withoutForbiddenRequiredEntries(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return schema;
  seen.add(schema);
  if (Array.isArray(schema)) {
    for (const value of schema) withoutForbiddenRequiredEntries(value, seen);
    return schema;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value)) {
      schema[key] = value.filter((name) => !FORBIDDEN_BASH_ARGUMENTS.has(name));
    }
    withoutForbiddenRequiredEntries(schema[key], seen);
  }
  return schema;
}

/** Return a detached JSON Schema with architect-forbidden bash controls hidden. */
export function sanitizeArchitectBashParameters(parameters) {
  if (!parameters || typeof parameters !== "object") return parameters;
  const sanitized = structuredClone(parameters);
  if (sanitized.properties && typeof sanitized.properties === "object") {
    delete sanitized.properties.sandbox_permissions;
    delete sanitized.properties.justification;
  }
  return withoutForbiddenRequiredEntries(sanitized);
}

/** Copy ordinary arguments without forwarding host escalation controls. */
export function sanitizeArchitectBashArguments(args) {
  if (!args || typeof args !== "object") return args;
  const sanitized = { ...args };
  delete sanitized.sandbox_permissions;
  delete sanitized.justification;
  return sanitized;
}

/**
 * Shadow inherited host bash for architect sessions only.
 *
 * All behavior except the model-visible schema and the two forbidden execute
 * arguments remains delegated to the base definition. The global symbol makes
 * repeated wrapping idempotent even when plugin modules are replaced by HMR.
 */
export function wrapArchitectBash(base) {
  if (!base || typeof base.execute !== "function") {
    throw new Error("architect requires a bash tool to wrap");
  }
  if (base[ARCHITECT_WRAPPED_BASH] === true) return base;
  return {
    ...base,
    [ARCHITECT_WRAPPED_BASH]: true,
    parameters: sanitizeArchitectBashParameters(base.parameters),
    execute(args, exec) {
      return base.execute(sanitizeArchitectBashArguments(args), exec);
    },
  };
}
