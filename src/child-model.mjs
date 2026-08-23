// Prompt-model binding for workflow children.
//
// qq operator chairs pass agentOptions plus a setup that fills {{model}} on
// system-prompt/assemble. Workflow children created through ctx.agents.create
// skipped that, so the first turn died: prompt variable "{{model}}" has no
// value for this assembly.

export function childRoute(sources = {}) {
  for (const candidate of [
    sources.binding,
    sources.options,
    envRoute(sources.env),
  ]) {
    const route = normalizeRoute(candidate);
    if (route) return route;
  }
  return null;
}

export function childCreateOptions(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) return {};
  return {
    agentOptions: {
      provider: normalized.provider,
      model: normalized.model,
      ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
    },
    setup: childModelSetup(normalized),
  };
}

export function childModelSetup(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) return undefined;
  const { provider, model, reasoningEffort } = normalized;
  return (agentCtx) => {
    let assembled;
    agentCtx.on(
      "system-prompt/assemble",
      async (_assembly, _context, next) => {
        const result = await next();
        assembled = true;
        return {
          ...result,
          variables: {
            ...result.variables,
            provider,
            model,
          },
        };
      },
    );
    agentCtx.on("agent/request", async (_payload, next) => {
      const result = await next();
      if (!assembled) return result;
      const { reasoningEffort: _inherited, ...withoutInherited } = result;
      return {
        ...withoutInherited,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    });
  };
}

function envRoute(env = process.env) {
  const provider = env?.QQ_DSH_PROVIDER;
  const model = env?.QQ_DSH_MODEL;
  if (typeof provider !== "string" || !provider) return null;
  if (typeof model !== "string" || !model) return null;
  const reasoningEffort = env?.QQ_DSH_REASONING_EFFORT;
  return {
    provider,
    model,
    ...(typeof reasoningEffort === "string" && reasoningEffort ? { reasoningEffort } : {}),
  };
}

function normalizeRoute(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.provider !== "string" || value.provider.length === 0) return null;
  if (typeof value.model !== "string" || value.model.length === 0) return null;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === "string" && value.reasoningEffort
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  };
}
