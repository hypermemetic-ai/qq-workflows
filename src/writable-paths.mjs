// Shared model-facing declaration for host-enforced external write capabilities.
//
// This package only exposes and forwards the request. qq-core/DSH remains the
// authority for project identity, canonicalization, approval, persistence,
// revocation, and OS sandbox construction.

export const WRITABLE_PATHS_ARGUMENT = "writable_paths";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const WRITABLE_PATHS_SCHEMA = deepFreeze({
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: {
    type: "string",
    minLength: 1,
  },
  description: "Exact additional directory roots this command needs to write. The host canonicalizes each path and remembers an approved folder grant for the logical project. Request narrow folders; protected broad roots are refused.",
});

/**
 * Clone a bash parameters schema and add writable_paths when an older host has
 * not advertised it yet. A newer host's exact property schema always wins.
 */
export function exposeWritablePaths(parameters) {
  if (!parameters || typeof parameters !== "object") return parameters;
  const exposed = structuredClone(parameters);
  if (!exposed.properties || typeof exposed.properties !== "object" || Array.isArray(exposed.properties)) {
    return exposed;
  }
  if (!Object.hasOwn(exposed.properties, WRITABLE_PATHS_ARGUMENT)) {
    exposed.properties[WRITABLE_PATHS_ARGUMENT] = structuredClone(WRITABLE_PATHS_SCHEMA);
  }
  return exposed;
}

/** Use the host's exact field schema when available, otherwise the fallback. */
export function writablePathsSchemaFrom(parameters) {
  const candidate = parameters?.properties?.[WRITABLE_PATHS_ARGUMENT];
  return structuredClone(candidate && typeof candidate === "object" ? candidate : WRITABLE_PATHS_SCHEMA);
}
