// Projects already runs with the host's widest standing sandbox and cannot
// legitimately escalate. Keep its ordinary bash contract while removing
// escalation-only controls from both the model schema and execution.

const PROJECTS_WRAPPED_BASH = Symbol.for("qq.workflows.projectsWrappedBash");
const LEGACY_NON_ESCALATING_BASH = Symbol.for("qq.workflows.architectWrappedBash");
const INAPPLICABLE_BASH_ARGUMENTS = new Set(["sandbox_permissions", "justification"]);

function withoutInapplicableRequiredEntries(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return schema;
  seen.add(schema);
  if (Array.isArray(schema)) {
    for (const value of schema) withoutInapplicableRequiredEntries(value, seen);
    return schema;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value)) {
      schema[key] = value.filter((name) => !INAPPLICABLE_BASH_ARGUMENTS.has(name));
    }
    withoutInapplicableRequiredEntries(schema[key], seen);
  }
  return schema;
}

/** Return a detached JSON Schema with Projects-inapplicable escalation controls hidden. */
export function sanitizeProjectsBashParameters(parameters) {
  if (!parameters || typeof parameters !== "object") return parameters;
  const sanitized = structuredClone(parameters);
  if (sanitized.properties && typeof sanitized.properties === "object") {
    delete sanitized.properties.sandbox_permissions;
    delete sanitized.properties.justification;
  }
  return withoutInapplicableRequiredEntries(sanitized);
}

/** Copy ordinary arguments without forwarding host escalation controls. */
export function sanitizeProjectsBashArguments(args) {
  if (!args || typeof args !== "object") return args;
  const sanitized = { ...args };
  delete sanitized.sandbox_permissions;
  delete sanitized.justification;
  return sanitized;
}

/**
 * Shadow inherited host bash for Projects sessions only.
 *
 * All behavior except the model-visible schema and the two inapplicable execute
 * arguments remains delegated to the base definition. The global symbols make
 * repeated and pre-rename wrapping idempotent across HMR.
 */
export function wrapProjectsBash(base) {
  if (!base || typeof base.execute !== "function") {
    throw new Error("Projects requires a bash tool to wrap");
  }
  if (base[PROJECTS_WRAPPED_BASH] === true || base[LEGACY_NON_ESCALATING_BASH] === true) return base;
  return {
    ...base,
    [PROJECTS_WRAPPED_BASH]: true,
    parameters: sanitizeProjectsBashParameters(base.parameters),
    execute(args, exec) {
      return base.execute(sanitizeProjectsBashArguments(args), exec);
    },
  };
}
